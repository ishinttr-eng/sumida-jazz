#!/usr/bin/env python3
"""
すみだストリートジャズフェスティバル公式サイトから venues.json / performances.json を生成する。

公式サイトはビルド時点でJSON/APIを持たない静的HTMLのため、タイムテーブルページを
スクレイピングしてパースする。マークアップは主催者側の都合で変わりうるので、
このスクリプトは "壊れたら tools/raw/ の生HTMLを見て CSS セレクタ・正規表現を直す"
前提のベストエフォート実装。

実行:
    python3 tools/build_data.py

入力:
    tools/raw/timetable.html  (事前に `curl -s https://sumida-jazz.jp/sj/timetable.html -o tools/raw/timetable.html` 等で取得)
出力:
    data/venues.json
    data/performances.json
    data/checked.json
    data/changes.json  (差分がある回のみ履歴追記)
"""
import html as html_lib
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "tools" / "raw" / "timetable.html"
DATA = ROOT / "data"
JST = timezone(timedelta(hours=9))

# 会場名 → (id, stageNo) の固定マッピング。
# タイムテーブルページの見出し文言が変わったらここも更新する。
VENUE_ORDER = [
    "やおきんステージ（錦糸公園）",
    "すみだトリフォニーホール（大ホール）",
    "すみだトリフォニーホール（小ホール）",
    "Platinum PLANET",
    "押上天祖神社【業平二丁目町会会館】",
    "cafe kohana",
    "カラコネ",
    "LOCO BAR【ロコバー】",
    "オリナス広場",
    "82 ALE HOUSE【エールハウス】",
    "地下鉄出口前 アルカイースト",
    "アルカキット前",
    "赤いオブジェ　アルカセントラル２F",
    "みずほ銀行前　アルカセントラル１F",
    "東武ホテルレバント東京１Fロビーラウンジ クリスタルムーブメント",
    "エントランス広場　アルカウェスト１F",
    "大横川親水公園イベント広場",
    "テルミナガーデンテラス　テルミナ5階",
    "JR錦糸町駅南口広場",
    "楽天地ビル前",
    "タワレコステージ",
    "JRAウィンズ錦糸町東館ダービー通り前",
    "モクシー東京錦糸町",
    "ホテルタバードトーキョー",
    "両国駅広小路",
    "TATEKAWA・安兵衛",
    "飲食特設ステージ",
]


def normalize_venue_name(s: str) -> str:
    """全角/半角スペースの入り方の揺れ（主に【】の直前直後）を吸収する。
    それ以外の内部スペース（例: "Platinum PLANET"）はそのまま保持する。"""
    s = s.strip()
    s = re.sub(r"[ 　]+(?=[【】])", "", s)
    s = re.sub(r"(?<=[【】])[ 　]+", "", s)
    return s


VENUE_ID_BY_NAME = {normalize_venue_name(name): f"S-{i+1:02d}" for i, name in enumerate(VENUE_ORDER)}

# 実際のマークアップ（2026-09時点）:
#   <div class="stage" id="plsNNN">
#     <h2 class="place"><strong>[1]　やおきんステージ（錦糸公園）</strong></h2>
#     <p class="date sat">17日(土)</p>
#     <ul><li><span class="time">9:50-10:00</span> オープニング</li>...</ul>
#     <p class="date sun">18日(日)</p>
#     <ul>...</ul>
#   </div>
# 出演者名がリンク（<a>）で囲まれているケースがあるため、タグを剥がした上で
# 「開始-終了 名前」の1行としてパースする（tagを愚直に改行へ変換すると<a>の内側だけ
# 別行に分離されてしまい、時刻と名前が引き離されるので採らない）。
STAGE_SPLIT_RE = re.compile(r'<div class="stage" id="(pls\d+)">')
HEADING_RE = re.compile(r'<h2 class="place"><strong>\s*\[(\d+)\]\s*(.+?)\s*</strong></h2>', re.S)
DATE_BLOCK_RE = re.compile(r'<p class="date (sat|sun)">.*?</p>\s*<ul>(.*?)</ul>', re.S)
LI_RE = re.compile(r"<li>(.*?)</li>", re.S)
TAG_RE = re.compile(r"<[^>]+>")
TIME_LINE_RE = re.compile(r"^(\d{1,2}:\d{2})\s*[-–~〜]\s*(\d{1,2}:\d{2})\s*(.+)$", re.S)

CLASS_DATE_MAP = {"sat": "2026-10-17", "sun": "2026-10-18"}


def load_manual_coords():
    coords_path = DATA / "venues.json"
    if not coords_path.exists():
        return {}
    try:
        existing = json.loads(coords_path.read_text(encoding="utf-8"))
        return {v["id"]: (v["lat"], v["lng"]) for v in existing.get("venues", [])}
    except Exception:
        return {}


def pad_time(t: str) -> str:
    """公式サイトは "9:50" のようにゼロ埋めしない表記なので "09:50" に揃える。
    startを文字列比較でソートしている箇所があるため必須。"""
    h, m = t.split(":")
    return f"{int(h):02d}:{m}"


def resolve_venue_id(venue_name_raw: str):
    key = normalize_venue_name(venue_name_raw)
    venue_id = VENUE_ID_BY_NAME.get(key)
    if venue_id is not None:
        return venue_id
    # 完全一致しない場合は部分一致でフォールバック
    for name, vid in VENUE_ID_BY_NAME.items():
        if name in key or key in name:
            return vid
    return None


def parse_timetable(html: str):
    performances = []
    pid = 0
    order_counter = {}

    stage_starts = list(STAGE_SPLIT_RE.finditer(html))
    for i, sm in enumerate(stage_starts):
        block_start = sm.end()
        block_end = stage_starts[i + 1].start() if i + 1 < len(stage_starts) else len(html)
        block = html[block_start:block_end]

        heading = HEADING_RE.search(block)
        if not heading:
            continue
        venue_name_raw = html_lib.unescape(heading.group(2))
        venue_id = resolve_venue_id(venue_name_raw)
        if venue_id is None:
            print(f"[build_data] 会場名が一致しませんでした: {venue_name_raw!r}（VENUE_ORDERを確認してください）", file=sys.stderr)
            continue

        for date_m in DATE_BLOCK_RE.finditer(block):
            day_class, ul_html = date_m.groups()
            current_date = CLASS_DATE_MAP.get(day_class)
            if not current_date:
                continue

            for li_m in LI_RE.finditer(ul_html):
                text = html_lib.unescape(TAG_RE.sub("", li_m.group(1))).strip()
                tm = TIME_LINE_RE.match(text)
                if not tm:
                    continue
                start, end, name = tm.groups()
                start, end = pad_time(start), pad_time(end)
                name = name.strip()
                pid += 1
                key = (venue_id, current_date, name)
                order_counter[key] = order_counter.get(key, 0) + 1
                performances.append(
                    {
                        "id": f"p-{pid:04d}",
                        "name": name,
                        "kana": "",
                        "venueId": venue_id,
                        "date": current_date,
                        "start": start,
                        "end": end,
                        "genre": "",
                        "region": "",
                        "intro": "",
                        "awardEntry": "",
                        "isU25": False,
                        "order": order_counter[key],
                    }
                )
    return performances


QUOTE_TRANSLATION = str.maketrans({
    "‘": "'", "’": "'", "ʼ": "'", "`": "'",
    "“": '"', "”": '"',
})


def normalize_for_diff(name: str) -> str:
    """表記ゆれ（全角/半角、スペースの数・全角スペース混在、引用符の字形違い等）を
    差分として誤検出しないための比較用正規化。表示用のテキストには使わない。"""
    s = unicodedata.normalize("NFKC", name)
    s = s.translate(QUOTE_TRANSLATION)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def diff_performances(old_list, new_list):
    def nkey(p):
        return (p["venueId"], p["date"], p["start"], normalize_for_diff(p["name"]))

    old_by_key = {nkey(p): p for p in old_list}
    new_by_key = {nkey(p): p for p in new_list}
    added = [p for k, p in new_by_key.items() if k not in old_by_key]
    removed = [p for k, p in old_by_key.items() if k not in new_by_key]
    items = []
    # ざっくり: 同一枠(venueId+date+start)で名前（表記ゆれ除く）が変わっていれば「交代」扱い
    old_slots = {(p["venueId"], p["date"], p["start"]): p for p in old_list}
    new_slots = {(p["venueId"], p["date"], p["start"]): p for p in new_list}
    handled_names = set()
    for slot, np in new_slots.items():
        op = old_slots.get(slot)
        if op and normalize_for_diff(op["name"]) != normalize_for_diff(np["name"]):
            items.append({"kind": "swap", "text": f"{op['name']} → {np['name']}（{slot[2]}〜）"})
            handled_names.add(np["name"])
            handled_names.add(op["name"])
    for p in added:
        if p["name"] not in handled_names:
            items.append({"kind": "added", "text": f"{p['name']} が追加されました"})
    for p in removed:
        if p["name"] not in handled_names:
            items.append({"kind": "removed", "text": f"{p['name']} が削除されました"})

    # フィールド単位の変更検出（同一枠・同一名のまま、時刻やジャンル等だけが変わったケース）
    MODIFIED_FIELDS = [
        ("end", "終了時刻"),
        ("genre", "ジャンル"),
        ("region", "活動地域"),
        ("awardEntry", "アワードエントリー"),
    ]
    for key, np in new_by_key.items():
        op = old_by_key.get(key)
        if not op:
            continue
        changes = []
        for field, label in MODIFIED_FIELDS:
            ov, nv = op.get(field, ""), np.get(field, "")
            if ov != nv:
                changes.append(f"{label}: {ov or '（空欄）'} → {nv or '（空欄）'}")
        if changes:
            items.append(
                {
                    "kind": "modified",
                    "text": f"{np['name']}（{np['start']}〜）が変更されました: " + " / ".join(changes),
                }
            )

    return items


def main():
    if not RAW.exists():
        print(f"[build_data] {RAW} が見つかりません。先に公式ページのHTMLを取得してください。", file=sys.stderr)
        sys.exit(1)

    html = RAW.read_text(encoding="utf-8")
    performances = parse_timetable(html)

    if not performances:
        print("[build_data] 出演情報を1件も抽出できませんでした。STAGE_SPLIT_RE / HEADING_RE / DATE_BLOCK_RE / TIME_LINE_RE を見直してください。", file=sys.stderr)
        sys.exit(1)

    old_perf_path = DATA / "performances.json"
    old_list = []
    if old_perf_path.exists():
        try:
            old_list = json.loads(old_perf_path.read_text(encoding="utf-8")).get("performances", [])
        except Exception:
            old_list = []

    now = datetime.now(JST).isoformat()
    out = {"updatedAt": now, "performances": performances}
    old_perf_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    checked = {"checkedAt": now}
    (DATA / "checked.json").write_text(json.dumps(checked, ensure_ascii=False, indent=2), encoding="utf-8")

    items = diff_performances(old_list, performances)
    if items:
        changes_path = DATA / "changes.json"
        changes = {"history": []}
        if changes_path.exists():
            try:
                changes = json.loads(changes_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        changes.setdefault("history", []).insert(0, {"checkedAt": now, "items": items})
        changes["history"] = changes["history"][:20]
        changes_path.write_text(json.dumps(changes, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[build_data] 差分 {len(items)} 件を検出しました")
    else:
        print("[build_data] 差分なし")

    print(f"[build_data] {len(performances)} 件の出演情報を書き出しました")


if __name__ == "__main__":
    main()

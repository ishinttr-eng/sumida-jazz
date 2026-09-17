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
import json
import re
import sys
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
VENUE_ID_BY_NAME = {name: f"S-{i+1:02d}" for i, name in enumerate(VENUE_ORDER)}

# 会場名の一部に「10月17日」「10月18日」等が続く見出しパターンを想定。
# 実際のHTML構造に合わせて調整すること（現状はざっくりテキスト抽出ベース）。
STAGE_HEADING_RE = re.compile(r"\[(\d+)\]\s*(.+?)\s*[-–]\s*(10月\d+日)")
TIME_LINE_RE = re.compile(r"(\d{1,2}:\d{2})\s*[-–~〜]\s*(\d{1,2}:\d{2})\s*[|｜]\s*(.+)")

DAY_MAP = {"10月17日": "2026-10-17", "10月18日": "2026-10-18"}


def load_manual_coords():
    coords_path = DATA / "venues.json"
    if not coords_path.exists():
        return {}
    try:
        existing = json.loads(coords_path.read_text(encoding="utf-8"))
        return {v["id"]: (v["lat"], v["lng"]) for v in existing.get("venues", [])}
    except Exception:
        return {}


def parse_timetable(html: str):
    """生HTMLをざっくりテキスト化してステージ見出し・出演枠行をパースする。
    実際のマークアップに応じて BeautifulSoup 等でのDOMベース抽出に置き換えるのが望ましい。
    """
    text = re.sub(r"<[^>]+>", "\n", html)
    lines = [l.strip() for l in text.splitlines() if l.strip()]

    performances = []
    current_venue_id = None
    current_date = None
    pid = 0
    order_counter = {}

    for line in lines:
        m = STAGE_HEADING_RE.search(line)
        if m:
            venue_name_raw = m.group(2).strip()
            venue_id = VENUE_ID_BY_NAME.get(venue_name_raw)
            if venue_id is None:
                # 完全一致しない場合は部分一致でフォールバック
                for name, vid in VENUE_ID_BY_NAME.items():
                    if name in venue_name_raw or venue_name_raw in name:
                        venue_id = vid
                        break
            current_venue_id = venue_id
            current_date = DAY_MAP.get(m.group(3))
            continue

        m = TIME_LINE_RE.match(line)
        if m and current_venue_id and current_date:
            start, end, name = m.groups()
            name = name.strip()
            pid += 1
            key = (current_venue_id, current_date, name)
            order_counter[key] = order_counter.get(key, 0) + 1
            performances.append(
                {
                    "id": f"p-{pid:04d}",
                    "name": name,
                    "kana": "",
                    "venueId": current_venue_id,
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


def diff_performances(old_list, new_list):
    def key(p):
        return (p["id"], p["date"])

    old_by_key = {(p["venueId"], p["date"], p["start"], p["name"]): p for p in old_list}
    new_by_key = {(p["venueId"], p["date"], p["start"], p["name"]): p for p in new_list}
    added = [p for k, p in new_by_key.items() if k not in old_by_key]
    removed = [p for k, p in old_by_key.items() if k not in new_by_key]
    items = []
    # ざっくり: 同一枠(venueId+date+start)で名前だけ変わっていれば「交代」扱い
    old_slots = {(p["venueId"], p["date"], p["start"]): p for p in old_list}
    new_slots = {(p["venueId"], p["date"], p["start"]): p for p in new_list}
    handled_names = set()
    for slot, np in new_slots.items():
        op = old_slots.get(slot)
        if op and op["name"] != np["name"]:
            items.append({"kind": "swap", "text": f"{op['name']} → {np['name']}（{slot[2]}〜）"})
            handled_names.add(np["name"])
            handled_names.add(op["name"])
    for p in added:
        if p["name"] not in handled_names:
            items.append({"kind": "added", "text": f"{p['name']} が追加されました"})
    for p in removed:
        if p["name"] not in handled_names:
            items.append({"kind": "removed", "text": f"{p['name']} が削除されました"})
    return items


def main():
    if not RAW.exists():
        print(f"[build_data] {RAW} が見つかりません。先に公式ページのHTMLを取得してください。", file=sys.stderr)
        sys.exit(1)

    html = RAW.read_text(encoding="utf-8")
    performances = parse_timetable(html)

    if not performances:
        print("[build_data] 出演情報を1件も抽出できませんでした。STAGE_HEADING_RE / TIME_LINE_RE を見直してください。", file=sys.stderr)
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

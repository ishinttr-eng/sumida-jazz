#!/usr/bin/env python3
"""
全会場ペアの徒歩ルートを FOSSGIS OSRM から一括取得し、
data/routes.json（ポリライン・距離・所要時間）と data/walktimes.json（分数マトリクス）を更新する。

一度きりのセットアップ用。中断しても再実行時は取得済みペアをスキップして再開できる。

実行:
    python3 tools/build_routes.py
"""
import json
import time
import urllib.request
import urllib.parse
from pathlib import Path
from itertools import combinations

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OSRM_BASE = "https://routing.openstreetmap.de/routed-foot/route/v1/foot"
SLEEP_SEC = 0.3


def load_venues():
    venues = json.loads((DATA / "venues.json").read_text(encoding="utf-8"))["venues"]
    return venues


def load_routes():
    path = DATA / "routes.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"routes": {}}


def fetch_route(a, b):
    url = f"{OSRM_BASE}/{a['lng']},{a['lat']};{b['lng']},{b['lat']}?overview=full&geometries=polyline"
    req = urllib.request.Request(url, headers={"User-Agent": "sumida-jazz-navi/1.0"})
    with urllib.request.urlopen(req, timeout=15) as res:
        data = json.loads(res.read().decode("utf-8"))
    route = data["routes"][0]
    return {
        "distM": round(route["distance"]),
        "durMin": round(route["duration"] / 60),
        "poly": route["geometry"],
    }


def main():
    venues = load_venues()
    routes_doc = load_routes()
    routes = routes_doc.setdefault("routes", {})

    pairs = list(combinations(sorted(venues, key=lambda v: v["id"]), 2))
    total = len(pairs)
    done = 0
    for a, b in pairs:
        key = "|".join(sorted([a["id"], b["id"]]))
        if key in routes:
            done += 1
            continue
        try:
            routes[key] = fetch_route(a, b)
            print(f"[build_routes] {key} OK ({done+1}/{total})")
        except Exception as e:
            print(f"[build_routes] {key} FAILED: {e}")
        done += 1
        time.sleep(SLEEP_SEC)
        if done % 20 == 0:
            (DATA / "routes.json").write_text(json.dumps(routes_doc, ensure_ascii=False, indent=2), encoding="utf-8")

    (DATA / "routes.json").write_text(json.dumps(routes_doc, ensure_ascii=False, indent=2), encoding="utf-8")

    # walktimes.json を実測値で更新（無いペアは概算のままにする＝build_data.py側の役割）
    ids = [v["id"] for v in sorted(venues, key=lambda v: v["id"])]
    wt_path = DATA / "walktimes.json"
    if wt_path.exists():
        wt = json.loads(wt_path.read_text(encoding="utf-8"))
    else:
        wt = {"ids": ids, "minutes": [[0] * len(ids) for _ in ids]}
    id_index = {vid: i for i, vid in enumerate(wt["ids"])}
    for key, r in routes.items():
        a_id, b_id = key.split("|")
        if a_id in id_index and b_id in id_index:
            i, j = id_index[a_id], id_index[b_id]
            wt["minutes"][i][j] = r["durMin"]
            wt["minutes"][j][i] = r["durMin"]
    wt["source"] = "OSRM"
    wt_path.write_text(json.dumps(wt, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[build_routes] 完了: {len(routes)}/{total} ペア")


if __name__ == "__main__":
    main()

// モンキーテスト（ランダムUI操作＋不変条件チェック）。ブラウザのページ内で実行する。
// 使い方（orcaの組み込みブラウザ）:
//   1) 開発サーバーを起動し、テスト用のお気に入り・時刻/現在地シミュレーションを設定して地図タブを開く
//      （終わったら必ず消す。実データは使わない）
//   2) DURATION_MS（実行時間）とSEED（乱数の種。失敗を同じ操作列で再現できる）を置換して
//        orca eval --expression "$(sed -e 's/__DURATION__/180000/' -e 's/__SEED__/20261008/' tools/monkey_test.js)"
//   3) 完了後に window.__monkey を読む（done / actions / counts / failures / errors）
//      failures[].trace が失敗直前の操作列。
// 不変条件: JS例外なし／横スクロールなし／地図タブでページが縦に伸びない・地図が最低高さを割らない・
//           タブバーに被らない・Leaflet高さが枠と一致／エリアタブ押下後にそのエリアが表示されタブのactiveと一致
(() => {
  const DURATION_MS = __DURATION__;
  const SEED = __SEED__;
  let s = SEED >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.confirm = () => true;
  window.alert = () => {};
  window.open = () => null;
  const errors = [];
  window.addEventListener("error", (e) => errors.push("error: " + e.message));
  window.addEventListener("unhandledrejection", (e) => errors.push("rejection: " + (e.reason && e.reason.message || e.reason)));

  const M = (window.__monkey = { seed: SEED, done: false, actions: 0, failures: [], errors, trace: [], counts: {} });

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    const top = document.elementFromPoint(cx, cy);
    return !!top && (top === el || el.contains(top) || top.contains(el));
  };
  const label = (el) => (el.dataset && (el.dataset.tab || el.dataset.area)) || (el.className && String(el.className).split(" ")[0]) || el.tagName;
  // 外部遷移・破壊的操作になり得るものは触らない
  const SAFE_SKIP = /export|import|書き出|読み込|共有|share|削除|リセット|clear/i;

  const candidates = () => {
    const sel = [
      ".tab-btn", ".map-area-tab", ".toggle-btn", ".myroute-nav", ".leaflet-marker-icon",
      ".modal-close", ".map-search-row", ".btn", ".day-tab", ".chip", "button", "summary",
    ].join(",");
    return [...document.querySelectorAll(sel)].filter((el) => {
      if (el.closest("a") || el.tagName === "A") return false;
      if (el.tagName === "BUTTON" && SAFE_SKIP.test(el.textContent || "")) return false;
      if (el.classList.contains("leaflet-marker-icon") && !el.textContent.trim()) return false;
      return visible(el);
    });
  };

  const markersInside = () => {
    const m = document.querySelector("#map-view");
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return [...document.querySelectorAll(".leaflet-marker-icon")]
      .filter((e) => e.textContent.trim())
      .filter((e) => { const b = e.getBoundingClientRect(); return b.left >= r.left && b.right <= r.right && b.top >= r.top && b.bottom <= r.bottom; })
      .map((e) => e.textContent.trim());
  };

  const check = (last) => {
    const fails = [];
    const modalOpen = !!document.querySelector(".modal-backdrop, .modal-sheet");
    const app = document.getElementById("app");
    if (document.documentElement.scrollWidth > innerWidth + 1) fails.push(`横スクロール発生 scrollW=${document.documentElement.scrollWidth} innerW=${innerWidth}`);
    if (app.classList.contains("screen-map")) {
      const mv = document.querySelector("#map-view");
      const tb = document.getElementById("tabbar").getBoundingClientRect();
      if (!mv) fails.push("screen-mapなのに#map-viewが無い");
      else {
        const r = mv.getBoundingClientRect();
        if (document.documentElement.scrollHeight > innerHeight + 1) fails.push(`地図タブでページが縦に伸びている docH=${document.documentElement.scrollHeight} innerH=${innerHeight}`);
        if (r.height < 199) fails.push(`地図が小さすぎる h=${Math.round(r.height)}`);
        if (r.bottom > tb.top + 1) fails.push(`地図がタブバーに被る mapBottom=${Math.round(r.bottom)} tabTop=${Math.round(tb.top)}`);
        const lc = mv.querySelector(".leaflet-container") || (mv.classList.contains("leaflet-container") ? mv : null);
        if (lc && Math.abs(lc.getBoundingClientRect().height - r.height) > 4) fails.push(`Leaflet高さと枠がズレ lc=${Math.round(lc.getBoundingClientRect().height)} frame=${Math.round(r.height)}`);
      }
      // エリアタブを直前に押した場合は、そのエリアが表示されているはず
      if (last && last.kind === "area" && !modalOpen) {
        const ins = markersInside() || [];
        const active = document.querySelector(".map-area-tab.active")?.dataset.area;
        if (active !== last.area) fails.push(`タブのactive(${active})が押したエリア(${last.area})と違う`);
        if (last.area === "ryogoku" && !(ins.length === 1 && ins[0] === "25")) fails.push(`両国駅なのに表示中=${ins.length}:${ins.slice(0, 6).join(",")}`);
        if (last.area === "kinshicho" && !(ins.length >= 20 && !ins.every((x) => x === "25"))) fails.push(`錦糸町なのに表示中=${ins.length}:${ins.slice(0, 6).join(",")}`);
      }
    }
    return fails;
  };

  (async () => {
    const t0 = performance.now();
    let last = null;
    while (performance.now() - t0 < DURATION_MS) {
      const r = rnd();
      let act = null;
      if (r < 0.06) {
        // 検索欄に入力
        const inp = document.querySelector(".map-search-wrap .search-input, .search-input");
        if (inp && visible(inp)) {
          const txt = pick(["1", "錦", "両国", "ステージ", "", "ホール", "25"]);
          inp.focus(); inp.value = txt; inp.dispatchEvent(new Event("input", { bubbles: true }));
          act = { kind: "type", desc: `type "${txt}"` };
        }
      } else if (r < 0.12) {
        const y = Math.floor(rnd() * 600);
        window.scrollTo(0, y);
        act = { kind: "scroll", desc: `scrollTo ${y}` };
      } else if (r < 0.15) {
        document.dispatchEvent(new Event("visibilitychange"));
        act = { kind: "visibility", desc: "visibilitychange" };
      } else {
        const c = candidates();
        if (c.length) {
          // 状態依存の不具合が出やすい操作（エリア切替・マイルート・カード送り・モーダルを閉じる）を優先して引く
          const prio = c.filter((e) => /map-area-tab|toggle-btn|myroute-nav|modal-close|tab-btn/.test(e.className));
          const el = prio.length && rnd() < 0.6 ? pick(prio) : pick(c);
          const area = el.classList.contains("map-area-tab") ? el.dataset.area : null;
          act = { kind: area ? "area" : "click", area, desc: `click ${label(el)} "${(el.textContent || "").trim().slice(0, 14)}"` };
          el.click();
        }
      }
      if (!act) { await sleep(100); continue; }
      M.actions++;
      M.counts[act.kind] = (M.counts[act.kind] || 0) + 1;
      M.trace.push(act.desc);
      if (M.trace.length > 25) M.trace.shift();
      last = act;
      await sleep(act.kind === "area" ? 900 : 350);
      const f = check(act);
      if (f.length) {
        M.failures.push({ at: Math.round(performance.now() - t0), tab: document.querySelector(".tab-btn.active")?.dataset.tab, mode: !!document.querySelector(".myroute-banner"), fails: f, trace: M.trace.slice(-8) });
        if (M.failures.length >= 15) break;
      }
    }
    M.done = true; M.elapsed = Math.round(performance.now() - t0);
  })();
  return "started";
})()

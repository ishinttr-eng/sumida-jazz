import * as store from "./store.js";
import {
  DAYS,
  DAY_LABELS,
  el,
  normalize,
  perfKey,
  fmtRange,
  todayStr,
  nowMin,
  toMin,
  minToHHMM,
  estimateWalkMin,
  isVenueFinished,
  isFestivalOver,
  debounce,
} from "./util.js";

const $main = document.getElementById("main");
const $modalRoot = document.getElementById("modal-root");

let activeTab = "now";
const ui = {
  artistsDay: "all",
  artistsSearch: "",
  artistsVenue: "",
  artistsGenre: "",
  mapMode: "normal", // normal | myroute
  mapSearch: "",
  myttMode: "list", // list | schedule
};
const finishedOpen = { now: new Set(), artists: new Set(), mytt: new Set() };
const venueCollapseOpen = new Set();

const mapState = {
  instance: null,
  center: null,
  zoom: null,
  layer: null,
  geoMarker: null,
  singleRoute: null,
  myRouteSegInfo: null,
  myRouteApplyHighlight: null,
  myRouteFocusMap: null,
  selectedVenueId: null,
};

// 選択中の会場ピンの色を即座に反映する（地図タブを表示中なら再描画、そうでなければ何もしない）
function refreshMapMarkers() {
  if (mapState.instance) {
    const { date, min } = curDateMin();
    drawMapLayer(date, min);
  }
}
let weatherData = null;
let geoWatchStarted = false;
let myRouteIndex = 0; // マイルートでフォーカス中の区間（カードのスワイプで移動）
const ROUTE_COLORS = ["#ff2f92", "#3ddc84", "#3f7dff", "#ffb703", "#a78bfa", "#f97316", "#22d3ee", "#f43f5e"];
const MYROUTE_CARD_H = 56; // 1カード分の高さ(px)。スワイプの1コマ分＝この高さ

// ---------- time / geo helpers ----------
function effectiveNow() {
  if (store.state.settings.simTime) return new Date(store.state.settings.simTime);
  return new Date();
}
function effectiveGeo() {
  if (store.state.settings.simGeo) return store.state.settings.simGeo;
  return store.state.currentGeo;
}
function curDateMin() {
  const d = effectiveNow();
  return { date: todayStr(d), min: nowMin(d) };
}

function isNowPlaying(p, date, min) {
  return p.date === date && p.startMin <= min && min < p.endMin;
}
function isSoon(p, date, min) {
  return p.date === date && p.startMin > min && p.startMin <= min + 30;
}

// ---------- generic render ----------
function render() {
  applyTabVisibility();
  $main.innerHTML = "";
  const { date, min } = curDateMin();
  const over = isFestivalOver(date, min);

  if (over && (activeTab === "artists" || activeTab === "map")) activeTab = "now";

  if (activeTab === "now") renderNow($main, date, min, over);
  else if (activeTab === "artists") renderArtists($main, date, min);
  else if (activeTab === "map") renderMap($main, date, min);
  else if (activeTab === "mytt") renderMyTT($main, date, min, over);

  syncTabButtons();
}

function applyTabVisibility() {
  const { date, min } = curDateMin();
  const over = isFestivalOver(date, min);
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const t = btn.dataset.tab;
    const hide = over && (t === "artists" || t === "map");
    btn.hidden = hide;
  });
}
function syncTabButtons() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === activeTab);
  });
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    render();
  });
});

// ---------- weather badge ----------
function weatherBadgeFor(dateStr, startMin) {
  if (!weatherData) return null;
  const hour = Math.floor(startMin / 60);
  const key = `${dateStr}T${String(hour).padStart(2, "0")}:00`;
  const w = weatherData[key];
  if (!w) return null;
  return el("span", { class: "badge weather" }, `${store.weatherIcon(w.code)} ${Math.round(w.temp)}° ${w.pop}%`);
}

// ---------- performance card ----------
function perfCard(p, { date, min, showVenue = true, showDate = false } = {}) {
  const venue = store.venueById(p.venueId);
  const playing = isNowPlaying(p, date, min);
  const soon = isSoon(p, date, min);
  const card = el("div", {
    class: `perf-card${playing ? " now" : ""}${soon ? " soon" : ""}`,
    onclick: () => openDetailModal(p),
  });
  const timeCol = el("div", { class: "time" }, [
    document.createTextNode(fmtRange(p.start, p.end)),
    showDate ? el("div", {}, DAY_LABELS[p.date] || p.date) : null,
  ]);
  const body = el("div", { class: "body" });
  body.appendChild(el("div", { class: "name" }, p.name));
  if (showVenue && venue) body.appendChild(el("div", { class: "venue-name" }, `${venue.stageNo}. ${venue.name}`));

  const badges = el("div", { class: "badges" });
  if (playing) badges.appendChild(el("span", { class: "badge ok" }, "● 演奏中"));
  else if (soon) badges.appendChild(el("span", { class: "badge" }, "まもなく開始"));

  const geo = effectiveGeo();
  if (geo && venue && (playing || soon)) {
    const walk = estimateWalk(geo, venue);
    const remain = p.startMin - min;
    const ok = playing || walk <= Math.max(remain, 0);
    badges.appendChild(
      el("span", { class: `badge ${ok ? "ok" : "ng"}` }, `🚶 徒歩${walk}分 ${ok ? "間に合う" : "間に合わない"}`)
    );
  }
  const wb = weatherBadgeFor(p.date, p.startMin);
  if (wb) badges.appendChild(wb);
  if (badges.children.length) body.appendChild(badges);

  const favBtn = el(
    "button",
    {
      class: `fav-btn${store.isFavorite(p) ? " active" : ""}`,
      "aria-label": "お気に入り",
      onclick: (e) => {
        e.stopPropagation();
        store.toggleFavorite(p);
        render();
      },
    },
    store.isFavorite(p) ? "★" : "☆"
  );

  card.append(timeCol, body, favBtn);
  return card;
}

function estimateWalk(geo, venue) {
  return estimateWalkMin(geo.lat, geo.lng, venue.lat, venue.lng);
}

// 現在地取得の導線。未取得時はボタンを、取得済み/シミュレーション中は状態テキストを表示する
function locationRow() {
  if (store.state.settings.simGeo) {
    return el(
      "div",
      { class: "loc-row" },
      el("span", { class: "sub-note" }, "📍 現在地シミュレーション中（⚙️設定で変更できます）")
    );
  }
  if (store.state.currentGeo) {
    return el(
      "div",
      { class: "loc-row" },
      el("span", { class: "sub-note" }, "📍 現在地取得済み（徒歩時間は直線距離からの目安）")
    );
  }
  const btn = el(
    "button",
    {
      class: "btn small",
      onclick: async (e) => {
        e.target.textContent = "取得中…";
        try {
          await locateOnce();
        } catch {
          e.target.textContent = "現在地を取得できませんでした（再試行）";
        }
      },
    },
    "📍 現在地を取得して徒歩時間を表示"
  );
  return el("div", { class: "loc-row" }, btn);
}

function finishedDetails(key, label, content) {
  const d = el("details", { class: "finished-group" });
  d.open = finishedOpen[key.screen].has(key.id);
  d.addEventListener("toggle", () => {
    if (d.open) finishedOpen[key.screen].add(key.id);
    else finishedOpen[key.screen].delete(key.id);
  });
  d.appendChild(el("summary", {}, label));
  d.appendChild(content);
  return d;
}

// ---------- Tab: 演奏中 ----------
function renderNow(root, date, min, over) {
  if (over) {
    root.appendChild(overPanel());
    return;
  }
  root.appendChild(el("h1", { class: "screen-title" }, "🎺 演奏中"));
  if (store.state.settings.simTime) {
    root.appendChild(el("div", { class: "sub-note" }, `⏱ 時刻シミュレーション中: ${DAY_LABELS[date] || date} ${minToHHMM(min)}`));
  }
  root.appendChild(locationRow());

  const playing = store.state.performances.filter((p) => isNowPlaying(p, date, min));
  const soon = store.state.performances.filter((p) => isSoon(p, date, min));

  if (!playing.length && !soon.length) {
    root.appendChild(
      el("div", { class: "empty-state" }, [
        el("span", { class: "emoji" }, "🎷"),
        el("div", {}, "今演奏中のステージはありません"),
      ])
    );
  } else {
    if (playing.length) {
      root.appendChild(el("h3", {}, "演奏中"));
      playing
        .sort((a, b) => a.startMin - b.startMin)
        .forEach((p) => root.appendChild(perfCard(p, { date, min })));
    }
    if (soon.length) {
      root.appendChild(el("h3", {}, "まもなく開始（30分以内）"));
      soon
        .sort((a, b) => a.startMin - b.startMin)
        .forEach((p) => root.appendChild(perfCard(p, { date, min })));
    }
  }

  const finishedVenues = store.state.venues.filter((v) => isVenueFinished(store.state.performances, v.id, date, date, min));
  if (finishedVenues.length) {
    const list = el("div", {});
    finishedVenues.forEach((v) =>
      list.appendChild(
        el(
          "button",
          { class: "link-btn", style: "display:block;padding:6px 0", onclick: () => openVenueModal(v.id, date) },
          `${v.stageNo}. ${v.name}`
        )
      )
    );
    root.appendChild(finishedDetails({ screen: "now", id: "fin" }, `🏁 終了したステージ（${finishedVenues.length}）`, list));
  }
}

function overPanel() {
  const panel = el("div", { class: "over-panel" });
  panel.append(
    el("div", { class: "emoji" }, "🎉"),
    el("h2", {}, "すみだジャズフェスティバル2026、終了しました"),
    el("p", {}, "ご来場ありがとうございました。マイタイムテーブルは引き続きご覧いただけます。")
  );
  return panel;
}

// ---------- Tab: 出演者 ----------
function renderArtists(root, date, min) {
  root.appendChild(el("h1", { class: "screen-title" }, "📅 出演者"));

  const dayTabs = el("div", { class: "day-tabs" });
  const mkDayTab = (val, label) =>
    el(
      "button",
      {
        class: `day-tab${ui.artistsDay === val ? " active" : ""}`,
        onclick: () => {
          ui.artistsDay = val;
          render();
        },
      },
      label
    );
  dayTabs.append(mkDayTab("all", "すべて"), ...DAYS.map((d) => mkDayTab(d, DAY_LABELS[d])));
  root.appendChild(dayTabs);

  const listContainer = el("div", {});

  const filterRow = el("div", { class: "filter-row" });
  const searchInput = el("input", {
    class: "search-input",
    type: "search",
    placeholder: "出演者名・かなで検索",
    value: ui.artistsSearch,
    oninput: debounce((e) => {
      // ここでfull render()すると<input>ごと作り直されてしまい、入力中にフォーカスが
      // 外れる（1文字打つたびに再フォーカスが必要になる）ため、リスト部分だけ更新する
      ui.artistsSearch = e.target.value;
      renderArtistsList(listContainer, date, min);
    }, 200),
  });
  const venueSelect = el("select", {
    class: "filter-select",
    onchange: (e) => {
      ui.artistsVenue = e.target.value;
      render();
    },
  });
  venueSelect.appendChild(el("option", { value: "" }, "会場: すべて"));
  store.state.venues.forEach((v) => {
    venueSelect.appendChild(el("option", { value: v.id, selected: ui.artistsVenue === v.id || undefined }, `${v.stageNo}. ${v.name}`));
  });

  const genres = [...new Set(store.state.performances.map((p) => p.genre).filter(Boolean))].sort();
  const genreSelect = el("select", {
    class: "filter-select",
    onchange: (e) => {
      ui.artistsGenre = e.target.value;
      render();
    },
  });
  genreSelect.appendChild(el("option", { value: "" }, "ジャンル: すべて"));
  genres.forEach((g) => genreSelect.appendChild(el("option", { value: g, selected: ui.artistsGenre === g || undefined }, g)));

  filterRow.append(searchInput, venueSelect);
  if (genres.length) filterRow.append(genreSelect);
  root.appendChild(filterRow);

  root.appendChild(listContainer);
  renderArtistsList(listContainer, date, min);
}

function renderArtistsList(container, date, min) {
  container.innerHTML = "";

  const q = normalize(ui.artistsSearch);
  let list = store.state.performances.filter((p) => {
    if (ui.artistsDay !== "all" && p.date !== ui.artistsDay) return false;
    if (ui.artistsVenue && p.venueId !== ui.artistsVenue) return false;
    if (ui.artistsGenre && p.genre !== ui.artistsGenre) return false;
    if (q && !normalize(p.name).includes(q) && !normalize(p.kana).includes(q) && !normalize(p.awardEntry).includes(q)) return false;
    return true;
  });

  if (!list.length) {
    container.appendChild(el("div", { class: "empty-state" }, [el("span", { class: "emoji" }, "🔍"), el("div", {}, "該当する出演者が見つかりません")]));
    return;
  }

  const byVenue = new Map();
  list.forEach((p) => {
    if (!byVenue.has(p.venueId)) byVenue.set(p.venueId, []);
    byVenue.get(p.venueId).push(p);
  });

  const venuesOrdered = store.state.venues.filter((v) => byVenue.has(v.id));
  const activeVenues = [];
  const finishedVenues = [];
  venuesOrdered.forEach((v) => {
    const finished = ui.artistsDay !== "all" && isVenueFinished(store.state.performances, v.id, ui.artistsDay, date, min);
    (finished ? finishedVenues : activeVenues).push(v);
  });

  const renderVenueGroup = (v) => {
    const group = el("div", { class: "venue-group" });
    group.appendChild(el("div", { class: "venue-group-head" }, [el("span", { class: "stageno" }, `#${v.stageNo}`), v.name]));
    byVenue
      .get(v.id)
      .sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date.localeCompare(b.date)))
      .forEach((p) => group.appendChild(perfCard(p, { date, min, showVenue: false, showDate: ui.artistsDay === "all" })));
    return group;
  };

  activeVenues.forEach((v) => container.appendChild(renderVenueGroup(v)));

  if (finishedVenues.length) {
    const wrap = el("div", {});
    finishedVenues.forEach((v) => wrap.appendChild(renderVenueGroup(v)));
    container.appendChild(finishedDetails({ screen: "artists", id: "fin" }, `🏁 終了したステージ（${finishedVenues.length}）`, wrap));
  }
}

// ---------- detail modal ----------
function openDetailModal(p) {
  const venue = store.venueById(p.venueId);
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) close(); } });
  const sheet = el("div", { class: "modal-sheet" });
  const close = () => backdrop.remove();

  sheet.appendChild(el("button", { class: "modal-close", onclick: close, "aria-label": "閉じる" }, "✕"));
  sheet.appendChild(el("div", { class: "modal-title" }, p.name));
  sheet.appendChild(
    el("div", { class: "modal-meta" }, [
      document.createTextNode(`${DAY_LABELS[p.date] || p.date} ${fmtRange(p.start, p.end)} / `),
      venue
        ? el(
            "button",
            { class: "link-btn", onclick: () => { close(); openVenueModal(venue.id, p.date); } },
            `${venue.stageNo}. ${venue.name}`
          )
        : null,
    ])
  );
  if (p.genre || p.region) {
    const tags = el("div", { class: "badges" });
    if (p.genre) tags.appendChild(el("span", { class: "badge" }, p.genre));
    if (p.region) tags.appendChild(el("span", { class: "badge" }, p.region));
    if (p.isU25) tags.appendChild(el("span", { class: "badge" }, "U-25"));
    if (p.awardEntry) tags.appendChild(el("span", { class: "badge" }, p.awardEntry));
    sheet.appendChild(tags);
  }
  if (p.intro) {
    const s = el("div", { class: "modal-section" });
    s.appendChild(el("h4", {}, "紹介"));
    s.appendChild(el("p", {}, p.intro));
    sheet.appendChild(s);
  }

  const favSection = el("div", { class: "modal-section" });
  favSection.appendChild(
    el(
      "button",
      {
        class: `btn ${store.isFavorite(p) ? "primary" : ""} block`,
        onclick: () => {
          store.toggleFavorite(p);
          render();
          close();
          openDetailModal(p);
        },
      },
      store.isFavorite(p) ? "★ お気に入り登録済み" : "☆ お気に入りに追加"
    )
  );
  sheet.appendChild(favSection);

  if (venue) {
    const mapBtn = el(
      "button",
      { class: "btn block", style: "margin-top:6px" },
      "🗺️ マップで見る"
    );
    mapBtn.addEventListener("click", () => {
      close();
      activeTab = "map";
      mapState.selectedVenueId = venue.id;
      render();
      focusMapOnVenue(venue);
    });
    sheet.appendChild(mapBtn);
  }

  backdrop.appendChild(sheet);
  $modalRoot.appendChild(backdrop);
}

// ---------- 会場詳細モーダル ----------
function openVenueModal(venueId, day) {
  const venue = store.venueById(venueId);
  if (!venue) return;
  const state = { day: day && venue.days.includes(day) ? day : venue.days[0] || DAYS[0], from: "here" };

  // モーダルは画面全体を覆うので、選択中の色は裏の地図には見えない。閉じて地図に戻ったときに
  // 「さっき見ていた会場」だと分かるよう、選択状態は閉じても解除せずそのまま残す
  mapState.selectedVenueId = venue.id;
  refreshMapMarkers();

  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) close(); } });
  const sheet = el("div", { class: "modal-sheet" });
  const close = () => backdrop.remove();

  function redraw() {
    sheet.innerHTML = "";
    sheet.appendChild(el("button", { class: "modal-close", onclick: close, "aria-label": "閉じる" }, "✕"));
    sheet.appendChild(el("div", { class: "modal-title" }, `${venue.stageNo}. ${venue.name}`));

    const dayTabs = el("div", { class: "day-tabs" });
    DAYS.forEach((d) => {
      const open = venue.days.includes(d);
      dayTabs.appendChild(
        el(
          "button",
          {
            class: `day-tab${state.day === d ? " active" : ""}`,
            style: open ? "" : "opacity:.4;cursor:default",
            onclick: () => { if (open) { state.day = d; redraw(); } },
          },
          DAY_LABELS[d] + (open ? "" : "（開催なし）")
        )
      );
    });
    sheet.appendChild(dayTabs);

    const fromRow = el("div", { class: "modal-section", style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" });
    const fromSelect = el("select", {
      class: "filter-select",
      onchange: (e) => { state.from = e.target.value; redraw(); },
    });
    fromSelect.appendChild(el("option", { value: "here" }, "現在地から"));
    store.state.venues
      .filter((v) => v.id !== venue.id)
      .forEach((v) => {
        fromSelect.appendChild(
          el("option", { value: v.id, selected: state.from === v.id || undefined }, `${v.stageNo}. ${v.name}`)
        );
      });
    fromSelect.value = state.from;

    let walkText;
    let fromLat = null;
    let fromLng = null;
    if (state.from === "here") {
      const geo = effectiveGeo();
      if (geo) {
        fromLat = geo.lat;
        fromLng = geo.lng;
        walkText = `🚶 徒歩 約${estimateWalk(geo, venue)}分`;
      } else {
        walkText = "（現在地未取得）";
      }
    } else {
      const fromVenue = store.venueById(state.from);
      fromLat = fromVenue.lat;
      fromLng = fromVenue.lng;
      const walk = store.walkMinutes(state.from, venue.id);
      const mins = walk != null ? walk : estimateWalkMin(fromVenue.lat, fromVenue.lng, venue.lat, venue.lng);
      walkText = `🚶 徒歩 約${mins}分`;
    }
    fromRow.append(fromSelect, el("span", { class: "sub-note", style: "margin:0" }, walkText));
    sheet.appendChild(fromRow);

    const btnRow = el("div", { class: "btn-row" });
    btnRow.appendChild(
      el(
        "button",
        {
          class: "btn",
          onclick: () => {
            close();
            activeTab = "map";
            ui.mapMode = "normal";
            mapState.singleRoute = { fromId: state.from === "here" ? null : state.from, toId: venue.id };
            render();
          },
        },
        "🗺 地図で見る"
      )
    );
    const gmaps =
      fromLat != null
        ? `https://www.google.com/maps/dir/?api=1&origin=${fromLat},${fromLng}&destination=${venue.lat},${venue.lng}&travelmode=walking`
        : `https://www.google.com/maps/dir/?api=1&destination=${venue.lat},${venue.lng}&travelmode=walking`;
    btnRow.appendChild(el("a", { class: "btn", href: gmaps, target: "_blank", rel: "noopener" }, "ここへ行く"));
    sheet.appendChild(btnRow);

    const list = el("div", { class: "modal-section" });
    const ps = store.state.performances
      .filter((p) => p.date === state.day && p.venueId === venue.id)
      .sort((a, b) => a.startMin - b.startMin);
    if (ps.length) {
      const { date: curDate, min: curMin } = curDateMin();
      ps.forEach((p) => list.appendChild(perfCard(p, { date: curDate, min: curMin, showVenue: false })));
    } else {
      list.appendChild(el("p", { style: "color:var(--muted)" }, "この日の演奏はありません"));
    }
    sheet.appendChild(list);
  }

  redraw();
  backdrop.appendChild(sheet);
  $modalRoot.appendChild(backdrop);
}

// ---------- Tab: マップ ----------
function renderMap(root, date, min) {
  root.appendChild(el("h1", { class: "screen-title" }, "🗺️ マップ"));

  const toolbar = el("div", { class: "map-toolbar" });
  const searchWrap = el("div", { class: "map-search-wrap" });
  const resultsBox = el("div", { class: "map-search-results" });
  const searchInput = el("input", {
    class: "search-input",
    type: "search",
    placeholder: "ステージ番号・会場名で検索",
    value: ui.mapSearch,
    oninput: (e) => {
      ui.mapSearch = e.target.value;
      renderMapSearchResults(resultsBox, ui.mapSearch);
    },
    onkeydown: (e) => {
      if (e.key === "Escape") {
        e.target.value = "";
        ui.mapSearch = "";
        resultsBox.replaceChildren();
      }
    },
  });
  searchWrap.append(searchInput, resultsBox);
  if (ui.mapSearch) renderMapSearchResults(resultsBox, ui.mapSearch);
  toolbar.appendChild(searchWrap);
  toolbar.appendChild(
    el(
      "button",
      {
        class: `toggle-btn${ui.mapMode === "myroute" ? " active" : ""}`,
        onclick: () => {
          ui.mapMode = ui.mapMode === "myroute" ? "normal" : "myroute";
          mapState.singleRoute = null;
          render();
        },
      },
      "🎟️ マイルート"
    )
  );
  root.appendChild(toolbar);

  if (mapState.singleRoute) renderRouteBanner(root);
  else if (ui.mapMode === "myroute") renderMyRouteBanner(root, date, min);

  const mapDiv = el("div", { id: "map-view" });
  root.appendChild(mapDiv);

  ensureMapResizeListener();
  requestAnimationFrame(() => {
    fitMapHeight(mapDiv);
    initOrUpdateMap(mapDiv, date, min);
  });
}

// マップの高さはCSSの固定計算値(calc(100vh - Npx))だと、マイルートの区間パネルのように
// ツールバーとマップの間に高さが可変なバナーが挟まるケースを想定できず、
// マップの下端が固定タブバーの下に潜り込んだり、逆に検索エリアが画面外に押し出されたりする。
// そのため実際にDOMへ配置された後の残り高さを毎回測って明示的にセットする。
function fitMapHeight(mapDiv) {
  const top = mapDiv.getBoundingClientRect().top;
  const tabbar = document.getElementById("tabbar");
  const tabbarH = tabbar ? tabbar.getBoundingClientRect().height : 0;
  const available = window.innerHeight - top - tabbarH - 12;
  // 極端に縦が狭い画面（横向き等）では280pxだと逆にタブバーへ食い込むため、
  // 最低保証は控えめにして「タブバーに被らない」を優先する
  mapDiv.style.height = `${Math.max(200, Math.round(available))}px`;
  mapState.instance?.invalidateSize();
}

let mapResizeBound = false;
function ensureMapResizeListener() {
  if (mapResizeBound) return;
  mapResizeBound = true;
  window.addEventListener("resize", () => {
    const mapDiv = document.getElementById("map-view");
    if (mapDiv) fitMapHeight(mapDiv);
  });
}

// 会場詳細モーダルから「地図で見る」で指定された、現在地または特定会場→会場の単一区間ルート
function singleRouteInfo(spec) {
  const to = store.venueById(spec.toId);
  if (!to) return null;
  const from = spec.fromId ? store.venueById(spec.fromId) : effectiveGeo();
  if (!from) return { to, from: null };
  let walkMin = null;
  let hasRoute = false;
  let latlngs = [[from.lat, from.lng], [to.lat, to.lng]];
  if (spec.fromId) {
    const route = store.routeBetween(spec.fromId, spec.toId);
    if (route && route.poly) {
      latlngs = decodePolyline(route.poly);
      walkMin = route.durMin;
      hasRoute = true;
    } else {
      walkMin = store.walkMinutes(spec.fromId, spec.toId);
    }
  }
  if (walkMin == null) walkMin = estimateWalkMin(from.lat, from.lng, to.lat, to.lng);
  return { to, from, walkMin, hasRoute, latlngs };
}

function drawSingleRoute(layer, spec) {
  const info = singleRouteInfo(spec);
  if (!info || !info.from) return;
  L.polyline(info.latlngs, { color: "#ffffff", weight: 8, opacity: 0.9, lineCap: "round" }).addTo(layer);
  L.polyline(info.latlngs, { color: "#ff2f92", weight: 4, opacity: 1, lineCap: "round" }).addTo(layer);
  L.circleMarker([info.from.lat, info.from.lng], { radius: 8, color: "#fff", weight: 3, fillColor: "#ff2f92", fillOpacity: 1 }).addTo(layer);
  const mid = info.latlngs[Math.floor(info.latlngs.length / 2)];
  L.marker(mid, { icon: walkTimeIcon(info.walkMin, "#ff2f92"), interactive: false, zIndexOffset: 1200 }).addTo(layer);
  mapState.instance.fitBounds(L.latLngBounds(info.latlngs), { padding: [56, 56] });
}

function renderRouteBanner(root) {
  const spec = mapState.singleRoute;
  if (!spec) return;
  const info = singleRouteInfo(spec);
  const toLabel = info?.to ? `${info.to.stageNo}. ${info.to.name}` : "";
  const fromVenue = spec.fromId ? store.venueById(spec.fromId) : null;
  const fromLabel = spec.fromId ? (fromVenue ? `${fromVenue.stageNo}. ${fromVenue.name}` : "") : "現在地";

  const banner = el("div", { class: "route-banner" });
  banner.appendChild(
    el("div", { class: "route-banner-head" }, [
      el("div", { class: "route-banner-title" }, `${fromLabel} → ${toLabel}`),
      el(
        "button",
        { class: "modal-close", style: "position:static", onclick: () => { mapState.singleRoute = null; render(); } },
        "✕"
      ),
    ])
  );
  let subText;
  if (!info || !info.from) subText = "現在地が未取得です（マップ左上の📍ボタンで取得できます）";
  else if (info.hasRoute) subText = `🚶 徒歩約${info.walkMin}分`;
  else subText = `📏 直線距離からの概算 徒歩約${info.walkMin}分（実測ルート未取得）`;
  banner.appendChild(el("div", { class: "sub-note", style: "margin:0" }, subText));
  if (info && info.from) {
    const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${info.from.lat},${info.from.lng}&destination=${info.to.lat},${info.to.lng}&travelmode=walking`;
    banner.appendChild(el("a", { class: "btn small", href: gmaps, target: "_blank", rel: "noopener" }, "Googleマップで開く"));
  }
  root.appendChild(banner);
}

// ステージ番号または会場名でマップ上の会場を検索し、候補をリスト表示する
function renderMapSearchResults(resultsBox, query) {
  const nq = normalize(query);
  if (!nq) {
    resultsBox.replaceChildren();
    return;
  }
  const matches = store.state.venues
    .filter((v) => String(v.stageNo).includes(nq) || normalize(v.name).includes(nq))
    .slice(0, 8);
  resultsBox.replaceChildren(
    ...(matches.length
      ? matches.map((v) =>
          el(
            "button",
            { class: "map-search-row", onclick: () => selectMapSearchResult(v) },
            `${v.stageNo}. ${v.name}`
          )
        )
      : [el("div", { class: "map-search-empty" }, "該当する会場がありません")])
  );
}

// 検索結果タップ: その会場にズームし、ピンをハイライトして検索欄・候補は閉じる
function selectMapSearchResult(v) {
  mapState.selectedVenueId = v.id;
  focusMapOnVenue(v);
  refreshMapMarkers();
  ui.mapSearch = "";
  const wrap = document.querySelector(".map-search-wrap");
  const input = wrap?.querySelector(".search-input");
  if (input) input.value = "";
  wrap?.querySelector(".map-search-results")?.replaceChildren();
}

function focusMapOnVenue(venue) {
  // mapState.center/zoomも更新しておく。タブ切替直後はrequestAnimationFrame内で
  // initOrUpdateMap()がこの値を使って再度setViewするため、ここを更新しないと
  // 下記のsetViewがその後の再アタッチ処理で上書きされて元の表示位置に戻ってしまう
  mapState.center = L.latLng(venue.lat, venue.lng);
  mapState.zoom = 18;
  if (mapState.instance) {
    mapState.instance.setView([venue.lat, venue.lng], 18, { animate: true });
  }
}

function pinDivIcon(label, color, offset) {
  const style = offset
    ? `transform:translate(${offset[0]}px,${offset[1]}px);`
    : "";
  return L.divIcon({
    className: "",
    html: `<div class="pin-tieup" style="${style}background:${color};color:#14131a;font-weight:700;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:11px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)">${label}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13 + (offset ? -offset[1] : 0)],
  });
}

// 会場マーカー: ステージ番号を常時表示する円形ピン（下向きの吹き出し尻尾付き）
function venueDivIcon(stageNo, color, finished) {
  const size = stageNo >= 10 ? 34 : 30;
  const opacity = finished ? 0.42 : 1;
  const tail = 8;
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:${size}px;height:${size + tail}px;opacity:${opacity}">
      <div style="position:absolute;top:0;left:0;width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2.5px solid #14131a;box-shadow:0 2px 6px rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;color:#14131a;font-weight:800;font-size:13px;line-height:1;font-family:'IBM Plex Mono',ui-monospace,monospace">${stageNo}</div>
      <div style="position:absolute;top:${size - 3}px;left:${size / 2 - tail / 2}px;width:0;height:0;border-left:${tail / 2}px solid transparent;border-right:${tail / 2}px solid transparent;border-top:${tail}px solid #14131a"></div>
    </div>`,
    iconSize: [size, size + tail],
    iconAnchor: [size / 2, size + tail],
    popupAnchor: [0, -(size + tail)],
  });
}

function decodePolyline(str, precision = 5) {
  let index = 0,
    lat = 0,
    lng = 0,
    coords = [];
  const factor = Math.pow(10, precision);
  while (index < str.length) {
    let result = 1,
      shift = 0,
      b;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

function initOrUpdateMap(mapDiv, date, min) {
  if (!window.L) return;
  if (!mapState.instance) {
    const map = L.map(mapDiv, { inertiaMaxSpeed: 1500 }).setView(
      mapState.center || [store.state.venues[0]?.lat || 35.697, store.state.venues[0]?.lng || 139.814],
      mapState.zoom || 15
    );
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    map.on("moveend", () => {
      mapState.center = map.getCenter();
      mapState.zoom = map.getZoom();
    });

    const locBtn = L.control({ position: "topleft" });
    locBtn.onAdd = () => {
      const b = L.DomUtil.create("button", "map-loc-btn");
      b.type = "button";
      b.textContent = "📍";
      b.title = "現在地を取得";
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, "click", async (e) => {
        L.DomEvent.stop(e);
        b.textContent = "…";
        try {
          const geo = await locateOnce();
          b.textContent = "📍";
          map.setView([geo.lat, geo.lng], 16);
        } catch {
          b.textContent = "❌";
          setTimeout(() => { b.textContent = "📍"; }, 1500);
        }
      });
      return b;
    };
    locBtn.addTo(map);

    mapState.instance = map;
  } else {
    // 別のdivへ再アタッチ（タブ切替でDOMが作り直されるため）
    mapDiv.appendChild(mapState.instance.getContainer());
    mapState.instance.invalidateSize();
    if (mapState.center) mapState.instance.setView(mapState.center, mapState.zoom);
  }
  drawMapLayer(date, min);
}

function drawMapLayer(date, min) {
  const map = mapState.instance;
  if (mapState.layer) {
    map.removeLayer(mapState.layer);
  }
  const layer = L.layerGroup().addTo(map);
  mapState.layer = layer;

  // 座標重複検出
  const coordCount = new Map();
  const keyOf = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`;
  store.state.venues.forEach((v) => coordCount.set(keyOf(v.lat, v.lng), (coordCount.get(keyOf(v.lat, v.lng)) || 0) + 1));
  const tieupOffsetSeen = new Map();

  store.state.venues.forEach((v) => {
    const finished = isVenueFinished(store.state.performances, v.id, null, date, min);
    const isSelected = mapState.selectedVenueId === v.id;
    const marker = L.marker([v.lat, v.lng], {
      icon: venueDivIcon(v.stageNo, isSelected ? "#ffb020" : "#39e0c9", finished),
      zIndexOffset: isSelected ? 500 : 0,
    }).addTo(layer);
    // ポップアップは挟まず、タップで直接その日の会場詳細（タイムテーブル）を開く
    marker.on("click", () => openVenueModal(v.id, date));
  });

  (store.state.tieup.stages || []).forEach((s) => {
    const key = keyOf(s.lat, s.lng);
    let offset = null;
    if (coordCount.get(key)) {
      const n = tieupOffsetSeen.get(key) || 0;
      tieupOffsetSeen.set(key, n + 1);
      offset = n === 0 ? [0, -22] : n % 2 === 1 ? [-18, -14] : [18, -14];
    }
    const marker = L.marker([s.lat, s.lng], { icon: pinDivIcon("T", "#e6a740", offset) }).addTo(layer);
    marker.bindPopup(`<b>${s.name}</b>${s.sponsor ? `<br>${s.sponsor}` : ""}${s.approx ? "<br><i>位置は近似</i>" : ""}`);
  });

  if (ui.mapMode === "myroute") {
    drawMyRoute(layer, date, min);
  }
  if (mapState.singleRoute) {
    drawSingleRoute(layer, mapState.singleRoute);
  }

  const geo = effectiveGeo();
  if (geo) {
    L.circleMarker([geo.lat, geo.lng], { radius: 9, color: "#fff", weight: 3, fillColor: "#3d8bff", fillOpacity: 1 })
      .addTo(layer)
      .bindPopup("現在地");
  }
}

// ルート線の始点・終点マーカー。始点=丸いリング、終点=雫形のピンで形から見分けられるようにする
function endpointIcon(kind, color) {
  return kind === "start"
    ? L.divIcon({
        className: "route-endpoint start",
        html: `<span style="--dot-color:${color}"></span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      })
    : L.divIcon({
        className: "route-endpoint end",
        html: `<span style="--dot-color:${color}"></span>`,
        iconSize: [20, 20],
        iconAnchor: [10, 19],
      });
}

// 経路線の中間地点に添える徒歩時間ラベル
function walkTimeIcon(minutes, color = "#0f9c8c") {
  return L.divIcon({
    className: "",
    html: `<div style="display:inline-block;width:max-content;background:${color};color:#14131a;font-weight:700;font-size:11px;font-family:'IBM Plex Mono',ui-monospace,monospace;padding:3px 8px;border-radius:20px;border:2px solid #14131a;box-shadow:0 2px 6px rgba(0,0,0,.5);white-space:nowrap;transform:translate(-50%,-50%)">🚶 ${minutes}分</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

// 現在時刻（シミュレーション込み）を基準に、マイタイムテーブルでまだ終了していない移動区間を
// すべて求める（直前の（終了済み最後の）お気に入り→次のお気に入り→その次…と連なる区間の配列）
function computeMyRouteSegments(date, min) {
  const favs = [...store.state.favorites]
    .map((key) => store.state.performances.find((p) => perfKey(p) === key))
    .filter((p) => p && p.date === date)
    .sort((a, b) => a.startMin - b.startMin);
  if (!favs.length) return { message: "本日のお気に入りが登録されていません" };

  const upcoming = favs.filter((p) => p.startMin > min);
  if (!upcoming.length) return { message: "本日のお気に入り予定はすべて終了しました" };

  const prevList = favs.filter((p) => p.startMin <= min);
  const prev = prevList.length ? prevList[prevList.length - 1] : null;

  const segments = [];
  let fromId = prev ? prev.venueId : null; // null = 最初の区間のみ「現在地から」
  upcoming.forEach((p) => {
    segments.push({ fromId, toId: p.venueId, toPerf: p });
    fromId = p.venueId;
  });
  return { segments };
}

// 区間ごとの座標・徒歩時間・ラベルをLeaflet非依存で計算する（地図描画・カード表示の両方から使う）
function myRouteSegmentDetails(segments) {
  return segments.map((seg) => {
    const to = store.venueById(seg.toId);
    let from = null;
    let coords = null;
    let hasRoute = false;
    let walkMin = null;
    if (seg.fromId) {
      from = store.venueById(seg.fromId);
      const route = store.routeBetween(seg.fromId, seg.toId);
      if (route && route.poly) {
        coords = decodePolyline(route.poly);
        walkMin = route.durMin;
        hasRoute = true;
      } else {
        coords = [[from.lat, from.lng], [to.lat, to.lng]];
        walkMin = store.walkMinutes(seg.fromId, seg.toId);
      }
    } else {
      from = effectiveGeo();
      if (from) coords = [[from.lat, from.lng], [to.lat, to.lng]];
    }
    if (walkMin == null && coords) {
      const last = coords[coords.length - 1];
      walkMin = estimateWalkMin(coords[0][0], coords[0][1], last[0], last[1]);
    }
    const fromLabel = seg.fromId ? (from ? `${from.stageNo}. ${from.name}` : "") : from ? "現在地" : "現在地（未取得）";
    let legText;
    if (!coords) legText = "現在地が未取得です";
    else if (hasRoute) legText = `🚶約${walkMin}分`;
    else legText = `📏約${walkMin}分（概算）`;
    return { seg, to, from, coords, hasRoute, walkMin, fromLabel, legText };
  });
}

// マイルートモード: 区間ごとに色分けして地図に描く。カルーセルのスクロールと連動できるよう、
// ハイライト適用・地図フォーカスの関数をmapStateに残しておく（フルre-renderせずに更新するため）
function drawMyRoute(layer, date, min) {
  const { segments } = computeMyRouteSegments(date, min);
  if (!segments || !segments.length) {
    mapState.myRouteSegInfo = null;
    mapState.myRouteApplyHighlight = null;
    mapState.myRouteFocusMap = null;
    return;
  }
  myRouteIndex = Math.max(0, Math.min(myRouteIndex, segments.length - 1));
  const details = myRouteSegmentDetails(segments);

  const segInfo = details.map((d, i) => {
    const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
    let halo = null;
    let line = null;
    let startMarker = null;
    let endMarker = null;
    let timeMarker = null;
    if (d.coords) {
      const dash = d.hasRoute ? null : "7 9";
      halo = L.polyline(d.coords, { color: "#ffffff", weight: 7, opacity: 0.85, dashArray: dash }).addTo(layer);
      line = L.polyline(d.coords, { color, weight: 4, opacity: 0.85, dashArray: dash }).addTo(layer);
      startMarker = L.marker(d.coords[0], { icon: endpointIcon("start", color), interactive: false, zIndexOffset: 1000 }).addTo(layer);
      endMarker = L.marker(d.coords[d.coords.length - 1], { icon: endpointIcon("end", color), interactive: false, zIndexOffset: 1000 }).addTo(layer);
      const mid = d.coords[Math.floor(d.coords.length / 2)];
      timeMarker = L.marker(mid, { icon: walkTimeIcon(d.walkMin, color), interactive: false, zIndexOffset: 1200, opacity: 0 }).addTo(layer);
    }
    return { ...d, halo, line, startMarker, endMarker, timeMarker };
  });

  // フォーカス中の区間だけ太く・不透明に、徒歩時間ラベルも付ける。他は細く・薄くして「今どの線か」を一目で分かるようにする
  const applyHighlight = (idx) => {
    segInfo.forEach((s, i) => {
      if (!s.line) return;
      const focused = i === idx;
      s.halo.setStyle({ weight: focused ? 9 : 7, opacity: focused ? 0.95 : 0.85 });
      s.line.setStyle({ weight: focused ? 5 : 4, opacity: focused ? 1 : 0.85 });
      s.startMarker.setOpacity(focused ? 1 : 0.6);
      s.endMarker.setOpacity(focused ? 1 : 0.6);
      s.timeMarker?.setOpacity(focused ? 1 : 0);
      if (focused) s.line.bringToFront();
    });
  };
  const focusMap = (idx) => {
    const s = segInfo[idx];
    if (s && s.line) mapState.instance.fitBounds(s.line.getBounds(), { padding: [56, 90] });
  };

  mapState.myRouteSegInfo = segInfo;
  mapState.myRouteApplyHighlight = applyHighlight;
  mapState.myRouteFocusMap = focusMap;
  applyHighlight(myRouteIndex);
  focusMap(myRouteIndex);
}

// マイルートのバナー: カードを上下スワイプ（スクロールスナップ）で1件ずつ切り替えると、
// 対応する地図上の線が連動してハイライトされる。スクロール中はフルre-renderせず
// mapState経由でLeafletの見た目だけ直接更新する（じゃないと毎スクロールで地図が作り直されてしまう）
function renderMyRouteBanner(root, date, min) {
  const { message, segments } = computeMyRouteSegments(date, min);
  if (message) {
    const banner = el("div", { class: "route-banner" });
    banner.appendChild(
      el("div", { class: "route-banner-head" }, [
        el("div", { class: "route-banner-title" }, "🎟️ マイルート"),
        el(
          "button",
          { class: "modal-close", style: "position:static", onclick: () => { ui.mapMode = "normal"; render(); } },
          "✕"
        ),
      ])
    );
    banner.appendChild(el("div", { class: "sub-note", style: "margin:0" }, message));
    root.appendChild(banner);
    return;
  }

  myRouteIndex = Math.max(0, Math.min(myRouteIndex, segments.length - 1));
  const details = myRouteSegmentDetails(segments);
  const counter = el("span", { class: "myroute-counter" }, `${myRouteIndex + 1} / ${segments.length}`);

  const cards = details.map((d) => {
    const gUrl = d.coords
      ? `https://www.google.com/maps/dir/?api=1&origin=${d.coords[0][0]},${d.coords[0][1]}&destination=${d.to.lat},${d.to.lng}&travelmode=walking`
      : null;
    return el("div", { class: "myroute-card" }, [
      el("div", { class: "myroute-main" }, [
        el("div", { class: "myroute-route" }, `${d.fromLabel} → ${d.to.stageNo}. ${d.to.name}`),
        el("div", { class: "myroute-sub" }, `${d.legText}　次: ${d.seg.toPerf.start} ${d.seg.toPerf.name}`),
      ]),
      gUrl ? el("a", { class: "myroute-g", href: gUrl, target: "_blank", rel: "noopener", title: "Googleで開く" }, "↗") : null,
    ]);
  });
  const carousel = el("div", { class: "myroute-carousel" }, cards);

  const goTo = (idx) => {
    const clamped = Math.max(0, Math.min(segments.length - 1, idx));
    carousel.scrollTo({ top: clamped * MYROUTE_CARD_H, behavior: "smooth" });
  };

  let settleTimer = null;
  carousel.addEventListener("scroll", () => {
    const idx = Math.max(0, Math.min(segments.length - 1, Math.round(carousel.scrollTop / MYROUTE_CARD_H)));
    if (idx !== myRouteIndex) {
      myRouteIndex = idx;
      mapState.myRouteApplyHighlight?.(idx);
      counter.textContent = `${idx + 1} / ${segments.length}`;
    }
    // 地図の視点合わせはスクロールが落ち着いてから（スワイプ中に何度も動くと酔うため）
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => mapState.myRouteFocusMap?.(myRouteIndex), 150);
  });

  const banner = el("div", { class: "route-banner myroute-banner" }, [
    el("button", { class: "myroute-nav", onclick: () => goTo(myRouteIndex - 1) }, "▲"),
    el("div", { class: "myroute-carousel-wrap" }, carousel),
    el("button", { class: "myroute-nav", onclick: () => goTo(myRouteIndex + 1) }, "▼"),
    el("div", { class: "route-banner-btns" }, [
      counter,
      el(
        "button",
        { class: "modal-close", style: "position:static", onclick: () => { ui.mapMode = "normal"; render(); } },
        "✕"
      ),
    ]),
  ]);
  root.appendChild(banner);

  requestAnimationFrame(() => { carousel.scrollTop = myRouteIndex * MYROUTE_CARD_H; });
}

// ---------- Tab: マイタイムテーブル ----------
function renderMyTT(root, date, min, over) {
  root.appendChild(el("h1", { class: "screen-title" }, "★ マイタイムテーブル"));

  const favs = [...store.state.favorites]
    .map((key) => store.state.performances.find((p) => perfKey(p) === key))
    .filter(Boolean);

  if (!favs.length) {
    root.appendChild(
      el("div", { class: "empty-state" }, [
        el("span", { class: "emoji" }, "☆"),
        el("div", {}, "出演者タブの☆から気になるステージをお気に入り登録しよう"),
      ])
    );
    return;
  }

  const availableDays = over ? DAYS : DAYS;
  const curDay = availableDays.includes(date) ? date : availableDays[0];

  const dayTabs = el("div", { class: "day-tabs" });
  availableDays.forEach((d) => {
    dayTabs.appendChild(
      el(
        "button",
        {
          class: `day-tab${d === (ui.myttDay || curDay) ? " active" : ""}`,
          onclick: () => {
            ui.myttDay = d;
            render();
          },
        },
        DAY_LABELS[d]
      )
    );
  });
  root.appendChild(dayTabs);
  const activeDay = ui.myttDay || curDay;

  if (!over) {
    const modeRow = el("div", { class: "map-toolbar" });
    modeRow.appendChild(
      el(
        "button",
        { class: `toggle-btn${ui.myttMode === "list" ? " active" : ""}`, onclick: () => { ui.myttMode = "list"; render(); } },
        "リスト"
      )
    );
    modeRow.appendChild(
      el(
        "button",
        { class: `toggle-btn${ui.myttMode === "schedule" ? " active" : ""}`, onclick: () => { ui.myttMode = "schedule"; render(); } },
        "スケジュール表"
      )
    );
    root.appendChild(modeRow);
  }

  const dayFavs = favs.filter((p) => p.date === activeDay).sort((a, b) => a.startMin - b.startMin);
  if (!dayFavs.length) {
    root.appendChild(el("div", { class: "empty-state" }, [el("span", { class: "emoji" }, "📅"), el("div", {}, "この日のお気に入りはありません")]));
    return;
  }

  if (!over && activeDay === date) {
    root.appendChild(
      el(
        "button",
        {
          class: "btn block",
          style: "margin-bottom:12px",
          onclick: () => {
            activeTab = "map";
            ui.mapMode = "myroute";
            render();
          },
        },
        "🗺️ マップでステージ間のルート・徒歩時間を見る"
      )
    );
  }

  const warnings = computeWarnings(dayFavs);
  warnings.forEach((w) => {
    const banner = el(
      "div",
      {
        class: "warn-banner",
        onclick: () => {
          activeTab = "map";
          ui.mapMode = "myroute";
          render();
        },
      },
      `⚠️ ${w}`
    );
    root.appendChild(banner);
  });

  if (ui.myttMode === "schedule" && !over) {
    root.appendChild(renderScheduleGrid(dayFavs, date, min));
  } else {
    const finished = dayFavs.filter((p) => p.date < date || (p.date === date && p.endMin <= min));
    const active = dayFavs.filter((p) => !finished.includes(p));
    appendPerfCardsWithConnectors(root, active, date, min);
    if (finished.length) {
      const wrap = el("div", {});
      appendPerfCardsWithConnectors(wrap, finished, date, min);
      root.appendChild(finishedDetails({ screen: "mytt", id: activeDay }, `🏁 終了したステージ（${finished.length}）`, wrap));
    }
  }

  if (over) {
    root.appendChild(
      el(
        "button",
        { class: "btn block primary", style: "margin-top:16px", onclick: exportFavoritesFile },
        "💾 ファイルに書き出す"
      )
    );
  }
}

// お気に入りの演目カードを、連続する2件の間にそのステージ間の移動時間を挟みながら描画する
function appendPerfCardsWithConnectors(container, list, date, min) {
  list.forEach((p, i) => {
    container.appendChild(perfCard(p, { date, min }));
    if (i < list.length - 1) {
      const connector = travelConnector(list[i], list[i + 1]);
      if (connector) container.appendChild(connector);
    }
  });
}

function travelConnector(a, b) {
  if (a.venueId === b.venueId) {
    return el("div", { class: "mytt-connector" }, "同じ会場");
  }
  const venueA = store.venueById(a.venueId);
  const venueB = store.venueById(b.venueId);
  if (!venueA || !venueB) return null;
  const walk = store.walkMinutes(a.venueId, b.venueId);
  const mins = walk != null ? walk : estimateWalkMin(venueA.lat, venueA.lng, venueB.lat, venueB.lng);
  const gap = b.startMin - a.endMin;
  const tight = gap < mins;
  return el("div", { class: `mytt-connector${tight ? " tight" : ""}` }, `🚶 徒歩${mins}分`);
}

function computeWarnings(dayFavs) {
  const warnings = [];
  for (let i = 0; i < dayFavs.length - 1; i++) {
    const a = dayFavs[i];
    const b = dayFavs[i + 1];
    if (a.endMin > b.startMin) {
      warnings.push(`「${a.name}」と「${b.name}」の時間が重複しています`);
      continue;
    }
    if (a.venueId !== b.venueId) {
      const walk = store.walkMinutes(a.venueId, b.venueId);
      const venueA = store.venueById(a.venueId);
      const venueB = store.venueById(b.venueId);
      const est = walk != null ? walk : venueA && venueB ? estimateWalkMin(venueA.lat, venueA.lng, venueB.lat, venueB.lng) : 0;
      const gap = b.startMin - a.endMin;
      if (est > gap) {
        warnings.push(`「${a.name}」→「${b.name}」の移動時間が足りない可能性があります（必要 約${est}分 / 余裕 ${gap}分）`);
      }
    }
  }
  return warnings;
}

function renderScheduleGrid(dayFavs, date, min) {
  const wrap = el("div", { class: "schedule-wrap" });
  const startHour = Math.min(...dayFavs.map((p) => Math.floor(p.startMin / 60))) ;
  const endHour = Math.max(...dayFavs.map((p) => Math.ceil(p.endMin / 60)));
  const pxPerMin = 1.6;
  const totalMin = (endHour - startHour) * 60;

  // greedy列割り当て
  const sorted = [...dayFavs].sort((a, b) => a.startMin - b.startMin);
  const colEndTimes = [];
  const placed = sorted.map((p) => {
    let col = colEndTimes.findIndex((t) => t <= p.startMin);
    if (col === -1) {
      col = colEndTimes.length;
      colEndTimes.push(p.endMin);
    } else {
      colEndTimes[col] = p.endMin;
    }
    return { p, col };
  });
  const maxCol = Math.max(1, colEndTimes.length);
  if (maxCol > 3) wrap.classList.add("scrollable");

  const axis = el("div", { class: "sched-axis", style: `height:${totalMin * pxPerMin}px` });
  for (let h = startHour; h <= endHour; h++) {
    const top = (h - startHour) * 60 * pxPerMin;
    axis.appendChild(el("div", { class: "sched-hour-label", style: `top:${top}px` }, `${h}:00`));
    axis.appendChild(el("div", { class: "sched-hour-line", style: `top:${top}px` }));
  }

  const grid = el("div", { class: "schedule-grid", style: `height:${totalMin * pxPerMin}px; margin-left:8px; min-width:${maxCol * 130}px` });
  placed.forEach(({ p, col }) => {
    const top = (p.startMin - startHour * 60) * pxPerMin;
    const height = Math.max(20, (p.endMin - p.startMin) * pxPerMin);
    const playing = isNowPlaying(p, date, min);
    const box = el(
      "div",
      {
        class: "sched-col",
        style: `top:${top}px;left:${col * 128}px;width:120px;height:${height}px;${playing ? "outline:2px solid var(--ok)" : ""}`,
        onclick: () => openDetailModal(p),
      },
      [el("div", { class: "t" }, fmtRange(p.start, p.end)), el("div", { class: "n" }, p.name)]
    );
    grid.appendChild(box);
  });
  axis.appendChild(grid);
  wrap.appendChild(axis);
  return wrap;
}

function exportFavoritesFile() {
  const data = {
    exportedAt: new Date().toISOString(),
    favorites: [...store.state.favorites],
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sumida-jazz-mytt-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- 更新履歴 ----------
document.getElementById("btn-changelog").addEventListener("click", openChangelogModal);
function updateChangelogBadge() {
  const btn = document.getElementById("btn-changelog");
  const latest = store.state.changes?.history?.[0]?.checkedAt;
  const unread = latest && (!store.state.seenChangeAt || latest > store.state.seenChangeAt);
  btn.classList.toggle("has-badge", !!unread);
  btn.classList.toggle("muted", !unread);
}
const OFFICIAL_TIMETABLE_URL = "https://sumida-jazz.jp/sj/timetable.html";

function openChangelogModal() {
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
  const sheet = el("div", { class: "modal-sheet" });
  sheet.appendChild(el("button", { class: "modal-close", onclick: () => backdrop.remove() }, "✕"));
  sheet.appendChild(el("div", { class: "modal-title" }, "更新履歴"));

  const history = store.state.changes?.history || [];
  if (history.length) {
    sheet.appendChild(el("h4", { style: "color:var(--muted);font-size:.78rem;text-transform:uppercase;margin:10px 0 6px" }, "出演者情報の変更"));
    history.forEach((h) => {
      sheet.appendChild(
        el("div", { class: "changelog-date-row" }, [
          el("span", { class: "changelog-date" }, h.checkedAt),
          el(
            "a",
            { class: "changelog-official-link", href: OFFICIAL_TIMETABLE_URL, target: "_blank", rel: "noopener" },
            "公式サイトで確認 ↗"
          ),
        ])
      );
      (h.items || []).forEach((item) => {
        const tagLabel = { added: "追加", removed: "削除", swap: "交代", modified: "変更" }[item.kind] || item.kind;
        sheet.appendChild(
          el("div", { class: "changelog-item" }, [el("span", { class: `tag ${item.kind}` }, tagLabel), el("span", {}, item.text || JSON.stringify(item))])
        );
      });
    });
  } else {
    sheet.appendChild(el("p", { style: "color:var(--muted)" }, "出演者情報の変更履歴はまだありません。"));
  }

  const app = store.state.appChangelog?.entries || [];
  if (app.length) {
    sheet.appendChild(el("h4", { style: "color:var(--muted);font-size:.78rem;text-transform:uppercase;margin:18px 0 6px" }, "アプリの更新履歴"));
    let lastDate = null;
    app.forEach((e) => {
      if (e.date !== lastDate) {
        sheet.appendChild(el("div", { class: "changelog-date" }, e.date));
        lastDate = e.date;
      }
      sheet.appendChild(el("div", { class: "changelog-item" }, [el("span", { class: "tag" }, e.version), el("span", {}, e.text)]));
    });
  }

  backdrop.appendChild(sheet);
  $modalRoot.appendChild(backdrop);

  store.state.seenChangeAt = history[0]?.checkedAt || store.state.seenChangeAt;
  store.persistSeenChanges();
  updateChangelogBadge();
}

// ---------- 設定 ----------
document.getElementById("btn-settings").addEventListener("click", openSettingsModal);
function openSettingsModal() {
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
  const sheet = el("div", { class: "modal-sheet" });
  sheet.appendChild(el("button", { class: "modal-close", onclick: () => backdrop.remove() }, "✕"));
  sheet.appendChild(el("div", { class: "modal-title" }, "設定"));

  // 文字サイズ
  const fontRow = el("div", { class: "settings-row" });
  fontRow.appendChild(el("div", {}, [el("div", { class: "label" }, "文字サイズ")]));
  const seg = el("div", { class: "seg-control" });
  ["normal", "large"].forEach((v) => {
    seg.appendChild(
      el(
        "button",
        {
          class: store.state.settings.fontSize === v ? "active" : "",
          onclick: () => {
            store.state.settings.fontSize = v;
            store.persistSettings();
            document.documentElement.classList.toggle("font-large", v === "large");
            backdrop.remove();
            openSettingsModal();
          },
        },
        v === "normal" ? "標準" : "大"
      )
    );
  });
  fontRow.appendChild(seg);
  sheet.appendChild(fontRow);

  // 時刻シミュレーション
  const simRow = el("div", { class: "settings-row" });
  simRow.appendChild(el("div", {}, [el("div", { class: "label" }, "時刻シミュレーション"), el("div", { class: "desc" }, "開催日前でも当日の見え方を確認できます")]));
  const simInput = el("input", {
    type: "datetime-local",
    value: store.state.settings.simTime || "",
    onchange: (e) => {
      store.state.settings.simTime = e.target.value || null;
      store.persistSettings();
      render();
    },
  });
  simRow.appendChild(simInput);
  sheet.appendChild(simRow);

  // 現在地シミュレーション
  const geoSimRow = el("div", { class: "settings-row" });
  geoSimRow.appendChild(el("div", {}, [el("div", { class: "label" }, "現在地シミュレーション"), el("div", { class: "desc" }, "GPSが使えない環境での動作確認用")]));
  const useSimGeo = !!store.state.settings.simGeo;
  const geoSwitch = mkSwitch(useSimGeo, (checked) => {
    if (checked) {
      const v = store.state.venues[0];
      store.state.settings.simGeo = v ? { lat: v.lat, lng: v.lng } : { lat: 35.697, lng: 139.814 };
    } else {
      store.state.settings.simGeo = null;
    }
    store.persistSettings();
    render();
    backdrop.remove();
    openSettingsModal();
  });
  geoSimRow.appendChild(geoSwitch);
  sheet.appendChild(geoSimRow);

  // 現在地の自動更新
  const autoRow = el("div", { class: "settings-row" });
  autoRow.appendChild(el("div", {}, [el("div", { class: "label" }, "現在地の自動更新"), el("div", { class: "desc" }, "フォアグラウンド復帰時・マップ表示時に測位")]));
  autoRow.appendChild(
    mkSwitch(store.state.settings.autoLocate, (checked) => {
      store.state.settings.autoLocate = checked;
      store.persistSettings();
      if (checked) locateOnce();
    })
  );
  sheet.appendChild(autoRow);

  // 共有・書き出し
  const shareSection = el("div", { class: "modal-section" });
  shareSection.appendChild(el("h4", {}, "お気に入りの共有・バックアップ"));
  const btnRow = el("div", { class: "btn-row" });
  btnRow.appendChild(
    el(
      "button",
      { class: "btn", onclick: shareFavoritesLink },
      navigator.share ? "🔗 共有する" : "🔗 共有リンクをコピー"
    )
  );
  btnRow.appendChild(el("button", { class: "btn", onclick: exportFavoritesFile }, "💾 ファイルに書き出す"));
  const importInput = el("input", { type: "file", accept: "application/json", style: "display:none", onchange: handleImportFile });
  btnRow.appendChild(el("button", { class: "btn", onclick: () => importInput.click() }, "📂 ファイルから読み込む"));
  shareSection.append(btnRow, importInput);
  sheet.appendChild(shareSection);

  backdrop.appendChild(sheet);
  $modalRoot.appendChild(backdrop);
}

function mkSwitch(checked, onChange) {
  const label = el("label", { class: "switch" });
  const input = el("input", { type: "checkbox", checked: checked || undefined, onchange: (e) => onChange(e.target.checked) });
  label.append(input, el("span", { class: "track" }));
  return label;
}

function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      confirmImport(data.favorites || []);
    } catch {
      alert("読み込みに失敗しました");
    }
  };
  reader.readAsText(file);
}

function confirmImport(keys) {
  const merge = confirm(`${keys.length}件のお気に入りを取り込みます。\nOK: 既存に追加（マージ） / キャンセル: 中止`);
  if (!merge) return;
  keys.forEach((k) => store.state.favorites.add(k));
  store.persistFavorites();
  render();
  alert("取り込みました");
}

function buildShareUrl(keys) {
  return `${location.origin}${location.pathname}?fav=${encodeURIComponent(keys.join(","))}`;
}

// お気に入りをnavigator.share（端末の共有シート）で送る。非対応環境ではクリップボードにコピーする
async function shareFavoritesLink() {
  const keys = [...store.state.favorites];
  if (!keys.length) {
    alert("お気に入りがまだ登録されていません");
    return;
  }
  const url = buildShareUrl(keys);
  if (navigator.share) {
    try {
      await navigator.share({ title: "すみだジャズナビ マイタイムテーブル", url });
    } catch {
      // 共有シートのキャンセル等は何もしない
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    alert("共有リンクをコピーしました");
  } catch {
    prompt("このリンクをコピーしてください", url);
  }
}

function checkUrlImport() {
  const params = new URLSearchParams(location.search);
  const fav = params.get("fav");
  if (fav) {
    const keys = fav.split(",").filter(Boolean);
    confirmImport(keys);
    history.replaceState({}, "", location.pathname);
  }
}

// ---------- 現在地取得 ----------
function locateOnce() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("geolocation unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        store.state.currentGeo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        render();
        resolve(store.state.currentGeo);
      },
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && store.state.settings.autoLocate && !store.state.settings.simGeo) locateOnce();
});

// ---------- ヘッダー: バージョン・公式データ確認日時 ----------
// sw.js側のCACHE_NAME(=VERSION)と二重管理にならないよう、値そのものはここでは持たない
async function currentSwVersion() {
  if (!("caches" in window)) return null;
  try {
    // 新旧のキャッシュが一時的に共存することがある（新SWのinstall直後〜旧SWのactivate削除まで）ため、
    // 見つかった中で一番新しい（数値が大きい）ものを採用する
    const keys = (await caches.keys()).filter((k) => k.startsWith("sjz-"));
    if (!keys.length) return null;
    keys.sort((a, b) => (parseInt(b.slice(5), 10) || 0) - (parseInt(a.slice(5), 10) || 0));
    return keys[0].slice("sjz-".length);
  } catch {
    return null;
  }
}

async function updateHeaderInfo() {
  const el2 = document.getElementById("header-updated");
  if (!el2) return;
  const checkedAt = store.state.checked?.checkedAt || store.state.performancesUpdatedAt;
  const ver = await currentSwVersion();
  if (!checkedAt) {
    el2.textContent = ver || "";
    return;
  }
  const d = new Date(checkedAt);
  const text =
    `確認: ${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}時点` +
    (ver ? ` / ${ver}` : "");
  el2.textContent = text;
}

// 新しいService Workerが有効化されてページの制御を引き継いだら、ヘッダーのバージョン表示を追従させる
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => updateHeaderInfo());
}

// ---------- init ----------
async function init() {
  await store.loadAll();
  updateChangelogBadge();
  checkUrlImport();
  updateHeaderInfo();
  if (store.state.settings.autoLocate && !store.state.settings.simGeo) locateOnce();
  render();
  store.fetchWeather().then((w) => {
    weatherData = w;
    render();
  });
}

init();

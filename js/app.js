import * as store from "./store.js";
import {
  DAYS,
  DAY_LABELS,
  STAMP_STAGE_NOS,
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
  mapMode: "normal", // normal | myroute | stamp
  mapSearch: "",
  myttMode: "list", // list | schedule
};
const finishedOpen = { now: new Set(), artists: new Set(), mytt: new Set() };
const venueCollapseOpen = new Set();

const mapState = { instance: null, center: null, zoom: null, layer: null, geoMarker: null };
let weatherData = null;
let geoWatchStarted = false;

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
    finishedVenues.forEach((v) => list.appendChild(el("div", { class: "venue-name", style: "padding:6px 0" }, `${v.stageNo}. ${v.name}`)));
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

  const filterRow = el("div", { class: "filter-row" });
  const searchInput = el("input", {
    class: "search-input",
    type: "search",
    placeholder: "出演者名・かなで検索",
    value: ui.artistsSearch,
    oninput: debounce((e) => {
      ui.artistsSearch = e.target.value;
      render();
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

  const q = normalize(ui.artistsSearch);
  let list = store.state.performances.filter((p) => {
    if (ui.artistsDay !== "all" && p.date !== ui.artistsDay) return false;
    if (ui.artistsVenue && p.venueId !== ui.artistsVenue) return false;
    if (ui.artistsGenre && p.genre !== ui.artistsGenre) return false;
    if (q && !normalize(p.name).includes(q) && !normalize(p.kana).includes(q) && !normalize(p.awardEntry).includes(q)) return false;
    return true;
  });

  if (!list.length) {
    root.appendChild(el("div", { class: "empty-state" }, [el("span", { class: "emoji" }, "🔍"), el("div", {}, "該当する出演者が見つかりません")]));
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

  activeVenues.forEach((v) => root.appendChild(renderVenueGroup(v)));

  if (finishedVenues.length) {
    const wrap = el("div", {});
    finishedVenues.forEach((v) => wrap.appendChild(renderVenueGroup(v)));
    root.appendChild(finishedDetails({ screen: "artists", id: "fin" }, `🏁 終了したステージ（${finishedVenues.length}）`, wrap));
  }
}

// ---------- detail modal ----------
function openDetailModal(p) {
  const venue = store.venueById(p.venueId);
  const review = store.getReview(p) || { rating: 0, note: "" };
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) close(); } });
  const sheet = el("div", { class: "modal-sheet" });
  const close = () => backdrop.remove();

  sheet.appendChild(el("button", { class: "modal-close", onclick: close, "aria-label": "閉じる" }, "✕"));
  sheet.appendChild(el("div", { class: "modal-title" }, p.name));
  sheet.appendChild(
    el(
      "div",
      { class: "modal-meta" },
      `${DAY_LABELS[p.date] || p.date} ${fmtRange(p.start, p.end)} / ${venue ? `${venue.stageNo}. ${venue.name}` : ""}`
    )
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

  const reviewSection = el("div", { class: "modal-section" });
  reviewSection.appendChild(el("h4", {}, "感想・評価"));
  let curRating = review.rating;
  const stars = el("div", { class: "rating-stars" });
  const drawStars = () => {
    stars.innerHTML = "";
    for (let i = 1; i <= 5; i++) {
      stars.appendChild(
        el(
          "span",
          {
            class: `star${i <= curRating ? " filled" : ""}`,
            onclick: () => {
              curRating = curRating === i ? 0 : i;
              drawStars();
            },
          },
          "★"
        )
      );
    }
  };
  drawStars();
  reviewSection.appendChild(stars);
  const noteInput = el("textarea", { class: "note-input", placeholder: "感想メモ" }, review.note);
  reviewSection.appendChild(noteInput);
  reviewSection.appendChild(
    el(
      "button",
      {
        class: "btn primary",
        style: "margin-top:8px",
        onclick: () => {
          store.setReview(p, curRating, noteInput.value);
          render();
          close();
        },
      },
      "保存"
    )
  );
  sheet.appendChild(reviewSection);

  if (venue) {
    const mapBtn = el(
      "button",
      { class: "btn block", style: "margin-top:6px" },
      "🗺️ マップで見る"
    );
    mapBtn.addEventListener("click", () => {
      close();
      activeTab = "map";
      render();
      focusMapOnVenue(venue);
    });
    sheet.appendChild(mapBtn);
  }

  backdrop.appendChild(sheet);
  $modalRoot.appendChild(backdrop);
}

// ---------- Tab: マップ ----------
function renderMap(root, date, min) {
  root.appendChild(el("h1", { class: "screen-title" }, "🗺️ マップ"));

  const toolbar = el("div", { class: "map-toolbar" });
  toolbar.appendChild(
    el("input", {
      class: "search-input",
      type: "search",
      placeholder: "ステージ番号・会場名で検索",
      value: ui.mapSearch,
      onkeydown: (e) => {
        if (e.key === "Enter") {
          ui.mapSearch = e.target.value;
          searchOnMap(ui.mapSearch);
        }
      },
    })
  );
  toolbar.appendChild(
    el(
      "button",
      {
        class: `toggle-btn${ui.mapMode === "myroute" ? " active" : ""}`,
        onclick: () => {
          ui.mapMode = ui.mapMode === "myroute" ? "normal" : "myroute";
          render();
        },
      },
      "🎟️ マイルート"
    )
  );
  toolbar.appendChild(
    el(
      "button",
      {
        class: `toggle-btn${ui.mapMode === "stamp" ? " active" : ""}`,
        onclick: () => {
          ui.mapMode = ui.mapMode === "stamp" ? "normal" : "stamp";
          render();
        },
      },
      "🎫 スタンプラリー"
    )
  );
  root.appendChild(toolbar);

  if (ui.mapMode === "stamp") {
    root.appendChild(el("div", { class: "sub-note", id: "stamp-progress" }, stampProgressText(date)));
  }

  const mapDiv = el("div", { id: "map-view" });
  root.appendChild(mapDiv);

  requestAnimationFrame(() => initOrUpdateMap(mapDiv, date, min));
}

function stampProgressText(date) {
  const target = store.state.venues.filter((v) => STAMP_STAGE_NOS.includes(v.stageNo) && v.days.includes(date));
  const done = target.filter((v) => store.state.stamps.has(v.id)).length;
  return `達成 ${done} / ${target.length}`;
}

function searchOnMap(q) {
  const nq = normalize(q);
  if (!nq) return;
  const venue = store.state.venues.find(
    (v) => normalize(v.name).includes(nq) || String(v.stageNo) === q.trim()
  );
  if (venue && mapState.instance) focusMapOnVenue(venue);
}

function focusMapOnVenue(venue) {
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

  const stampTarget = new Set(
    store.state.venues.filter((v) => STAMP_STAGE_NOS.includes(v.stageNo)).map((v) => v.id)
  );

  // 座標重複検出
  const coordCount = new Map();
  const keyOf = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`;
  store.state.venues.forEach((v) => coordCount.set(keyOf(v.lat, v.lng), (coordCount.get(keyOf(v.lat, v.lng)) || 0) + 1));
  const tieupOffsetSeen = new Map();

  let venuesToShow = store.state.venues;
  if (ui.mapMode === "stamp") venuesToShow = store.state.venues.filter((v) => stampTarget.has(v.id));

  venuesToShow.forEach((v) => {
    const finished = isVenueFinished(store.state.performances, v.id, null, date, min);
    const isStamp = stampTarget.has(v.id);
    const color = isStamp ? "#ffb020" : "#39e0c9";
    const marker = L.marker([v.lat, v.lng], {
      icon: venueDivIcon(v.stageNo, color, finished),
      zIndexOffset: isStamp ? 200 : 0,
    }).addTo(layer);
    let popupHtml = `<b>${v.stageNo}. ${v.name}</b>`;
    if (ui.mapMode === "stamp") {
      const visited = store.state.stamps.has(v.id);
      popupHtml += `<br><button data-stamp="${v.id}" style="margin-top:6px">${visited ? "✓ 訪問済み" : "訪問済みにする"}</button>`;
    }
    const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}&travelmode=walking`;
    popupHtml += `<br><a href="${gmaps}" target="_blank" rel="noopener">Googleマップで徒歩ナビ</a>`;
    marker.bindPopup(popupHtml);
    marker.on("popupopen", () => {
      const btn = document.querySelector(`[data-stamp="${v.id}"]`);
      if (btn) btn.addEventListener("click", () => {
        store.toggleStamp(v.id);
        marker.closePopup();
        drawMapLayer(date, min);
        const progress = document.getElementById("stamp-progress");
        if (progress) progress.textContent = stampProgressText(date);
      });
    });
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

  const geo = effectiveGeo();
  if (geo) {
    L.circleMarker([geo.lat, geo.lng], { radius: 9, color: "#fff", weight: 3, fillColor: "#3d8bff", fillOpacity: 1 })
      .addTo(layer)
      .bindPopup("現在地");
  }
}

function drawMyRoute(layer, date, min) {
  const favs = [...store.state.favorites]
    .map((key) => store.state.performances.find((p) => perfKey(p) === key))
    .filter((p) => p && p.date === date && p.endMin > min)
    .sort((a, b) => a.startMin - b.startMin);
  if (!favs.length) return;

  const geo = effectiveGeo();
  const points = [];
  if (geo) points.push({ lat: geo.lat, lng: geo.lng, id: null });
  favs.forEach((p) => {
    const v = store.venueById(p.venueId);
    if (v) points.push({ lat: v.lat, lng: v.lng, id: v.id });
  });

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    let latlngs = [[a.lat, a.lng], [b.lat, b.lng]];
    if (a.id && b.id) {
      const route = store.routeBetween(a.id, b.id);
      if (route && route.poly) {
        latlngs = decodePolyline(route.poly);
      }
    }
    const isFirst = a.id === null;
    L.polyline(latlngs, { color: "#0f9c8c", weight: 5, opacity: 0.95, dashArray: isFirst ? "2 8" : null, lineCap: "round" }).addTo(layer);
  }
  if (points.length) {
    const first = points[0];
    L.circleMarker([first.lat, first.lng], { radius: 9, color: "#0f9c8c", weight: 4, fillOpacity: 0 }).addTo(layer);
  }
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
    active.forEach((p) => root.appendChild(perfCard(p, { date, min })));
    if (finished.length) {
      const wrap = el("div", {});
      finished.forEach((p) => wrap.appendChild(perfCard(p, { date, min })));
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
    reviews: Object.fromEntries(store.state.reviews),
    stamps: [...store.state.stamps],
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
function openChangelogModal() {
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
  const sheet = el("div", { class: "modal-sheet" });
  sheet.appendChild(el("button", { class: "modal-close", onclick: () => backdrop.remove() }, "✕"));
  sheet.appendChild(el("div", { class: "modal-title" }, "更新履歴"));

  const history = store.state.changes?.history || [];
  if (history.length) {
    sheet.appendChild(el("h4", { style: "color:var(--muted);font-size:.78rem;text-transform:uppercase;margin:10px 0 6px" }, "出演者情報の変更"));
    history.forEach((h) => {
      sheet.appendChild(el("div", { class: "changelog-date" }, h.checkedAt));
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
      {
        class: "btn",
        onclick: () => {
          const url = `${location.origin}${location.pathname}?fav=${encodeURIComponent([...store.state.favorites].join(","))}`;
          navigator.clipboard?.writeText(url).catch(() => {});
          alert("共有リンクをコピーしました");
        },
      },
      "🔗 共有リンクをコピー"
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
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      store.state.currentGeo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      render();
    },
    () => {},
    { enableHighAccuracy: true, timeout: 8000 }
  );
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && store.state.settings.autoLocate && !store.state.settings.simGeo) locateOnce();
});

// ---------- init ----------
async function init() {
  await store.loadAll();
  updateChangelogBadge();
  checkUrlImport();
  if (store.state.settings.autoLocate && !store.state.settings.simGeo) locateOnce();
  render();
  store.fetchWeather().then((w) => {
    weatherData = w;
    render();
  });
}

init();

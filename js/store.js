// すみだジャズナビ - 状態管理・データ読み込み

import { toMin, perfKey, WEATHER_LAT, WEATHER_LNG } from "./util.js";

const LS = {
  favorites: "sjz.favorites.v1",
  settings: "sjz.settings.v1",
  seenChanges: "sjz.seenChanges.v1",
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* ignore quota errors */
  }
}

export const state = {
  venues: [],
  performances: [],
  walktimes: null,
  routes: null,
  tieup: { stages: [] },
  checked: null,
  changes: null,
  appChangelog: null,
  performancesUpdatedAt: null,
  favorites: new Set(loadJSON(LS.favorites, [])),
  settings: Object.assign(
    {
      fontSize: "normal", // normal | large
      simTime: null, // "2026-10-17T13:00" 等
      simGeo: null, // {lat,lng}
      autoLocate: false,
      theme: "system",
    },
    loadJSON(LS.settings, {})
  ),
  seenChangeAt: loadJSON(LS.seenChanges, null),
  currentGeo: null,
};

export function persistFavorites() {
  saveJSON(LS.favorites, [...state.favorites]);
}
export function persistSettings() {
  saveJSON(LS.settings, state.settings);
}
export function persistSeenChanges() {
  saveJSON(LS.seenChanges, state.seenChangeAt);
}

export function toggleFavorite(p) {
  const key = perfKey(p);
  if (state.favorites.has(key)) state.favorites.delete(key);
  else state.favorites.add(key);
  persistFavorites();
}
export function isFavorite(p) {
  return state.favorites.has(perfKey(p));
}

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`fetch failed: ${path}`);
  return res.json();
}

export async function loadAll() {
  const [venues, performances] = await Promise.all([
    fetchJSON("data/venues.json"),
    fetchJSON("data/performances.json"),
  ]);
  state.venues = venues.venues;
  state.performances = performances.performances.map((p) => ({
    ...p,
    startMin: toMin(p.start),
    endMin: toMin(p.end),
  }));
  state.performancesUpdatedAt = performances.updatedAt || null;

  const optional = async (path, fallback) => {
    try {
      return await fetchJSON(path);
    } catch {
      return fallback;
    }
  };
  const [walktimes, routes, tieup, checked, changes, appChangelog] = await Promise.all([
    optional("data/walktimes.json", null),
    optional("data/routes.json", { routes: {} }),
    optional("data/tieup.json", { stages: [] }),
    optional("data/checked.json", null),
    optional("data/changes.json", { history: [] }),
    optional("data/app_changelog.json", { entries: [] }),
  ]);
  state.walktimes = walktimes;
  state.routes = routes;
  state.tieup = tieup;
  state.checked = checked;
  state.changes = changes;
  state.appChangelog = appChangelog;
}

export function venueById(id) {
  return state.venues.find((v) => v.id === id);
}

export function walkMinutes(idA, idB) {
  if (!state.walktimes || idA === idB) return 0;
  const { ids, minutes } = state.walktimes;
  const i = ids.indexOf(idA);
  const j = ids.indexOf(idB);
  if (i === -1 || j === -1) return null;
  return minutes[i][j];
}

export function routeBetween(idA, idB) {
  if (!state.routes) return null;
  const key = [idA, idB].sort().join("|");
  return state.routes.routes[key] || null;
}

export async function fetchWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LNG}&hourly=temperature_2m,precipitation_probability,weathercode&timezone=Asia%2FTokyo&start_date=2026-10-17&end_date=2026-10-18`;
    const res = await fetch(url);
    if (!res.ok) {
      // Open-Meteoの無料予報は開催日の16日前を切るまで該当日のデータが
      // 存在せずHTTP 400になる（"start_date out of allowed range"等）。
      // バッジには表示せず(呼び出し側で「-」にフォールバック)、開発時に
      // 「壊れている」のか「まだ予報が無いだけ」なのか判別できるよう理由だけ出す。
      let reason = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.reason) reason = body.reason;
      } catch {
        /* エラーレスポンスがJSONでない場合はHTTPステータスのみ出す */
      }
      console.warn(`[weather] 天気予報を取得できませんでした: ${reason}`);
      return null;
    }
    const data = await res.json();
    const map = {};
    data.hourly.time.forEach((t, i) => {
      map[t] = {
        temp: data.hourly.temperature_2m[i],
        pop: data.hourly.precipitation_probability[i],
        code: data.hourly.weathercode[i],
      };
    });
    return map;
  } catch (e) {
    console.warn("[weather] 天気予報の取得に失敗しました:", e);
    return null;
  }
}

export function weatherIcon(code) {
  if (code == null) return "";
  if (code === 0) return "☀️";
  if ([1, 2].includes(code)) return "🌤️";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "☁️";
}

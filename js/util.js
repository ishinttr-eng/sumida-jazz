// すみだジャズナビ - 汎用ユーティリティ

export const DAYS = ["2026-10-17", "2026-10-18"];
export const DAY_LABELS = { "2026-10-17": "10/17(土)", "2026-10-18": "10/18(日)" };

export const WEATHER_LAT = 35.6969;
export const WEATHER_LNG = 139.8144;

export function toMin(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minToHHMM(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function normalize(s) {
  if (!s) return "";
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/\s+/g, "");
}

export function perfKey(p) {
  return `${p.id}__${p.date}__${p.start}`;
}

const R = 6371000;
export function haversine(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 実測ルートが無い場合の概算: 直線距離 x 補正係数1.3 / 徒歩速度80m/分
export function estimateWalkMin(lat1, lng1, lat2, lng2) {
  const distM = haversine(lat1, lng1, lat2, lng2);
  return Math.max(1, Math.round((distM * 1.3) / 80));
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === false || v == null) continue;
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function fmtRange(start, end) {
  return `${start}–${end}`;
}

export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function nowMin(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

// 開催中/未開催/終了 の全体状態
export function isVenueFinished(performances, venueId, date, curDate, curMin) {
  const list = performances.filter((p) => p.venueId === venueId && (date ? p.date === date : true));
  if (list.length === 0) return false;
  return list.every((p) => {
    if (p.date < curDate) return true;
    if (p.date === curDate) return p.endMin <= curMin;
    return false;
  });
}

export function isFestivalOver(curDate, curMin) {
  const lastDay = DAYS[DAYS.length - 1];
  if (curDate > lastDay) return true;
  if (curDate < lastDay) return false;
  return curMin >= 21 * 60; // クロージングは概ね21時までに終了する想定
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

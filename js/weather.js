// 気象データ取得（Open-Meteo: GFS 0.25° 予報、標高API、ドローン用の地上付近予報）
import { G0, R_AIR, R0_GEOPOT } from './atmosphere.js';

export const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400,
  350, 300, 250, 200, 150, 100, 70, 50, 40, 30, 20, 15, 10];

const cache = new Map();

async function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url);
  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || (body && body.error)) {
    const reason = body && body.reason ? body.reason : `HTTP ${res.status}`;
    if (res.status === 429) throw new Error('気象APIの利用上限に達しました。1分ほど待ってから再実行してください。');
    throw new Error(`気象データの取得に失敗しました: ${reason}`);
  }
  cache.set(url, body);
  return body;
}

const isoHour = (unix) => new Date(unix * 1000).toISOString().slice(0, 13) + ':00';
const fmt = (x) => x.toFixed(4);

/** GFSの格子点（0.25°）に揃えた格子を作る */
export function makeGrid(latMin, latMax, lonMin, lonMax, maxPoints = 25) {
  for (const step of [0.25, 0.5, 0.75, 1.0, 1.5, 2.0]) {
    const la0 = Math.floor(latMin / step) * step, la1 = Math.ceil(latMax / step) * step;
    const lo0 = Math.floor(lonMin / step) * step, lo1 = Math.ceil(lonMax / step) * step;
    const ny = Math.round((la1 - la0) / step) + 1, nx = Math.round((lo1 - lo0) / step) + 1;
    if (nx * ny <= maxPoints || step === 2.0) {
      const lats = Array.from({ length: ny }, (_, i) => +(la0 + i * step).toFixed(4));
      const lons = Array.from({ length: nx }, (_, i) => +(lo0 + i * step).toFixed(4));
      return { lats, lons, step };
    }
  }
}

/**
 * 上空の風・気圧・気温の予報を格子で取得し、AtmosphereField用データに変換する。
 * 気温は等圧面高度の差から静力学（層厚）で求めるので、密度計算に必要な仮温度に近い値になる。
 */
export async function fetchUpperAir(lats, lons, t0, t1) {
  const coords = [];
  for (const la of lats) for (const lo of lons) coords.push([la, lo]);
  const hourly = [
    ...LEVELS.flatMap((p) => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`]),
    'wind_speed_10m', 'wind_direction_10m', 'temperature_2m', 'surface_pressure',
  ].join(',');
  const ts = Math.floor(t0 / 3600) * 3600, te = Math.max(Math.ceil(t1 / 3600) * 3600, ts + 3600);
  const url = 'https://api.open-meteo.com/v1/gfs'
    + `?latitude=${coords.map((c) => fmt(c[0])).join(',')}`
    + `&longitude=${coords.map((c) => fmt(c[1])).join(',')}`
    + `&hourly=${hourly}&wind_speed_unit=ms&timeformat=unixtime&timezone=GMT&cell_selection=nearest`
    + `&start_hour=${isoHour(ts)}&end_hour=${isoHour(te)}`;
  const json = await getJSON(url);
  const list = Array.isArray(json) ? json : [json];
  const times = list[0].hourly.time.slice();
  const nx = lons.length, ny = lats.length, nt = times.length;
  const profiles = new Array(nt * ny * nx);
  const elev = new Float64Array(ny * nx);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const loc = list[iy * nx + ix];
      const e = loc.elevation ?? 0;
      elev[iy * nx + ix] = e;
      for (let it = 0; it < nt; it++) profiles[(it * ny + iy) * nx + ix] = buildProfile(loc.hourly, it, e);
    }
  }
  return { lats: lats.slice(), lons: lons.slice(), times, profiles, elev, model: 'GFS 0.25°' };
}

function buildProfile(H, it, elev) {
  const ws10 = H.wind_speed_10m[it] ?? 0, wd10 = (H.wind_direction_10m[it] ?? 0) * Math.PI / 180;
  const sp = H.surface_pressure[it] ?? 1013.25 * Math.exp(-elev / 8400);
  const nodes = [{ gh: elev, z: elev, lnp: Math.log(sp * 100), T: (H.temperature_2m[it] ?? 15) + 273.15,
    u: -ws10 * Math.sin(wd10), v: -ws10 * Math.cos(wd10) }];
  for (const p of LEVELS) {
    const gh = H[`geopotential_height_${p}hPa`][it];
    const ws = H[`wind_speed_${p}hPa`][it], wdDeg = H[`wind_direction_${p}hPa`][it];
    if (gh == null || ws == null || wdDeg == null) continue;
    const last = nodes[nodes.length - 1];
    const z = R0_GEOPOT * gh / (R0_GEOPOT - gh);
    const lnp = Math.log(p * 100);
    if (z <= last.z + 5 || lnp >= last.lnp) continue; // 地中の等圧面は捨てる
    const wd = wdDeg * Math.PI / 180;
    nodes.push({ gh, z, lnp, T: NaN, u: -ws * Math.sin(wd), v: -ws * Math.cos(wd) });
  }
  // 層厚から層平均気温（仮温度）を求め、節点の気温にする
  const n = nodes.length, layerT = [];
  for (let j = 0; j < n - 1; j++) {
    const T = G0 * (nodes[j + 1].gh - nodes[j].gh) / (R_AIR * (nodes[j].lnp - nodes[j + 1].lnp));
    layerT.push(Math.min(Math.max(T, 160), 330));
  }
  for (let j = 1; j < n; j++) nodes[j].T = j < n - 1 ? (layerT[j - 1] + layerT[j]) / 2 : layerT[j - 1];
  const pick = (k) => Float64Array.from(nodes, (x) => x[k]);
  return { z: pick('z'), u: pick('u'), v: pick('v'), lnp: pick('lnp'), T: pick('T') };
}

/** 標高の取得（100点ずつ） */
export async function fetchElevations(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const url = 'https://api.open-meteo.com/v1/elevation'
      + `?latitude=${chunk.map((p) => fmt(p.lat)).join(',')}&longitude=${chunk.map((p) => fmt(p.lon)).join(',')}`;
    const j = await getJSON(url);
    out.push(...j.elevation);
  }
  return out;
}

/** 落下域の詳細地形格子（n×n点） */
export async function fetchTerrainGrid(latMin, latMax, lonMin, lonMax, n = 15) {
  const lats = Array.from({ length: n }, (_, i) => latMin + (latMax - latMin) * i / (n - 1));
  const lons = Array.from({ length: n }, (_, i) => lonMin + (lonMax - lonMin) * i / (n - 1));
  const pts = [];
  for (const la of lats) for (const lo of lons) pts.push({ lat: la, lon: lo });
  const elev = await fetchElevations(pts);
  return { lats, lons, elev: Float64Array.from(elev) };
}

/** ドローン用：地上付近の高度別の風・突風・降水・気温・視程（1時間ごと） */
export async function fetchDroneForecast(lat, lon, days = 3) {
  const hourly = ['wind_speed_10m', 'wind_speed_80m', 'wind_speed_120m', 'wind_speed_180m',
    'wind_direction_10m', 'wind_direction_120m', 'wind_gusts_10m', 'precipitation_probability',
    'precipitation', 'temperature_2m', 'visibility', 'weather_code'].join(',');
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${fmt(lat)}&longitude=${fmt(lon)}&hourly=${hourly}`
    + `&wind_speed_unit=ms&timeformat=unixtime&timezone=auto&forecast_days=${days}`;
  return getJSON(url);
}

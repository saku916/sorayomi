// 大気モデル
//  - stdAtm: 米国標準大気1976（0〜86km）＋熱圏の近似（〜300km）
//  - AtmosphereField: GFS予報から作った「緯度×経度×時刻×高度」の実大気場
//    （風・気圧・気温・密度）。格子間は線形補間、予報上端より上は標準大気で外挿。

export const R_AIR = 287.05287;      // 乾燥空気の気体定数 [J/kg/K]
export const GAMMA = 1.4;
export const G0 = 9.80665;
export const RE = 6371008.8;         // 地球平均半径 [m]
export const R0_GEOPOT = 6356766;    // ジオポテンシャル高度換算用半径 [m]
export const OMEGA = 7.2921159e-5;   // 地球自転角速度 [rad/s]
export const P0 = 101325;

const HB = [0, 11000, 20000, 32000, 47000, 51000, 71000, 84852];
const LB = [-0.0065, 0, 0.001, 0.0028, 0, -0.0028, -0.002];
const TB = [288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65];
const PB = [101325, 22632.06, 5474.889, 868.0187, 110.9063, 66.93887, 3.956420];
// 86km以上: [高度m, 温度K, 密度kg/m3]（US1976の代表値）
const HI = [
  [86000, 186.87, 6.958e-6], [100000, 195.08, 5.604e-7], [110000, 240.0, 9.708e-8],
  [120000, 360.0, 2.222e-8], [150000, 634.39, 2.076e-9], [200000, 854.56, 2.541e-10],
  [300000, 976.0, 1.916e-11],
];

/** 標準大気（幾何高度 z [m]）→ {T, p, rho} */
export function stdAtm(z, out = {}) {
  if (z < 86000) {
    const H = R0_GEOPOT * z / (R0_GEOPOT + z);
    let i = 0;
    while (i < 6 && H >= HB[i + 1]) i++;
    const dh = H - HB[i], L = LB[i], Tb = TB[i];
    let T, p;
    if (L === 0) { T = Tb; p = PB[i] * Math.exp(-G0 * dh / (R_AIR * Tb)); }
    else { T = Tb + L * dh; p = PB[i] * Math.pow(T / Tb, -G0 / (R_AIR * L)); }
    out.T = T; out.p = p; out.rho = p / (R_AIR * T);
  } else {
    let i = 0;
    while (i < HI.length - 2 && z >= HI[i + 1][0]) i++;
    const [z0, T0, r0] = HI[i], [z1, T1, r1] = HI[i + 1];
    const f = (z - z0) / (z1 - z0);
    const rho = r0 * Math.pow(r1 / r0, f);
    const T = T0 + (T1 - T0) * Math.min(Math.max(f, 0), 1);
    out.T = T; out.rho = rho; out.p = rho * R_AIR * T;
  }
  return out;
}

/** 重力加速度（緯度[rad]・高度[m]）。遠心力込みのSomigliana式＋逆二乗則 */
export function gravity(lat, h) {
  const s = Math.sin(lat), s2 = Math.sin(2 * lat);
  const g = 9.780327 * (1 + 0.0053024 * s * s - 0.0000058 * s2 * s2);
  const r = RE / (RE + h);
  return g * r * r;
}

function axis(arr, x, st) {
  const n = arr.length;
  if (n === 1) { st.i = 0; st.w = 0; return; }
  const span = arr[n - 1] - arr[0];
  if (x < arr[0] - span * 1e-3 || x > arr[n - 1] + span * 1e-3) st.out = true;
  if (x <= arr[0]) { st.i = 0; st.w = 0; return; }
  if (x >= arr[n - 1]) { st.i = n - 2; st.w = 1; return; }
  // 等間隔とは限らないので二分探索
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m; else hi = m; }
  st.i = lo; st.w = (x - arr[lo]) / (arr[lo + 1] - arr[lo]);
}

function bilinear(lats, lons, grid, lat, lon) {
  const ax = { i: 0, w: 0, out: false }, ay = { i: 0, w: 0, out: false };
  axis(lons, lon, ax); axis(lats, lat, ay);
  const nx = lons.length;
  const x1 = nx > 1 ? ax.i + 1 : 0, y1 = lats.length > 1 ? ay.i + 1 : 0;
  const a = grid[ay.i * nx + ax.i], b = grid[ay.i * nx + x1];
  const c = grid[y1 * nx + ax.i], d = grid[y1 * nx + x1];
  const top = a + (b - a) * ax.w, bot = c + (d - c) * ax.w;
  return { value: top + (bot - top) * ay.w, out: ax.out || ay.out };
}

/**
 * 実大気場。data = {
 *   lats[], lons[]（昇順・度）, times[]（昇順・UNIX秒）,
 *   profiles[]: 長さ nt*ny*nx、各要素 {z,u,v,lnp,T}（高度昇順の配列）,
 *   elev: 各格子点の地表標高 [m]（ny*nx）,
 *   terrain?: {lats, lons, elev} 落下域の詳細地形
 * }
 */
export class AtmosphereField {
  constructor(data) {
    this.data = data;
    this.lats = data.lats; this.lons = data.lons; this.times = data.times;
    this.nx = this.lons.length; this.ny = this.lats.length; this.nt = this.times.length;
    this.profiles = data.profiles;
    this.elev = data.elev;
    this.terrain = data.terrain || null;
    this.hint = new Int32Array(this.profiles.length);
    const s = {};
    this.topLnpStd = new Float64Array(this.profiles.length);
    this.topTStd = new Float64Array(this.profiles.length);
    this.profiles.forEach((P, k) => {
      stdAtm(P.z[P.z.length - 1], s);
      this.topLnpStd[k] = Math.log(s.p); this.topTStd[k] = s.T;
    });
    this.outOfGrid = false;
    this._ax = { i: 0, w: 0, out: false }; this._ay = { i: 0, w: 0, out: false }; this._at = { i: 0, w: 0, out: false };
    this._std = {};
    this._stdZ = NaN;
  }

  toData() { return { ...this.data, terrain: this.terrain }; }
  setTerrain(t) { this.terrain = t; this.data.terrain = t; }

  /** 標準大気＋任意の風関数から作る単一点の大気場（テスト・オフライン用） */
  static fromStandard({ lat = 35, lon = 139, elev = 0, wind = () => [0, 0], top = 40000, step = 250 } = {}) {
    const z = [], u = [], v = [], lnp = [], T = [];
    const s = {};
    for (let h = elev; h <= top + 1e-6; h += step) {
      stdAtm(h, s); const [wu, wv] = wind(h);
      z.push(h); u.push(wu); v.push(wv); lnp.push(Math.log(s.p)); T.push(s.T);
    }
    const P = { z: Float64Array.from(z), u: Float64Array.from(u), v: Float64Array.from(v), lnp: Float64Array.from(lnp), T: Float64Array.from(T) };
    return new AtmosphereField({ lats: [lat], lons: [lon], times: [0], profiles: [P], elev: Float64Array.from([elev]) });
  }

  _evalProfile(k, h, w, acc) {
    const P = this.profiles[k], z = P.z, n = z.length;
    if (h <= z[0]) {
      const T0 = P.T[0];
      acc.u += w * P.u[0]; acc.v += w * P.v[0]; acc.T += w * T0;
      acc.lnp += w * (P.lnp[0] - G0 * (h - z[0]) / (R_AIR * T0));
      return;
    }
    if (h >= z[n - 1]) {
      if (this._stdZ !== h) { stdAtm(h, this._std); this._stdZ = h; }
      const s = this._std;
      acc.u += w * P.u[n - 1]; acc.v += w * P.v[n - 1];
      acc.lnp += w * (P.lnp[n - 1] + Math.log(s.p) - this.topLnpStd[k]);
      acc.T += w * (s.T + (P.T[n - 1] - this.topTStd[k]) * Math.exp(-(h - z[n - 1]) / 8000));
      return;
    }
    let j = this.hint[k];
    if (j > n - 2) j = n - 2;
    while (j > 0 && z[j] > h) j--;
    while (j < n - 2 && z[j + 1] <= h) j++;
    this.hint[k] = j;
    const f = (h - z[j]) / (z[j + 1] - z[j]);
    acc.u += w * (P.u[j] + (P.u[j + 1] - P.u[j]) * f);
    acc.v += w * (P.v[j] + (P.v[j + 1] - P.v[j]) * f);
    acc.T += w * (P.T[j] + (P.T[j + 1] - P.T[j]) * f);
    acc.lnp += w * (P.lnp[j] + (P.lnp[j + 1] - P.lnp[j]) * f);
  }

  /** 任意点の大気状態 → out {u, v, T, p, rho, a}（u:東向き風, v:北向き風） */
  sample(lat, lon, h, t, out) {
    const ax = this._ax, ay = this._ay, at = this._at;
    ax.out = ay.out = at.out = false;
    axis(this.lons, lon, ax); axis(this.lats, lat, ay); axis(this.times, t, at);
    if (ax.out || ay.out) this.outOfGrid = true;
    const nx = this.nx, ny = this.ny;
    const acc = out; acc.u = 0; acc.v = 0; acc.T = 0; acc.lnp = 0;
    const dxs = nx > 1 ? 2 : 1, dys = ny > 1 ? 2 : 1, dts = this.nt > 1 ? 2 : 1;
    for (let dt = 0; dt < dts; dt++) {
      const wt = dts === 1 ? 1 : (dt ? at.w : 1 - at.w);
      if (wt === 0) continue;
      for (let dy = 0; dy < dys; dy++) {
        const wy = dys === 1 ? 1 : (dy ? ay.w : 1 - ay.w);
        if (wy === 0) continue;
        for (let dx = 0; dx < dxs; dx++) {
          const wx = dxs === 1 ? 1 : (dx ? ax.w : 1 - ax.w);
          if (wx === 0) continue;
          const k = ((at.i + dt) * ny + ay.i + dy) * nx + ax.i + dx;
          this._evalProfile(k, h, wt * wy * wx, acc);
        }
      }
    }
    out.p = Math.exp(acc.lnp);
    out.rho = out.p / (R_AIR * out.T);
    out.a = Math.sqrt(GAMMA * R_AIR * out.T);
    return out;
  }

  /** 地表標高 [m]。詳細地形があればそれを優先 */
  ground(lat, lon) {
    const t = this.terrain;
    if (t) {
      const r = bilinear(t.lats, t.lons, t.elev, lat, lon);
      if (!r.out) return r.value;
    }
    return bilinear(this.lats, this.lons, this.elev, lat, lon).value;
  }
}

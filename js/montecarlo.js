// モンテカルロ法による落下地点のばらつき評価
import { simulate } from './sim.js';
import { RE } from './atmosphere.js';

const D2R = Math.PI / 180;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// 1σの既定値（気象予報の誤差・機体の製作誤差の目安）
export const DEFAULT_SIGMA = {
  windAbs: 1.5,      // 風の予報誤差 [m/s]
  windFrac: 0.05,    // 風速に比例する誤差 [割合]
  gas: 0.03,         // 充填ガス量 [割合]
  ascent: 0.05,      // 上昇速度（簡易モデル）[割合]
  burstD: 0.06,      // 破裂直径 [割合]
  burstAlt: 0.04,    // 破裂高度（簡易モデル）[割合]
  balloonCd: 0.08,
  chute: 0.08,       // パラシュート抗力 [割合]
  thrust: 0.02,      // 総力積 [割合]
  cd: 0.08,          // 機体Cd [割合]
  mass: 0.01,        // 機体質量 [割合]
  elev: 0.5,         // 発射仰角 [度]
  azi: 1.0,          // 発射方位 [度]
  misalign: 0.15,    // 推力の偏心 [度]
  releaseAlt: 300,   // ロックーン点火高度 [m]
  deployDelay: 0.3,  // 開傘タイミング [s]
};

/** 高度方向に相関を持つ風の誤差（2kmごとの節点、AR(1)で滑らかにつなぐ） */
function windError(rng, sig, scale) {
  const n = 61, rho = 0.7, q = Math.sqrt(1 - rho * rho);
  const eu = new Float64Array(n), ev = new Float64Array(n);
  eu[0] = gaussian(rng); ev[0] = gaussian(rng);
  for (let i = 1; i < n; i++) {
    eu[i] = rho * eu[i - 1] + q * gaussian(rng);
    ev[i] = rho * ev[i - 1] + q * gaussian(rng);
  }
  return { dz: 2000, eu, ev, s0: sig.windAbs * scale, frac: sig.windFrac * scale };
}

export function perturb(cfg, sig, rng, scale = 1) {
  const c = structuredClone(cfg);
  const N = () => gaussian(rng) * scale;
  if (c.balloon) {
    c.balloon.gasScale = 1 + sig.gas * N();
    c.balloon.cdScale = 1 + sig.balloonCd * N();
    c.balloon.ascentScale = 1 + sig.ascent * N();
    c.balloon.burstScale = 1 + (c.balloon.model === 'latex' ? sig.burstD : sig.burstAlt) * N();
  }
  if (c.descent) c.descent.chuteScale = 1 + sig.chute * N();
  if (c.rocket) {
    const R = c.rocket;
    R.thrustScale = 1 + sig.thrust * N();
    R.cdScale = 1 + sig.cd * N();
    R.dryMass *= 1 + sig.mass * N();
    R.rail = { ...R.rail, elev: Math.min(90, R.rail.elev + sig.elev * N()), azi: R.rail.azi + sig.azi * N() };
    const m = Math.tan(sig.misalign * D2R);
    R.misalign = [m * N(), m * N(), m * N()];
    if (R.recovery && R.recovery.type !== 'none') {
      R.recovery = { ...R.recovery, chuteScale: 1 + sig.chute * N(), delay: (R.recovery.delay || 0) + sig.deployDelay * N() };
    }
  }
  if (c.rockoon) c.rockoon.releaseOffset = sig.releaseAlt * N();
  // 風の誤差は予報由来なので、機体側の倍率（scale）はかけない
  return { cfg: c, windErr: windError(rng, sig, 1) };
}

function decimate(path, max = 150) {
  if (path.length <= max) return path.map((p) => [p.lat, p.lon, p.h]);
  const out = [], step = (path.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) { const p = path[Math.round(i * step)]; out.push([p.lat, p.lon, p.h]); }
  return out;
}

export function runMonteCarlo(cfg, atm, sig, n, seed, onProgress, groundMargin = 0) {
  const rng = mulberry32(seed);
  const runs = [];
  for (let i = 0; i < n; i++) {
    const { cfg: c, windErr } = perturb(cfg, sig, rng, sig.scale ?? 1);
    const r = simulate(c, { atm, windErr, groundMargin }, { record: true, sparse: true });
    if (r.landing) {
      runs.push({
        lat: r.landing.lat, lon: r.landing.lon, t: r.landing.t, v: r.landing.v,
        apogee: r.stats.apogee ?? r.stats.burstAlt ?? null,
        burstAlt: r.stats.burstAlt ?? null,
        path: decimate(r.path),
        ground: r.landing.h,
      });
    }
    if (onProgress && (i % 5 === 4 || i === n - 1)) onProgress(i + 1, n);
  }
  return runs;
}

/** 落下点の統計（平均・共分散・確率楕円・CEP） */
export function landingStats(points, ref) {
  const cl = Math.cos(ref.lat * D2R);
  const xy = points.map((p) => [(p.lon - ref.lon) * D2R * RE * cl, (p.lat - ref.lat) * D2R * RE]);
  const n = xy.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const [x, y] of xy) { mx += x; my += y; }
  mx /= n; my /= n;
  let a = 0, b = 0, c = 0;
  for (const [x, y] of xy) { a += (x - mx) ** 2; b += (x - mx) * (y - my); c += (y - my) ** 2; }
  a /= n - 1; b /= n - 1; c /= n - 1;
  const tr = (a + c) / 2, d = Math.sqrt(((a - c) / 2) ** 2 + b * b);
  const l1 = tr + d, l2 = Math.max(tr - d, 0);
  const angle = 0.5 * Math.atan2(2 * b, a - c); // x軸（東）からの角度
  const dists = xy.map(([x, y]) => Math.hypot(x - mx, y - my)).sort((p, q) => p - q);
  const quant = (q) => dists[Math.min(n - 1, Math.floor(q * n))];
  const ellipse = (p) => {
    const k = Math.sqrt(-2 * Math.log(1 - p));
    return { p, a: k * Math.sqrt(l1), b: k * Math.sqrt(l2), angle };
  };
  return {
    n, ref,
    mean: { lat: ref.lat + my / (D2R * RE), lon: ref.lon + mx / (D2R * RE * cl) },
    meanXY: [mx, my], cov: [a, b, c],
    ellipses: [ellipse(0.5), ellipse(0.95), ellipse(0.99)],
    cep50: quant(0.5), r95: quant(0.95),
  };
}

/** 楕円を緯度経度の多角形に変換 */
export function ellipsePolygon(stats, e, nPts = 72) {
  const cl = Math.cos(stats.ref.lat * D2R);
  const [mx, my] = stats.meanXY;
  const pts = [];
  for (let i = 0; i <= nPts; i++) {
    const th = 2 * Math.PI * i / nPts;
    const x0 = e.a * Math.cos(th), y0 = e.b * Math.sin(th);
    const x = mx + x0 * Math.cos(e.angle) - y0 * Math.sin(e.angle);
    const y = my + x0 * Math.sin(e.angle) + y0 * Math.cos(e.angle);
    pts.push([stats.ref.lat + y / (D2R * RE), stats.ref.lon + x / (D2R * RE * cl)]);
  }
  return pts;
}

/** 2点間の距離[m]と方位角[度]（球面） */
export function distBearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const d = 2 * RE * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { d, brg: (Math.atan2(y, x) / D2R + 360) % 360 };
}

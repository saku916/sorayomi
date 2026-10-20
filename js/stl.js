// 3Dモデル（STL）の読み込みと形状解析、抗力係数の推定
//  形状から：全長・胴体径・正面投影面積・側面投影面積・表面積・体積・ノーズ長・フィン高さ
//  抗力：部品ごとの積み上げ法（摩擦抵抗＋底面抵抗＋ノーズ造波抵抗＋フィン前縁抵抗）

/** STL（バイナリ/ASCII）→ 三角形の頂点配列 Float32Array（三角形ごとに9要素） */
export function parseSTL(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let j = 0; j < 9; j++) out[i * 9 + j] = dv.getFloat32(o + j * 4, true);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(buf);
  const v = [];
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  let m;
  while ((m = re.exec(text))) v.push(+m[1], +m[2], +m[3]);
  if (!v.length || v.length % 9) throw new Error('STLファイルを読めませんでした');
  return Float32Array.from(v);
}

/** 平面に投影した面積をラスタ化して求める（重なりは1回だけ数える） */
function projectedArea(tris, ia, ib, res = 512) {
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    a0 = Math.min(a0, tris[i + ia]); a1 = Math.max(a1, tris[i + ia]);
    b0 = Math.min(b0, tris[i + ib]); b1 = Math.max(b1, tris[i + ib]);
  }
  const cell = Math.max(a1 - a0, b1 - b0) / res;
  const na = Math.ceil((a1 - a0) / cell) + 1, nb = Math.ceil((b1 - b0) / cell) + 1;
  const grid = new Uint8Array(na * nb);
  for (let t = 0; t < tris.length; t += 9) {
    const ax = (tris[t + ia] - a0) / cell, ay = (tris[t + ib] - b0) / cell;
    const bx = (tris[t + 3 + ia] - a0) / cell, by = (tris[t + 3 + ib] - b0) / cell;
    const cx = (tris[t + 6 + ia] - a0) / cell, cy = (tris[t + 6 + ib] - b0) / cell;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    const xs = Math.max(0, Math.floor(Math.min(ax, bx, cx))), xe = Math.min(na - 1, Math.ceil(Math.max(ax, bx, cx)));
    const ys = Math.max(0, Math.floor(Math.min(ay, by, cy))), ye = Math.min(nb - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = ys; y <= ye; y++) {
      for (let x = xs; x <= xe; x++) {
        const px = x + 0.5, py = y + 0.5;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        if (l1 >= -1e-9 && l2 >= -1e-9 && 1 - l1 - l2 >= -1e-9) grid[y * na + x] = 1;
      }
    }
  }
  let c = 0;
  for (let i = 0; i < grid.length; i++) c += grid[i];
  return c * cell * cell;
}

/**
 * 形状解析。unit: 1単位あたりのメートル（mm=0.001）、axis: 'auto'|'x'|'y'|'z'
 */
export function analyzeSTL(raw, { unit = 0.001, axis = 'auto' } = {}) {
  const tris = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) tris[i] = raw[i] * unit;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], tris[i + k]); max[k] = Math.max(max[k], tris[i + k]); }
  }
  const ext = max.map((m, k) => m - min[k]);
  const ax = axis === 'auto' ? ext.indexOf(Math.max(...ext)) : { x: 0, y: 1, z: 2 }[axis];
  const p1 = (ax + 1) % 3, p2 = (ax + 2) % 3;
  const length = ext[ax];

  // 表面積・体積・体積重心
  let S = 0, V = 0;
  const cen = [0, 0, 0];
  for (let t = 0; t < tris.length; t += 9) {
    const a = [tris[t], tris[t + 1], tris[t + 2]], b = [tris[t + 3], tris[t + 4], tris[t + 5]], c = [tris[t + 6], tris[t + 7], tris[t + 8]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    S += Math.hypot(...cr) / 2;
    const dv = (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    V += dv;
    for (let k = 0; k < 3; k++) cen[k] += dv * (a[k] + b[k] + c[k]) / 4;
  }
  for (let k = 0; k < 3; k++) cen[k] = V !== 0 ? cen[k] / V : (min[k] + max[k]) / 2;
  V = Math.abs(V);

  // 機軸に沿った半径分布（三角形の内部も細かくサンプリングする）
  const nb = 120, binW = length / nb;
  const rBin = new Float64Array(nb);
  const c1 = (min[p1] + max[p1]) / 2, c2 = (min[p2] + max[p2]) / 2;
  const addPt = (x, y, z) => {
    const P = [x, y, z];
    const i = Math.min(nb - 1, Math.max(0, Math.floor((P[ax] - min[ax]) / binW)));
    const r = Math.hypot(P[p1] - c1, P[p2] - c2);
    if (r > rBin[i]) rBin[i] = r;
  };
  for (let t = 0; t < tris.length; t += 9) {
    const xa = tris[t + ax], xb = tris[t + 3 + ax], xc = tris[t + 6 + ax];
    const n = Math.min(60, Math.max(1, Math.ceil((Math.max(xa, xb, xc) - Math.min(xa, xb, xc)) / binW)));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const l1 = i / n, l2 = j / n, l3 = 1 - l1 - l2;
        addPt(l1 * tris[t] + l2 * tris[t + 3] + l3 * tris[t + 6],
          l1 * tris[t + 1] + l2 * tris[t + 4] + l3 * tris[t + 7],
          l1 * tris[t + 2] + l2 * tris[t + 5] + l3 * tris[t + 8]);
      }
    }
  }
  const mid = Array.from(rBin.slice(Math.floor(nb * 0.2), Math.ceil(nb * 0.8))).filter((r) => r > 0).sort((a, b) => a - b);
  const rBody = mid.length ? mid[Math.floor(mid.length / 2)] : Math.max(ext[p1], ext[p2]) / 2;
  const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  const head = avg(Array.from(rBin.slice(0, 6))), tail = avg(Array.from(rBin.slice(nb - 6)));
  const noseAtMin = head < tail; // ノーズ側：先端の半径が小さい方
  const ordered = noseAtMin ? Array.from(rBin) : Array.from(rBin).reverse();
  let iNose = ordered.findIndex((r) => r >= 0.95 * rBody);
  if (iNose < 0) iNose = 0;
  const noseLength = (iNose + 0.5) * binW;
  const finR = Math.max(...ordered.slice(Math.floor(nb * 0.5)));
  const finSpan = finR > rBody * 1.25 ? finR - rBody : 0;

  const frontalArea = projectedArea(tris, p1, p2);
  const sideArea = Math.max(projectedArea(tris, ax, p1), projectedArea(tris, ax, p2));
  const bodyArea = Math.PI * rBody * rBody;

  // 側面投影の図心（簡易的な圧力中心の目安）：ノーズ先端からの距離
  let cpNum = 0, cpDen = 0;
  for (let i = 0; i < nb; i++) { const r = ordered[i]; cpNum += r * (i + 0.5) * binW; cpDen += r; }
  const cpFromNose = cpDen ? cpNum / cpDen : length / 2;
  const cgFromNose = noseAtMin ? cen[ax] - min[ax] : max[ax] - cen[ax];

  return {
    triCount: raw.length / 9, unit, axis: ['x', 'y', 'z'][ax], length,
    bodyDiameter: 2 * rBody, finSpan, noseLength,
    frontalArea, sideArea, wettedArea: S, volume: V, bodyArea,
    cpFromNose, cgFromNose, rProfile: ordered, binW,
    bounds: { min, max }, axisIndex: ax, noseAtMin,
  };
}

/**
 * 部品積み上げ法による Cd(マッハ数) の推定（基準面積＝胴体断面積）。
 * 精度は形状により ±20% 程度。風洞・CFDの値があればそちらを使うこと。
 */
export function estimateCd(g, { baseRatio = 1, roughness = 20e-6 } = {}) {
  const L = g.length, d = g.bodyDiameter, Aref = g.bodyArea;
  const f = L / d;
  const FF = 1 + 60 / f ** 3 + 0.0025 * f;           // 胴体の形状係数（Hoerner）
  const finFront = Math.max(0, g.frontalArea - Aref);  // フィン等の正面面積
  const sigma = Math.atan(d / 2 / Math.max(g.noseLength, d / 4)) * 180 / Math.PI; // 等価円錐半頂角[度]
  const Mach = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.3, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
  const nu = 1.46e-5, a = 340.3;
  const cfAt = (M) => {
    const V = Math.max(M * a, 30), Re = V * L / nu;
    let cf = Re < 5e5 ? 1.328 / Math.sqrt(Re) : 0.074 / Math.pow(Re, 0.2);
    cf = Math.max(cf, 0.032 * Math.pow(roughness / L, 0.2)); // 表面粗さによる下限
    return M < 1 ? cf * (1 - 0.1 * M * M) : cf / Math.pow(1 + 0.15 * M * M, 0.58);
  };
  const base = (M) => (M < 1 ? 0.12 + 0.13 * M * M : 0.25 / M) * baseRatio;
  const noseWave = (M) => (M <= 1 ? 0 : 0.8 * (0.083 + 0.096 / (M * M)) * Math.pow(sigma / 10, 1.69));
  const finLE = (M) => (M < 0.9 ? 0.12 : M < 1.2 ? 0.12 + (M - 0.9) / 0.3 * 0.68 : 0.8 * Math.sqrt(1.2 / M));
  const sub = (M) => cfAt(M) * FF * g.wettedArea / Aref + base(M) + finLE(M) * finFront / Aref;
  const cd08 = sub(0.8), wave12 = noseWave(1.2);
  const table = Mach.map((M) => {
    let cd = sub(M);
    if (M > 0.8 && M < 1.2) {
      const s = (M - 0.8) / 0.4;
      cd += wave12 * s * s + 0.3 * cd08 * Math.sin(Math.PI * Math.min(1, (M - 0.8) / 0.5));
    } else if (M >= 1.2) cd += noseWave(M);
    return [M, +(cd * 1.08).toFixed(4)]; // ランチラグ等の突起分 +8%
  });
  return { table, aref: Aref, cd0: cdInterp(table, 0.3), fineness: f, noseHalfAngle: sigma };
}

function cdInterp(t, M) {
  for (let i = 1; i < t.length; i++) if (M <= t[i][0]) return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (M - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
  return t[t.length - 1][1];
}

/** テスト・サンプル用：ノーズコーン＋円筒＋フィン4枚のロケット形状をSTL三角形で生成 */
export function makeSampleRocket({ d = 0.1, L = 1.5, nose = 0.3, finH = 0.08, finC = 0.15, finT = 0.004, seg = 48 } = {}) {
  const out = [];
  let part = [];
  const r = d / 2;
  const tri = (a, b, c) => part.push(...a, ...b, ...c);
  // 閉じた部品ごとに符号付き体積を見て、面が外向きになるよう揃える
  const flush = () => {
    let v = 0;
    for (let t = 0; t < part.length; t += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = part.slice(t, t + 9);
      v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    if (v < 0) for (let t = 0; t < part.length; t += 9) for (let k = 0; k < 3; k++) [part[t + 3 + k], part[t + 6 + k]] = [part[t + 6 + k], part[t + 3 + k]];
    out.push(...part); part = [];
  };
  const ring = (z, rr) => Array.from({ length: seg }, (_, i) => { const t = 2 * Math.PI * i / seg; return [rr * Math.cos(t), rr * Math.sin(t), z]; });
  // ノーズ（タンジェントオジャイブ近似を10段で）
  const nst = 10;
  let prev = null;
  for (let k = 0; k <= nst; k++) {
    const x = nose * k / nst;
    const rr = r * Math.sqrt(1 - (1 - x / nose) ** 2);
    const rg = ring(L - x, Math.max(rr, 1e-6));
    if (prev) for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; tri(prev[i], rg[j], prev[j]); tri(prev[i], rg[i], rg[j]); }
    prev = rg;
  }
  // 胴体
  const top = ring(L - nose, r), bot = ring(0, r);
  for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; tri(bot[i], bot[j], top[j]); tri(bot[i], top[j], top[i]); }
  // 底面
  for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; tri([0, 0, 0], bot[j], bot[i]); }
  flush();
  // フィン（薄い板＝直方体）
  for (let f = 0; f < 4; f++) {
    const th = f * Math.PI / 2, c = Math.cos(th), s = Math.sin(th), nx = -s, ny = c;
    const P = (rad, z, side) => [rad * c + side * nx * finT / 2, rad * s + side * ny * finT / 2, z];
    const v = [P(r, 0, -1), P(r + finH, 0, -1), P(r + finH, finC * 0.6, -1), P(r, finC, -1),
      P(r, 0, 1), P(r + finH, 0, 1), P(r + finH, finC * 0.6, 1), P(r, finC, 1)];
    const q = (a, b, cc, dd) => { tri(v[a], v[b], v[cc]); tri(v[a], v[cc], v[dd]); };
    q(0, 3, 2, 1); q(4, 5, 6, 7); q(0, 1, 5, 4); q(1, 2, 6, 5); q(2, 3, 7, 6); q(3, 0, 4, 7);
    flush();
  }
  return Float32Array.from(out);
}

/** 三角形配列 → バイナリSTL */
export function toBinarySTL(tris) {
  const n = tris.length / 9, buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) for (let j = 0; j < 9; j++) dv.setFloat32(84 + i * 50 + 12 + j * 4, tris[i * 9 + j], true);
  return buf;
}

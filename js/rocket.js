// ロケット関連：モーター（推力曲線）と抗力係数（Cd-マッハ数）

/** RASP形式（.eng）の推力曲線を読む */
export function parseEng(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean);
  if (!lines.length) throw new Error('.engファイルが空です');
  const h = lines[0].split(/\s+/);
  if (h.length < 7) throw new Error('.engファイルのヘッダ行を読めません');
  const t = [0], F = [0];
  for (const l of lines.slice(1)) {
    const [a, b] = l.split(/\s+/).map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a === 0) { F[0] = b; continue; }
    if (a <= t[t.length - 1]) continue;
    t.push(a); F.push(b);
  }
  if (t.length < 2) throw new Error('.engファイルに推力データがありません');
  return makeMotor({
    name: h[0], diameter: +h[1] / 1000, length: +h[2] / 1000,
    propMass: +h[4], totalMass: +h[5], maker: h.slice(6).join(' '), t, F,
  });
}

/** 平均推力・燃焼時間から台形の推力曲線を作る */
export function parametricMotor({ thrust, burnTime, propMass, totalMass, name = 'パラメトリック' }) {
  const r = Math.min(0.05, burnTime * 0.05);
  // 立ち上がり/立ち下がりを含めて平均推力が指定値になるようにピークを調整
  const peak = thrust * burnTime / (burnTime - r);
  return makeMotor({ name, propMass, totalMass, t: [0, r, burnTime - r, burnTime], F: [0, peak, peak, 0], diameter: 0, length: 0 });
}

export function makeMotor(m) {
  const { t, F } = m;
  const I = [0];
  for (let i = 1; i < t.length; i++) I.push(I[i - 1] + 0.5 * (F[i] + F[i - 1]) * (t[i] - t[i - 1]));
  const Itot = I[I.length - 1];
  const tb = t[t.length - 1];
  return { ...m, I, Itot, tb, avgThrust: Itot / tb, maxThrust: Math.max(...F),
    isp: m.propMass > 0 ? Itot / (m.propMass * 9.80665) : 0 };
}

function seg(t, x) {
  if (x <= t[0]) return -1;
  if (x >= t[t.length - 1]) return t.length - 1;
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= x) lo = m; else hi = m; }
  return lo;
}

export function thrustAt(motor, x) {
  const { t, F } = motor, i = seg(t, x);
  if (i < 0 || i >= t.length - 1) return 0;
  return F[i] + (F[i + 1] - F[i]) * (x - t[i]) / (t[i + 1] - t[i]);
}

/** 0〜xまでの累積力積 */
export function impulseAt(motor, x) {
  const { t, F, I } = motor, i = seg(t, x);
  if (i < 0) return 0;
  if (i >= t.length - 1) return motor.Itot;
  const dt = x - t[i], f = F[i] + (F[i + 1] - F[i]) * dt / (t[i + 1] - t[i]);
  return I[i] + 0.5 * (F[i] + f) * dt;
}

/** 典型的な小型ロケットのCd-マッハ曲線（亜音速Cd0を基準に形を与える） */
export function defaultCdCurve(cd0) {
  const pts = [[0, 1], [0.6, 1], [0.8, 1.03], [0.9, 1.15], [0.95, 1.35], [1.0, 1.6], [1.05, 1.75], [1.1, 1.72],
    [1.2, 1.62], [1.5, 1.45], [2.0, 1.28], [2.5, 1.15], [3.0, 1.05], [4.0, 0.92], [5.0, 0.85], [8.0, 0.78]];
  return pts.map(([M, f]) => [M, cd0 * f]);
}

export function cdAt(table, M) {
  if (M <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (M <= table[i][0]) {
      const [m0, c0] = table[i - 1], [m1, c1] = table[i];
      return c0 + (c1 - c0) * (M - m0) / (m1 - m0);
    }
  }
  return table[table.length - 1][1];
}

/** "マッハ数,Cd" のCSV（OpenRocket/RASAeroの書き出しなど）を読む */
export function parseCdCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split(/[,\t;]/).map((s) => parseFloat(s));
    if (cols.length >= 2 && Number.isFinite(cols[0]) && Number.isFinite(cols[1])) rows.push([cols[0], cols[1]]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  if (rows.length < 2) throw new Error('Cd-マッハ数のCSVを読めません（「マッハ数,Cd」の2列が必要）');
  return rows;
}

export const SAMPLE_ENG = `; サンプル推力曲線（実在モーターのデータではありません。形の確認用）
SAMPLE-H180 38 250 0 0.125 0.290 SORAYOMI
0.02 120
0.05 230
0.10 215
0.30 205
0.60 195
0.90 180
1.10 150
1.20 80
1.28 0
`;

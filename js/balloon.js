// 気球関連：プリセット・浮揚ガス・充填量の計算

// 破裂直径は各メーカー公表値の代表値。実際の機体はメーカーのデータシートで確認すること。
export const BALLOONS = [
  { id: 'totex-200', name: 'Totex TA200', mass: 200, burstD: 3.00 },
  { id: 'totex-350', name: 'Totex TA350', mass: 350, burstD: 4.12 },
  { id: 'totex-500', name: 'Totex TA500', mass: 500, burstD: 4.99 },
  { id: 'totex-800', name: 'Totex TA800', mass: 800, burstD: 7.00 },
  { id: 'totex-1000', name: 'Totex TA1000', mass: 1000, burstD: 7.86 },
  { id: 'totex-1200', name: 'Totex TA1200', mass: 1200, burstD: 8.63 },
  { id: 'totex-1500', name: 'Totex TA1500', mass: 1500, burstD: 9.44 },
  { id: 'totex-2000', name: 'Totex TA2000', mass: 2000, burstD: 10.54 },
  { id: 'totex-3000', name: 'Totex TA3000', mass: 3000, burstD: 13.00 },
  { id: 'hwoyee-100', name: 'Hwoyee 100g', mass: 100, burstD: 2.00 },
  { id: 'hwoyee-300', name: 'Hwoyee 300g', mass: 300, burstD: 3.80 },
  { id: 'hwoyee-600', name: 'Hwoyee 600g', mass: 600, burstD: 5.80 },
  { id: 'hwoyee-1000', name: 'Hwoyee 1000g', mass: 1000, burstD: 7.50 },
  { id: 'hwoyee-1600', name: 'Hwoyee 1600g', mass: 1600, burstD: 10.50 },
];

export const GASES = {
  helium: { name: 'ヘリウム', M: 4.002602e-3 },
  hydrogen: { name: '水素', M: 2.01588e-3 },
};
const M_AIR = 28.9647e-3, R_UNIV = 8.314462618;

/** 純度を考慮した浮揚ガスの気体定数 [J/kg/K] */
export function gasConstant(gas, purity = 1) {
  const M = purity * GASES[gas].M + (1 - purity) * M_AIR;
  return R_UNIV / M;
}

/**
 * 地上での充填状態を決める。
 * mode: 'necklift'（ネックリフト kg）| 'ascent'（目標上昇速度 m/s）| 'volume'（ガス体積 m3）
 * 戻り値: { gasMass, V0, neckLift, freeLift, ascentRate }
 */
export function solveFill({ mode, value, balloonMass, payloadMass, gas, purity, cd, rho, p, T }) {
  const Rg = gasConstant(gas, purity);
  const rhoG = p / (Rg * T);
  const fromVolume = (V0) => {
    const gross = (rho - rhoG) * V0;
    const neckLift = gross - balloonMass;
    const freeLift = neckLift - payloadMass;
    const D = Math.cbrt(6 * V0 / Math.PI);
    const A = Math.PI * D * D / 4;
    const ascentRate = freeLift > 0 ? Math.sqrt(2 * freeLift * 9.80665 / (rho * cd * A)) : 0;
    return { gasMass: rhoG * V0, V0, neckLift, freeLift, ascentRate, D0: D };
  };
  if (mode === 'volume') return fromVolume(value);
  if (mode === 'necklift') return fromVolume((value + balloonMass) / (rho - rhoG));
  // 目標上昇速度：ネックリフトを二分法で探す
  let lo = payloadMass + 1e-4, hi = payloadMass + 200;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const r = fromVolume((mid + balloonMass) / (rho - rhoG));
    if (r.ascentRate < value) lo = mid; else hi = mid;
  }
  return fromVolume((hi + balloonMass) / (rho - rhoG));
}

/** パラシュートなどの抗力面積 [m2] */
export const chuteCdA = (dia, cd) => cd * Math.PI * dia * dia / 4;

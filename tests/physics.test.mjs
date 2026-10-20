// 物理モデルの検証テスト：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { stdAtm, AtmosphereField, gravity } from '../js/atmosphere.js';
import { simulate } from '../js/sim.js';
import { parametricMotor, defaultCdCurve, parseEng, SAMPLE_ENG } from '../js/rocket.js';
import { solveFill, chuteCdA } from '../js/balloon.js';
import { distBearing, landingStats, runMonteCarlo, DEFAULT_SIGMA } from '../js/montecarlo.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const D2R = Math.PI / 180;

test('標準大気が US1976 の表と一致する', () => {
  near(stdAtm(0).rho, 1.225, 0.001, '海面密度');
  near(stdAtm(11000).rho, 0.3639, 0.001, '11km密度');
  near(stdAtm(20000).p, 5529, 10, '20km気圧');
  near(stdAtm(32000).T, 228.5, 0.5, '32km気温');
  near(stdAtm(50000).p, 79.78, 0.5, '50km気圧');
});

const motionless = () => AtmosphereField.fromStandard({ lat: 35, lon: 139, top: 120000, step: 500 });

function rocketCfg(over = {}) {
  const motor = parametricMotor({ thrust: 2000, burnTime: 3, propMass: 2.5, totalMass: 4 });
  return {
    kind: 'rocket', launch: { lat: 35, lon: 139, alt: null, time: 0 },
    rocket: {
      motor, dryMass: 6, propMass: 2.5, cdTable: defaultCdCurve(0), aref: 0.008,
      rail: { length: 0, elev: 90, azi: 0 }, stiffness: 50, exitArea: 0, recovery: { type: 'none' }, ...over,
    },
  };
}

test('真空中の鉛直打ち上げ：最高高度がエネルギー保存と一致', () => {
  const cfg = rocketCfg();
  const r = simulate(cfg, { atm: motionless() }, { record: false });
  const bo = r.events.find((e) => e.type === 'burnout');
  const v = r.stats.burnoutV, g = gravity(35 * D2R, bo.h);
  // 逆二乗重力場での到達高度
  const mu = g * (6371008.8 + bo.h) ** 2, r0 = 6371008.8 + bo.h;
  const rMax = 1 / (1 / r0 - v * v / (2 * mu));
  near(r.stats.apogee, rMax - 6371008.8, (rMax - 6371008.8) * 0.003, '最高高度');
});

test('鉛直に上げて落とすと、コリオリ力で西にずれる（理論値 4/3·ω·cosφ·√(8h³/g)）', () => {
  const cfg = rocketCfg({ motor: parametricMotor({ thrust: 3000, burnTime: 0.2, propMass: 0.05, totalMass: 0.1 }), dryMass: 1, propMass: 0.05 });
  const r = simulate(cfg, { atm: motionless() }, { record: false });
  const H = r.stats.apogee - r.stats.burnoutAlt;
  const theory = 4 / 3 * 7.2921159e-5 * Math.cos(35 * D2R) * Math.sqrt(8 * H ** 3 / 9.797);
  const dx = (r.landing.lon - 139) * D2R * 6371008.8 * Math.cos(35 * D2R);
  assert.ok(dx < 0, '西向きにずれる');
  near(-dx, theory, theory * 0.1, '西への偏差[m]');
});

test('パラシュート降下速度が終端速度の式と一致', () => {
  const m = 2, cdA = chuteCdA(1.2, 0.8);
  const cfg = {
    kind: 'balloon', launch: { lat: 35, lon: 139, alt: null, time: 0 },
    balloon: { model: 'constant', ascentRate: 5, burstAlt: 3000 },
    descent: { mode: 'chute', mass: m, cdA },
  };
  const r = simulate(cfg, { atm: motionless() }, { record: false });
  near(r.landing.v, Math.sqrt(2 * m * 9.797 / (1.225 * cdA)), 0.05, '着地速度');
});

test('一様な風で気球が風下に流される距離が理論値どおり', () => {
  const atm = AtmosphereField.fromStandard({ lat: 35, lon: 139, wind: () => [10, 0], top: 40000 });
  const cfg = {
    kind: 'balloon', launch: { lat: 35, lon: 139, alt: null, time: 0 },
    balloon: { model: 'constant', ascentRate: 5, burstAlt: 10000 },
    descent: { mode: 'rate', mass: 1, rate: 5 },
  };
  const r = simulate(cfg, { atm }, { record: false });
  const { d, brg } = distBearing(35, 139, r.landing.lat, r.landing.lon);
  near(d, 10 * r.landing.t, 10 * r.landing.t * 0.002, '流された距離');
  near(brg, 90, 0.5, '東向き');
});

test('ラテックス気球（1200g・ペイロード1kg・上昇5m/s）の破裂高度が妥当（31〜36km）', () => {
  const cfg = {
    kind: 'balloon', launch: { lat: 35, lon: 139, alt: null, time: 0 },
    balloon: { model: 'latex', balloonMass: 1.2, burstD: 8.63, cd: 0.3, gas: 'helium', purity: 1,
      fill: { mode: 'ascent', value: 5 }, payloadMass: 1.0 },
    descent: { mode: 'chute', mass: 1.2, cdA: chuteCdA(1.0, 0.8) },
  };
  const r = simulate(cfg, { atm: motionless() }, { record: false });
  assert.ok(r.stats.burstAlt > 31000 && r.stats.burstAlt < 36000, `破裂高度 ${r.stats.burstAlt}`);
  near(r.stats.fill.ascentRate, 5, 0.01, '初期上昇速度');
});

test('目標上昇速度から求めた充填量を使うと、その速度が再現される', () => {
  const s = stdAtm(0);
  const f = solveFill({ mode: 'ascent', value: 4, balloonMass: 0.6, payloadMass: 0.8, gas: 'helium', purity: 0.99, cd: 0.3, rho: s.rho, p: s.p, T: s.T });
  const g = solveFill({ mode: 'necklift', value: f.neckLift, balloonMass: 0.6, payloadMass: 0.8, gas: 'helium', purity: 0.99, cd: 0.3, rho: s.rho, p: s.p, T: s.T });
  near(g.ascentRate, 4, 1e-6, '上昇速度');
});

test('.engファイルの読み込みと総力積', () => {
  const m = parseEng(SAMPLE_ENG);
  assert.equal(m.name, 'SAMPLE-H180');
  near(m.tb, 1.28, 1e-9, '燃焼時間');
  assert.ok(m.Itot > 200 && m.Itot < 260, `総力積 ${m.Itot}`);
});

test('空気抵抗ありのロケット：二段開傘で着地し、イベント順序が正しい', () => {
  const cfg = rocketCfg({
    cdTable: defaultCdCurve(0.45), rail: { length: 5, elev: 85, azi: 90 },
    recovery: { type: 'dual', trigger: 'apogee', delay: 1, drogueCdA: chuteCdA(0.6, 0.8), mainCdA: chuteCdA(2, 0.8), mainAlt: 300 },
  });
  const r = simulate(cfg, { atm: AtmosphereField.fromStandard({ lat: 35, lon: 139, wind: () => [5, 0], top: 40000 }) }, {});
  const order = r.events.map((e) => e.type);
  assert.deepEqual(order, ['launch', 'ignition', 'rail_exit', 'burnout', 'apogee', 'deploy', 'main', 'landing']);
  assert.ok(r.landing.v < 8, `着地速度 ${r.landing.v}`);
});

test('ロックーン：点火高度で点火し、宇宙空間（高度100km）まで届く', () => {
  const motor = parametricMotor({ thrust: 6000, burnTime: 20, propMass: 45, totalMass: 55 });
  const cfg = {
    kind: 'rockoon', launch: { lat: 35, lon: 139, alt: 0, time: 0 },
    balloon: { model: 'constant', ascentRate: 5 },
    rockoon: { releaseAlt: 30000, floatTime: 0 },
    rocket: { motor, dryMass: 25, propMass: 45, cdTable: defaultCdCurve(0.4), aref: 0.0177, exitArea: 0.004,
      rail: { length: 0, elev: 85, azi: 90 }, stiffness: 50, recovery: { type: 'single', trigger: 'apogee', delay: 0, mainCdA: chuteCdA(3, 0.8) } },
  };
  const r = simulate(cfg, { atm: motionless() }, {});
  near(r.stats.releaseAlt, 30000, 1, '点火高度');
  assert.ok(r.stats.apogee > 100000, `最高高度 ${r.stats.apogee}`);
  assert.ok(r.landing, '着地まで計算される');
});

test('モンテカルロ：落下点が散らばり、統計が計算できる', () => {
  const atm = AtmosphereField.fromStandard({ lat: 35, lon: 139, wind: () => [8, 2], top: 40000 });
  const cfg = {
    kind: 'balloon', launch: { lat: 35, lon: 139, alt: null, time: 0 },
    balloon: { model: 'latex', balloonMass: 0.6, burstD: 5.8, cd: 0.3, gas: 'helium', purity: 1, fill: { mode: 'ascent', value: 5 }, payloadMass: 0.5 },
    descent: { mode: 'chute', mass: 0.8, cdA: chuteCdA(0.8, 0.8) },
  };
  const runs = runMonteCarlo(cfg, atm, DEFAULT_SIGMA, 40, 1);
  assert.equal(runs.length, 40);
  const s = landingStats(runs, { lat: 35, lon: 139 });
  assert.ok(s.ellipses[1].a > s.ellipses[0].a && s.cep50 > 0);
});

test('降下中の指定高度で開傘し、真空に近い高空では開傘警告が出ない', () => {
  const motor = parametricMotor({ thrust: 6000, burnTime: 20, propMass: 45, totalMass: 55 });
  const cfg = {
    kind: 'rockoon', launch: { lat: 35, lon: 139, alt: 0, time: 0 },
    balloon: { model: 'constant', ascentRate: 5 }, rockoon: { releaseAlt: 30000, floatTime: 0 },
    rocket: { motor, dryMass: 25, propMass: 45, cdTable: defaultCdCurve(0.4), aref: 0.0177, exitArea: 0.004,
      rail: { length: 0, elev: 85, azi: 90 }, stiffness: 50,
      recovery: { type: 'single', trigger: 'altitude', deployAlt: 5000, mainCdA: chuteCdA(3, 0.8) } },
  };
  const r = simulate(cfg, { atm: motionless() }, { record: false });
  const dep = r.events.find((e) => e.type === 'deploy');
  near(dep.h, 5000, 100, '開傘高度');
  const hi = { ...cfg, rocket: { ...cfg.rocket, recovery: { type: 'single', trigger: 'apogee', delay: 0, mainCdA: chuteCdA(3, 0.8) } } };
  const r2 = simulate(hi, { atm: motionless() }, { record: false });
  assert.ok(!r2.warnings.some((w) => w.includes('開傘')), '高度450kmでの開傘は動圧がほぼ0なので警告しない');
});

test('タンブリングを有効にすると再突入の速度が大きく下がる', () => {
  const motor = parametricMotor({ thrust: 6000, burnTime: 20, propMass: 45, totalMass: 55 });
  const base = {
    kind: 'rockoon', launch: { lat: 35, lon: 139, alt: 0, time: 0 },
    balloon: { model: 'constant', ascentRate: 5 }, rockoon: { releaseAlt: 30000, floatTime: 0 },
    rocket: { motor, dryMass: 25, propMass: 45, cdTable: defaultCdCurve(0.4), aref: 0.0177, exitArea: 0.004,
      rail: { length: 0, elev: 85, azi: 90 }, stiffness: 50,
      recovery: { type: 'single', trigger: 'altitude', deployAlt: 8000, mainCdA: chuteCdA(3, 0.8) } },
  };
  const nose = simulate(base, { atm: motionless() }, { record: false });
  const tumble = simulate({ ...base, rocket: { ...base.rocket, tumbleCdA: 1.2 * (Math.PI * 0.15 * 3) / 4 } }, { atm: motionless() }, { record: false });
  const v = (r) => r.events.find((e) => e.type === 'deploy').v;
  assert.ok(v(tumble) < v(nose) * 0.6, `機首から ${v(nose)} m/s → 横転 ${v(tumble)} m/s`);
});

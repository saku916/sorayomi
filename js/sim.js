// 飛翔シミュレーション本体
//  気球：浮力・抗力の釣り合いから上昇速度を求め、風に乗って移動（準定常）
//  ロケット：球体地球上の3自由度運動（重力の高度変化・コリオリ力・地球曲率を含む）をRK4で積分
//  落下：パラシュート開傘直後は運動方程式で、終端速度に落ち着いたら準定常で地表まで
import { RE, OMEGA, G0, gravity } from './atmosphere.js';
import { solveFill, gasConstant } from './balloon.js';
import { thrustAt, impulseAt, cdAt } from './rocket.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const MAX_T = 48 * 3600;

export const PHASE_LABEL = {
  ascent: '気球上昇', float: '浮遊', rail: 'ランチャー', powered: '推進中', coast: '慣性飛行',
  drogue: 'ドローグ降下', main: 'メイン降下', descent: 'パラシュート降下', ballistic: '弾道落下',
};

function air(env, lat, lon, h, t, out) {
  env.atm.sample(lat * R2D, lon * R2D, h, env.t0 + t, out);
  const we = env.windErr;
  if (we) {
    const x = Math.min(Math.max(h / we.dz, 0), we.eu.length - 1.0001);
    const i = Math.floor(x), f = x - i;
    const s = we.s0 + we.frac * Math.hypot(out.u, out.v);
    out.u += (we.eu[i] + (we.eu[i + 1] - we.eu[i]) * f) * s;
    out.v += (we.ev[i] + (we.ev[i + 1] - we.ev[i]) * f) * s;
  }
  return out;
}

const groundAt = (env, lat, lon) => env.atm.ground(lat * R2D, lon * R2D);

function move(st, vE, vN, vU, dt) {
  const r = RE + st.h;
  st.lat += vN / r * dt;
  st.lon += vE / (r * Math.cos(st.lat)) * dt;
  st.h += vU * dt;
}

const INTERVAL = { ascent: 10, float: 30, rail: 0.02, powered: 0.05, coast: 0.25, ballistic: 0.25, drogue: 0.5, main: 2, descent: 4 };

function makeRecorder(res, opts) {
  const mult = opts.sparse ? 10 : 1;
  let last = -1e9;
  return {
    enabled: opts.record !== false,
    push(st, phase, extra, force) {
      if (!this.enabled) return;
      if (!force && st.t - last < INTERVAL[phase] * mult) return;
      last = st.t;
      res.path.push({ t: st.t, lat: st.lat * R2D, lon: st.lon * R2D, h: st.h,
        vE: st.vE, vN: st.vN, vU: st.vU, phase, ...extra });
    },
  };
}

function addEvent(res, rec, st, type, label, extra = {}) {
  const ev = { type, label, t: st.t, lat: st.lat * R2D, lon: st.lon * R2D, h: st.h, ...extra };
  res.events.push(ev);
  return ev;
}

// ───────────────────────────── 気球 ─────────────────────────────

function balloonAscent(st, cfg, env, res, rec, targetAlt) {
  const b = cfg.balloon, a = {};
  air(env, st.lat, st.lon, st.h, st.t, a);
  let mGas = 0, Rg = 0, mTot = 0;
  if (b.model === 'latex') {
    const fill = solveFill({ mode: b.fill.mode, value: b.fill.value, balloonMass: b.balloonMass, payloadMass: b.payloadMass,
      gas: b.gas, purity: b.purity, cd: b.cd, rho: a.rho, p: a.p, T: a.T });
    res.stats.fill = fill;
    if (fill.freeLift <= 0) {
      res.warnings.push('浮力が不足しています（自由浮力が0以下）。ガスを増やすかペイロードを軽くしてください。');
      return false;
    }
    mGas = fill.gasMass * (b.gasScale || 1);
    Rg = gasConstant(b.gas, b.purity);
    mTot = b.balloonMass + b.payloadMass + mGas;
  }
  const burstD = (b.burstD || 0) * (b.burstScale || 1);
  const stopAlt = targetAlt ?? (b.model === 'constant' ? b.burstAlt * (b.burstScale || 1) : Infinity);
  const physics = (aa) => {
    const V = mGas * Rg * aa.T / aa.p, D = Math.cbrt(6 * V / Math.PI), A = Math.PI * D * D / 4;
    const F = (aa.rho * V - mTot) * G0;
    return { vU: F > 0 ? Math.sqrt(2 * F / (aa.rho * b.cd * (b.cdScale || 1) * A)) : 0, D };
  };
  // 'constant'：地上での上昇速度を保つ（実際のラテックス気球の観測に近い）。直径・破裂は物理計算のまま
  const v0 = b.model === 'latex' ? physics(a).vU : 0;
  const rate = (aa) => {
    if (b.model !== 'latex') return { vU: b.ascentRate * (b.ascentScale || 1), D: 0 };
    const r0 = physics(aa);
    if (b.ascentProfile === 'physics' || r0.vU === 0) return r0;
    return { vU: v0, D: r0.D };
  };
  const dt = 2, mid = {};
  let r = rate(a), sumV = 0, n = 0;
  rec.push(st, 'ascent', {}, true);
  for (;;) {
    if (b.model === 'latex' && targetAlt == null && r.D >= burstD) {
      addEvent(res, rec, st, 'burst', '気球破裂', { D: r.D });
      res.stats.burstAlt = st.h;
      break;
    }
    if (st.h >= stopAlt - 1e-6) {
      if (targetAlt == null) { addEvent(res, rec, st, 'burst', '気球破裂'); res.stats.burstAlt = st.h; }
      break;
    }
    if (r.vU < 0.05) {
      res.warnings.push(`高度${Math.round(st.h)}mで上昇が止まりました（浮力と重さが釣り合い）。`);
      return false;
    }
    const step = Math.min(dt, (stopAlt - st.h) / r.vU + 1e-6);
    // 中点法
    Object.assign(mid, st);
    move(mid, a.u, a.v, r.vU, step / 2);
    const am = air(env, mid.lat, mid.lon, mid.h, st.t + step / 2, {});
    const rm = rate(am);
    move(st, am.u, am.v, rm.vU, step);
    st.t += step;
    air(env, st.lat, st.lon, st.h, st.t, a);
    r = rate(a);
    st.vE = a.u; st.vN = a.v; st.vU = r.vU;
    sumV += r.vU; n++;
    rec.push(st, 'ascent', {});
    if (st.t > MAX_T) { res.warnings.push('飛行時間が48時間を超えたため計算を打ち切りました。'); return false; }
  }
  res.stats.ascentRateAvg = n ? sumV / n : r.vU;
  st.vE = a.u; st.vN = a.v; st.vU = r.vU;
  return true;
}

function floatPhase(st, env, res, rec, duration) {
  const a = {}, mid = {};
  const tEnd = st.t + duration;
  while (st.t < tEnd - 1e-9) {
    const dt = Math.min(10, tEnd - st.t);
    air(env, st.lat, st.lon, st.h, st.t, a);
    Object.assign(mid, st);
    move(mid, a.u, a.v, 0, dt / 2);
    air(env, mid.lat, mid.lon, mid.h, st.t + dt / 2, a);
    move(st, a.u, a.v, 0, dt);
    st.t += dt;
    st.vE = a.u; st.vN = a.v; st.vU = 0;
    rec.push(st, 'float', {});
  }
}

// ───────────────────────────── 自由飛行（ロケット・落下共通） ─────────────────────────────

function makeDeriv(env, F) {
  const a = {};
  const info = { M: 0, q: 0, accNG: 0, rho: 0, vr: 0 };
  function deriv(y, t, out) {
    const lat = y[0], h = y[2], vE = y[3], vN = y[4], vU = y[5];
    air(env, lat, y[1], h, t, a);
    const vrE = vE - a.u, vrN = vN - a.v, vrU = vU;
    const vr = Math.sqrt(vrE * vrE + vrN * vrN + vrU * vrU);
    const M = vr / a.a, q = 0.5 * a.rho * vr * vr;
    const m = F.mass(t);
    let fE = 0, fN = 0, fU = 0;
    const T = F.thrust(t, a.p);
    if (T > 0) { const d = F.thrustDir; fE += T * d[0] / m; fN += T * d[1] / m; fU += T * d[2] / m; }
    const body = F.tumbling ? Math.max(F.cdA(M), F.tumbleCdA) : F.cdA(M);
    const CdA = F.chuteCdA > 0 ? F.chuteCdA + F.bodyDescentCdA : body;
    if (vr > 1e-9) {
      const k = q * CdA / m / vr;
      fE -= k * vrE; fN -= k * vrN; fU -= k * vrU;
    }
    const r = RE + h, cl = Math.cos(lat), sl = Math.sin(lat), tl = sl / cl, g = gravity(lat, h);
    out[0] = vN / r; out[1] = vE / (r * cl); out[2] = vU;
    out[3] = fE + vE * vN * tl / r - vE * vU / r + 2 * OMEGA * (vN * sl - vU * cl);
    out[4] = fN - vE * vE * tl / r - vN * vU / r - 2 * OMEGA * vE * sl;
    out[5] = fU + (vE * vE + vN * vN) / r + 2 * OMEGA * vE * cl - g;
    info.M = M; info.q = q; info.rho = a.rho; info.vr = vr;
    info.accNG = Math.sqrt(fE * fE + fN * fN + fU * fU);
    info.vrE = vrE; info.vrN = vrN; info.vrU = vrU;
    info.p = a.p; info.u = a.u; info.v = a.v;
    return out;
  }
  return { deriv, info };
}

function rk4(deriv, y, t, dt, k) {
  const n = 6;
  deriv(y, t, k.k1);
  for (let i = 0; i < n; i++) k.y[i] = y[i] + k.k1[i] * dt / 2;
  deriv(k.y, t + dt / 2, k.k2);
  for (let i = 0; i < n; i++) k.y[i] = y[i] + k.k2[i] * dt / 2;
  deriv(k.y, t + dt / 2, k.k3);
  for (let i = 0; i < n; i++) k.y[i] = y[i] + k.k3[i] * dt;
  deriv(k.y, t + dt, k.k4);
  for (let i = 0; i < n; i++) y[i] += dt / 6 * (k.k1[i] + 2 * k.k2[i] + 2 * k.k3[i] + k.k4[i]);
}

function normalize(v) { const n = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= n; v[1] /= n; v[2] /= n; return v; }

/** 準定常のパラシュート降下（終端速度で降りながら風に流される） */
function steadyDescent(st, F, env, res, rec, phase) {
  const a = {}, mid = {};
  const m = F.mass(st.t);
  const vt = (aa) => Math.sqrt(2 * m * gravity(st.lat, st.h) / (aa.rho * (F.chuteCdA + F.bodyDescentCdA)));
  for (;;) {
    air(env, st.lat, st.lon, st.h, st.t, a);
    const g0 = groundAt(env, st.lat, st.lon);
    if (F.mainAlt != null && !F.mainOpen && st.h - g0 <= F.mainAlt) {
      F.mainOpen = true; F.chuteCdA = F.mainCdA; phase = 'main';
      addEvent(res, rec, st, 'main', 'メインパラシュート開傘', { v: Math.abs(st.vU) });
    }
    const v1 = vt(a);
    const dt = Math.min(Math.max(20 / v1, 0.2), 4);
    Object.assign(mid, st);
    move(mid, a.u, a.v, -v1, dt / 2);
    const am = air(env, mid.lat, mid.lon, mid.h, st.t + dt / 2, {});
    const v2 = vt(am);
    const prev = { lat: st.lat, lon: st.lon, h: st.h };
    move(st, am.u, am.v, -v2, dt);
    const g1 = groundAt(env, st.lat, st.lon);
    const margin = env.groundMargin || 0;
    if (st.h < g1 - margin) {
      const d0 = prev.h - (g0 - margin), d1 = st.h - (g1 - margin);
      const f = d0 / (d0 - d1);
      st.lat = prev.lat + (st.lat - prev.lat) * f; st.lon = prev.lon + (st.lon - prev.lon) * f;
      st.h = prev.h + (st.h - prev.h) * f; st.t += dt * f;
      st.vE = am.u; st.vN = am.v; st.vU = -v2;
      rec.push(st, phase, {}, true);
      addEvent(res, rec, st, 'landing', '着地', { v: v2 });
      return;
    }
    st.t += dt; st.vE = am.u; st.vN = am.v; st.vU = -v2;
    rec.push(st, phase, {});
    if (st.t > MAX_T) { res.warnings.push('飛行時間が48時間を超えたため計算を打ち切りました。'); return; }
  }
}

/**
 * 運動方程式による自由飛行。F は機体の性質：
 *  mass(t), thrust(t, p), cdA(M), thrustDir, att, stiffness, chuteCdA, bodyDescentCdA,
 *  tb（燃焼終了の時刻・シミュレーション時間）, recovery 設定
 */
function freeFlight(st, F, env, res, rec, phase) {
  const { deriv, info } = makeDeriv(env, F);
  const y = [st.lat, st.lon, st.h, st.vE, st.vN, st.vU];
  const k = { k1: new Array(6), k2: new Array(6), k3: new Array(6), k4: new Array(6), y: new Array(6) };
  const rc = F.recovery || { type: 'none' };
  let tDeploy = F.chuteCdA > 0 ? st.t : null;
  let apogeeDone = F.apogeeDone || false;
  const stats = res.stats;
  for (;;) {
    const powered = st.t < F.tb;
    let dt;
    if (powered) dt = F.dtBurn;
    else if (F.chuteCdA > 0) dt = 0.05;
    else dt = st.h > 30000 ? 0.1 : 0.05;
    // 抵抗が非常に大きいとき（高速での開傘など）は数値的に不安定にならないよう刻みを小さくする
    if (info.vr > 0) {
      const cda = F.chuteCdA > 0 ? F.chuteCdA + F.bodyDescentCdA : (F.tumbling ? Math.max(F.cdA(info.M), F.tumbleCdA) : F.cdA(info.M));
      const lam = info.rho * info.vr * cda / F.mass(st.t);
      if (lam * dt > 0.5) dt = Math.max(0.5 / lam, 1e-4);
    }
    if (powered && st.t + dt > F.tb && F.tb - st.t > 1e-6) dt = F.tb - st.t;

    // パラシュートが終端速度に落ち着いたら準定常計算へ
    if (F.chuteCdA > 0 && st.t - tDeploy > 2) {
      const m = F.mass(st.t);
      const vt = Math.sqrt(2 * m * gravity(st.lat, st.h) / (info.rho * (F.chuteCdA + F.bodyDescentCdA)));
      const vh = Math.hypot(info.vrE, info.vrN);
      if (Math.abs(st.vU + vt) < 0.03 * vt && vh < 0.5) {
        steadyDescent(st, F, env, res, rec, phase);
        return;
      }
    }

    const prev = { lat: y[0], lon: y[1], h: y[2], vU: y[5], t: st.t };
    if (!powered || !F.misalign) { F.thrustDir[0] = F.att[0]; F.thrustDir[1] = F.att[1]; F.thrustDir[2] = F.att[2]; }
    else {
      F.thrustDir[0] = F.att[0] + F.misalign[0]; F.thrustDir[1] = F.att[1] + F.misalign[1]; F.thrustDir[2] = F.att[2] + F.misalign[2];
      normalize(F.thrustDir);
    }
    rk4(deriv, y, st.t, dt, k);
    st.t += dt;
    st.lat = y[0]; st.lon = y[1]; st.h = y[2]; st.vE = y[3]; st.vN = y[4]; st.vU = y[5];
    deriv(y, st.t, k.k1); // 現在点の情報（マッハ数など）を更新

    // 風見安定：機軸は対気速度の向きに向かう（動圧が大きいほど速く）
    if (info.vr > 1 && F.chuteCdA === 0) {
      const w = Math.min(1, dt * info.q / F.stiffness);
      F.att[0] += (info.vrE / info.vr - F.att[0]) * w;
      F.att[1] += (info.vrN / info.vr - F.att[1]) * w;
      F.att[2] += (info.vrU / info.vr - F.att[2]) * w;
      normalize(F.att);
    }

    if (F.chuteCdA === 0) {
      const sp = Math.hypot(st.vE, st.vN, st.vU);
      if (sp > (stats.maxSpeed || 0)) stats.maxSpeed = sp;
      if (info.M > (stats.maxMach || 0)) stats.maxMach = info.M;
      if (info.q > (stats.maxQ || 0)) { stats.maxQ = info.q; stats.maxQAlt = st.h; }
      if (powered && info.accNG / G0 > (stats.maxAccelG || 0)) stats.maxAccelG = info.accNG / G0;
    }

    if (prev.t < F.tb && st.t >= F.tb - 1e-9) {
      addEvent(res, rec, st, 'burnout', '燃焼終了', { v: Math.hypot(st.vE, st.vN, st.vU), M: info.M });
      stats.burnoutAlt = st.h; stats.burnoutV = Math.hypot(st.vE, st.vN, st.vU);
      if (rc.type !== 'none' && rc.trigger === 'delay') F.tDelayDeploy = F.tb + (rc.delay || 0);
    }

    let ph = powered ? 'powered' : (F.chuteCdA > 0 ? phase : (rc.type === 'none' && apogeeDone ? 'ballistic' : 'coast'));

    if (!apogeeDone && prev.vU > 0 && st.vU <= 0 && st.t > F.tIgn + 0.2) {
      apogeeDone = true;
      // 区間内で鉛直速度が0になる時刻を線形補間し、その点の高度を求める
      const f = prev.vU / (prev.vU - st.vU);
      const apo = {
        lat: prev.lat + (st.lat - prev.lat) * f, lon: prev.lon + (st.lon - prev.lon) * f,
        h: Math.max(prev.h + prev.vU * f * dt / 2, prev.h, st.h), t: prev.t + f * dt,
      };
      addEvent(res, rec, apo, 'apogee', '最高到達点', { v: Math.hypot(st.vE, st.vN) });
      stats.apogee = apo.h; stats.apogeeT = apo.t;
      if (F.tumbleCdA > 0) { F.tumbling = true; F.bodyDescentCdA = Math.max(F.bodyDescentCdA, F.tumbleCdA); }
      if (rc.type !== 'none' && rc.trigger === 'apogee') F.tDelayDeploy = st.t + (rc.delay || 0);
    }

    const gNow = groundAt(env, st.lat, st.lon);
    const altTrigger = rc.type !== 'none' && rc.trigger === 'altitude' && apogeeDone && !F.deployed && st.vU < 0 && st.h - gNow <= rc.deployAlt;
    if ((F.tDelayDeploy != null && st.t >= F.tDelayDeploy && F.chuteCdA === 0) || altTrigger) {
      F.tDelayDeploy = null; F.deployed = true;
      if (rc.type === 'dual') { F.chuteCdA = rc.drogueCdA; phase = 'drogue'; F.mainAlt = rc.mainAlt; F.mainCdA = rc.mainCdA; }
      else { F.chuteCdA = rc.mainCdA; phase = 'main'; }
      tDeploy = st.t; ph = phase;
      // パラシュートの負荷は動圧で決まるので、海面相当の速度（等価対気速度）で判断する
      const eas = info.vr * Math.sqrt(info.rho / 1.225);
      addEvent(res, rec, st, 'deploy', rc.type === 'dual' ? 'ドローグ開傘' : 'パラシュート開傘', { v: info.vr, eas });
      stats.deployV = info.vr; stats.deployEAS = eas;
      if (eas > 60) res.warnings.push(`開傘時の等価対気速度が${eas.toFixed(0)}m/s（実速度${info.vr.toFixed(0)}m/s）と大きく、パラシュート破損の恐れがあります。`);
    }

    if (rc.type === 'dual' && F.mainAlt != null && !F.mainOpen && F.chuteCdA > 0 && st.vU < 0 && st.h - gNow <= F.mainAlt) {
      F.mainOpen = true; F.chuteCdA = F.mainCdA; phase = 'main'; ph = 'main'; tDeploy = st.t;
      addEvent(res, rec, st, 'main', 'メインパラシュート開傘', { v: info.vr });
    }

    const margin = env.groundMargin || 0;
    if (st.t > F.tIgn + 0.5 && st.h < gNow - margin && st.vU < 0) {
      const g0 = groundAt(env, prev.lat, prev.lon);
      const d0 = prev.h - (g0 - margin), d1 = st.h - (gNow - margin);
      const f = d0 > 0 ? d0 / (d0 - d1) : 0;
      st.lat = prev.lat + (st.lat - prev.lat) * f; st.lon = prev.lon + (st.lon - prev.lon) * f;
      st.h = prev.h + (st.h - prev.h) * f; st.t = prev.t + dt * f;
      rec.push(st, ph, {}, true);
      addEvent(res, rec, st, 'landing', '着地', { v: Math.hypot(st.vE, st.vN, st.vU) });
      return;
    }
    rec.push(st, ph, { M: info.M });
    if (!Number.isFinite(st.h) || !Number.isFinite(st.vU)) { res.warnings.push('数値計算が発散したため打ち切りました。入力値を確認してください。'); return; }
    if (st.t > MAX_T) { res.warnings.push('飛行時間が48時間を超えたため計算を打ち切りました。'); return; }
  }
}

// ───────────────────────────── ロケット ─────────────────────────────

function attitudeVector(elevDeg, aziDeg) {
  const e = elevDeg * D2R, z = aziDeg * D2R;
  return [Math.cos(e) * Math.sin(z), Math.cos(e) * Math.cos(z), Math.sin(e)];
}

function rocketFlight(st, cfg, env, res, rec, platform) {
  const R = cfg.rocket, motor = R.motor;
  const tIgn = st.t;
  const ts = R.thrustScale || 1;
  const mProp = R.propMass;
  const rc0 = R.recovery || { type: 'none' }, cs = rc0.chuteScale || 1;
  const F = {
    tIgn, tb: tIgn + motor.tb,
    dtBurn: Math.min(Math.max(motor.tb / 400, 0.002), 0.02),
    mass: (t) => R.dryMass + mProp * (1 - impulseAt(motor, t - tIgn) / motor.Itot),
    thrust: (t, p) => {
      const f = thrustAt(motor, t - tIgn);
      return f > 0 ? f * ts + (101325 - p) * (R.exitArea || 0) : 0;
    },
    cdA: (M) => cdAt(R.cdTable, M) * (R.cdScale || 1) * R.aref,
    att: attitudeVector(R.rail.elev, R.rail.azi), thrustDir: [0, 0, 0],
    misalign: R.misalign || null,
    stiffness: R.stiffness || 50,
    chuteCdA: 0, bodyDescentCdA: cdAt(R.cdTable, 0.3) * R.aref, tumbleCdA: (R.tumbleCdA || 0) * (R.cdScale || 1),
    recovery: { ...rc0, drogueCdA: (rc0.drogueCdA || 0) * cs, mainCdA: (rc0.mainCdA || 0) * cs },
  };
  addEvent(res, rec, st, 'ignition', '点火');

  // ランチャー上（機軸方向に拘束、プラットフォームと一緒に動く）
  const L = R.rail.length || 0;
  const u = F.att.slice();
  if (L > 0) {
    const a = {}, o = { ...st };
    let s = 0, sd = 0;
    const dt = 0.001;
    while (s < L) {
      const t = st.t;
      air(env, st.lat, st.lon, st.h, t, a);
      const T = F.thrust(t, a.p), m = F.mass(t), g = gravity(st.lat, st.h);
      const drag = 0.5 * a.rho * sd * sd * F.cdA(sd / a.a);
      let acc = (T - drag) / m - g * u[2];
      if (acc <= 0 && sd <= 0) {
        acc = 0; sd = 0;
        if (t > F.tb) { res.warnings.push('推力が重量を上回らず、ランチャーから離れられません。'); addEvent(res, rec, st, 'landing', '発射失敗', { v: 0 }); return; }
      }
      sd += acc * dt; s += sd * dt; st.t += dt;
      const el = st.t - tIgn;
      const dE = s * u[0] + platform[0] * el, dN = s * u[1] + platform[1] * el, dU = s * u[2] + platform[2] * el;
      st.lat = o.lat + dN / (RE + o.h); st.lon = o.lon + dE / ((RE + o.h) * Math.cos(o.lat)); st.h = o.h + dU;
      st.vE = platform[0] + sd * u[0]; st.vN = platform[1] + sd * u[1]; st.vU = platform[2] + sd * u[2];
      rec.push(st, 'rail', {});
    }
    res.stats.railExitV = sd;
    addEvent(res, rec, st, 'rail_exit', 'ランチャー離脱', { v: sd });
    if (sd < 15 && !cfg.rockoon) res.warnings.push(`ランチャー離脱速度が${sd.toFixed(1)}m/sと低く、風の影響で姿勢が乱れやすい状態です（目安15m/s以上）。`);
  } else {
    st.vE = platform[0]; st.vN = platform[1]; st.vU = platform[2];
  }
  freeFlight(st, F, env, res, rec, 'coast');
}

// ───────────────────────────── 入口 ─────────────────────────────

/**
 * cfg: { kind:'balloon'|'rocket'|'rockoon', launch:{lat,lon,alt,time}, balloon, descent, rockoon, rocket }
 * env: { atm: AtmosphereField, windErr?, groundMargin? }
 * opts: { record?: boolean, sparse?: boolean }
 */
export function simulate(cfg, env, opts = {}) {
  const res = { path: [], events: [], warnings: [], stats: {}, kind: cfg.kind };
  const rec = makeRecorder(res, opts);
  env.t0 = cfg.launch.time;
  env.atm.outOfGrid = false;
  const st = { lat: cfg.launch.lat * D2R, lon: cfg.launch.lon * D2R, h: 0, vE: 0, vN: 0, vU: 0, t: 0 };
  const g0 = groundAt(env, st.lat, st.lon);
  // 発射高度が与えられていればそのまま使う（格子補間の地表より正確な標高・船上・建物など）
  st.h = cfg.launch.alt != null && Number.isFinite(cfg.launch.alt) ? cfg.launch.alt : g0;
  res.stats.launchAlt = st.h;
  addEvent(res, rec, st, 'launch', cfg.kind === 'rocket' ? '発射' : '放球');

  if (cfg.kind === 'balloon') {
    if (balloonAscent(st, cfg, env, res, rec, null)) {
      const d = cfg.descent;
      const m = d.mass;
      const cdA = d.mode === 'rate' ? 2 * m * G0 / (1.225 * d.rate * d.rate) : d.cdA * (d.chuteScale || 1);
      const F = { tIgn: st.t, tb: -1, mass: () => m, thrust: () => 0, cdA: () => 0, att: [0, 0, 1], thrustDir: [0, 0, 1],
        stiffness: 1e9, chuteCdA: cdA, bodyDescentCdA: 0, recovery: { type: 'none' }, apogeeDone: true };
      freeFlight(st, F, env, res, rec, 'descent');
    }
  } else if (cfg.kind === 'rocket') {
    rocketFlight(st, cfg, env, res, rec, [0, 0, 0]);
  } else if (cfg.kind === 'rockoon') {
    const ro = cfg.rockoon;
    const target = ro.releaseAlt + (ro.releaseOffset || 0);
    if (balloonAscent(st, cfg, env, res, rec, target)) {
      addEvent(res, rec, st, 'release_alt', '点火高度に到達');
      let vU = st.vU;
      if (ro.floatTime > 0) { floatPhase(st, env, res, rec, ro.floatTime); vU = 0; }
      const a = air(env, st.lat, st.lon, st.h, st.t, {});
      res.stats.releaseAlt = st.h;
      rocketFlight(st, { ...cfg, rockoon: true }, env, res, rec, [a.u, a.v, vU]);
    }
  }

  res.landing = res.events.find((e) => e.type === 'landing') || null;
  res.stats.flightTime = res.landing ? res.landing.t : st.t;
  if (env.atm.outOfGrid) res.outOfGrid = true;
  return res;
}

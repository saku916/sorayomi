// 画面の制御：入力 → 気象取得 → 計算 → 地図・グラフ・3D・表の表示
import { AtmosphereField } from './atmosphere.js';
import { fetchUpperAir, makeGrid, fetchTerrainGrid, fetchElevations, fetchDroneForecast } from './weather.js';
import { simulate, PHASE_LABEL } from './sim.js';
import { BALLOONS, chuteCdA } from './balloon.js';
import { parseEng, parametricMotor, defaultCdCurve, parseCdCsv, SAMPLE_ENG } from './rocket.js';
import { parseSTL, analyzeSTL, estimateCd, makeSampleRocket } from './stl.js';
import { DEFAULT_SIGMA, landingStats, ellipsePolygon, distBearing } from './montecarlo.js';
import { judgeDrone, goodWindows, isInDID, weatherName } from './drone.js';
import { trajectoryCSV, monteCarloCSV, trajectoryKML, download } from './export.js';
import { showModel, showTrajectory } from './viewer3d.js';

const $ = (id) => document.getElementById(id);
const STORE = 'sorayomi.v1';
const PHASE_COLOR = { ascent: '#e0453a', float: '#f29b30', rail: '#7a52d1', powered: '#7a52d1', coast: '#2f6fdf',
  ballistic: '#2f6fdf', drogue: '#16a3a3', main: '#2e9d55', descent: '#2e9d55' };
const state = { mode: 'balloon', engMotor: null, cdCsv: null, stlTris: null, stlGeo: null, stlCd: null, payloadCdA: 0,
  last: null, drone: null, groundElev: null, charts: {}, busy: false };

// ───────────────────────────── 入力の補助 ─────────────────────────────

function labelOf(id) {
  const l = $(id).closest('label');
  return l ? l.childNodes[0].textContent.trim() : id;
}
function num(id) {
  const v = parseFloat($(id).value);
  if (!Number.isFinite(v)) throw new Error(`「${labelOf(id)}」に数値を入力してください`);
  return v;
}
function positive(id) {
  const v = num(id);
  if (v <= 0) throw new Error(`「${labelOf(id)}」は0より大きい値にしてください`);
  return v;
}

function applyVisibility() {
  document.querySelectorAll('[data-show]').forEach((el) => { el.hidden = !el.dataset.show.split(' ').includes(state.mode); });
  document.querySelectorAll('[data-req]').forEach((el) => {
    const r = el.dataset.req;
    if (r.includes('=')) { const [id, vals] = r.split('='); el.hidden = !vals.split(',').includes($(id).value); }
    else el.hidden = !$(r).checked;
  });
  const active = document.querySelector('.tabs button.active');
  if (active && active.hidden) selectTab('summary');
}

function saveForm() {
  const v = { mode: state.mode };
  document.querySelectorAll('#panel input, #panel select').forEach((el) => {
    if (!el.id || el.type === 'file') return;
    v[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return v;
}
function loadForm(v) {
  for (const [id, val] of Object.entries(v)) {
    const el = $(id);
    if (!el || el.type === 'file') continue;
    if (el.type === 'checkbox') el.checked = !!val; else el.value = val;
  }
  if (v.mode) setMode(v.mode);
}
function persist() { try { localStorage.setItem(STORE, JSON.stringify(saveForm())); } catch { /* 保存できない環境では無視 */ } }

function setMode(m) {
  state.mode = m;
  document.body.dataset.mode = m;
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('run').textContent = m === 'drone' ? '飛行できるか確認' : '予測を実行';
  applyVisibility();
  clearResults();
  if (m === 'drone') checkDID();
}

function selectTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  if (name === 'view3d') draw3D();
  if (name === 'charts') Object.values(state.charts).forEach((c) => c.resize());
}

let statusTimer = null;
function progress(p, msg, isError = false) {
  const bar = document.querySelector('.progress');
  bar.hidden = p == null || p >= 1;
  if (p != null) bar.querySelector('.bar').style.width = `${Math.round(p * 100)}%`;
  const s = $('status');
  s.textContent = msg || '';
  s.classList.toggle('error', isError);
  clearTimeout(statusTimer);
}

// ───────────────────────────── 書式 ─────────────────────────────

const DIRS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
const dirName = (deg) => DIRS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const fx = (x, d = 0) => (x == null || !Number.isFinite(x) ? '—' : x.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));
function fmtDur(s) {
  if (!Number.isFinite(s)) return '—';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (h) return `${h}時間${m}分`;
  if (m) return `${m}分${sec}秒`;
  return `${sec}秒`;
}
const fmtClock = (unix) => new Date(unix * 1000).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtLen = (m) => (m >= 1000 ? `${fx(m / 1000, m >= 1e5 ? 0 : 1)} km` : `${fx(m)} m`);
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
function motorClass(I) {
  if (I < 1.25) return '—';
  const i = Math.ceil(Math.log2(I / 1.25)) - 1;
  return i < 26 ? String.fromCharCode(65 + i) : '—';
}

// ───────────────────────────── 地図 ─────────────────────────────

const map = L.map('map', { zoomControl: true, worldCopyJump: true });
const gsiAttr = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
const bases = {
  '地理院 標準地図': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', { maxZoom: 18, attribution: gsiAttr }),
  '地理院 写真': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', { maxZoom: 18, attribution: gsiAttr }),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
};
bases['地理院 標準地図'].addTo(map);
const didLayer = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/did2020/{z}/{x}/{y}.png', { opacity: 0.45, minZoom: 8, maxNativeZoom: 16, attribution: `${gsiAttr}（人口集中地区 令和2年）` });
L.control.layers(bases, { '人口集中地区（DID）': didLayer }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
const resultLayer = L.layerGroup().addTo(map);
new ResizeObserver(() => map.invalidateSize()).observe($('map'));

const pin = (color) => L.divIcon({ className: '', iconSize: [26, 34], iconAnchor: [13, 33], popupAnchor: [0, -30],
  html: `<svg width="26" height="34" viewBox="0 0 26 34"><path d="M13 33C13 33 2 20 2 12a11 11 0 0 1 22 0c0 8-11 21-11 21z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="13" cy="12" r="4" fill="#fff"/></svg>` });
const launchMarker = L.marker([42.5, 143.45], { draggable: true, icon: pin('#1c1f24'), zIndexOffset: 1000 }).addTo(map)
  .bindTooltip('発射地点（ドラッグで移動）');

const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => {
  const d = L.DomUtil.create('div', 'map-legend');
  d.id = 'map-legend'; d.hidden = true;
  return d;
};
legend.addTo(map);

let elevTimer = null;
function setLaunch(lat, lon, { pan = false } = {}) {
  $('lat').value = lat.toFixed(5); $('lon').value = lon.toFixed(5);
  launchMarker.setLatLng([lat, lon]);
  if (pan) map.setView([lat, lon], Math.max(map.getZoom(), 10));
  clearTimeout(elevTimer);
  elevTimer = setTimeout(async () => {
    try {
      const [e] = await fetchElevations([{ lat, lon }]);
      state.groundElev = e;
      $('ground-elev').textContent = e <= 0 ? '0 m（海上）' : `${fx(e)} m`;
    } catch { $('ground-elev').textContent = '取得できません'; }
    if (state.mode === 'drone') checkDID();
  }, 350);
  persist();
}
map.on('click', (e) => { if (!state.busy) setLaunch(e.latlng.lat, e.latlng.lng); });
launchMarker.on('dragend', () => { const p = launchMarker.getLatLng(); setLaunch(p.lat, p.lng); });

async function searchAddress() {
  const q = $('addr').value.trim();
  if (!q) return;
  try {
    const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
    const list = await res.json();
    if (!list.length) { progress(null, `「${q}」は見つかりませんでした`, true); return; }
    const [lon, lat] = list[0].geometry.coordinates;
    setLaunch(lat, lon, { pan: true });
    progress(null, `${list[0].properties.title} に移動しました`);
  } catch { progress(null, '住所検索に失敗しました', true); }
}

let didSeq = 0;
async function checkDID() {
  const seq = ++didSeq;
  try {
    const inside = await isInDID(+$('lat').value, +$('lon').value);
    if (seq === didSeq) state.didInside = inside;
  } catch { state.didInside = null; }
}

// ───────────────────────────── ファイル読み込み ─────────────────────────────

function updateMotorInfo() {
  const el = $('motor-info');
  try {
    const src = $('r-motor-src').value;
    let m;
    if (src === 'eng') { m = state.engMotor; if (!m) { el.textContent = '.engファイルを選んでください（ThrustCurve.org などで入手できます）'; return; } }
    else if (src === 'sample') m = parseEng(SAMPLE_ENG);
    else m = parametricMotor({ thrust: positive('r-thrust'), burnTime: positive('r-burn'), propMass: positive('r-prop'), totalMass: positive('r-motor-mass') });
    el.textContent = `${m.name}  ${motorClass(m.Itot)}クラス\n総力積 ${fx(m.Itot, 1)} N·s ／ 平均推力 ${fx(m.avgThrust, 1)} N ／ 最大 ${fx(m.maxThrust, 1)} N\n燃焼 ${fx(m.tb, 2)} s ／ 推進剤 ${fx(m.propMass, 3)} kg ／ 比推力 ${fx(m.isp, 0)} s`;
  } catch (e) { el.textContent = e.message; }
}

function analyzeRocketSTL() {
  if (!state.stlTris) return;
  const unit = +$('r-stl-unit').value;
  const g = analyzeSTL(state.stlTris, { unit, axis: $('r-stl-axis').value });
  const cd = estimateCd(g, { baseRatio: num('r-baseratio') });
  state.stlGeo = g; state.stlCd = cd;
  const mmax = cd.table.reduce((a, r) => (r[1] > a[1] ? r : a));
  const margin = (g.cpFromNose - g.cgFromNose) / g.bodyDiameter;
  $('stl-info').textContent =
    `三角形 ${fx(g.triCount)} 枚 ／ 機軸 ${g.axis.toUpperCase()}\n`
    + `全長 ${fx(g.length * 1000)} mm ／ 胴体径 ${fx(g.bodyDiameter * 1000, 1)} mm ／ 細長比 ${fx(cd.fineness, 1)}\n`
    + `ノーズ長 ${fx(g.noseLength * 1000)} mm ／ フィン高さ ${fx(g.finSpan * 1000)} mm\n`
    + `正面投影 ${fx(g.frontalArea * 1e4, 1)} cm² ／ 表面積 ${fx(g.wettedArea * 1e4)} cm² ／ 体積 ${fx(g.volume * 1e6)} cm³\n`
    + `推定Cd（M0.3）${fx(cd.cd0, 3)} ／ 最大 ${fx(mmax[1], 3)}（M${mmax[0]}）\n`
    + `参考：形状重心（中身が均一な場合）${fx(g.cgFromNose * 1000)} mm、側面積中心 ${fx(g.cpFromNose * 1000)} mm（ノーズ先端から）`
    + `\n　　　目安の安定余裕 ${fx(margin, 2)} 口径（実際の重心で確認してください）`;
  $('stl-view').hidden = false;
  showModel($('stl-view'), state.stlTris, unit, g).catch(() => { $('stl-view').hidden = true; });
}

async function readFile(input, kind) {
  const f = input.files[0];
  if (!f) return null;
  return kind === 'text' ? f.text() : f.arrayBuffer();
}

// ───────────────────────────── 設定の組み立て ─────────────────────────────

function launchConfig() {
  const lat = num('lat'), lon = num('lon');
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) throw new Error('緯度・経度の範囲が正しくありません');
  const time = new Date($('launch-time').value).getTime() / 1000;
  if (!Number.isFinite(time)) throw new Error('発射日時を入力してください');
  return { lat, lon, alt: $('alt-override').checked ? num('alt') : null, time };
}

function rocketConfig() {
  const src = $('r-motor-src').value;
  let motor;
  if (src === 'eng') { motor = state.engMotor; if (!motor) throw new Error('.engファイルを選んでください'); }
  else if (src === 'sample') motor = parseEng(SAMPLE_ENG);
  else motor = parametricMotor({ thrust: positive('r-thrust'), burnTime: positive('r-burn'), propMass: positive('r-prop'), totalMass: positive('r-motor-mass') });
  if (motor.propMass >= motor.totalMass) throw new Error('モーター全質量は推進剤質量より大きくしてください');
  const dryMass = positive('r-airframe') + motor.totalMass - motor.propMass;
  let cdTable, aref, wetted;
  const cdSrc = $('r-cd-src').value;
  if (cdSrc === 'stl') {
    if (!state.stlCd) throw new Error('3Dモデル（STL）を読み込むか、抗力係数の求め方を「Cdを入力」にしてください');
    cdTable = state.stlCd.table; aref = state.stlCd.aref; wetted = state.stlGeo.wettedArea;
  } else {
    const d = positive('r-diam') / 1000;
    aref = Math.PI * d * d / 4;
    wetted = Math.PI * d * positive('r-length') / 1000 + 2 * aref;
    if (cdSrc === 'csv') { if (!state.cdCsv) throw new Error('Cd-マッハ数のCSVを選んでください'); cdTable = state.cdCsv; }
    else cdTable = defaultCdCurve(positive('r-cd0'));
  }
  const type = $('r-rec').value;
  const recovery = { type, trigger: $('r-trig').value, delay: num('r-delay'), deployAlt: num('r-deploy-alt') };
  if (type === 'dual') { recovery.drogueCdA = chuteCdA(positive('r-drogue-d'), positive('r-drogue-cd')); recovery.mainAlt = num('r-main-alt'); }
  if (type !== 'none') recovery.mainCdA = chuteCdA(positive('r-main-d'), positive('r-main-cd'));
  const elev = num('r-elev');
  if (elev <= 0 || elev > 90) throw new Error('仰角は0〜90度にしてください');
  return {
    motor, dryMass, propMass: motor.propMass, cdTable, aref, exitArea: num('r-exit') / 1e4,
    rail: { length: Math.max(0, num('r-rail')), elev, azi: num('r-azi') },
    stiffness: positive('r-stiff'), recovery,
    // 横転中の平均投影面積は表面積の1/4（凸形状のコーシーの定理）、横流れのCdは約1.2
    tumbleCdA: $('r-tumble').checked ? 1.2 * wetted / 4 : 0,
  };
}

function buildConfig() {
  const launch = launchConfig();
  const kind = state.mode;
  if (kind === 'balloon') {
    const model = $('b-model').value, payloadMass = positive('b-payload');
    const balloon = model === 'latex'
      ? { model, balloonMass: positive('b-mass') / 1000, burstD: positive('b-burstd'), cd: positive('b-cd'), gas: $('b-gas').value,
        purity: Math.min(1, positive('b-purity') / 100), fill: { mode: $('b-fillmode').value, value: positive('b-fillval') }, payloadMass,
        ascentProfile: $('b-profile').value }
      : { model, ascentRate: positive('b-rate'), burstAlt: positive('b-burstalt'), payloadMass };
    const descent = $('b-desc-mode').value === 'rate'
      ? { mode: 'rate', mass: payloadMass, rate: positive('b-desc-rate') }
      : { mode: 'chute', mass: payloadMass + ($('b-remnant').checked && model === 'latex' ? balloon.balloonMass : 0),
        cdA: chuteCdA(positive('b-chute-d'), positive('b-chute-cd')) + state.payloadCdA };
    return { kind, launch, balloon, descent };
  }
  const rocket = rocketConfig();
  if (kind === 'rocket') return { kind, launch, rocket };
  return {
    kind, launch, rocket,
    balloon: { model: 'constant', ascentRate: positive('ro-rate'), payloadMass: 0 },
    rockoon: { releaseAlt: positive('ro-alt'), floatTime: Math.max(0, num('ro-float')) * 60 },
  };
}

// ───────────────────────────── 計算の流れ ─────────────────────────────

let worker = null;
function monteCarlo(cfg, atm, n, seed, onProg) {
  if (!worker) worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  // 予報の誤差は先の日時ほど大きい（1日先ごとに25%増し）
  const lead = 1 + 0.25 * Math.max(0, (cfg.launch.time - Date.now() / 1000) / 86400);
  const sig = { ...DEFAULT_SIGMA, windAbs: num('mc-wind') * lead, windFrac: num('mc-windfrac') / 100 * lead, scale: num('mc-scale') };
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress') onProg(d.i / d.total);
      else if (d.type === 'done') resolve(d);
      else reject(new Error(d.message));
    };
    worker.onerror = (e) => { worker = null; reject(new Error(e.message || 'モンテカルロ計算でエラーが発生しました')); };
    worker.postMessage({ cfg, atmData: atm.toData(), sig, n, seed, groundMargin: 0 });
  });
}

function bbox(points) {
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const [la, lo] of points) { latMin = Math.min(latMin, la); latMax = Math.max(latMax, la); lonMin = Math.min(lonMin, lo); lonMax = Math.max(lonMax, lo); }
  return { latMin, latMax, lonMin, lonMax };
}

/** 軌跡直下の標高を細かく取り、着地点を正確に決め直す */
async function refineLanding(res, atm) {
  if (!res.landing) return res;
  const maxT = Math.max(...atm.terrain.elev, 0);
  let i0 = res.path.length - 1;
  while (i0 > 0 && res.path[i0].h < maxT + 300) i0--;
  let seg = res.path.slice(i0);
  if (seg.length > 200) { const k = Math.ceil(seg.length / 200); seg = seg.filter((_, i) => i % k === 0 || i === seg.length - 1); }
  const elev = await fetchElevations(seg.map((p) => ({ lat: p.lat, lon: p.lon })));
  let j = seg.findIndex((p, i) => p.h <= elev[i]);
  if (j < 0) j = seg.length - 1;
  let L = { ...seg[j], h: elev[j] };
  if (j > 0) {
    const a = seg[j - 1], b = seg[j];
    const d0 = a.h - elev[j - 1], d1 = b.h - elev[j], f = d0 / (d0 - d1);
    const lerp = (x, y) => x + (y - x) * f;
    L = { ...b, t: lerp(a.t, b.t), lat: lerp(a.lat, b.lat), lon: lerp(a.lon, b.lon), h: lerp(elev[j - 1], elev[j]) };
  }
  const v = Math.hypot(L.vE, L.vN, L.vU);
  res.path = res.path.filter((p) => p.t < L.t);
  res.path.push(L);
  const ev = res.events.find((e) => e.type === 'landing');
  Object.assign(ev, { t: L.t, lat: L.lat, lon: L.lon, h: L.h, v: Math.abs(L.vU) < v ? Math.abs(L.vU) : v });
  res.events = res.events.filter((e) => e.type === 'landing' || e.t <= L.t);
  res.landing = ev;
  res.stats.flightTime = L.t;
  return res;
}

async function runFlight() {
  const cfg = buildConfig();
  const n = Math.min(2000, Math.max(0, Math.round(num('mc-n')))), seed = Math.round(num('mc-seed'));
  const t0 = cfg.launch.time;
  const est = cfg.kind === 'rocket' ? 2 * 3600 : cfg.kind === 'balloon' ? 8 * 3600
    : cfg.rockoon.releaseAlt / cfg.balloon.ascentRate + cfg.rockoon.floatTime + 4 * 3600;

  progress(0.03, '発射地点の予報を取得中…');
  if (cfg.launch.alt == null) [cfg.launch.alt] = await fetchElevations([{ lat: cfg.launch.lat, lon: cfg.launch.lon }]);
  let atm = new AtmosphereField(await fetchUpperAir([cfg.launch.lat], [cfg.launch.lon], t0 - 3600, t0 + est));
  let r = simulate(cfg, { atm }, {});
  if (!r.landing) { state.last = { cfg, nominal: r, runs: [], stats: null, atm }; render(); progress(1, '計算できませんでした（警告を確認してください）', true); return; }

  const b = bbox([[cfg.launch.lat, cfg.launch.lon], ...r.path.map((p) => [p.lat, p.lon])]);
  const pLa = Math.max(0.3, (b.latMax - b.latMin) * 0.35), pLo = Math.max(0.3, (b.lonMax - b.lonMin) * 0.35);
  const grid = makeGrid(b.latMin - pLa, b.latMax + pLa, b.lonMin - pLo, b.lonMax + pLo, 25);
  progress(0.12, `周辺の予報を取得中（${grid.lats.length * grid.lons.length}地点・${grid.step}°格子）…`);
  atm = new AtmosphereField(await fetchUpperAir(grid.lats, grid.lons, t0 - 3600, t0 + r.stats.flightTime * 1.3 + 3600));
  r = simulate(cfg, { atm }, {});
  if (!r.landing) { state.last = { cfg, nominal: r, runs: [], stats: null, atm }; render(); progress(1, '計算できませんでした（警告を確認してください）', true); return; }

  let pts = [[r.landing.lat, r.landing.lon]];
  if (n > 0) {
    progress(0.25, '落下範囲を見積もり中…');
    const pre = await monteCarlo(cfg, atm, Math.min(n, 60), seed + 7919, (p) => progress(0.25 + 0.2 * p, '落下範囲を見積もり中…'));
    pts = pts.concat(pre.runs.map((x) => [x.lat, x.lon]));
  }
  const lb = bbox(pts);
  const tLa = Math.max(0.03, (lb.latMax - lb.latMin) * 0.25), tLo = Math.max(0.03, (lb.lonMax - lb.lonMin) * 0.25);
  progress(0.47, '落下域の地形データを取得中…');
  atm.setTerrain(await fetchTerrainGrid(lb.latMin - tLa, lb.latMax + tLa, lb.lonMin - tLo, lb.lonMax + tLo, 15));

  progress(0.52, '着地点を詳細な標高で決定中…');
  const nominal = await refineLanding(simulate(cfg, { atm, groundMargin: 300 }, {}), atm);
  if (atm.outOfGrid) nominal.outOfGrid = true;

  let runs = [], outOfGrid = !!nominal.outOfGrid;
  if (n > 0) {
    const mc = await monteCarlo(cfg, atm, n, seed, (p) => progress(0.55 + 0.43 * p, `モンテカルロ計算中（${Math.round(p * n)}/${n}回）…`));
    runs = mc.runs; outOfGrid ||= mc.outOfGrid;
  }
  const stats = runs.length >= 3 ? landingStats(runs, { lat: nominal.landing.lat, lon: nominal.landing.lon }) : null;
  state.last = { cfg, nominal, runs, stats, atm, grid, n, outOfGrid };
  render();
  progress(1, `完了（${grid.lats.length * grid.lons.length}地点の予報・${fmtClock(atm.times[0])} 以降のGFS）`);
}

async function runDrone() {
  const lat = num('lat'), lon = num('lon');
  const p = { maxWind: positive('dr-maxwind'), alt: positive('dr-alt'), tMin: num('dr-tmin'), tMax: num('dr-tmax'),
    rainStop: num('dr-rain'), popCaution: num('dr-pop'), visMin: num('dr-vis') };
  progress(0.3, '地上付近の予報を取得中…');
  const fc = await fetchDroneForecast(lat, lon, +$('dr-days').value);
  const rows = judgeDrone(fc, p);
  await checkDID();
  state.drone = { rows, fc, p };
  renderDrone();
  progress(1, '完了');
}

async function run() {
  if (state.busy) return;
  state.busy = true;
  $('run').disabled = true;
  try {
    persist();
    if (state.mode === 'drone') await runDrone(); else await runFlight();
  } catch (e) {
    console.error(e);
    progress(1, e.message || String(e), true);
  } finally {
    state.busy = false;
    $('run').disabled = false;
  }
}

// ───────────────────────────── 表示 ─────────────────────────────

function clearResults() {
  resultLayer.clearLayers();
  $('summary').innerHTML = ''; $('warnings').innerHTML = ''; $('events').innerHTML = ''; $('drone-out').innerHTML = '';
  $('empty').hidden = false;
  $('map-legend').hidden = true;
  Object.values(state.charts).forEach((c) => c.destroy());
  state.charts = {};
  state.last = null; state.drone = null;
}

const card = (k, v, unit = '', sub = '', hero = false) =>
  `<div class="stat${hero ? ' hero' : ''}"><div class="k">${k}</div><div class="v">${v}${unit ? `<small>${unit}</small>` : ''}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function sd(a) { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); }

function render() {
  const { cfg, nominal: r, runs, stats } = state.last;
  $('empty').hidden = true;
  const L = r.landing, l0 = cfg.launch;
  const warn = [...r.warnings];
  if (state.last.outOfGrid) warn.push('軌跡の一部が取得した気象格子の外に出ました。その区間は格子の端の風で計算しています。');
  if (state.last.n && runs.length < state.last.n) warn.push(`モンテカルロ ${state.last.n} 回のうち ${state.last.n - runs.length} 回は着地まで計算できませんでした。`);
  $('warnings').innerHTML = warn.map((w) => `<div class="alert warn">${esc(w)}</div>`).join('');

  const s = r.stats, c = [];
  if (L) {
    const db = distBearing(l0.lat, l0.lon, L.lat, L.lon);
    const sea = L.h <= 0.5;
    c.push(card('予測落下地点', `${L.lat.toFixed(5)}, ${L.lon.toFixed(5)}`, '', `発射点から${dirName(db.brg)}へ ${fmtLen(db.d)}${sea ? '・海上' : `・標高 ${fx(L.h)} m`}`, true));
    c.push(card('着地時刻', fmtClock(l0.time + L.t), '', `飛行時間 ${fmtDur(L.t)}`));
    c.push(card('着地速度', fx(L.v, 1), 'm/s'));
  }
  if (cfg.kind === 'balloon') {
    if (s.burstAlt != null) c.push(card('破裂高度', fx(s.burstAlt / 1000, 2), 'km', runs.length ? `ばらつき ±${fx(sd(runs.map((x) => x.burstAlt).filter((x) => x != null)) / 1000, 2)} km` : ''));
    if (s.ascentRateAvg != null) c.push(card('平均上昇速度', fx(s.ascentRateAvg, 2), 'm/s'));
    if (s.fill) {
      c.push(card('ネックリフト', fx(s.fill.neckLift, 3), 'kg', `自由浮力 ${fx(s.fill.freeLift, 3)} kg`));
      c.push(card('ガス量（地上）', fx(s.fill.V0, 2), 'm³', `初期上昇 ${fx(s.fill.ascentRate, 2)} m/s・直径 ${fx(s.fill.D0, 2)} m`));
    }
  } else {
    if (cfg.kind === 'rockoon' && s.releaseAlt != null) c.push(card('点火高度', fx(s.releaseAlt / 1000, 2), 'km', `放球から ${fmtDur(r.events.find((e) => e.type === 'ignition')?.t)}`));
    if (s.apogee != null) c.push(card('最高到達高度', fx(s.apogee / 1000, s.apogee > 1e5 ? 1 : 2), 'km', runs.length ? `ばらつき ±${fx(sd(runs.map((x) => x.apogee).filter((x) => x != null)) / 1000, 2)} km` : `海抜（発射点標高 ${fx(s.launchAlt)} m）`));
    if (s.maxSpeed != null) c.push(card('最高速度', fx(s.maxSpeed), 'm/s', `マッハ ${fx(s.maxMach, 2)}`));
    if (s.maxQ != null) c.push(card('最大動圧', fx(s.maxQ / 1000, 1), 'kPa', `高度 ${fx(s.maxQAlt / 1000, 1)} km`));
    if (s.maxAccelG != null) c.push(card('最大加速度', fx(s.maxAccelG, 1), 'G'));
    if (s.railExitV != null) c.push(card('ランチャー離脱速度', fx(s.railExitV, 1), 'm/s'));
    if (s.burnoutAlt != null) c.push(card('燃焼終了', fx(s.burnoutAlt / 1000, 2), 'km', `速度 ${fx(s.burnoutV)} m/s`));
    if (s.deployV != null) c.push(card('開傘時の対気速度', fx(s.deployV, 1), 'm/s', `海面相当 ${fx(s.deployEAS, 1)} m/s`));
  }
  if (stats) {
    const e95 = stats.ellipses[1];
    const seaP = runs.filter((x) => x.ground <= 0.5).length / runs.length;
    c.push(card('95%落下範囲', `${fmtLen(2 * e95.a)} × ${fmtLen(2 * e95.b)}`, '', `長軸の向き ${dirName(90 - e95.angle * 180 / Math.PI)}–${dirName(270 - e95.angle * 180 / Math.PI)}`));
    c.push(card('半数が入る半径（CEP）', fmtLen(stats.cep50), '', `95%は ${fmtLen(stats.r95)} 以内`));
    c.push(card('海上に落ちる確率', fx(seaP * 100), '%', `${runs.length} 回の試行`));
  }
  $('summary').innerHTML = c.join('');

  const rows = r.events.map((e) => `<tr><td>${esc(e.label)}</td><td>${fmtDur(e.t)}</td><td>${fmtClock(l0.time + e.t)}</td><td>${fx(e.h)} m</td>
    <td>${e.lat.toFixed(5)}</td><td>${e.lon.toFixed(5)}</td><td>${e.v != null ? `${fx(e.v, 1)} m/s` : '—'}</td></tr>`).join('');
  $('events').innerHTML = `<thead><tr><th>イベント</th><th>経過</th><th>時刻</th><th>高度（海抜）</th><th>緯度</th><th>経度</th><th>速度</th></tr></thead><tbody>${rows}</tbody>`;

  renderMap();
  renderCharts();
  if (!$('tab-view3d').hidden) draw3D();
}

function renderMap() {
  const { nominal: r, runs, stats } = state.last;
  resultLayer.clearLayers();
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue('--muted').trim();
  const showPaths = runs.length <= 400;
  if (showPaths) for (const x of runs) L.polyline(x.path.map((p) => [p[0], p[1]]), { color: muted, weight: 1, opacity: 0.15, interactive: false }).addTo(resultLayer);
  if (stats) {
    const style = [{ fillOpacity: 0.18, weight: 2 }, { fillOpacity: 0.08, weight: 1.5 }, { fillOpacity: 0.04, weight: 1, dashArray: '4 4' }];
    stats.ellipses.slice().reverse().forEach((e, i) => {
      L.polygon(ellipsePolygon(stats, e), { color: '#e0453a', ...style[2 - i] }).addTo(resultLayer)
        .bindTooltip(`${Math.round(e.p * 100)}%の確率でこの中に落下`);
    });
  }
  for (const x of runs) L.circleMarker([x.lat, x.lon], { radius: 2.5, color: '#e0453a', weight: 0, fillOpacity: 0.6, interactive: false }).addTo(resultLayer);
  // 公称軌跡（区間ごとに色分け）
  let seg = [], phase = null;
  const flush = () => { if (seg.length > 1) L.polyline(seg, { color: PHASE_COLOR[phase] || '#888', weight: 3.5, opacity: 0.95 }).addTo(resultLayer); };
  for (const p of r.path) {
    if (p.phase !== phase) { flush(); seg = seg.length ? [seg[seg.length - 1]] : []; phase = p.phase; }
    seg.push([p.lat, p.lon]);
  }
  flush();
  for (const e of r.events) {
    if (['launch', 'landing', 'ignition'].includes(e.type) && !(e.type === 'ignition' && state.last.cfg.kind === 'rockoon')) continue;
    L.circleMarker([e.lat, e.lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#1c1f24', fillOpacity: 1 }).addTo(resultLayer)
      .bindTooltip(`${e.label}　高度 ${fx(e.h)} m`);
  }
  if (r.landing) {
    const L0 = r.landing;
    L.marker([L0.lat, L0.lon], { icon: pin('#e0453a'), zIndexOffset: 900 }).addTo(resultLayer)
      .bindPopup(`<b>予測落下地点</b><br>${L0.lat.toFixed(5)}, ${L0.lon.toFixed(5)}<br>着地 ${fmtClock(state.last.cfg.launch.time + L0.t)}<br>`
        + `<a href="https://maps.gsi.go.jp/#15/${L0.lat.toFixed(5)}/${L0.lon.toFixed(5)}/" target="_blank" rel="noopener">地理院地図で開く</a>`);
  }
  const all = r.path.map((p) => [p.lat, p.lon]).concat(runs.map((x) => [x.lat, x.lon]));
  map.invalidateSize();
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [30, 30], maxZoom: 14 });
  const used = [...new Set(r.path.map((p) => p.phase))];
  const lg = $('map-legend');
  lg.innerHTML = used.map((p) => `<div><i style="background:${PHASE_COLOR[p]}"></i>${PHASE_LABEL[p]}</div>`).join('')
    + (runs.length ? `<div><b style="background:#e0453a"></b>落下点のばらつき（${runs.length}回）</div>` : '');
  lg.hidden = false;
}

function chartColors() {
  const css = getComputedStyle(document.documentElement);
  return { text: css.getPropertyValue('--muted').trim(), grid: css.getPropertyValue('--grid').trim(), accent: css.getPropertyValue('--accent').trim() };
}

function makeChart(id, config) {
  if (typeof Chart === 'undefined') return;
  state.charts[id]?.destroy();
  const col = chartColors();
  Chart.defaults.color = col.text;
  Chart.defaults.borderColor = col.grid;
  Chart.defaults.font.family = '"Noto Sans JP", system-ui, sans-serif';
  state.charts[id] = new Chart($(id), { ...config, options: { responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'nearest', intersect: false }, ...config.options } });
}

const axis = (title, extra = {}) => ({ type: 'linear', title: { display: true, text: title }, ...extra });

function renderCharts() {
  const { cfg, nominal: r, atm } = state.last;
  const col = chartColors();
  const long = r.stats.flightTime > 1800;
  const tk = long ? 60 : 1, tu = long ? '分' : '秒';
  const l0 = r.path[0];
  const pts = r.path.map((p) => ({ x: p.t / tk, y: p.h / 1000 }));
  const evPts = r.events.map((e) => ({ x: e.t / tk, y: e.h / 1000, label: e.label }));
  makeChart('ch-alt', { type: 'scatter', data: { datasets: [
    { label: '高度', data: pts, showLine: true, pointRadius: 0, borderColor: col.accent, borderWidth: 2 },
    { label: 'イベント', data: evPts, pointRadius: 4, backgroundColor: '#e0453a' },
  ] }, options: { plugins: { title: { display: true, text: '高度の時間変化' }, legend: { display: false },
    tooltip: { callbacks: { label: (c) => `${c.raw.label ? `${c.raw.label}：` : ''}${fx(c.raw.y, 2)} km（${fx(c.raw.x, 1)}${tu}）` } } },
  scales: { x: axis(`経過時間（${tu}）`), y: axis('高度（km）') } } });

  const range = r.path.map((p) => ({ x: distBearing(l0.lat, l0.lon, p.lat, p.lon).d / 1000, y: p.h / 1000 }));
  makeChart('ch-range', { type: 'scatter', data: { datasets: [{ label: '軌跡', data: range, showLine: true, pointRadius: 0, borderColor: '#2e9d55', borderWidth: 2 }] },
    options: { plugins: { title: { display: true, text: '高度と水平距離（発射点から）' }, legend: { display: false } },
      scales: { x: axis('水平距離（km）'), y: axis('高度（km）') } } });

  if (cfg.kind !== 'balloon') {
    const iIgn = r.path.findIndex((p) => p.phase === 'rail' || p.phase === 'powered' || p.phase === 'coast');
    const tIgn = iIgn >= 0 ? r.path[iIgn].t : 0;
    const iApo = r.events.find((e) => e.type === 'apogee');
    const tEnd = iApo ? iApo.t + (iApo.t - tIgn) * 0.6 : tIgn + 120;
    const fl = r.path.filter((p) => p.t >= tIgn && p.t <= tEnd);
    makeChart('ch-speed', { type: 'scatter', data: { datasets: [
      { label: '速度（m/s）', data: fl.map((p) => ({ x: p.t - tIgn, y: Math.hypot(p.vE, p.vN, p.vU) })), showLine: true, pointRadius: 0, borderColor: col.accent, borderWidth: 2, yAxisID: 'y' },
      { label: 'マッハ数', data: fl.filter((p) => p.M != null).map((p) => ({ x: p.t - tIgn, y: p.M })), showLine: true, pointRadius: 0, borderColor: '#f29b30', borderWidth: 2, yAxisID: 'y2' },
    ] }, options: { plugins: { title: { display: true, text: '点火後の速度とマッハ数' } },
      scales: { x: axis('点火からの時間（秒）'), y: axis('速度（m/s）'), y2: axis('マッハ数', { position: 'right', grid: { drawOnChartArea: false } }) } } });
    const tbl = cfg.rocket.cdTable;
    makeChart('ch-cd', { type: 'scatter', data: { datasets: [{ label: 'Cd', data: tbl.filter((x) => x[0] <= 6).map(([x, y]) => ({ x, y })), showLine: true, pointRadius: 2, borderColor: '#7a52d1', borderWidth: 2 }] },
      options: { plugins: { title: { display: true, text: '抗力係数とマッハ数' }, legend: { display: false } }, scales: { x: axis('マッハ数'), y: axis('Cd') } } });
  }

  // 発射時刻・発射地点の風の高度分布（使った予報そのもの）
  const a = {}, sp = [], dir = [];
  const top = Math.min(36000, Math.max(...r.path.map((p) => p.h)) + 2000);
  for (let h = Math.max(0, l0.h); h <= top; h += 250) {
    atm.sample(cfg.launch.lat, cfg.launch.lon, h, cfg.launch.time, a);
    sp.push({ x: Math.hypot(a.u, a.v), y: h / 1000 });
    dir.push({ x: (Math.atan2(-a.u, -a.v) * 180 / Math.PI + 360) % 360, y: h / 1000 });
  }
  makeChart('ch-wind', { type: 'scatter', data: { datasets: [
    { label: '風速（m/s）', data: sp, showLine: true, pointRadius: 0, borderColor: col.accent, borderWidth: 2, xAxisID: 'x' },
    { label: '風向（度・吹いてくる方向）', data: dir, pointRadius: 1.5, backgroundColor: '#f29b30', xAxisID: 'x2' },
  ] }, options: { plugins: { title: { display: true, text: '発射時の風（GFS予報）' } },
    scales: { x: axis('風速（m/s）'), x2: axis('風向（度）', { position: 'top', min: 0, max: 360, ticks: { stepSize: 90 }, grid: { drawOnChartArea: false } }), y: axis('高度（km）') } } });
}

function draw3D() {
  if (!state.last || !state.last.nominal) return;
  showTrajectory($('traj3d'), state.last.nominal, state.last.runs, +$('v3-exag').value)
    .catch((e) => { $('traj3d').textContent = `3D表示を読み込めませんでした：${e.message}`; });
}

function renderDrone() {
  const { rows, fc, p } = state.drone;
  $('empty').hidden = true;
  const off = fc.utc_offset_seconds || 0;
  const lt = (t) => { const d = new Date((t + off) * 1000); return { day: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, hour: d.getUTCHours(), d }; };
  const nowT = Date.now() / 1000;
  const cur = rows.find((x) => x.t + 3600 > nowT) || rows[0];
  const LV = { ok: '飛行可', caution: '注意', stop: '中止' };
  const wins = goodWindows(rows.filter((x) => x.t + 3600 > nowT), 2);
  const c = [];
  c.push(card('いまの判定', `<span class="lv ${cur.level}">${LV[cur.level]}</span>`, '', cur.reasons.join('／') || '問題なし', true));
  c.push(card(`風（地上${fx(p.alt)}m）`, fx(cur.wind, 1), 'm/s', `突風 ${fx(cur.gust, 1)} m/s・${dirName(cur.dir)}の風`));
  c.push(card('気温', fx(cur.temp, 0), '℃', weatherName(cur.code)));
  c.push(card('人口集中地区', state.didInside == null ? '不明' : state.didInside ? 'DID内' : 'DID外', '',
    state.didInside ? '飛行には国の許可が必要です' : state.didInside === false ? '他の飛行禁止区域も確認してください' : ''));
  $('summary').innerHTML = c.join('');
  $('warnings').innerHTML = '<div class="alert info">判定は気象条件のみです。空港周辺・150m以上・イベント上空・夜間・目視外などの規制は、国土交通省のドローン情報基盤システム（DIPS）で確認してください。</div>';
  $('drone-out').innerHTML = `<h3 style="font-size:13px;margin:4px 0">連続2時間以上「飛行可」の時間帯</h3><div class="windows">${
    wins.length ? wins.map((w) => { const a = lt(w.from), b = lt(w.to); return `<span>${a.day} ${a.hour}時〜${b.day === a.day ? '' : `${b.day} `}${b.hour}時（${w.hours}h）</span>`; }).join('') : '<em class="hint">期間内にありません</em>'}</div>`;
  let day = null;
  const body = rows.map((x) => {
    const t = lt(x.t);
    const sep = t.day !== day ? `<tr class="daysep"><td colspan="11">${t.day}（${'日月火水木金土'[t.d.getUTCDay()]}）</td></tr>` : '';
    day = t.day;
    return `${sep}<tr${x.t + 3600 < nowT ? ' style="opacity:.45"' : ''}><td>${t.hour}時</td><td><span class="lv ${x.level}">${LV[x.level]}</span></td>
      <td>${fx(x.wind, 1)}</td><td>${fx(x.gust, 1)}</td><td>${dirName(x.dir)}</td><td>${fx(x.pop)}%</td><td>${fx(x.precip, 1)}</td>
      <td>${fx(x.temp, 0)}℃</td><td>${x.vis != null ? fx(x.vis / 1000, 1) : '—'}</td><td>${weatherName(x.code)}</td><td class="reason">${esc(x.reasons.join('／'))}</td></tr>`;
  }).join('');
  $('events').innerHTML = `<thead><tr><th>時刻</th><th>判定</th><th>風 m/s</th><th>突風 m/s</th><th>風向</th><th>降水確率</th><th>降水 mm</th><th>気温</th><th>視程 km</th><th>天気</th><th>理由</th></tr></thead><tbody>${body}</tbody>`;

  const labels = rows.map((x) => { const t = lt(x.t); return t.hour === 0 ? `${t.day}` : `${t.hour}時`; });
  const lvColor = { ok: '#2e9d5555', caution: '#f29b3066', stop: '#e0453a66' };
  const col = chartColors();
  makeChart('ch-drone', { type: 'line', data: { labels, datasets: [
    { label: `風（地上${p.alt}m）`, data: rows.map((x) => x.wind), borderColor: col.accent, pointRadius: 0, borderWidth: 2 },
    { label: '突風', data: rows.map((x) => x.gust), borderColor: '#f29b30', pointRadius: 0, borderWidth: 1.5, borderDash: [4, 3] },
    { label: '耐風性能', data: rows.map(() => p.maxWind), borderColor: '#e0453a', pointRadius: 0, borderWidth: 1 },
    { type: 'bar', label: '判定', data: rows.map(() => p.maxWind * 0.08), backgroundColor: rows.map((x) => lvColor[x.level]), barPercentage: 1, categoryPercentage: 1 },
  ] }, options: { plugins: { title: { display: true, text: '風速の予報と判定' } }, scales: { y: { title: { display: true, text: 'm/s' }, beginAtZero: true } } } });
  map.setView([+$('lat').value, +$('lon').value], Math.max(map.getZoom(), 12));
}

// ───────────────────────────── 初期化 ─────────────────────────────

function init() {
  $('b-preset').innerHTML = BALLOONS.map((b) => `<option value="${b.id}">${b.name}（破裂直径 ${b.burstD} m）</option>`).join('') + '<option value="custom">その他（手入力）</option>';
  $('b-preset').value = 'totex-1200';
  const now = new Date(); now.setMinutes(0, 0, 0); now.setHours(now.getHours() + 1);
  const pad = (x) => String(x).padStart(2, '0');
  const localISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('launch-time').value = localISO(now);

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { saved = null; }
  if (saved) {
    const t = new Date(saved['launch-time']);
    if (!(t > new Date(Date.now() - 6 * 3600e3))) delete saved['launch-time']; // 古い日時は今に置き換える
    loadForm(saved);
  } else setMode('balloon');
  // ?mode=drone などのURLで開いたときはそのモードにする（検索やリンクからの入口用）
  const qm = new URLSearchParams(location.search).get('mode');
  if (['drone', 'balloon', 'rocket', 'rockoon'].includes(qm)) setMode(qm);

  document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); persist(); }));
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
  $('panel').addEventListener('change', (e) => {
    if (e.target.type !== 'file') persist();
    applyVisibility();
    if (e.target.id?.startsWith('r-')) updateMotorInfo();
  });
  $('panel').addEventListener('input', (e) => { if (['r-thrust', 'r-burn', 'r-prop', 'r-motor-mass'].includes(e.target.id)) updateMotorInfo(); });
  $('b-preset').addEventListener('change', () => {
    const b = BALLOONS.find((x) => x.id === $('b-preset').value);
    if (b) { $('b-mass').value = b.mass; $('b-burstd').value = b.burstD; persist(); }
  });
  $('lat').addEventListener('change', () => setLaunch(+$('lat').value, +$('lon').value, { pan: true }));
  $('lon').addEventListener('change', () => setLaunch(+$('lat').value, +$('lon').value, { pan: true }));
  $('btn-addr').addEventListener('click', searchAddress);
  $('addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchAddress(); });
  $('btn-now').addEventListener('click', () => { const d = new Date(); d.setSeconds(0, 0); $('launch-time').value = localISO(d); persist(); });
  $('run').addEventListener('click', run);
  $('v3-exag').addEventListener('change', draw3D);

  $('r-eng').addEventListener('change', async (e) => {
    try { state.engMotor = parseEng(await readFile(e.target, 'text')); } catch (err) { state.engMotor = null; progress(null, err.message, true); }
    updateMotorInfo();
  });
  $('r-cdcsv').addEventListener('change', async (e) => {
    try { state.cdCsv = parseCdCsv(await readFile(e.target, 'text')); progress(null, `Cd表を読み込みました（${state.cdCsv.length}点）`); }
    catch (err) { state.cdCsv = null; progress(null, err.message, true); }
  });
  $('r-stl').addEventListener('change', async (e) => {
    try { state.stlTris = parseSTL(await readFile(e.target, 'buffer')); analyzeRocketSTL(); }
    catch (err) { state.stlTris = null; state.stlCd = null; progress(null, err.message, true); }
  });
  ['r-stl-unit', 'r-stl-axis', 'r-baseratio'].forEach((id) => $(id).addEventListener('change', () => { try { analyzeRocketSTL(); } catch (err) { progress(null, err.message, true); } }));
  $('btn-sample-stl').addEventListener('click', () => {
    state.stlTris = makeSampleRocket(); $('r-stl-unit').value = '1'; $('r-stl-axis').value = 'auto';
    analyzeRocketSTL();
  });
  $('b-stl').addEventListener('change', async (e) => {
    try {
      const g = analyzeSTL(parseSTL(await readFile(e.target, 'buffer')), { unit: +$('b-stl-unit').value });
      state.payloadCdA = 1.0 * g.wettedArea / 4;
      $('b-stl-info').textContent = `寸法 ${g.bounds.max.map((m, k) => fx((m - g.bounds.min[k]) * 1000)).join(' × ')} mm ／ 平均投影面積 ${fx(g.wettedArea / 4 * 1e4)} cm² → 抗力面積 ${fx(state.payloadCdA * 1e4)} cm² を加算`;
    } catch (err) { state.payloadCdA = 0; $('b-stl-info').textContent = err.message; }
  });

  $('ex-csv').addEventListener('click', () => state.last && download('trajectory.csv', trajectoryCSV(state.last.nominal, state.last.cfg.launch.time), 'text/csv'));
  $('ex-mc').addEventListener('click', () => state.last && download('montecarlo.csv', monteCarloCSV(state.last.runs), 'text/csv'));
  $('ex-kml').addEventListener('click', () => state.last && download('trajectory.kml',
    trajectoryKML(state.last.nominal, state.last.runs, state.last.stats, `SORAYOMI ${new Date(state.last.cfg.launch.time * 1000).toLocaleString('ja-JP')}`),
    'application/vnd.google-earth.kml+xml'));
  $('btn-save').addEventListener('click', () => download('sorayomi-settings.json', JSON.stringify(saveForm(), null, 2), 'application/json'));
  $('cfg-file').addEventListener('change', async (e) => {
    try { loadForm(JSON.parse(await readFile(e.target, 'text'))); setLaunch(+$('lat').value, +$('lon').value, { pan: true }); progress(null, '設定を読み込みました'); }
    catch { progress(null, '設定ファイルを読めませんでした', true); }
  });

  applyVisibility();
  updateMotorInfo();
  const lat = +$('lat').value, lon = +$('lon').value;
  map.setView([lat, lon], 9);
  setLaunch(lat, lon);
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      if (state.last) renderCharts(); else if (state.drone) renderDrone();
    });
  }
}

init();

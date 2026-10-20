// 結果の書き出し（CSV・KML）
import { PHASE_LABEL } from './sim.js';
import { ellipsePolygon } from './montecarlo.js';

export function download(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function trajectoryCSV(res, t0) {
  const rows = ['経過時間[s],時刻(UTC),緯度,経度,高度[m],東向き速度[m/s],北向き速度[m/s],上向き速度[m/s],マッハ数,区間'];
  for (const p of res.path) {
    rows.push([p.t.toFixed(2), new Date((t0 + p.t) * 1000).toISOString(), p.lat.toFixed(6), p.lon.toFixed(6), p.h.toFixed(1),
      p.vE.toFixed(2), p.vN.toFixed(2), p.vU.toFixed(2), p.M != null ? p.M.toFixed(3) : '', PHASE_LABEL[p.phase] ?? p.phase].join(','));
  }
  return '﻿' + rows.join('\n');
}

export function monteCarloCSV(runs) {
  const rows = ['試行,落下緯度,落下経度,着地標高[m],飛行時間[s],最高高度[m],着地速度[m/s]'];
  runs.forEach((r, i) => rows.push([i + 1, r.lat.toFixed(6), r.lon.toFixed(6), r.ground.toFixed(1), r.t.toFixed(1),
    r.apogee != null ? r.apogee.toFixed(0) : '', r.v != null ? r.v.toFixed(2) : ''].join(',')));
  return '﻿' + rows.join('\n');
}

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/** Google Earth で3D表示できるKML（軌跡・イベント・落下範囲） */
export function trajectoryKML(res, runs, stats, title) {
  const coords = res.path.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)},${p.h.toFixed(1)}`).join(' ');
  const evs = res.events.map((e) => `
    <Placemark><name>${esc(e.label)}</name><description>高度 ${Math.round(e.h)} m / 経過 ${e.t.toFixed(1)} s</description>
      <Point><altitudeMode>absolute</altitudeMode><coordinates>${e.lon.toFixed(6)},${e.lat.toFixed(6)},${e.h.toFixed(1)}</coordinates></Point></Placemark>`).join('');
  const pts = (runs || []).map((r) => `
    <Placemark><styleUrl>#mc</styleUrl><Point><coordinates>${r.lon.toFixed(6)},${r.lat.toFixed(6)},0</coordinates></Point></Placemark>`).join('');
  const ell = stats ? stats.ellipses.map((e) => `
    <Placemark><name>落下範囲 ${Math.round(e.p * 100)}%</name><styleUrl>#ell</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${
      ellipsePolygon(stats, e).map(([la, lo]) => `${lo.toFixed(6)},${la.toFixed(6)},0`).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`).join('') : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(title)}</name>
  <Style id="traj"><LineStyle><color>ff2b45e0</color><width>3</width></LineStyle></Style>
  <Style id="mc"><IconStyle><scale>0.4</scale><color>ff3a45e0</color></IconStyle></Style>
  <Style id="ell"><LineStyle><color>ff3a45e0</color><width>2</width></LineStyle><PolyStyle><color>333a45e0</color></PolyStyle></Style>
  <Placemark><name>予測軌跡</name><styleUrl>#traj</styleUrl><LineString><extrude>0</extrude><altitudeMode>absolute</altitudeMode><coordinates>${coords}</coordinates></LineString></Placemark>
  ${evs}
  <Folder><name>モンテカルロ落下点</name>${pts}</Folder>
  ${ell}
</Document></kml>`;
}

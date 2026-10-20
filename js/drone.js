// ドローンの飛行可否判定（高度別の風・突風・降水・気温・視程）

const HEIGHTS = [10, 80, 120, 180];

/** 地上高 h[m] の風速を、10/80/120/180m の予報から対数高度で補間 */
export function windAtHeight(speeds, h) {
  const z = Math.min(Math.max(h, 10), 180);
  for (let i = 1; i < HEIGHTS.length; i++) {
    if (z <= HEIGHTS[i]) {
      const f = Math.log(z / HEIGHTS[i - 1]) / Math.log(HEIGHTS[i] / HEIGHTS[i - 1]);
      return speeds[i - 1] + (speeds[i] - speeds[i - 1]) * f;
    }
  }
  return speeds[3];
}

const WEATHER = {
  0: '快晴', 1: '晴れ', 2: '一部曇り', 3: '曇り', 45: '霧', 48: '着氷性の霧', 51: '霧雨', 53: '霧雨', 55: '強い霧雨',
  56: '着氷性の霧雨', 57: '着氷性の霧雨', 61: '小雨', 63: '雨', 65: '強い雨', 66: '着氷性の雨', 67: '着氷性の雨',
  71: '小雪', 73: '雪', 75: '大雪', 77: '霧雪', 80: 'にわか雨', 81: 'にわか雨', 82: '激しいにわか雨',
  85: 'にわか雪', 86: '強いにわか雪', 95: '雷雨', 96: '雷雨（ひょう）', 99: '激しい雷雨（ひょう）',
};
export const weatherName = (c) => WEATHER[c] ?? '—';

/**
 * p = { maxWind, alt, tMin, tMax, rainStop, popCaution, visMin }
 * 戻り値: 1時間ごとの判定 [{ t, wind, gust, dir, pop, precip, temp, vis, code, level, reasons }]
 */
export function judgeDrone(fc, p) {
  const H = fc.hourly;
  return H.time.map((t, i) => {
    const sp = [H.wind_speed_10m[i], H.wind_speed_80m[i], H.wind_speed_120m[i], H.wind_speed_180m[i]].map((x) => x ?? H.wind_speed_10m[i] ?? 0);
    const wind = windAtHeight(sp, p.alt);
    const w10 = Math.max(H.wind_speed_10m[i] ?? 0, 0.1);
    const gf = Math.min(Math.max((H.wind_gusts_10m[i] ?? w10) / w10, 1), 3); // 突風率
    const gust = wind * gf;
    const pop = H.precipitation_probability[i] ?? 0, precip = H.precipitation[i] ?? 0;
    const temp = H.temperature_2m[i], vis = H.visibility[i], code = H.weather_code[i];
    const stop = [], caution = [];
    if (gust > p.maxWind) stop.push(`突風 ${gust.toFixed(1)}m/s が耐風性能を超える`);
    else if (wind > p.maxWind * 0.7) caution.push(`風 ${wind.toFixed(1)}m/s（耐風性能の70%超）`);
    else if (gust > p.maxWind * 0.8) caution.push(`突風 ${gust.toFixed(1)}m/s（耐風性能の80%超）`);
    if (precip >= p.rainStop) stop.push(`降水 ${precip.toFixed(1)}mm/h`);
    else if (pop >= p.popCaution) caution.push(`降水確率 ${pop}%`);
    if (code >= 95) stop.push('雷雨の予報');
    if (temp != null && (temp < p.tMin || temp > p.tMax)) stop.push(`気温 ${temp.toFixed(0)}℃ が動作範囲外`);
    else if (temp != null && temp < p.tMin + 5) caution.push(`低温 ${temp.toFixed(0)}℃（バッテリー性能低下）`);
    if (vis != null && vis < p.visMin) stop.push(`視程 ${(vis / 1000).toFixed(1)}km（目視が困難）`);
    const level = stop.length ? 'stop' : caution.length ? 'caution' : 'ok';
    return { t, wind, gust, dir: H.wind_direction_120m[i] ?? H.wind_direction_10m[i], pop, precip, temp, vis, code, level, reasons: [...stop, ...caution] };
  });
}

/** 連続して「飛行可」の時間帯をまとめる */
export function goodWindows(rows, minHours = 2) {
  const out = [];
  let s = null;
  rows.forEach((r, i) => {
    if (r.level === 'ok' && s == null) s = i;
    if ((r.level !== 'ok' || i === rows.length - 1) && s != null) {
      const e = r.level === 'ok' ? i : i - 1;
      if (e - s + 1 >= minHours) out.push({ from: rows[s].t, to: rows[e].t + 3600, hours: e - s + 1 });
      s = null;
    }
  });
  return out;
}

/** 地理院の人口集中地区（令和2年）タイルの画素から、地点がDID内かを判定 */
export async function isInDID(lat, lon) {
  const z = 14, n = 2 ** z;
  const x = (lon + 180) / 360 * n;
  const lr = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n;
  const tx = Math.floor(x), ty = Math.floor(y);
  const px = Math.floor((x - tx) * 256), py = Math.floor((y - ty) * 256);
  const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/did2020/${z}/${tx}/${ty}.png`);
  if (res.status === 404) return false; // タイルなし＝DIDなし
  if (!res.ok) throw new Error('DIDタイル取得失敗');
  const bmp = await createImageBitmap(await res.blob());
  const c = new OffscreenCanvas(256, 256), ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(px, py, 1, 1).data[3] > 0;
}

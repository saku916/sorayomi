// モンテカルロ計算を画面と別スレッドで実行する
import { AtmosphereField } from './atmosphere.js';
import { runMonteCarlo } from './montecarlo.js';

self.onmessage = (e) => {
  const { cfg, atmData, sig, n, seed, groundMargin } = e.data;
  try {
    const atm = new AtmosphereField(atmData);
    const runs = runMonteCarlo(cfg, atm, sig, n, seed, (i, total) => self.postMessage({ type: 'progress', i, total }), groundMargin);
    self.postMessage({ type: 'done', runs, outOfGrid: atm.outOfGrid });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};

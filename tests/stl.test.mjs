// 3Dモデル解析の検証テスト
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSTL, analyzeSTL, estimateCd, makeSampleRocket, toBinarySTL } from '../js/stl.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('サンプル機体の寸法・面積・体積が設計値と一致する', () => {
  const tris = parseSTL(toBinarySTL(makeSampleRocket()));
  const g = analyzeSTL(tris, { unit: 1 });
  near(g.length, 1.5, 1e-6, '全長');
  near(g.bodyDiameter, 0.1, 0.002, '胴体径');
  near(g.frontalArea, Math.PI * 0.05 ** 2 + 4 * 0.08 * 0.004, 0.0003, '正面投影面積');
  // 胴体円筒 + 半回転楕円体ノーズ（48角形近似ぶん少し小さい）
  const vol = Math.PI * 0.05 ** 2 * 1.2 + (2 / 3) * Math.PI * 0.05 ** 2 * 0.3 + 4 * 0.08 * 0.004 * 0.12;
  near(g.volume, vol, vol * 0.02, '体積');
  near(g.noseLength, 0.206, 0.02, 'ノーズ長（半径95%到達点）');
  near(g.finSpan, 0.08, 0.01, 'フィン高さ');
  assert.equal(g.noseAtMin, false, 'ノーズは+Z側');
});

test('推定Cdが一般的な小型ロケットの範囲（亜音速0.3〜0.7）に入り、遷音速で増える', () => {
  const g = analyzeSTL(makeSampleRocket(), { unit: 1 });
  const cd = estimateCd(g);
  assert.ok(cd.cd0 > 0.3 && cd.cd0 < 0.7, `Cd0 ${cd.cd0}`);
  const at = (M) => cd.table.find((r) => r[0] === M)[1];
  assert.ok(at(1.05) > at(0.5) * 1.3, '遷音速で抵抗が増える');
  assert.ok(at(3) < at(1.1), '超音速で下がる');
});

test('ASCII STLも読める', () => {
  const txt = `solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n`;
  const t = parseSTL(new TextEncoder().encode(txt).buffer);
  assert.equal(t.length, 9);
});

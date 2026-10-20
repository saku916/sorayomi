// 3D表示（three.js）：機体モデルのプレビューと飛翔軌跡
let THREE = null, OrbitControls = null;

async function load() {
  if (THREE) return;
  THREE = await import('three');
  ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

class Viewer {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.innerHTML = '';
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1e7);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4);
    dl.position.set(1, 2, 1.5);
    this.scene.add(dl);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    const loop = () => { this.raf = requestAnimationFrame(loop); this.controls.update(); this.renderer.render(this.scene, this.camera); };
    loop();
  }
  resize() {
    const w = this.el.clientWidth || 300, h = this.el.clientHeight || 300;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  clear() {
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    this.scene.remove(this.group);
    this.group = new THREE.Group();
    this.scene.add(this.group);
  }
  frame(size, target = new THREE.Vector3()) {
    this.controls.target.copy(target);
    this.camera.position.set(target.x + size * 1.2, target.y + size * 0.8, target.z + size * 1.4);
    this.camera.near = size / 1000; this.camera.far = size * 100;
    this.camera.updateProjectionMatrix();
  }
}

const viewers = new WeakMap();
async function viewerFor(el) {
  await load();
  if (!viewers.has(el)) viewers.set(el, new Viewer(el));
  return viewers.get(el);
}

/** 機体モデル表示。g は analyzeSTL の結果（重心・簡易圧力中心を球で示す） */
export async function showModel(el, tris, unit, g) {
  const v = await viewerFor(el);
  v.clear();
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i++) pos[i] = tris[i] * unit;
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox.getCenter(c);
  geo.translate(-c.x, -c.y, -c.z);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: css('--accent'), metalness: 0.2, roughness: 0.55, side: THREE.DoubleSide }));
  v.group.add(mesh);
  if (g) {
    const ax = g.axisIndex, dir = new THREE.Vector3(); dir.setComponent(ax, 1);
    const noseEnd = g.noseAtMin ? g.bounds.min[ax] : g.bounds.max[ax];
    const sgn = g.noseAtMin ? 1 : -1;
    const at = (d) => { const p = new THREE.Vector3(); p.setComponent(ax, noseEnd + sgn * d - c.getComponent(ax)); return p; };
    const r = g.length * 0.02;
    const ball = (color, p) => { const s = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false })); s.position.copy(p); s.renderOrder = 2; v.group.add(s); };
    ball(0x2f6fdf, at(g.cgFromNose));
    ball(0xe0453a, at(g.cpFromNose));
  }
  const size = geo.boundingBox.getSize(new THREE.Vector3()).length();
  v.frame(size * 0.8);
}

const PHASE_COLOR = { ascent: 0xe0453a, float: 0xf29b30, rail: 0x7a52d1, powered: 0x7a52d1, coast: 0x2f6fdf,
  ballistic: 0x2f6fdf, drogue: 0x16a3a3, main: 0x2e9d55, descent: 0x2e9d55 };

/** 飛翔軌跡（km単位、東=x・上=y・南=z）。runs はモンテカルロの間引き軌跡 */
export async function showTrajectory(el, nominal, runs, exaggeration = 1) {
  const v = await viewerFor(el);
  v.clear();
  if (!nominal || !nominal.path.length) return;
  const o = nominal.path[0];
  const cl = Math.cos(o.lat * Math.PI / 180), k = Math.PI / 180 * 6371.0088;
  const P = (lat, lon, h) => new THREE.Vector3((lon - o.lon) * k * cl, (h - o.h) / 1000 * exaggeration, -(lat - o.lat) * k);
  const pos = [], col = [];
  const color = new THREE.Color();
  for (let i = 1; i < nominal.path.length; i++) {
    const a = nominal.path[i - 1], b = nominal.path[i];
    const pa = P(a.lat, a.lon, a.h), pb = P(b.lat, b.lon, b.h);
    pos.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    color.set(PHASE_COLOR[b.phase] ?? 0x888888);
    col.push(color.r, color.g, color.b, color.r, color.g, color.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  v.group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true })));

  const box = new THREE.Box3().setFromBufferAttribute(geo.getAttribute('position'));
  if (runs && runs.length) {
    const mp = [];
    const lp = [];
    for (const r of runs.slice(0, 200)) {
      for (let i = 1; i < r.path.length; i++) {
        const a = P(...r.path[i - 1]), b = P(...r.path[i]);
        mp.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      const l = P(r.lat, r.lon, r.ground);
      lp.push(l.x, l.y, l.z);
    }
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
    v.group.add(new THREE.LineSegments(g2, new THREE.LineBasicMaterial({ color: css('--muted'), transparent: true, opacity: 0.18 })));
    const g3 = new THREE.BufferGeometry();
    g3.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    v.group.add(new THREE.Points(g3, new THREE.PointsMaterial({ color: 0xe0453a, size: 4, sizeAttenuation: false })));
    box.union(new THREE.Box3().setFromBufferAttribute(g2.getAttribute('position')));
  }
  const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.5);
  const grid = new THREE.GridHelper(size * 1.5, 20, css('--grid-strong'), css('--grid'));
  const center = box.getCenter(new THREE.Vector3());
  grid.position.set(center.x, 0, center.z);
  v.group.add(grid);
  const mk = (p, c) => { const s = new THREE.Mesh(new THREE.SphereGeometry(size * 0.008, 12, 8), new THREE.MeshBasicMaterial({ color: c })); s.position.copy(p); v.group.add(s); };
  mk(P(o.lat, o.lon, o.h), 0x222222);
  if (nominal.landing) mk(P(nominal.landing.lat, nominal.landing.lon, nominal.landing.h), 0xe0453a);
  v.frame(size * 0.45, center);
}

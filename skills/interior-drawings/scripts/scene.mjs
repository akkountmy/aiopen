#!/usr/bin/env node
/**
 * Интерактивная 3D-сцена интерьера из того же JSON-спека: three.js r186 локально,
 * без CDN. Стены собираются с проёмами (подоконная часть + перемычка), пол по
 * полигонам комнат, мебель — блоки с габаритами из каталога.
 *
 *   node scene.mjs spec.json out.html [--render] [--width 1600]
 *
 * --render дополнительно снимает PNG (нужен Edge/Chrome) рядом с HTML.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, area, num } from './lib.mjs';
import { htmlToPng } from './render.mjs';

/* Сборка three.js, которая лежит в самом сервисе: на сервере (~/.dsh нет) сцена
   иначе не собиралась бы вовсе, хотя файл рядом — в public/vendor сайта. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

const THREE_VENDOR = [
  'C:\\Users\\33620\\.dsh\\vendor\\three\\dist\\three.global.js',
  process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'vendor/three/dist/three.global.js') : null,
  path.join(os.homedir(), '.dsh', 'vendor', 'three', 'dist', 'three.global.js'),
  path.resolve(HERE, '../../../public/vendor/three.global.js'),
  path.resolve(HERE, '../../three-js/vendor/three.global.js'),
];

function threePath() {
  for (const p of THREE_VENDOR) if (p && fs.existsSync(p)) return p;
  throw new Error('не найден vendor three.global.js — установите three по навыку three-js');
}

const WALL_H = 2700;

export function sceneHtml(spec) {
  const json = JSON.stringify(spec);
  const areaTotal = (spec.rooms || []).reduce((s, r) => s + area(r.poly), 0);
  const title = String(spec.project || 'Интерьер 3D').replace(/[<>&]/g, '');
  const object = spec.object ? String(spec.object).replace(/[<>&]/g, '') + ' · ' : '';
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${title}</title>
<style>
  :root { color-scheme: light }
  html,body { margin:0; height:100%; overflow:hidden; background:#eceae4;
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif; color:#1d2125 }
  #c { display:block; width:100vw; height:100vh }
  .hud { position:fixed; left:20px; top:18px; max-width:330px; pointer-events:none }
  .hud h1 { margin:0 0 4px; font-size:17px; font-weight:650; letter-spacing:-0.01em }
  .hud p { margin:0; font-size:12.5px; line-height:1.45; color:#4b5158 }
  .bar { position:fixed; left:20px; bottom:18px; display:flex; gap:8px; align-items:center;
    flex-wrap:wrap; font-size:12.5px }
  .bar button { font: inherit; padding:7px 12px; border-radius:9px; border:1px solid #c9c4ba;
    background:#fffdf8; color:#22262a; cursor:pointer }
  .bar button:hover { background:#f4efe5 }
  .bar button[aria-pressed="true"] { background:#22262a; color:#fbf8f1; border-color:#22262a }
  .badge { position:fixed; right:20px; bottom:18px; font-size:12px; color:#6a7077; text-align:right }
</style></head>
<body>
<canvas id="c"></canvas>
<div class="hud">
  <h1>${title}</h1>
  <p>${object}${num(areaTotal, 1)} м² · высота ${spec.heights?.wall || WALL_H} мм</p>
  <p style="margin-top:6px">Тяните мышью — поворот, колесо — масштаб, ПКМ — сдвиг.</p>
</div>
<div class="bar">
  <button data-view="plan">План</button>
  <button data-view="corner1" aria-pressed="true">Угол 1</button>
  <button data-view="corner2">Угол 2</button>
  <button data-view="kitchen">Кухня</button>
  <button id="ceil" aria-pressed="false">Потолок</button>
  <button id="cut" aria-pressed="true">Срез стен</button>
</div>
<div class="badge">three.js r186 · локально, без сети</div>
<script type="application/json" id="spec">${json.replace(/</g, '\\u003c')}</script>
<script src="${path.basename(threePath())}"></script>
<script>
window.addEventListener('error', (e) => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:20px;top:110px;max-width:640px;padding:12px 14px;background:#fff4f2;border:1px solid #d98b7f;border-radius:8px;font:12.5px monospace;color:#7a2b1e;white-space:pre-wrap;z-index:9';
  d.textContent = 'Ошибка сцены: ' + (e.message || e.type) + '\\n' + (e.filename || '') + ':' + (e.lineno || '');
  document.body.appendChild(d);
});
(() => {
  const spec = JSON.parse(document.getElementById('spec').textContent);
  const CATALOG = ${JSON.stringify(CATALOG)};
  const H = Number(spec.heights?.wall || ${WALL_H});
  const FLOOR = '#efe7d9';
  const cvs = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas: cvs, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#eceae4');

  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 400);
  const walls = spec.walls || [];
  const xs = walls.flatMap(w => [w.x1, w.x2]);
  const ys = walls.flatMap(w => [w.y1, w.y2]);
  const b = { x0: Math.min(...xs)/1000, x1: Math.max(...xs)/1000, y0: Math.min(...ys)/1000, y1: Math.max(...ys)/1000 };
  const center = new THREE.Vector3((b.x0 + b.x1)/2, H/1000/2, -(b.y0 + b.y1)/2);
  const size = Math.max(b.x1 - b.x0, b.y1 - b.y0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xb6ad9a, 1.55));
  const sun = new THREE.DirectionalLight(0xfff6e8, 1.5);
  sun.position.set(4, 9, -3);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xf3efe6, 0.85);
  fill.position.set(-6, 5, 5);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));

  // пол по комнатам: (x, y) модели -> (x, 0, -y) сцены
  const roomGroup = new THREE.Group();
  const FLOORS = { 'инженерная доска': '#d8bd97', 'ламинат 33 кл.': '#cbb08d', 'керамогранит 600×600': '#c9c6c0', 'керамогранит': '#c9c6c0', 'плитка': '#c9c6c0' };
  for (const r of spec.rooms || []) {
    const shape = new THREE.Shape();
    r.poly.forEach(([x, y], i) => (i ? shape.lineTo(x/1000, y/1000) : shape.moveTo(x/1000, y/1000)));
    shape.closePath();
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: FLOORS[r.floor] || FLOOR, roughness: 0.9 }));
    m.rotation.x = -Math.PI/2;
    m.receiveShadow = true;
    m.position.y = 0.002;
    roomGroup.add(m);
    const pts = r.poly.map(([x, y]) => new THREE.Vector3(x/1000, 0.06, -y/1000));
    pts.push(pts[0].clone());
    roomGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xb9b2a4 })));
  }
  scene.add(roomGroup);

  // стены с проёмами
  const WALL_COLOR = '#f4f1ea';
  const wallGroup = new THREE.Group();
  const openings = spec.openings || [];
  const matCache = new Map();
  const mat = (color, rough = 0.85) => {
    const key = color + rough;
    if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.02 }));
    return matCache.get(key);
  };
  const box = (x, y, z, sx, sy, sz, m) => {
    // геометрия привязана к низу: масштаб по Y режет коробку снизу вверх (срез стен)
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(0, sy / 2, 0);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    mesh.userData.base = y;
    mesh.userData.h = sy;
    return mesh;
  };
  for (const w of walls) {
    const t = (w.t ?? 150) / 1000;
    const horiz = Math.abs(w.y1 - w.y2) < 1;
    const a0 = (horiz ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2)) / 1000;
    const a1 = (horiz ? Math.max(w.x1, w.x2) : Math.max(w.y1, w.y2)) / 1000;
    const fixed = (horiz ? w.y1 : w.x1) / 1000;
    const own = openings.filter(o => (o.dir === 'h') === horiz &&
      Math.abs((horiz ? (o.y ?? 0) : (o.x ?? 0)) / 1000 - fixed) < 0.35 &&
      (o.x + (horiz ? 0 : 0)) / 1000 >= a0 - 0.4 && (o.x + (horiz ? o.w : 0)) / 1000 <= a1 + 0.4);
    const cuts = own.map(o => {
      const s = (horiz ? o.x : o.y) / 1000;
      const len = o.w / 1000;
      const sill = o.kind === 'window' ? Number(o.sill ?? 900) / 1000 : 0;
      const hh = (o.kind === 'window' ? Number(o.h ?? 1500) : 2100) / 1000;
      return { s, e: s + len, sill, top: Math.min(H/1000, sill + hh) };
    }).sort((p, q) => p.s - q.s);

    const m = mat(WALL_COLOR, 0.95);
    let cursor = a0;
    const place = (from, to, y0, y1) => {
      if (to - from < 0.004 || y1 - y0 < 0.004) return;
      const len = to - from;
      const mid = (from + to) / 2;
      const hh = y1 - y0;
      if (horiz) wallGroup.add(box(mid, y0, -fixed, len, hh, t, m));
      else wallGroup.add(box(fixed, y0, -mid, t, hh, len, m));
    };
    for (const c of cuts) {
      if (c.s > cursor) place(cursor, c.s, 0, H/1000);
      if (c.sill > 0) place(c.s, c.e, 0, c.sill);
      if (c.top < H/1000) place(c.s, c.e, c.top, H/1000);
      cursor = Math.max(cursor, c.e);
    }
    if (cursor < a1) place(cursor, a1, 0, H/1000);
  }
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xbcd6e6, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.35 });
  for (const o of openings) {
    if (o.kind !== 'window') continue;
    const sill = Number(o.sill ?? 900) / 1000;
    const hh = Number(o.h ?? 1500) / 1000;
    const wl = o.w / 1000;
    const cx = (o.dir === 'h' ? o.x + o.w / 2 : o.x) / 1000;
    const cz = -(o.dir === 'h' ? o.y : o.y + o.w / 2) / 1000;
    wallGroup.add(box(cx, sill, cz, o.dir === 'h' ? wl : 0.02, hh, o.dir === 'h' ? 0.02 : wl, glass));
  }
  // срез стен (как в аксонометрии): коробки привязаны к низу, режем масштабом по Y
  let cutOn = true;
  const CUT_Y = Number(spec.cut ?? 1150) / 1000;
  const applyCut = () => {
    for (const child of wallGroup.children) {
      const { base, h } = child.userData;
      if (base === undefined) continue;
      const frac = cutOn ? (CUT_Y - base) / h : 1;
      child.visible = frac > 0.02;
      child.scale.y = Math.min(1, Math.max(0.02, frac));
    }
  };
  applyCut();
  scene.add(wallGroup);

  // потолок
  const ceilGroup = new THREE.Group();
  for (const r of spec.rooms || []) {
    const shape = new THREE.Shape();
    r.poly.forEach(([x, y], i) => (i ? shape.lineTo(x/1000, y/1000) : shape.moveTo(x/1000, y/1000)));
    shape.closePath();
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI/2;
    m.position.y = H/1000 - 0.01;
    ceilGroup.add(m);
  }
  ceilGroup.visible = false;
  scene.add(ceilGroup);

  // мебель
  const CAT_COLOR = {
    seating: '#cdd6e0', sleep: '#e6d9c7', storage: '#d6cfc2', kitchen: '#dde3e6',
    wet: '#c8d6e2', table: '#e2dbd0', other: '#e6e3da',
  };
  const category = (kind) => {
    if (['sofa', 'armchair'].includes(kind)) return 'seating';
    if (['bed_double', 'bed_single'].includes(kind)) return 'sleep';
    if (['wardrobe', 'wardrobe_slide', 'shelving', 'tv_stand'].includes(kind)) return 'storage';
    if (['kitchen_counter', 'fridge', 'hob', 'sink'].includes(kind)) return 'kitchen';
    if (['bath', 'wc', 'bath_sink', 'shower'].includes(kind)) return 'wet';
    if (['dining_table', 'coffee_table', 'desk', 'chair'].includes(kind)) return 'table';
    return 'other';
  };
  const furn = new THREE.Group();
  for (const f of spec.furniture || []) {
    if (f.kind === 'rug') continue;
    const def = CATALOG[f.kind] || [1000, 600, 750];
    const w = Number(f.w || def[0]) / 1000;
    const d = Number(f.d || def[1]) / 1000;
    const h = Number(f.h || def[2]) / 1000;
    const mm = new THREE.MeshStandardMaterial({ color: CAT_COLOR[category(f.kind)], roughness: 0.75, metalness: 0.03 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mm);
    mesh.position.set(Number(f.x)/1000 + w/2, h/2, -(Number(f.y)/1000 + d/2));
    if (f.rot) mesh.rotation.y = -Number(f.rot) * Math.PI / 180;
    mesh.castShadow = true; mesh.receiveShadow = true;
    furn.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0x8f959c, transparent: true, opacity: 0.5 }));
    edges.position.copy(mesh.position); edges.rotation.copy(mesh.rotation);
    furn.add(edges);
  }
  scene.add(furn);

  // подписи комнат спрайтами
  const label = (txt, x, z, y) => {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(255,255,255,0.86)';
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = '#22262a';
    g.font = '600 56px "Segoe UI", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(txt, 256, 66);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    s.position.set(x, y, z);
    s.scale.set(1.5, 0.375, 1);
    s.renderOrder = 10;
    scene.add(s);
  };
  for (const r of spec.rooms || []) {
    const cx = r.poly.reduce((s, p) => s + p[0], 0) / r.poly.length / 1000;
    const cy = r.poly.reduce((s, p) => s + p[1], 0) / r.poly.length / 1000;
    label(r.name, cx, -cy, 1.15);
  }

  // камера-орбита
  let theta = -0.75, phi = 1.0, dist = size * 1.5, target = center.clone();
  const applyCam = () => {
    phi = Math.max(0.12, Math.min(Math.PI / 2 - 0.02, phi));
    dist = Math.max(size * 0.45, Math.min(size * 4.5, dist));
    camera.position.set(
      target.x + dist * Math.sin(phi) * Math.sin(theta),
      target.y + dist * Math.cos(phi),
      target.z + dist * Math.sin(phi) * Math.cos(theta),
    );
    camera.lookAt(target);
  };
  let drag = null;
  cvs.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; cvs.setPointerCapture(e.pointerId); });
  cvs.addEventListener('pointerup', () => { drag = null; });
  cvs.addEventListener('contextmenu', (e) => e.preventDefault());
  cvs.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) {
      const s = dist * 0.0012;
      const right = new THREE.Vector3().subVectors(camera.position, target).cross(new THREE.Vector3(0, 1, 0)).normalize();
      target.addScaledVector(right, -dx * s).y -= dy * s;
    } else {
      theta -= dx * 0.006;
      phi -= dy * 0.006;
    }
    applyCam();
  }, { passive: true });
  cvs.addEventListener('wheel', (e) => { e.preventDefault(); dist *= 1 + Math.sign(e.deltaY) * 0.08; applyCam(); }, { passive: false });

  const VIEWS = {
    plan: () => ({ theta: 0, phi: 0.02, dist: size * 1.6, target: center.clone() }),
    corner1: () => ({ theta: -0.8, phi: 1.02, dist: size * 1.5, target: center.clone() }),
    corner2: () => ({ theta: 2.4, phi: 1.05, dist: size * 1.5, target: center.clone() }),
    kitchen: () => ({ theta: -0.35, phi: 1.15, dist: size * 0.55, target: new THREE.Vector3(b.x0 + size * 0.25, H / 1000 / 2, -(b.y0 + size * 0.35)) }),
  };
  const setView = (name) => {
    const v = VIEWS[name] ? VIEWS[name]() : VIEWS.corner1();
    theta = v.theta; phi = v.phi; dist = v.dist; target = v.target;
    applyCam();
    document.querySelectorAll('[data-view]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.view === name)));
  };
  document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
  const ceilBtn = document.getElementById('ceil');
  ceilBtn.addEventListener('click', () => {
    ceilGroup.visible = !ceilGroup.visible;
    ceilBtn.setAttribute('aria-pressed', String(ceilGroup.visible));
  });
  const cutBtn = document.getElementById('cut');
  cutBtn.addEventListener('click', () => {
    cutOn = !cutOn;
    applyCut();
    cutBtn.setAttribute('aria-pressed', String(cutOn));
  });

  const resize = () => {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();
  setView('corner1');

  let frames = 0;
  const SHOT = location.search.includes('shot');
  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
    frames++;
    if (frames === 2) document.body.dataset.ready = '1';
    if (SHOT && frames >= 4) renderer.setAnimationLoop(null); // статичный кадр для скриншота
  });
})();
</script>
</body></html>`;
}

export function buildScene(spec, outHtml) {
  const html = sceneHtml(spec);
  fs.mkdirSync(path.dirname(path.resolve(outHtml)), { recursive: true });
  fs.writeFileSync(outHtml, html, 'utf8');
  const tp = threePath();
  fs.copyFileSync(tp, path.join(path.dirname(path.resolve(outHtml)), path.basename(tp)));
  return { html: path.resolve(outHtml), bytes: Buffer.byteLength(html) };
}

if (process.argv[1] && process.argv[1].endsWith('scene.mjs')) {
  const [file, outArg] = process.argv.slice(2);
  if (!file) {
    console.error('Использование: node scene.mjs spec.json out.html [--render]');
    process.exit(2);
  }
  const spec = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''));
  const out = path.resolve(outArg || file.replace(/\.json$/, '-3d.html'));
  const info = buildScene(spec, out);
  const res = { ...info };
  if (process.argv.includes('--render')) {
    const wIdx = process.argv.indexOf('--width');
    const width = wIdx > 0 ? Number(process.argv[wIdx + 1]) : 1600;
    const png = out.replace(/\.html$/, '.png');
    /* WebGL в headless Edge отдаёт пустой кадр — снимаем Chromium через Playwright,
       Edge остаётся запасным путём внутри htmlShot. */
    try {
      const { htmlShot } = await import('./shot.mjs');
      Object.assign(res, await htmlShot(out, png, { width, height: Math.round(width * 0.625), query: '?shot=1', dpi: 1 }));
    } catch (error) {
      Object.assign(res, htmlToPng(out, png, { width, height: Math.round(width * 0.625), waitMs: 7000, query: '?shot=1' }), { note: String(error?.message || error) });
    }
  }
  console.log(JSON.stringify(res, null, 2));
}

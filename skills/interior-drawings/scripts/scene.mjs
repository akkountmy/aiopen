#!/usr/bin/env node
/**
 * Интерактивная 3D-сцена интерьера из того же JSON-спека: three.js r186 локально,
 * без CDN. Это не «коробки на полу»: пол с процедурной текстурой, стены с
 * проёмами, мебель с мягкими подушками и фурнитурой, три слоя света, палитра из
 * референса и чистый hero-кадр для PNG.
 *
 *   node scene.mjs spec.json out.html [--render] [--width 1600]
 *
 * --render дополнительно снимает PNG (нужен Chromium/Edge) рядом с HTML.
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

function escHtml(value) {
  return String(value ?? '').replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]);
}

export function sceneHtml(spec) {
  const json = JSON.stringify(spec).replace(/</g, '\\u003c');
  const areaTotal = (spec.rooms || []).reduce((s, r) => s + area(r.poly), 0);
  const title = escHtml(spec.project || 'Интерьер 3D');
  const object = escHtml(spec.object || '');
  const styleName = escHtml(spec.style?.name || 'Современный нейтральный');
  const refName = escHtml(spec.style?.referenceName || '');
  const roomCount = (spec.rooms || []).length;

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    color-scheme: dark;
    --ink: #f3efe7;
    --muted: #a7a29a;
    --line: rgba(255,255,255,.14);
    --panel: rgba(18,19,21,.72);
    --accent: #d8a27a;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: #141517; overflow: hidden; }
  body { font-family: "Segoe UI", "Inter", system-ui, sans-serif; color: var(--ink); }
  #stage { position: fixed; inset: 0; }
  #stage canvas { display: block; width: 100%; height: 100%; touch-action: none; }
  #vignette {
    position: fixed; inset: 0; pointer-events: none;
    background: radial-gradient(120% 90% at 52% 38%, transparent 42%, rgba(0,0,0,.34) 100%);
  }
  #ui { position: fixed; inset: 0; pointer-events: none; }
  .panel {
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    box-shadow: 0 18px 60px rgba(0,0,0,.35);
  }
  #brand { position: absolute; left: 26px; top: 22px; max-width: min(420px, 62vw); padding: 14px 18px; }
  #brand .kicker { font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: var(--accent); font-weight: 700; }
  #brand h1 { margin: 6px 0 2px; font-size: clamp(16px, 2.2vw, 24px); line-height: 1.12; font-weight: 650; letter-spacing: -.015em; }
  #brand .sub { font-size: 11.5px; color: var(--muted); }
  #brand .sub b { color: #ddd3c4; font-weight: 500; }
  #palette { position: absolute; right: 26px; top: 22px; width: 220px; padding: 14px 16px; }
  #palette .head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
  #palette .t { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
  #palette .n { font-size: 10px; color: var(--accent); }
  #swatches { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; margin-top: 11px; }
  .sw { height: 28px; border-radius: 6px; border: 1px solid rgba(255,255,255,.18); position: relative; }
  .sw span { position: absolute; left: 0; right: 0; bottom: -15px; text-align: center; font-size: 8px; color: #929089; letter-spacing: .02em; }
  #palette .mats { margin-top: 23px; font-size: 10.5px; line-height: 1.5; color: #b8b3aa; }
  #palette .mats b { color: #e6dfd4; font-weight: 500; }
  #views { position: absolute; left: 26px; bottom: 24px; display: flex; flex-wrap: wrap; gap: 7px; max-width: min(760px, 70vw); pointer-events: auto; }
  .chip {
    appearance: none; border: 1px solid var(--line); background: rgba(20,21,23,.74); color: #d8d3ca;
    font: 500 11.5px/1 "Segoe UI", sans-serif; padding: 10px 13px; border-radius: 999px; cursor: pointer;
    transition: background .18s, color .18s, border-color .18s; backdrop-filter: blur(10px);
  }
  .chip:hover { background: rgba(255,255,255,.12); color: #fff; }
  .chip.on { background: #efe7da; color: #17181a; border-color: #efe7da; }
  .chip.toggle { color: #a9a49b; }
  .chip.toggle.on { background: rgba(216,162,122,.2); color: #f0c9a8; border-color: rgba(216,162,122,.5); }
  #actions { position: absolute; right: 26px; bottom: 24px; display: flex; gap: 8px; pointer-events: auto; }
  #hint { position: absolute; right: 26px; bottom: 72px; font-size: 10.5px; color: rgba(235,230,222,.52); text-align: right; line-height: 1.5; }
  #loading {
    position: fixed; inset: 0; display: grid; place-items: center; background: #141517;
    transition: opacity .5s ease; z-index: 20;
  }
  #loading .box { text-align: center; }
  #loading .ring { width: 46px; height: 46px; margin: 0 auto 16px; border-radius: 50%; border: 2px solid rgba(255,255,255,.12); border-top-color: var(--accent); animation: spin 1s linear infinite; }
  #loading p { margin: 0; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #a7a29a; }
  #loading.hide { opacity: 0; pointer-events: none; }
  #error { position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%); max-width: 520px; padding: 20px 24px; display: none; z-index: 30; font-size: 13px; line-height: 1.5; }
  @keyframes spin { to { transform: rotate(360deg); } }
  html.shot #ui, html.shot #hint, html.shot #vignette { display: none !important; }
  html.shot #loading { display: none; }
  @media (max-width: 820px) {
    #brand { left: 14px; top: 14px; padding: 11px 14px; max-width: 64vw; }
    #brand h1 { font-size: 15px; }
    #palette { right: 14px; top: 14px; width: 154px; padding: 11px 12px; }
    #palette .mats { display: none; }
    #swatches { gap: 5px; }
    .sw { height: 20px; }
    #views { left: 14px; bottom: 14px; max-width: 72vw; }
    .chip { padding: 8px 10px; font-size: 10.5px; }
    #actions { right: 14px; bottom: 14px; }
    #hint { display: none; }
  }
</style></head>
<body>
<div id="stage"></div>
<div id="vignette"></div>
<div id="ui">
  <div id="brand" class="panel">
    <div class="kicker">DSH OPEN · интерьер</div>
    <h1>${title}</h1>
    <div class="sub"><b>${object || '3D-визуализация'}</b> · ${num(areaTotal)} м² · ${roomCount} пом.</div>
  </div>
  <div id="palette" class="panel">
    <div class="head"><span class="t">Палитра</span><span class="n">${styleName}</span></div>
    <div id="swatches"></div>
    <div class="mats" id="mats"></div>
  </div>
  <div id="views"></div>
  <div id="actions">
    <button class="chip" id="download" type="button">Скачать PNG</button>
  </div>
  <div id="hint">ЛКМ — поворот · колесо — масштаб · ПКМ — сдвиг${refName ? `<br>референс: ${refName}` : ''}</div>
</div>
<div id="loading"><div class="box"><div class="ring"></div><p>Собираю свет и материалы</p></div></div>
<div id="error" class="panel"></div>
<script src="three.global.js"></script>
<script>
(function () {
  'use strict';
  const SPEC = ${json};
  const CAT = ${JSON.stringify(CATALOG)};
  const P = (SPEC.style && SPEC.style.palette) || {
    wall: '#E8E1D5', ceiling: '#F7F4EE', floor: '#C9A87C', accent: '#B5654A',
    textile: '#8C8577', wood: '#B98A5A', metal: '#9A9A96', stone: '#D8D2C6'
  };
  const H = Math.min(6, Math.max(2.2, Number((SPEC.heights && (SPEC.heights.ceiling || SPEC.heights.wall)) || 2650) / 1000));
  const S = 0.001;
  const SHOT = /[?&]shot=1/.test(location.search);
  const qView = (location.search.match(/[?&]view=([^&]+)/) || [])[1] || 'hero';
  if (SHOT) document.documentElement.classList.add('shot');
  const stage = document.getElementById('stage');
  const errBox = document.getElementById('error');
  const loading = document.getElementById('loading');

  function fail(message) {
    console.error(message);
    if (errBox) { errBox.style.display = 'block'; errBox.textContent = 'Не удалось собрать сцену: ' + message; }
    if (loading) loading.classList.add('hide');
  }

  let renderer, scene, camera, controls;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  } catch (e) {
    fail('WebGL недоступен в этом браузере');
    return;
  }
  renderer.setPixelRatio(SHOT ? 1 : Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  stage.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141517);
  scene.fog = new THREE.Fog(0x141517, 26, 62);

  camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 120);

  /* Свой орбитальный контроллер: в локальной сборке three нет addons, а тянуть
     OrbitControls с CDN нельзя. Заодно одинаково работает мышь и тач. */
  function createOrbit(cam, el) {
    const c = {
      target: new THREE.Vector3(),
      enableDamping: true,
      dampingFactor: 0.08,
      minDistance: 1.2,
      maxDistance: 34,
      minPolarAngle: 0.02,
      maxPolarAngle: Math.PI / 2 - 0.015,
      screenSpacePanning: true,
      _dTheta: 0, _dPhi: 0, _zoom: 1,
      _pan: new THREE.Vector3(),
      _drag: null,
    };
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    c.update = function () {
      const damp = c.enableDamping ? c.dampingFactor : 1;
      const off = cam.position.clone().sub(c.target);
      const sph = new THREE.Spherical().setFromVector3(off);
      c.target.addScaledVector(c._pan, damp);
      c._pan.multiplyScalar(1 - damp);
      sph.theta += c._dTheta * damp;
      sph.phi += c._dPhi * damp;
      sph.radius *= 1 + (c._zoom - 1) * damp;
      c._dTheta *= 1 - damp;
      c._dPhi *= 1 - damp;
      c._zoom = 1 + (c._zoom - 1) * (1 - damp);
      sph.phi = clamp(sph.phi, c.minPolarAngle, c.maxPolarAngle);
      sph.radius = clamp(sph.radius, c.minDistance, c.maxDistance);
      cam.position.copy(c.target).add(new THREE.Vector3().setFromSpherical(sph));
      cam.lookAt(c.target);
    };
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    el.addEventListener('pointerdown', function (e) {
      if (e.button === 0) c._drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 };
      else if (e.button === 2 || e.button === 1) c._drag = { x: e.clientX, y: e.clientY, pan: true };
      if (c._drag) { el.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    el.addEventListener('pointermove', function (e) {
      if (!c._drag) return;
      const dx = e.clientX - c._drag.x, dy = e.clientY - c._drag.y;
      c._drag.x = e.clientX; c._drag.y = e.clientY;
      if (c._drag.pan) {
        const scale = (2 * Math.tan((cam.fov * Math.PI) / 360) * cam.position.distanceTo(c.target)) / Math.max(1, el.clientHeight);
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
        c._pan.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
      } else {
        c._dTheta -= dx * 0.006;
        c._dPhi -= dy * 0.006;
      }
      e.preventDefault();
    });
    const endDrag = function (e) { c._drag = null; if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      c._zoom *= Math.exp(e.deltaY * 0.001);
      c._zoom = clamp(c._zoom, 0.45, 2.4);
    }, { passive: false });
    return c;
  }
  controls = createOrbit(camera, renderer.domElement);

  /* ------------------------------- палитра ------------------------------- */
  function C(hex) { return new THREE.Color(hex || '#cccccc'); }
  function shade(hex, dl) {
    const c = C(hex);
    c.offsetHSL(0, 0, dl);
    return '#' + c.getHexString();
  }
  function mix(a, b, t) {
    const ca = C(a), cb = C(b);
    return '#' + ca.clone().lerp(cb, t).getHexString();
  }
  let seed = 17;
  function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

  function canvasTex(size, draw) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    draw(g, size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  }

  function woodTexture(base) {
    return canvasTex(512, function (g, s) {
      g.fillStyle = shade(base, -0.10);
      g.fillRect(0, 0, s, s);
      const plank = 64;
      for (let i = 0; i < 8; i++) {
        g.fillStyle = shade(base, (i % 3 - 1) * 0.035 + (i % 2 ? -0.015 : 0.025));
        g.fillRect(i * plank, 0, plank - 1, s);
        for (let j = 0; j < 11; j++) {
          g.strokeStyle = 'rgba(62,40,24,' + (0.05 + rnd() * 0.07).toFixed(3) + ')';
          g.lineWidth = 0.6 + rnd() * 1.1;
          g.beginPath();
          const x = i * plank + 7 + rnd() * (plank - 14);
          g.moveTo(x, 0);
          g.bezierCurveTo(x + 5, s * 0.3, x - 5, s * 0.68, x + 2, s);
          g.stroke();
        }
        g.fillStyle = 'rgba(44,28,18,.35)';
        g.fillRect(i * plank, 0, 1, s);
      }
      g.fillStyle = 'rgba(255,255,255,.035)';
      for (let i = 0; i < 18; i++) g.fillRect(0, rnd() * s, s, 1);
    });
  }

  function tileTexture(base) {
    return canvasTex(512, function (g, s) {
      g.fillStyle = mix(base, '#ffffff', 0.18);
      g.fillRect(0, 0, s, s);
      const n = 4, step = s / n;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        g.fillStyle = shade(base, (rnd() - 0.5) * 0.035);
        g.fillRect(x * step + 1, y * step + 1, step - 2, step - 2);
        for (let k = 0; k < 5; k++) {
          g.strokeStyle = 'rgba(120,115,108,.10)';
          g.lineWidth = 0.7;
          g.beginPath();
          g.moveTo(x * step + 6, y * step + 8 + rnd() * (step - 16));
          g.bezierCurveTo(x * step + step * 0.3, y * step + rnd() * step, x * step + step * 0.7, y * step + rnd() * step, x * step + step - 6, y * step + 8 + rnd() * (step - 16));
          g.stroke();
        }
      }
      g.strokeStyle = 'rgba(255,255,255,.55)';
      g.lineWidth = 2;
      for (let i = 0; i <= n; i++) {
        g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, s); g.stroke();
        g.beginPath(); g.moveTo(0, i * step); g.lineTo(s, i * step); g.stroke();
      }
    });
  }

  function fabricTexture(base) {
    return canvasTex(256, function (g, s) {
      g.fillStyle = base;
      g.fillRect(0, 0, s, s);
      for (let y = 0; y < s; y += 3) {
        g.strokeStyle = 'rgba(255,255,255,' + (0.018 + rnd() * 0.025).toFixed(3) + ')';
        g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke();
        g.strokeStyle = 'rgba(0,0,0,' + (0.018 + rnd() * 0.02).toFixed(3) + ')';
        g.beginPath(); g.moveTo(0, y + 1.4); g.lineTo(s, y + 1.4); g.stroke();
      }
      for (let x = 0; x < s; x += 4) {
        g.strokeStyle = 'rgba(255,255,255,.020)';
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s); g.stroke();
      }
    });
  }

  function rugTexture(base, accent, textile) {
    return canvasTex(512, function (g, s) {
      g.fillStyle = mix(base, textile, 0.42);
      g.fillRect(0, 0, s, s);
      g.strokeStyle = accent;
      g.lineWidth = 9;
      g.strokeRect(24, 24, s - 48, s - 48);
      g.lineWidth = 2;
      g.strokeRect(42, 42, s - 84, s - 84);
      g.globalAlpha = 0.32;
      for (let i = 0; i < 9; i++) {
        g.strokeStyle = i % 2 ? accent : textile;
        g.beginPath();
        g.moveTo(70 + i * 40, 80);
        g.bezierCurveTo(120, 190 + i * 16, 390, 110 + i * 18, s - 70, 250 + i * 8);
        g.stroke();
      }
      g.globalAlpha = 1;
      for (let i = 0; i < 6000; i++) {
        g.fillStyle = 'rgba(255,255,255,' + (rnd() * 0.05).toFixed(3) + ')';
        g.fillRect(rnd() * s, rnd() * s, 1, 1);
      }
    });
  }

  function artTexture(kind) {
    return canvasTex(512, function (g, s) {
      g.fillStyle = kind % 2 ? mix(P.wall, '#ffffff', 0.32) : mix(P.textile, '#ffffff', 0.48);
      g.fillRect(0, 0, s, s);
      g.fillStyle = P.accent;
      g.beginPath();
      g.arc(s * (0.36 + kind * 0.08), s * 0.4, s * 0.22, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = P.wood;
      g.fillRect(s * 0.16, s * 0.62, s * 0.84, s * 0.09);
      g.fillStyle = mix(P.metal, '#ffffff', 0.25);
      g.beginPath();
      g.moveTo(s * 0.58, s * 0.12); g.lineTo(s * 0.88, s * 0.54); g.lineTo(s * 0.46, s * 0.54); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(30,30,30,.16)';
      g.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        g.moveTo(0, s * (0.15 + i * 0.17));
        g.bezierCurveTo(s * 0.35, s * (0.1 + i * 0.18), s * 0.7, s * (0.26 + i * 0.13), s, s * (0.12 + i * 0.17));
        g.stroke();
      }
    });
  }

  const woodMap = woodTexture(P.wood);
  const fabricMap = fabricTexture(P.textile);
  const accentMap = fabricTexture(P.accent);
  const stoneMap = canvasTex(512, function (g, s) {
    g.fillStyle = P.stone;
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 22; i++) {
      g.strokeStyle = 'rgba(110,105,96,' + (0.04 + rnd() * 0.09).toFixed(3) + ')';
      g.lineWidth = 0.7 + rnd() * 1.4;
      g.beginPath();
      const y = rnd() * s;
      g.moveTo(-20, y);
      g.bezierCurveTo(s * 0.3, y + (rnd() - 0.5) * 40, s * 0.7, y + (rnd() - 0.5) * 50, s + 20, y + (rnd() - 0.5) * 30);
      g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,.28)';
    for (let i = 0; i < 1800; i++) g.fillRect(rnd() * s, rnd() * s, 1, 1);
  });

  const M = {
    wall: new THREE.MeshStandardMaterial({ color: P.wall, roughness: 0.94, metalness: 0 }),
    wallAccent: new THREE.MeshStandardMaterial({ color: shade(P.wall, -0.10), roughness: 0.92 }),
    ceiling: new THREE.MeshStandardMaterial({ color: P.ceiling, roughness: 0.95, side: THREE.DoubleSide }),
    wood: new THREE.MeshStandardMaterial({ map: woodMap, color: 0xffffff, roughness: 0.62, metalness: 0.02 }),
    woodDark: new THREE.MeshStandardMaterial({ color: shade(P.wood, -0.02), roughness: 0.54, metalness: 0.02 }),
    fabric: new THREE.MeshStandardMaterial({ map: fabricMap, color: 0xffffff, roughness: 0.98 }),
    accentFabric: new THREE.MeshStandardMaterial({ map: accentMap, color: 0xffffff, roughness: 0.98 }),
    textile: new THREE.MeshStandardMaterial({ color: P.textile, roughness: 0.98 }),
    metal: new THREE.MeshStandardMaterial({ color: P.metal, roughness: 0.34, metalness: 0.72 }),
    black: new THREE.MeshStandardMaterial({ color: 0x1b1b1c, roughness: 0.42, metalness: 0.18 }),
    stone: new THREE.MeshStandardMaterial({ map: stoneMap, color: 0xffffff, roughness: 0.3, metalness: 0.04 }),
    ceramic: new THREE.MeshStandardMaterial({ color: '#f4f1eb', roughness: 0.24, metalness: 0.02 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xbfd8e4, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.24, side: THREE.DoubleSide }),
    screen: new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.16, metalness: 0.25, emissive: 0x090b10, emissiveIntensity: 0.6 }),
    mirror: new THREE.MeshStandardMaterial({ color: 0xc9d3d8, roughness: 0.04, metalness: 1 }),
    leaf: new THREE.MeshStandardMaterial({ color: mix(P.accent, '#2f5a3a', 0.55), roughness: 0.82 }),
    leaf2: new THREE.MeshStandardMaterial({ color: mix(P.accent, '#486b43', 0.4), roughness: 0.86 }),
    glow: new THREE.MeshBasicMaterial({ color: 0xfff0d4, transparent: true, opacity: 0.55 }),
    bulb: new THREE.MeshStandardMaterial({ color: 0xfff3dd, emissive: 0xffd9a0, emissiveIntensity: 2.2, roughness: 0.3 }),
    book1: new THREE.MeshStandardMaterial({ color: mix(P.accent, '#ffffff', 0.1), roughness: 0.85 }),
    book2: new THREE.MeshStandardMaterial({ color: mix(P.textile, '#ffffff', 0.18), roughness: 0.85 }),
    book3: new THREE.MeshStandardMaterial({ color: mix(P.wood, '#ffffff', 0.3), roughness: 0.85 }),
  };

  /* ------------------------------ геометрия ------------------------------ */
  function addBox(parent, w, h, d, mat, x, y, z, r) {
    const radius = Math.max(0, Math.min(r || 0, Math.min(w, h, d) / 2 - 0.001));
    const geo = radius > 0.004
      ? new THREE.RoundedBoxGeometry(Math.max(0.01, w), Math.max(0.01, h), Math.max(0.01, d), 2, radius)
      : new THREE.BoxGeometry(Math.max(0.01, w), Math.max(0.01, h), Math.max(0.01, d));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x || 0, y || 0, z || 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  function addCyl(parent, rt, rb, h, mat, x, y, z, seg) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 16), mat);
    mesh.position.set(x || 0, y || 0, z || 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  function addRod(parent, a, b, r, mat) {
    const va = new THREE.Vector3(a[0], a[1], a[2]);
    const vb = new THREE.Vector3(b[0], b[1], b[2]);
    const len = va.distanceTo(vb);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
    mesh.position.copy(va.clone().add(vb).multiplyScalar(0.5));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /* ----------------------------- свет и среда ----------------------------- */
  const envCanvas = document.createElement('canvas');
  envCanvas.width = 1024; envCanvas.height = 512;
  const eg = envCanvas.getContext('2d');
  const grad = eg.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#fff8eb');
  grad.addColorStop(0.42, '#e6e2d8');
  grad.addColorStop(0.56, '#a9aaa5');
  grad.addColorStop(1, '#252321');
  eg.fillStyle = grad; eg.fillRect(0, 0, 1024, 512);
  const wg = eg.createLinearGradient(0, 0, 0, 512);
  wg.addColorStop(0, 'rgba(255,248,230,.95)');
  wg.addColorStop(1, 'rgba(255,248,230,.05)');
  eg.fillStyle = wg;
  eg.fillRect(660, 40, 110, 330);
  eg.fillRect(800, 60, 70, 300);
  const envTex = new THREE.CanvasTexture(envCanvas);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(envTex).texture;

  scene.add(new THREE.HemisphereLight(0xdbe7ff, 0x6b5642, 1.2));
  const ambient = new THREE.AmbientLight(0xfff3e4, 0.28);
  scene.add(ambient);

  /* ------------------------------- комнаты ------------------------------- */
  const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const rooms = (SPEC.rooms || []).map(function (r, idx) {
    /* План: X вправо, Y вниз (юг). В 3D Z тоже вниз/на юг: z = +y.
       ShapeGeometry поворачиваем на -90°, поэтому локальный Y берём -y. */
    const poly = (r.poly || []).map(function (p) { return [Number(p[0]) * S, -Number(p[1]) * S]; });
    const xs = poly.map(function (p) { return p[0]; });
    const zs = poly.map(function (p) { return -p[1]; });
    const box = { minX: Math.min.apply(null, xs), maxX: Math.max.apply(null, xs), minZ: Math.min.apply(null, zs), maxZ: Math.max.apply(null, zs) };
    box.cx = (box.minX + box.maxX) / 2; box.cz = (box.minZ + box.maxZ) / 2;
    bbox.minX = Math.min(bbox.minX, box.minX); bbox.maxX = Math.max(bbox.maxX, box.maxX);
    bbox.minY = Math.min(bbox.minY, box.minZ); bbox.maxY = Math.max(bbox.maxY, box.maxZ);
    return { name: r.name || ('Комната ' + (idx + 1)), poly: poly, box: box, floor: r.floor || '', tile: Number(r.tile) || 0 };
  });
  if (!rooms.length) {
    rooms.push({ name: 'Помещение', poly: [[0, 0], [8, 0], [8, 6], [0, 6]], box: { minX: 0, maxX: 8, minZ: 0, maxZ: 6, cx: 4, cz: 3 }, floor: '', tile: 0 });
    bbox.minX = 0; bbox.maxX = 8; bbox.minY = 0; bbox.maxY = 6;
  }
  const center = new THREE.Vector3((bbox.minX + bbox.maxX) / 2, 0.65, (bbox.minY + bbox.maxY) / 2);
  const size = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, 3);

  function floorMatFor(room) {
    const name = String(room.floor || '').toLowerCase();
    const tile = /плитк|керамогранит|мозаик|porcelain|мрамор/.test(name) || room.tile > 0;
    const base = tile ? P.stone : P.floor;
    const map = tile ? tileTexture(base) : woodTexture(base);
    const w = Math.max(1, room.box.maxX - room.box.minX);
    const d = Math.max(1, room.box.maxZ - room.box.minZ);
    map.repeat.set(tile ? w / 2.4 : w / 2.2, tile ? d / 2.4 : d / 2.2);
    return new THREE.MeshStandardMaterial({ map: map, roughness: tile ? 0.32 : 0.56, metalness: 0.01, side: THREE.DoubleSide });
  }

  const floorGroup = new THREE.Group();
  for (const room of rooms) {
    const shape = new THREE.Shape();
    room.poly.forEach(function (p, i) { if (i) shape.lineTo(p[0], p[1]); else shape.moveTo(p[0], p[1]); });
    shape.closePath();
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), floorMatFor(room));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0;
    mesh.receiveShadow = true;
    floorGroup.add(mesh);
  }
  scene.add(floorGroup);

  /* подиум и газон: кадр не «висит в пустоте» */
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({ color: 0x26282a, roughness: 0.98 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.055;
  ground.receiveShadow = true;
  scene.add(ground);

  const plinth = new THREE.Mesh(
    new THREE.BoxGeometry((bbox.maxX - bbox.minX) + 0.36, 0.18, (bbox.maxY - bbox.minY) + 0.36),
    new THREE.MeshStandardMaterial({ color: 0x2f3032, roughness: 0.9 })
  );
  plinth.position.set((bbox.minX + bbox.maxX) / 2, -0.1, (bbox.minY + bbox.maxY) / 2);
  plinth.receiveShadow = true;
  plinth.castShadow = true;
  scene.add(plinth);

  /* -------------------------------- стены -------------------------------- */
  const wallsGroup = new THREE.Group();
  scene.add(wallsGroup);
  const wallGroups = [];
  const curtains = [];
  /* Полотна дверей в кукольном разрезе не нужны: они стоят поперёк комнат и
     читаются как высокие шкафы. Проёмы остаются, полотна показываем только в
     режиме целых стен. */
  const doorLeaves = [];
  const wallClip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.35);
  const wallCutMat = M.wall.clone();
  const glassCut = M.glass.clone();
  const glowCut = M.glow.clone();
  const clippedMats = [wallCutMat, glassCut, glowCut];
  for (const m of clippedMats) { m.clippingPlanes = [wallClip]; m.clipShadows = true; }
  renderer.localClippingEnabled = true;

  function openingOnWall(w, o) {
    const horizontal = Math.abs(w.y2 - w.y1) < 1;
    if (horizontal) {
      if (o.dir === 'v') return false;
      return Math.abs(o.y - w.y1) < 280 && o.x + o.w > Math.min(w.x1, w.x2) + 40 && o.x < Math.max(w.x1, w.x2) - 40;
    }
    if (o.dir === 'h') return false;
    return Math.abs(o.x - w.x1) < 280 && o.y + o.w > Math.min(w.y1, w.y2) + 40 && o.y < Math.max(w.y1, w.y2) - 40;
  }

  function buildOpening(parent, o, t, inSign, fullWall) {
    const win = o.kind !== 'door';
    const w = Math.max(0.4, Number(o.w) * S);
    const sill = win ? Math.max(0, Number(o.sill || 900) * S) : 0;
    const head = Math.min(H, sill + Math.max(0.3, Number(o.h || (win ? 1500 : 2100)) * S));
    const g = new THREE.Group();
    g.position.set(0, 0, 0);
    const frame = new THREE.MeshStandardMaterial({ color: win ? shade(P.metal, 0.28) : P.wood, roughness: 0.42, metalness: win ? 0.3 : 0.05 });
    if (!fullWall) {
      frame.clippingPlanes = [wallClip];
      frame.clipShadows = true;
      clippedMats.push(frame);
    }
    addBox(g, w + 0.05, 0.055, t + 0.07, frame, 0, sill + 0.027, 0);
    addBox(g, w + 0.05, 0.055, t + 0.07, frame, 0, head - 0.027, 0);
    addBox(g, 0.055, head - sill, t + 0.07, frame, -w / 2 + 0.027, (sill + head) / 2, 0);
    addBox(g, 0.055, head - sill, t + 0.07, frame, w / 2 - 0.027, (sill + head) / 2, 0);
    if (win) {
      addBox(g, w + 0.14, 0.04, t + 0.12, M.stone, 0, sill - 0.02, 0);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.06, head - sill - 0.06), fullWall ? M.glass : glassCut);
      glass.position.set(0, (sill + head) / 2, 0);
      g.add(glass);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.06, head - sill - 0.06), fullWall ? M.glow : glowCut);
      glow.position.set(0, (sill + head) / 2, -inSign * (t / 2 + 0.012));
      g.add(glow);
      /* шторы: две мягкие плоскости с синусоидальными складками */
      const curtainW = Math.max(0.22, w * 0.26);
      for (const side of [-1, 1]) {
        const geo = new THREE.PlaneGeometry(curtainW, H - 0.18, 18, 1);
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          pos.setZ(i, Math.sin((x / curtainW) * Math.PI * 7) * 0.026);
        }
        geo.computeVertexNormals();
        const cm = new THREE.Mesh(geo, M.fabric);
        cm.position.set(side * (w / 2 + curtainW * 0.42), (H - 0.1) / 2, inSign * (t / 2 + 0.09));
        cm.castShadow = true;
        cm.userData.fullWall = fullWall;
        g.add(cm);
        curtains.push(cm);
      }
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, w + curtainW * 1.8, 8), M.metal);
      rod.rotation.z = Math.PI / 2;
      rod.position.set(0, H - 0.08, inSign * (t / 2 + 0.09));
      rod.userData.fullWall = fullWall;
      g.add(rod);
      curtains.push(rod);
    } else {
      const leafMat = M.woodDark.clone();
      if (!fullWall) {
        leafMat.clippingPlanes = [wallClip];
        clippedMats.push(leafMat);
      }
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(w - 0.06, head - 0.06, 0.045), leafMat);
      const pivot = new THREE.Group();
      pivot.position.set(-w / 2 + 0.03, 0, inSign * 0.015);
      leaf.position.set((w - 0.06) / 2, (head - 0.06) / 2 + 0.03, 0);
      pivot.add(leaf);
      pivot.rotation.y = inSign * 0.32;
      /* ручка —child полотна: в разрезе она скрывается вместе с дверью */
      addBox(pivot, 0.045, 0.045, 0.045, M.metal, w - 0.15, 1.02, inSign * 0.035);
      g.add(pivot);
      pivot.visible = false;
      doorLeaves.push(pivot);
    }
    parent.add(g);
  }

  for (const w of (SPEC.walls || [])) {
    const horizontal = Math.abs(w.y2 - w.y1) < 1;
    const x1 = Number(w.x1) * S, x2 = Number(w.x2) * S, y1 = Number(w.y1) * S, y2 = Number(w.y2) * S;
    const t = Math.max(0.06, Number(w.t || 150) * S);
    const len = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1);
    if (len < 0.15) continue;
    const start = horizontal ? Math.min(x1, x2) : Math.min(y1, y2);
    const mid = horizontal ? (x1 + x2) / 2 : (y1 + y2) / 2;
    const group = new THREE.Group();
    group.userData.wall = w;
    group.userData.horizontal = horizontal;
    const outward = new THREE.Vector3(
      horizontal ? 0 : (mid < ((bbox.minX + bbox.maxX) / 2) ? -1 : 1),
      0,
      horizontal ? (mid < ((bbox.minY + bbox.maxY) / 2) ? -1 : 1) : 0
    );
    group.userData.normal = outward;
    group.userData.perimeter = horizontal
      ? (Math.abs(y1 - bbox.minY) < 0.03 || Math.abs(y1 - bbox.maxY) < 0.03)
      : (Math.abs(x1 - bbox.minX) < 0.03 || Math.abs(x1 - bbox.maxX) < 0.03);
    /* дальние стены (север и восток) оставляем во всю высоту — это задник
       dollhouse-кадра; ближние и перегородки режем на 1,35 м. */
    const fullWall = group.userData.perimeter && (horizontal ? y1 <= bbox.minY + 0.03 : x1 >= bbox.maxX - 0.03);
    group.userData.fullWall = fullWall;
    const wallMat = fullWall ? M.wall : wallCutMat;
    const inSign = horizontal ? (mid < ((bbox.minY + bbox.maxY) / 2) ? 1 : -1) : (mid < ((bbox.minX + bbox.maxX) / 2) ? 1 : -1);

    const openings = (SPEC.openings || []).filter(function (o) { return openingOnWall(w, o); })
      .map(function (o) {
        const s = horizontal ? (Number(o.x) * S - start) : (Number(o.y) * S - start);
        return { o: o, start: Math.max(0, s), end: Math.min(len, s + Number(o.w) * S) };
      })
      .filter(function (o) { return o.end > 0.05 && o.start < len - 0.05; });

    const cuts = [0, len];
    for (const o of openings) { cuts.push(o.start, o.end); }
    cuts.sort(function (a, b) { return a - b; });
    const uniq = cuts.filter(function (v, i) { return i === 0 || Math.abs(v - cuts[i - 1]) > 0.002; });
    for (let i = 0; i < uniq.length - 1; i++) {
      const a = uniq[i], b = uniq[i + 1];
      if (b - a < 0.012) continue;
      const slice = b - a;
      const cover = openings.find(function (o) { return o.start < b - 0.01 && o.end > a + 0.01; });
      const sill = cover && cover.o.kind !== 'door' ? Math.max(0, Number(cover.o.sill || 900) * S) : 0;
      const head = cover ? Math.min(H, sill + Math.max(0.3, Number(cover.o.h || 2100) * S)) : H;
      const pieces = cover ? [[0, sill], [head, H]] : [[0, H]];
      for (const seg of pieces) {
        if (seg[1] - seg[0] < 0.02) continue;
        const h = seg[1] - seg[0];
        const pos = start + (a + b) / 2;
        if (horizontal) addBox(group, slice, h, t, wallMat, pos, seg[0] + h / 2, y1);
        else addBox(group, t, h, slice, wallMat, x1, seg[0] + h / 2, start + (a + b) / 2);
      }
    }

    for (const o of openings) {
      const sub = new THREE.Group();
      const ww = Math.max(0.4, Number(o.o.w) * S);
      const s = horizontal ? (Number(o.o.x) * S + ww / 2) : (Number(o.o.y) * S + ww / 2);
      if (horizontal) {
        sub.position.set(s, 0, y1);
      } else {
        sub.position.set(x1, 0, s);
        sub.rotation.y = Math.PI / 2;
      }
      buildOpening(sub, o.o, t, inSign, fullWall);
      group.add(sub);
    }

    wallsGroup.add(group);
    wallGroups.push(group);
  }

  /* -------------------------- декоративная стена -------------------------- */
  let decorGroup = null;
  let decorWall = null;
  const northWall = (SPEC.walls || []).find(function (w) { return Math.abs(w.y2 - w.y1) < 1 && Math.min(w.y1, w.y2) < (bbox.minY + bbox.maxY) / 2; });
  const panelWall = northWall || (SPEC.walls || []).slice().sort(function (a, b) {
    return Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
  })[0];
  if (panelWall) {
    const horizontal = Math.abs(panelWall.y2 - panelWall.y1) < 1;
    const len = horizontal ? Math.abs(panelWall.x2 - panelWall.x1) * S : Math.abs(panelWall.y2 - panelWall.y1) * S;
    const start = horizontal ? Math.min(Number(panelWall.x1), Number(panelWall.x2)) * S : Math.min(Number(panelWall.y1), Number(panelWall.y2)) * S;
    const wallAt = horizontal ? (Number(panelWall.y1) + Number(panelWall.y2)) / 2 : (Number(panelWall.x1) + Number(panelWall.x2)) / 2;
    const end = start + len;

    /* Рейки вешаем только на глухой простенок: окно и дверь — не фон для
       декора, а проём. Вычитаем все проёмы этой стены и примыкающие
       перегородки, затем берём самый широкий оставшийся кусок. */
    const blocked = [];
    for (const o of (SPEC.openings || [])) {
      if (horizontal ? o.dir !== 'h' : o.dir !== 'v') continue;
      const axis = horizontal ? Number(o.y) : Number(o.x);
      if (Math.abs(axis - wallAt) > 40) continue;
      const from = Number(horizontal ? o.x : o.y) * S;
      blocked.push([from - 0.15, from + Number(o.w) * S + 0.15]);
    }
    for (const w of (SPEC.walls || [])) {
      const cross = horizontal
        ? Math.abs(Number(w.x2) - Number(w.x1)) < 1
        : Math.abs(Number(w.y2) - Number(w.y1)) < 1;
      if (!cross) continue;
      const at = Number(horizontal ? w.x1 : w.y1) * S;
      if (at <= start + 0.05 || at >= end - 0.05) continue;
      blocked.push([at - 0.2, at + 0.2]);
    }
    let spans = [[start, end]];
    for (const [from, to] of blocked.sort(function (a, b) { return a[0] - b[0]; })) {
      const next = [];
      for (const [a, b] of spans) {
        if (to <= a || from >= b) next.push([a, b]);
        else {
          if (from > a) next.push([a, from]);
          if (to < b) next.push([to, b]);
        }
      }
      spans = next;
    }
    const widest = spans.sort(function (a, b) { return (b[1] - b[0]) - (a[1] - a[0]); })[0];
    if (widest && widest[1] - widest[0] >= 1.6) {
      const panelW = Math.min(3.3, widest[1] - widest[0] - 0.3);
      const panelH = Math.min(H - 0.35, 2.42);
      const panelAt = (widest[0] + widest[1]) / 2;
      decorGroup = new THREE.Group();
      if (horizontal) {
        const north = Math.min(Number(panelWall.y1), Number(panelWall.y2)) < (bbox.minY + bbox.maxY) / 2 / S;
        decorGroup.position.set(panelAt, 0, wallAt * S);
        decorGroup.rotation.y = north ? 0 : Math.PI;
      } else {
        const west = Math.min(Number(panelWall.x1), Number(panelWall.x2)) < (bbox.minX + bbox.maxX) / 2 / S;
        decorGroup.position.set(wallAt * S, 0, panelAt);
        decorGroup.rotation.y = west ? Math.PI / 2 : -Math.PI / 2;
      }
      addBox(decorGroup, panelW, panelH, 0.035, M.wallAccent, 0, panelH / 2 + 0.06, 0.01);
      const slats = Math.floor(panelW / 0.13);
      for (let i = 0; i < slats; i++) {
        addBox(decorGroup, 0.032, panelH - 0.04, 0.045, M.wood, -panelW / 2 + 0.07 + i * 0.13, panelH / 2 + 0.06, 0.05);
      }
      wallsGroup.add(decorGroup);
      decorWall = wallGroups.find(function (g) {
        const w = g.userData.wall;
        return w && Math.abs(Number(w.x1) - Number(panelWall.x1)) < 1 && Math.abs(Number(w.y1) - Number(panelWall.y1)) < 1;
      });
    }
  }

  /* -------------------------------- потолок -------------------------------- */
  const ceilingGroup = new THREE.Group();
  for (const room of rooms) {
    const shape = new THREE.Shape();
    room.poly.forEach(function (p, i) { if (i) shape.lineTo(p[0], p[1]); else shape.moveTo(p[0], p[1]); });
    shape.closePath();
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), M.ceiling);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = H;
    ceilingGroup.add(mesh);
  }
  ceilingGroup.visible = false;
  scene.add(ceilingGroup);

  /* -------------------------------- мебель -------------------------------- */
  const furnGroup = new THREE.Group();
  scene.add(furnGroup);
  const roomCenter = new THREE.Vector3(center.x, 0, center.z);

  function defaultDim(kind) {
    const def = CAT[kind] || [1000, 600, 750];
    return { w: def[0], d: def[1], h: def[2] };
  }
  function localTowardRoom(group, cx, cz) {
    const v = new THREE.Vector3(roomCenter.x - cx, 0, roomCenter.z - cz);
    v.applyAxisAngle(new THREE.Vector3(0, 1, 0), -group.rotation.y);
    return v;
  }

  function buildSofa(g, w, d, h) {
    const baseH = 0.27;
    addBox(g, w, baseH, d, M.woodDark, 0, baseH / 2, 0, 0.03);
    const seatH = 0.19;
    addBox(g, w - 0.12, seatH, d - 0.14, M.fabric, 0, baseH + seatH / 2, 0.02, 0.05);
    const backH = Math.max(0.38, h - baseH - seatH);
    addBox(g, w - 0.02, backH, 0.18, M.fabric, 0, baseH + seatH + backH / 2, -d / 2 + 0.09, 0.055);
    addBox(g, 0.17, Math.max(0.34, h * 0.55), d - 0.04, M.fabric, -w / 2 + 0.085, Math.max(0.34, h * 0.55) / 2, 0, 0.05);
    addBox(g, 0.17, Math.max(0.34, h * 0.55), d - 0.04, M.fabric, w / 2 - 0.085, Math.max(0.34, h * 0.55) / 2, 0, 0.05);
    const seats = w > 2 ? 3 : 2;
    const seatW = (w - 0.34) / seats;
    for (let i = 0; i < seats; i++) {
      addBox(g, seatW - 0.03, 0.13, d - 0.32, M.fabric, -w / 2 + 0.19 + seatW * (i + 0.5), baseH + seatH + 0.04, 0.06, 0.055);
    }
    for (let i = 0; i < seats - 1; i++) {
      addBox(g, seatW - 0.06, Math.max(0.28, backH - 0.16), 0.12, M.fabric, -w / 2 + 0.2 + seatW * (i + 0.55), baseH + seatH + backH * 0.52, -d / 2 + 0.21, 0.05);
    }
    addBox(g, 0.38, 0.34, 0.12, M.accentFabric, -w * 0.25, baseH + seatH + 0.25, -d / 2 + 0.3, 0.05).rotation.z = -0.16;
    addBox(g, 0.34, 0.3, 0.11, M.accentFabric, w * 0.24, baseH + seatH + 0.24, -d / 2 + 0.3, 0.05).rotation.z = 0.14;
    addBox(g, 0.52, 0.035, d * 0.55, M.accentFabric, -w * 0.17, 0.45, d * 0.08, 0.02).rotation.z = 0.03;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) addCyl(g, 0.026, 0.022, baseH, M.woodDark, sx * (w / 2 - 0.12), baseH / 2, sz * (d / 2 - 0.12), 10);
  }

  function buildBed(g, w, d, h) {
    addBox(g, w, 0.3, d, M.wood, 0, 0.15, 0, 0.025);
    addBox(g, w - 0.06, 0.22, d - 0.06, M.ceramic, 0, 0.41, 0, 0.07);
    /* Одеяло — спокойный текстиль, терракота только дорожкой в ногах:
       иначе три спальни подряд читаются как красные полосы. */
    addBox(g, w - 0.14, 0.09, d * 0.7, M.textile, 0, 0.555, d * 0.12, 0.04);
    addBox(g, w - 0.2, 0.055, d * 0.2, M.accentFabric, 0, 0.61, d * 0.3, 0.03);
    const pillows = w > 1.2 ? 2 : 1;
    for (let i = 0; i < pillows; i++) {
      const p = addBox(g, w / pillows - 0.16, 0.15, 0.34, M.ceramic, -w / 4 + (i * w) / 2, 0.56, -d * 0.29, 0.06);
      p.rotation.x = -0.12;
    }
    addBox(g, w + 0.08, 1.05, 0.09, M.wood, 0, 0.53, -d / 2 - 0.015, 0.03);
    addBox(g, w * 0.55, 0.3, 0.05, M.accentFabric, 0, 0.78, -d / 2 + 0.035, 0.04);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) addCyl(g, 0.028, 0.02, 0.14, M.woodDark, sx * (w / 2 - 0.12), 0.07, sz * (d / 2 - 0.14), 8);
  }

  function buildWardrobe(g, w, d, h) {
    addBox(g, w, h, d, M.wood, 0, h / 2, 0, 0.015);
    const doors = w > 1.4 ? 3 : w > 0.85 ? 2 : 1;
    const dw = (w - 0.04) / doors;
    for (let i = 0; i < doors; i++) {
      addBox(g, dw - 0.025, h - 0.07, 0.025, M.woodDark, -w / 2 + 0.02 + dw * (i + 0.5), h / 2, d / 2 + 0.018, 0.01);
      addCyl(g, 0.009, 0.009, 0.22, M.metal, -w / 2 + 0.02 + dw * (i + 0.5) + dw * 0.32, h * 0.52, d / 2 + 0.04, 8);
    }
    addBox(g, w + 0.03, 0.05, d + 0.02, M.woodDark, 0, h + 0.02, 0, 0.01);
  }

  function buildNightstand(g, w, d, h) {
    addBox(g, w, h, d, M.wood, 0, h / 2, 0, 0.012);
    addBox(g, w - 0.07, h * 0.38, 0.02, M.woodDark, 0, h * 0.63, d / 2 + 0.012, 0.008);
    addBox(g, w - 0.07, h * 0.3, 0.02, M.woodDark, 0, h * 0.28, d / 2 + 0.012, 0.008);
    addCyl(g, 0.008, 0.008, 0.11, M.metal, 0, h * 0.63, d / 2 + 0.03, 8).rotation.z = Math.PI / 2;
    addCyl(g, 0.055, 0.075, 0.035, M.metal, 0, h + 0.04, 0, 14);
    addCyl(g, 0.012, 0.012, 0.2, M.metal, 0, h + 0.16, 0, 8);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.115, 0.2, 18, 1, true), new THREE.MeshStandardMaterial({ color: 0xffe8c4, emissive: 0xffca82, emissiveIntensity: 0.6, roughness: 0.8, side: THREE.DoubleSide }));
    shade.position.set(0, h + 0.31, 0);
    g.add(shade);
  }

  function buildDresser(g, w, d, h) {
    addBox(g, w, h, d, M.wood, 0, h / 2, 0, 0.014);
    for (let i = 0; i < 3; i++) {
      addBox(g, w - 0.08, h * 0.23, 0.022, M.woodDark, 0, h * (0.22 + i * 0.27), d / 2 + 0.014, 0.01);
      addCyl(g, 0.009, 0.009, 0.12, M.metal, 0, h * (0.22 + i * 0.27), d / 2 + 0.035, 8).rotation.z = Math.PI / 2;
    }
    addCyl(g, 0.08, 0.06, 0.16, M.ceramic, -w * 0.25, h + 0.08, 0, 14);
    addCyl(g, 0.06, 0.08, 0.3, M.leaf, w * 0.24, h + 0.15, 0, 12);
  }

  function buildShelf(g, w, d, h) {
    const sides = 0.025;
    addBox(g, sides, h, d, M.wood, -w / 2 + sides / 2, h / 2, 0, 0.008);
    addBox(g, sides, h, d, M.wood, w / 2 - sides / 2, h / 2, 0, 0.008);
    addBox(g, w, 0.03, d, M.wood, 0, 0.015, 0, 0.008);
    addBox(g, w, 0.03, d, M.wood, 0, h - 0.015, 0, 0.008);
    const shelves = Math.max(3, Math.round(h / 0.42));
    for (let i = 1; i < shelves; i++) {
      addBox(g, w - 0.03, 0.028, d, M.wood, 0, (h / shelves) * i, 0, 0.006);
      const n = 3 + (i % 3);
      for (let b = 0; b < n; b++) {
        const bw = 0.04 + (b % 3) * 0.012;
        addBox(g, bw, 0.2 + (b % 2) * 0.07, d * 0.55, [M.book1, M.book2, M.book3][b % 3], -w / 2 + 0.08 + b * 0.07, (h / shelves) * i + 0.14, -d * 0.08, 0.004);
      }
    }
  }

  function buildChair(g, w, d, h) {
    addBox(g, w, 0.055, d, M.fabric, 0, h * 0.5, 0, 0.03);
    addBox(g, w, h * 0.48, 0.05, M.fabric, 0, h * 0.74, -d / 2 + 0.025, 0.03);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) addCyl(g, 0.018, 0.014, h * 0.5, M.woodDark, sx * (w / 2 - 0.05), h * 0.25, sz * (d / 2 - 0.05), 8);
  }

  function buildDining(g, w, d, h, round) {
    if (round) {
      addCyl(g, w / 2, w / 2, 0.045, M.wood, 0, h - 0.023, 0, 36);
      addCyl(g, 0.055, 0.075, h - 0.05, M.metal, 0, (h - 0.05) / 2, 0, 18);
      addCyl(g, 0.3, 0.34, 0.035, M.metal, 0, 0.02, 0, 24);
    } else {
      addBox(g, w, 0.045, d, M.wood, 0, h - 0.023, 0, 0.012);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) addCyl(g, 0.022, 0.018, h - 0.045, M.woodDark, sx * (w / 2 - 0.1), (h - 0.045) / 2, sz * (d / 2 - 0.1), 10);
    }
    addCyl(g, 0.09, 0.07, 0.18, M.ceramic, 0, h + 0.09, 0, 16);
    addCyl(g, 0.025, 0.035, 0.16, M.leaf, 0, h + 0.26, 0, 8);
  }

  function buildCoffee(g, w, d, h) {
    addBox(g, w, 0.045, d, M.wood, 0, h - 0.023, 0, 0.012);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) addCyl(g, 0.015, 0.012, h - 0.045, M.metal, sx * (w / 2 - 0.08), (h - 0.045) / 2, sz * (d / 2 - 0.08), 8);
    addBox(g, 0.28, 0.04, 0.2, M.book2, -0.12, h + 0.02, 0.04, 0.006).rotation.y = 0.2;
    addBox(g, 0.24, 0.035, 0.17, M.book3, 0.06, h + 0.055, -0.04, 0.006).rotation.y = -0.15;
    addCyl(g, 0.045, 0.045, 0.02, M.ceramic, 0.22, h + 0.03, 0.08, 12);
  }

  function buildTv(g, w, d, h, cx, cz, wallMounted) {
    const roomDir = localTowardRoom(g, cx, cz);
    const face = roomDir.z >= 0 ? 1 : -1;
    if (wallMounted) {
      const tw = Math.min(1.35, w), th = tw * 0.56;
      addBox(g, tw + 0.05, th + 0.05, 0.05, M.black, 0, 1.6, face * 0.03, 0.008);
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(tw, th), M.screen);
      scr.position.set(0, 1.6, face * 0.06);
      if (face < 0) scr.rotation.y = Math.PI;
      g.add(scr);
      return;
    }
    addBox(g, w, 0.44, d, M.wood, 0, 0.22, 0, 0.014);
    addBox(g, w - 0.06, 0.02, d - 0.04, M.woodDark, 0, 0.45, 0, 0.006);
    for (let i = 0; i < 2; i++) addBox(g, (w - 0.12) / 2, 0.3, 0.02, M.woodDark, -w / 4 + (i * w) / 2, 0.24, d / 2 + 0.012, 0.008);
    const tw = Math.min(w * 0.78, 1.42), th = tw * 0.56;
    addBox(g, tw + 0.06, th + 0.06, 0.06, M.black, 0, 0.5 + th / 2 + 0.04, -face * (d / 2 - 0.05), 0.01);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(tw, th), M.screen);
    scr.position.set(0, 0.5 + th / 2 + 0.04, -face * (d / 2 - 0.05) + face * 0.035);
    if (face < 0) scr.rotation.y = Math.PI;
    g.add(scr);
    addBox(g, tw * 0.72, 0.055, 0.08, M.black, 0, 0.47, face * (d / 2 - 0.02), 0.008);
    addCyl(g, 0.05, 0.06, 0.1, M.ceramic, -w * 0.32, 0.5, 0.08, 12);
  }

  function buildKitchen(g, w, d, h) {
    const baseH = Math.min(0.86, h - 0.04);
    addBox(g, w, baseH - 0.1, d - 0.03, M.woodDark, 0, (baseH - 0.1) / 2 + 0.1, 0, 0.01);
    addBox(g, w, 0.1, d - 0.06, M.black, 0, 0.05, 0, 0.006);
    addBox(g, w + 0.02, 0.045, d + 0.02, M.stone, 0, baseH, 0, 0.01);
    const doors = Math.max(2, Math.round(w / 0.6));
    const dw = (w - 0.05) / doors;
    for (let i = 0; i < doors; i++) {
      addBox(g, dw - 0.022, baseH - 0.19, 0.025, M.wood, -w / 2 + 0.025 + dw * (i + 0.5), 0.1 + (baseH - 0.19) / 2, d / 2 + 0.005, 0.008);
      addCyl(g, 0.008, 0.008, 0.12, M.metal, -w / 2 + 0.025 + dw * (i + 0.5) + dw * 0.33, baseH * 0.72, d / 2 + 0.028, 8).rotation.z = Math.PI / 2;
    }
    addBox(g, w, 0.5, 0.025, M.stone, 0, 1.25, -d / 2 + 0.02, 0.005);
    addBox(g, w * 0.94, 0.72, 0.34, M.wood, 0, 1.92, -d / 2 + 0.17, 0.012);
    const udoors = Math.max(2, Math.round(w / 0.6));
    for (let i = 0; i < udoors; i++) addBox(g, (w * 0.94) / udoors - 0.02, 0.66, 0.02, M.woodDark, -w * 0.47 + (w * 0.94 / udoors) * (i + 0.5), 1.92, -d / 2 + 0.35, 0.006);
    addCyl(g, 0.04, 0.04, 0.02, M.metal, w * 0.2, 1.62, -d / 2 + 0.18, 12);
  }

  function buildSink(g, w, d) {
    addBox(g, w * 0.78, 0.02, d * 0.72, M.metal, 0, 0.9, 0, 0.008);
    addBox(g, w * 0.58, 0.1, d * 0.5, M.black, 0, 0.85, 0, 0.01);
    addCyl(g, 0.022, 0.022, 0.28, M.metal, 0, 1.04, -d * 0.28, 10);
    addRod(g, [0, 1.18, -d * 0.28], [0, 1.18, 0.02], 0.018, M.metal);
    addCyl(g, 0.012, 0.012, 0.06, M.metal, 0, 1.15, 0.02, 8);
  }

  function buildHob(g, w, d) {
    addBox(g, w * 0.9, 0.015, d * 0.78, M.black, 0, 0.905, 0, 0.006);
    for (let i = 0; i < 4; i++) {
      const x = (i % 2 ? 1 : -1) * w * 0.22;
      const z = (i > 1 ? 1 : -1) * d * 0.18;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.008, 8, 24), M.metal);
      ring.rotation.x = Math.PI / 2; ring.position.set(x, 0.915, z); g.add(ring);
    }
  }

  function buildFridge(g, w, d, h) {
    addBox(g, w, h, d, M.metal, 0, h / 2, 0, 0.02);
    addBox(g, w - 0.05, 0.012, 0.025, M.black, 0, h * 0.68, d / 2 + 0.012, 0.004);
    addCyl(g, 0.012, 0.012, 0.5, M.black, -w / 2 + 0.09, h * 0.48, d / 2 + 0.035, 8);
    addCyl(g, 0.012, 0.012, 0.3, M.black, -w / 2 + 0.09, h * 0.82, d / 2 + 0.035, 8);
  }

  function buildPlant(g, w, d, h) {
    const potH = Math.min(0.4, h * 0.3);
    addCyl(g, w * 0.32, w * 0.26, potH, M.ceramic, 0, potH / 2, 0, 20);
    addCyl(g, w * 0.29, w * 0.29, 0.02, M.woodDark, 0, potH + 0.01, 0, 18);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const hh = h * (0.65 + (i % 3) * 0.12);
      addRod(g, [0, potH, 0], [Math.cos(a) * w * 0.32, potH + hh * 0.6, Math.sin(a) * w * 0.32], 0.012, M.leaf);
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11 + (i % 3) * 0.03, 1), i % 2 ? M.leaf : M.leaf2);
      leaf.scale.set(1.3, 0.65, 0.9);
      leaf.position.set(Math.cos(a) * w * 0.38, potH + hh * 0.72, Math.sin(a) * w * 0.38);
      leaf.castShadow = true;
      g.add(leaf);
    }
  }

  function buildRug(g, w, d) {
    const map = rugTexture(P.floor, P.accent, P.textile);
    const mat = new THREE.MeshStandardMaterial({ map: map, roughness: 0.98 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.012;
    mesh.receiveShadow = true;
    g.add(mesh);
  }

  function buildMirror(g, w, h) {
    addBox(g, w + 0.06, h + 0.06, 0.05, M.woodDark, 0, h / 2, 0, 0.015);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.mirror);
    glass.position.set(0, h / 2, 0.03);
    g.add(glass);
  }

  function buildBath(g, w, d, h) {
    addBox(g, w, h, d, M.ceramic, 0, h / 2, 0, 0.06);
    addBox(g, w - 0.14, 0.04, d - 0.14, new THREE.MeshStandardMaterial({ color: '#dce8ed', roughness: 0.15, metalness: 0.1 }), 0, h - 0.03, 0, 0.04);
    addCyl(g, 0.02, 0.02, 0.25, M.metal, w * 0.36, h + 0.1, -d * 0.32, 8);
  }

  function buildBathSink(g, w, d, h) {
    addBox(g, w, h * 0.72, d, M.wood, 0, h * 0.36, 0, 0.012);
    addBox(g, w + 0.02, 0.04, d + 0.02, M.stone, 0, h * 0.72, 0, 0.01);
    addCyl(g, w * 0.34, w * 0.28, 0.08, M.ceramic, 0, h * 0.77, 0, 20);
    addCyl(g, 0.018, 0.018, 0.22, M.metal, 0, h * 0.86, -d * 0.25, 8);
    addRod(g, [0, h * 0.96, -d * 0.25], [0, h * 0.96, 0], 0.014, M.metal);
    const mirror = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.7, h * 0.6), M.mirror);
    mirror.position.set(0, h * 1.35, -d / 2 + 0.015);
    g.add(mirror);
  }

  function buildWc(g, w, d) {
    addBox(g, w * 0.7, 0.4, d * 0.75, M.ceramic, 0, 0.2, 0.05, 0.08);
    addBox(g, w * 0.7, 0.42, 0.18, M.ceramic, 0, 0.21, -d * 0.38, 0.04);
    addBox(g, w * 0.68, 0.05, d * 0.55, M.ceramic, 0, 0.43, 0.05, 0.06);
    addBox(g, w * 0.5, 0.05, 0.2, M.black, 0, 0.41, -d * 0.18, 0.02);
  }

  function buildShower(g, w, d, h) {
    addBox(g, w, 0.08, d, M.stone, 0, 0.04, 0, 0.02);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.glass);
    glass.position.set(0, h / 2, d / 2);
    g.add(glass);
    addCyl(g, 0.02, 0.02, 2.0, M.metal, -w / 2 + 0.03, h / 2, -d / 2 + 0.03, 8);
    addRod(g, [-w / 2 + 0.03, h - 0.06, -d / 2 + 0.03], [w * 0.22, h - 0.06, -d / 2 + 0.03], 0.018, M.metal);
    addCyl(g, 0.16, 0.16, 0.03, M.metal, w * 0.22, h - 0.08, -d / 2 + 0.03, 22);
  }

  function buildDesk(g, w, d, h) {
    addBox(g, w, 0.04, d, M.wood, 0, h - 0.02, 0, 0.01);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) addCyl(g, 0.02, 0.016, h - 0.04, M.metal, sx * (w / 2 - 0.08), (h - 0.04) / 2, sz * (d / 2 - 0.08), 8);
    addBox(g, 0.55, 0.36, 0.035, M.black, 0, h + 0.28, -d * 0.12, 0.012);
    addBox(g, 0.5, 0.3, 0.006, M.screen, 0, h + 0.28, -d * 0.12 + 0.021, 0.002);
    addCyl(g, 0.02, 0.03, 0.12, M.black, 0, h + 0.06, -d * 0.12, 8);
    addBox(g, 0.36, 0.012, 0.13, M.black, 0, h + 0.006, 0.08, 0.004);
    addBox(g, 0.21, 0.02, 0.28, M.book2, -w * 0.32, h + 0.01, 0.02, 0.004).rotation.y = 0.2;
  }

  function buildOfficeChair(g, w, d, h) {
    addBox(g, w * 0.72, 0.07, d * 0.72, M.fabric, 0, h * 0.45, 0, 0.04);
    addBox(g, w * 0.68, h * 0.38, 0.06, M.fabric, 0, h * 0.69, -d * 0.3, 0.04);
    addCyl(g, 0.035, 0.035, h * 0.38, M.black, 0, h * 0.22, 0, 10);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      addRod(g, [0, 0.07, 0], [Math.cos(a) * w * 0.4, 0.04, Math.sin(a) * d * 0.4], 0.018, M.black);
      addCyl(g, 0.028, 0.028, 0.04, M.black, Math.cos(a) * w * 0.4, 0.03, Math.sin(a) * d * 0.4, 10);
    }
  }

  function buildRadiator(g, w, d, h) {
    addBox(g, w, h, 0.055, M.ceramic, 0, h / 2, 0, 0.02);
    for (let i = 0; i < 9; i++) addBox(g, 0.035, h - 0.08, 0.09, M.ceramic, -w / 2 + 0.08 + i * ((w - 0.16) / 8), h / 2, 0, 0.01);
  }

  function buildPiano(g, w, d, h) {
    addBox(g, w, 0.36, d, M.black, 0, 0.45, 0, 0.02);
    addBox(g, w, 0.06, d * 0.8, M.ceramic, 0, 0.64, 0.02, 0.01);
    addBox(g, w * 0.92, 0.025, d * 0.42, M.black, 0, 0.675, 0.1, 0.005);
    for (let i = 0; i < 18; i++) addBox(g, w * 0.045, 0.012, d * 0.3, M.ceramic, -w * 0.43 + i * (w * 0.05), 0.69, 0.12, 0.002);
    for (const sx of [-1, 1]) addCyl(g, 0.025, 0.03, 0.45, M.black, sx * (w / 2 - 0.12), 0.225, 0, 8);
  }

  function buildWasher(g, w, d, h) {
    addBox(g, w, h, d, M.ceramic, 0, h / 2, 0, 0.03);
    const door = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.3, w * 0.3, 0.04, 24), M.black);
    door.rotation.x = Math.PI / 2;
    door.position.set(0, h * 0.45, d / 2 + 0.02);
    g.add(door);
    addBox(g, w * 0.6, 0.05, 0.02, M.metal, 0, h * 0.86, d / 2 + 0.02, 0.005);
  }

  function buildPiece(f) {
    const def = defaultDim(f.kind);
    const w = Math.max(0.18, Number(f.w || def.w) * S);
    const d = Math.max(0.18, Number(f.d || def.d) * S);
    const h = Math.max(0.05, Number(f.h || def.h) * S);
    const x = Number(f.x) * S, y = Number(f.y) * S;
    const cx = x + w / 2, cz = y + d / 2;
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);
    g.rotation.y = -((Number(f.rot) || 0) * Math.PI) / 180;
    const kind = String(f.kind || '');
    if (kind === 'rug') buildRug(g, w, d);
    else if (kind === 'sofa' || kind === 'sofa_small' || kind === 'sofa_corner' || kind === 'armchair') buildSofa(g, w, d, h);
    else if (kind.indexOf('bed_') === 0) buildBed(g, w, d, h);
    else if (kind === 'wardrobe' || kind === 'wardrobe_slide') buildWardrobe(g, w, d, h);
    else if (kind === 'nightstand') buildNightstand(g, w, d, h);
    else if (kind === 'dresser') buildDresser(g, w, d, h);
    else if (kind === 'shelf' || kind === 'bookshelf') buildShelf(g, w, d, h);
    else if (kind === 'chair') buildChair(g, w, d, h);
    else if (kind === 'office_chair') buildOfficeChair(g, w, d, h);
    else if (kind === 'dining_table' || kind === 'dining_table_big') buildDining(g, w, d, h, false);
    else if (kind === 'round_table') buildDining(g, w, d, h, true);
    else if (kind === 'coffee_table') buildCoffee(g, w, d, h);
    else if (kind === 'tv_stand' || kind === 'tv_wall') buildTv(g, w, d, h, cx, cz, kind === 'tv_wall' || h < 0.2);
    else if (kind === 'kitchen_counter') buildKitchen(g, w, d, h);
    else if (kind === 'sink') buildSink(g, w, d);
    else if (kind === 'hob') buildHob(g, w, d);
    else if (kind === 'fridge') buildFridge(g, w, d, h);
    else if (kind === 'plant') buildPlant(g, w, d, h);
    else if (kind === 'mirror') buildMirror(g, w, h);
    else if (kind === 'bath') buildBath(g, w, d, h);
    else if (kind === 'bath_sink') buildBathSink(g, w, d, h);
    else if (kind === 'wc') buildWc(g, w, d);
    else if (kind === 'shower') buildShower(g, w, d, h);
    else if (kind === 'desk' || kind === 'desk_small') buildDesk(g, w, d, h);
    else if (kind === 'radiator') buildRadiator(g, w, d, h);
    else if (kind === 'piano') buildPiano(g, w, d, h);
    else if (kind === 'washer' || kind === 'dishwasher') buildWasher(g, w, d, h);
    else {
      addBox(g, w, h, d, M.wood, 0, h / 2, 0, 0.02);
      addBox(g, w - 0.04, 0.04, d - 0.04, M.woodDark, 0, h + 0.02, 0, 0.01);
    }
    furnGroup.add(g);
  }
  for (const f of (SPEC.furniture || [])) buildPiece(f);

  /* ------------------------------ светильники ------------------------------ */
  const lightsGroup = new THREE.Group();
  scene.add(lightsGroup);
  let pointBudget = 2;
  for (const light of (SPEC.lighting || [])) {
    const lx = Number(light.x) * S, lz = Number(light.y) * S;
    if (light.kind === 'chandelier') {
      const g = new THREE.Group();
      g.position.set(lx, H - 0.1, lz);
      addCyl(g, 0.012, 0.012, 0.34, M.metal, 0, 0.17, 0, 8);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.018, 10, 36), M.metal);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.02;
      g.add(ring);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), M.bulb);
        b.position.set(Math.cos(a) * 0.3, 0.02, Math.sin(a) * 0.3);
        g.add(b);
        addCyl(g, 0.008, 0.008, 0.08, M.metal, Math.cos(a) * 0.3, 0.08, Math.sin(a) * 0.3, 6);
      }
      lightsGroup.add(g);
      if (pointBudget > 0) {
        const pl = new THREE.PointLight(0xffd6a0, 15, 8.5, 2);
        pl.position.set(lx, H - 0.55, lz);
        lightsGroup.add(pl);
        pointBudget--;
      }
    } else if (light.kind === 'led') {
      const w = Math.max(0.4, Number(light.w || 1200) * S);
      addBox(lightsGroup, w, 0.022, 0.04, M.bulb, lx, H - 0.025, lz, 0.006);
    } else {
      addCyl(lightsGroup, 0.05, 0.06, 0.02, M.metal, lx, H - 0.018, lz, 18);
      addCyl(lightsGroup, 0.036, 0.036, 0.008, M.bulb, lx, H - 0.03, lz, 16);
    }
  }

  /* ------------------------------ подписи rooms ------------------------------ */
  const labelGroup = new THREE.Group();
  labelGroup.visible = false;
  scene.add(labelGroup);
  function labelSprite(txt) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(18,19,21,.82)';
    g.beginPath();
    const r = 30;
    g.roundRect(4, 22, 504, 84, r);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#f1ece3';
    g.font = '600 44px "Segoe UI", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(txt, 256, 65);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(1.7, 0.425, 1);
    sprite.renderOrder = 12;
    return sprite;
  }
  for (const room of rooms) {
    const s = labelSprite(room.name);
    s.position.set(room.box.cx, 0.55, room.box.cz);
    labelGroup.add(s);
  }

  /* ---------------------------- камера и виды ---------------------------- */
  const views = {};
  /* Запас по кадру: в квартире с несколькими комнатами южная стена иначе
     упирается в нижний край PNG, и планировка читается хуже. */
  const heroDist = Math.max(7.6, size * 1.62);
  views.hero = { theta: -0.72, phi: 0.74, dist: heroDist, tx: center.x, tz: center.z + 0.1, ty: 0.5 };
  views.plan = { theta: -0.0001, phi: 0.045, dist: Math.max(7, size * 1.45), tx: center.x, tz: center.z, ty: 0 };
  const roomViews = [];
  for (const room of rooms) {
    const key = 'room' + roomViews.length;
    const diag = Math.max(2.4, Math.hypot(room.box.maxX - room.box.minX, room.box.maxZ - room.box.minZ));
    views[key] = { theta: -0.72, phi: 0.9, dist: diag * 1.25, tx: room.box.cx, tz: room.box.cz, ty: 0.55 };
    roomViews.push({ key: key, label: room.name });
  }
  const kitchenRoom = rooms.find(function (r) { return /кухн/i.test(r.name); });
  if (kitchenRoom) views.kitchen = { theta: -0.85, phi: 0.82, dist: Math.max(4.2, Math.hypot(kitchenRoom.box.maxX - kitchenRoom.box.minX, kitchenRoom.box.maxZ - kitchenRoom.box.minZ) * 0.95), tx: kitchenRoom.box.cx, tz: kitchenRoom.box.cz, ty: 0.75 };
  const bedroomRoom = rooms.find(function (r) { return /спальн/i.test(r.name); });
  if (bedroomRoom) views.bedroom = { theta: -0.55, phi: 0.86, dist: Math.max(4.2, Math.hypot(bedroomRoom.box.maxX - bedroomRoom.box.minX, bedroomRoom.box.maxZ - bedroomRoom.box.minZ) * 0.95), tx: bedroomRoom.box.cx, tz: bedroomRoom.box.cz, ty: 0.55 };

  let currentView = 'hero';
  let cutWalls = true;
  let showLabels = false;

  function cameraDir() {
    return camera.position.clone().sub(controls.target).normalize();
  }
  let clippingOn = true;
  function setWallClip(on) {
    if (on === clippingOn) return;
    clippingOn = on;
    for (const m of clippedMats) {
      m.clippingPlanes = on ? [wallClip] : null;
      m.needsUpdate = true;
    }
  }
  function updateWalls() {
    const plan = currentView === 'plan';
    const dir = cameraDir();
    setWallClip(cutWalls);
    for (const g of wallGroups) {
      if (plan) { g.visible = false; continue; }
      if (cutWalls) { g.visible = true; continue; }
      const dot = g.userData.normal ? g.userData.normal.dot(dir) : 0;
      g.visible = dot < 0.26;
    }
    if (decorGroup) decorGroup.visible = decorWall ? decorWall.visible : !cutWalls;
    for (const c of curtains) c.visible = !cutWalls || c.userData.fullWall === true;
    for (const leaf of doorLeaves) leaf.visible = !cutWalls;
    labelGroup.visible = plan || showLabels;
    ceilingGroup.visible = ceilingGroup.userData.want === true;
  }
  function applyView(name) {
    const v = views[name] || views.hero;
    currentView = views[name] ? name : 'hero';
    const target = new THREE.Vector3(v.tx, v.ty || 0.6, v.tz);
    const dist = v.dist;
    /* для плана «верх» экрана — север (-Z), иначе камера смотрит на север. */
    if (currentView === 'plan') camera.up.set(0, 0, -1);
    else camera.up.set(0, 1, 0);
    camera.position.set(
      target.x + dist * Math.sin(v.phi) * Math.sin(v.theta),
      target.y + dist * Math.cos(v.phi),
      target.z + dist * Math.sin(v.phi) * Math.cos(v.theta)
    );
    controls.target.copy(target);
    controls.update();
    updateWalls();
    for (const b of document.querySelectorAll('#views .chip[data-view]')) b.classList.toggle('on', b.dataset.view === currentView);
  }

  const viewsBox = document.getElementById('views');
  function addViewButton(label, key, toggle) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (toggle ? ' toggle' : '');
    b.textContent = label;
    b.dataset.view = key;
    b.addEventListener('click', function () {
      if (toggle) {
        if (key === 'cut') { cutWalls = !cutWalls; b.classList.toggle('on', cutWalls); }
        else if (key === 'ceiling') { ceilingGroup.userData.want = !ceilingGroup.userData.want; b.classList.toggle('on', ceilingGroup.userData.want); }
        else if (key === 'labels') { showLabels = !showLabels; b.classList.toggle('on', showLabels); }
        updateWalls();
        return;
      }
      applyView(key);
    });
    viewsBox.appendChild(b);
    return b;
  }
  addViewButton('Общий', 'hero');
  for (const item of roomViews.slice(0, 3)) addViewButton(item.label, item.key);
  if (views.kitchen) addViewButton('Кухня', 'kitchen');
  addViewButton('План', 'plan');
  const cutBtn = addViewButton('Стены', 'cut', true); cutBtn.classList.add('on');
  const ceilBtn = addViewButton('Потолок', 'ceiling', true);
  const labBtn = addViewButton('Подписи', 'labels', true);
  void ceilBtn; void labBtn;

  /* -------------------------------- палитра UI -------------------------------- */
  const swBox = document.getElementById('swatches');
  const labels = { wall: 'стены', floor: 'пол', accent: 'акцент', textile: 'текстиль', wood: 'дерево', metal: 'металл', stone: 'камень', ceiling: 'потолок' };
  for (const key of Object.keys(P)) {
    const d = document.createElement('div');
    d.className = 'sw';
    d.style.background = P[key];
    d.title = labels[key] + ' · ' + P[key];
    swBox.appendChild(d);
  }
  const mats = document.getElementById('mats');
  if (mats && SPEC.style) {
    const m = SPEC.style.materials || {};
    mats.innerHTML = '<b>Пол</b> ' + (m.floor || '—') + '<br><b>Стены</b> ' + (m.walls || '—') + '<br><b>Фронты</b> ' + (m.fronts || '—') + (SPEC.style.referenceName ? '<br><b>Референс</b> ' + SPEC.style.referenceName : '');
  }

  /* -------------------------------- кадр -------------------------------- */
  const sun = new THREE.DirectionalLight(0xffefd6, 1.8);
  const sunTarget = new THREE.Vector3(center.x, 0.8, center.z);
  const windows = (SPEC.openings || []).filter(function (o) { return o.kind !== 'door'; });
  let sunDir = new THREE.Vector3(0.5, 0.8, 0.7);
  if (windows.length) {
    const win = windows.slice().sort(function (a, b) { return Number(b.w) - Number(a.w); })[0];
    if (win.dir === 'v') sunDir = new THREE.Vector3(Number(win.x) < (bbox.minX + bbox.maxX) / 2 / S ? -1 : 1, 0.75, 0.35);
    else sunDir = new THREE.Vector3(0.25, 0.72, Number(win.y) < (bbox.minY + bbox.maxY) / 2 / S ? -1 : 1);
  }
  sun.position.copy(sunTarget).add(sunDir.clone().normalize().multiplyScalar(18));
  sun.target.position.copy(sunTarget);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -size * 0.85;
  sun.shadow.camera.right = size * 0.85;
  sun.shadow.camera.top = size * 0.85;
  sun.shadow.camera.bottom = -size * 0.85;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 40;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 4;
  scene.add(sun); scene.add(sun.target);
  const fill = new THREE.DirectionalLight(0xbcd4ff, 0.55);
  fill.position.set(-12, 10, -8);
  scene.add(fill);
  /* Второй заполняющий свет с юго-востока: шкафы и кухня не проваливаются
     в чёрное, когда солнце приходит из одного окна. */
  const fill2 = new THREE.DirectionalLight(0xffe7cf, 0.55);
  fill2.position.set(12, 9, 12);
  scene.add(fill2);

  applyView(SHOT ? qView : (views[qView] ? qView : 'hero'));

  function onResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }
  addEventListener('resize', onResize);

  document.getElementById('download').addEventListener('click', function () {
    renderer.render(scene, camera);
    const a = document.createElement('a');
    a.href = renderer.domElement.toDataURL('image/png');
    a.download = 'visualization.png';
    a.click();
  });

  window.__design = { camera: camera, controls: controls, views: views, bbox: bbox, center: center, rooms: rooms, spec: SPEC, scene: scene };
  let frames = 0;
  let ready = false;
  renderer.setAnimationLoop(function () {
    controls.update();
    updateWalls();
    renderer.render(scene, camera);
    frames++;
    if (!ready && frames >= 3) {
      ready = true;
      if (loading) loading.classList.add('hide');
      document.body.dataset.ready = '1';
      window.__designReady = true;
      document.title = 'DESIGN_OK ' + (SPEC.project || '');
      /* Кадр для PNG уже нарисован. В режиме снимка останавливаем цикл:
         иначе Chromium продолжает считать кадры, пока снимает 1,6 Мп, и
         снимок на слабом CPU растягивается на десятки секунд. */
      if (SHOT) {
        renderer.shadowMap.autoUpdate = false;
        renderer.setAnimationLoop(null);
      }
    }
  });
  setTimeout(function () {
    if (loading) loading.classList.add('hide');
    if (!document.body.dataset.ready) {
      document.body.dataset.ready = '1';
      window.__designReady = true;
    }
  }, 5000);
})();
</script>
</body></html>`;
}

export function buildScene(spec, outHtml) {
  const html = sceneHtml(spec);
  const out = path.resolve(outHtml);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf8');
  const tp = threePath();
  fs.copyFileSync(tp, path.join(path.dirname(out), path.basename(tp)));
  return { html: out, bytes: Buffer.byteLength(html) };
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
    try {
      const shot = htmlToPng(out, png, { width, height: Math.round((width * 9) / 16), query: '?shot=1&view=hero' });
      res.png = shot.png;
      res.bytesPng = shot.bytes;
      console.log(JSON.stringify(res, null, 2));
    } catch (error) {
      console.error('Не удалось снять 3D:', error.message);
      process.exit(1);
    }
  } else {
    console.log(JSON.stringify(res, null, 2));
  }
}

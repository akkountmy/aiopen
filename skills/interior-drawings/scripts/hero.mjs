#!/usr/bin/env node
/**
 * Статичная визуализация интерьера без браузера.
 *
 * Зачем свой рендер: на тарифе 500 МБ Chromium с WebGL не помещается рядом с
 * сервисом — контейнер убивает OOM, и `render.png` не появляется вовсе.
 * Здесь тот же спек, но кадр собирается векторно (аксонометрия с перспективой,
 * светом и тенями) и растрируется маленьким resvg. Память — единицы мегабайт,
 * время — доли секунды, результат детерминированный.
 *
 * Это не замена интерактивной 3D-сцене (`3d.html`): сцена остаётся объёмной,
 * а лист визуализации — аккуратный hero-кадр для карточки проекта.
 */
import { CATALOG, area, num } from './lib.mjs';

const W = 1600;
const H = 1000;
const RAD = Math.PI / 180;
const C30 = Math.cos(Math.PI / 6);
const S30 = Math.sin(Math.PI / 6);

const DEFAULT_PALETTE = {
  wall: '#E8E1D5', ceiling: '#F7F4EE', floor: '#C9A87C', accent: '#B5654A',
  textile: '#8C8577', wood: '#B98A5A', metal: '#9A9A96', stone: '#D8D2C6',
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hex(value, fallback) {
  const raw = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : fallback;
}

function rgb(value) {
  const text = hex(value, '#888888').slice(1);
  return [parseInt(text.slice(0, 2), 16), parseInt(text.slice(2, 4), 16), parseInt(text.slice(4, 6), 16)];
}

function mix(a, b, t) {
  const x = rgb(a);
  const y = rgb(b);
  const k = clamp(t, 0, 1);
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, '0')).join('')}`;
}

function shade(color, factor) {
  const [r, g, b] = rgb(color);
  const f = clamp(factor, 0, 2.2);
  return `#${[r, g, b].map((v) => Math.round(clamp(v * f, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
}

function rgba(color, alpha) {
  return `rgba(${rgb(color).join(',')},${clamp(alpha, 0, 1)})`;
}

/* --- геометрия: коробки, поворот вокруг центра, аксонометрия ---------------- */

function project(x, y, z) {
  return { X: (x - y) * C30, Y: (x + y) * S30 - z };
}

/* Площадь проекции: по ней отсекаем вырожденные грани и полы. resvg 2.6
   падает на некоторых полигонах нулевой площади, поэтому фильтр обязателен. */
function polyArea2D(points) {
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a.X * b.Y - b.X * a.Y;
  }
  return Math.abs(twice) / 2;
}

function rotate(x, y, cx, cy, deg) {
  if (!deg) return { x, y };
  const a = deg * RAD;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

function normalOf(points) {
  const [a, b, c] = points;
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

/* Грань видна, если её нормаль смотрит в сторону камеры (камера в +x,+y,+z). */
function visible(points) {
  const n = normalOf(points);
  return n.x * 0.55 + n.y * 0.55 + n.z * 0.63 > -0.02;
}

function face(points, fill, opts = {}) {
  return {
    points,
    fill,
    stroke: opts.stroke || 'rgba(16,17,19,.34)',
    strokeWidth: opts.strokeWidth ?? 1.15,
    depth: points.reduce((sum, p) => sum + p.x + p.y + p.z, 0) / points.length,
    opacity: opts.opacity ?? 1,
  };
}

function boxFaces(cx, cy, w, d, z0, z1, rot, fill, opts = {}) {
  const halfW = w / 2;
  const halfD = d / 2;
  const corners = [
    [-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD],
  ].map(([x, y]) => rotate(cx + x, cy + y, cx, cy, rot));
  const p = (i, z) => ({ x: corners[i].x, y: corners[i].y, z });
  const top = shade(fill, opts.top ?? 1.08);
  const front = shade(fill, opts.front ?? 0.94);
  const side = shade(fill, opts.side ?? 0.8);
  const dark = shade(fill, 0.68);
  const result = [];
  const add = (points, color, extra = {}) => {
    if (visible(points)) result.push(face(points, color, { ...opts, ...extra }));
  };
  add([p(0, z1), p(1, z1), p(2, z1), p(3, z1)], top); // верх
  add([p(1, z0), p(2, z0), p(2, z1), p(1, z1)], front); // +y
  add([p(2, z0), p(3, z0), p(3, z1), p(2, z1)], side); // +x
  add([p(0, z0), p(1, z0), p(1, z1), p(0, z1)], shade(front, 0.88)); // -y (для развёрнутых)
  add([p(3, z0), p(0, z0), p(0, z1), p(3, z1)], shade(side, 0.9)); // -x
  if (opts.bottom) add([p(0, z0), p(3, z0), p(2, z0), p(1, z0)], dark);
  return result;
}

function shadowFaces(room, cx, cy, w, d, rot) {
  // Три смещённых следа дают мягкую тень без SVG-фильтров.
  const layers = [
    { dx: 55, dy: 55, alpha: 0.07, grow: 1.03 },
    { dx: 30, dy: 30, alpha: 0.09, grow: 1.01 },
    { dx: 12, dy: 12, alpha: 0.1, grow: 1 },
  ];
  const out = [];
  for (const layer of layers) {
    const hw = (w * layer.grow) / 2;
    const hd = (d * layer.grow) / 2;
    const pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => {
      const r = rotate(cx + x + layer.dx, cy + y + layer.dy, cx, cy, rot);
      return { x: r.x, y: r.y, z: 3 };
    });
    out.push({ points: pts, alpha: layer.alpha });
  }
  return out;
}

/* --- детали мебели --------------------------------------------------------- */

function furnitureParts(item, palette) {
  const kind = String(item.kind || 'sofa');
  const def = CATALOG[kind] || CATALOG.sofa;
  const cat = def[4] || 'storage';
  const w = Math.max(120, Number(item.w) || def[0]);
  const d = Math.max(120, Number(item.d) || def[1]);
  const h = Math.max(80, Number(item.h) || def[2]);
  const rot = Number(item.rot) || 0;
  const cx = Number(item.x ?? 0) + w / 2;
  const cy = Number(item.y ?? 0) + d / 2;
  const wood = palette.wood;
  const textile = palette.textile;
  const stone = palette.stone;
  const metal = palette.metal;
  const accent = palette.accent;
  const parts = [];
  const add = (ox, oy, bw, bd, z0, z1, color, opts = {}) => {
    const c = rotate(cx + ox, cy + oy, cx, cy, rot);
    parts.push(...boxFaces(c.x, c.y, bw, bd, z0, z1, rot, color, opts));
  };

  if (kind === 'rug') return parts;
  if (kind === 'plant') {
    add(0, 0, w * 0.55, d * 0.55, 0, 380, mix(stone, '#6d5b4b', 0.35), { top: 1.05 });
    add(0, 0, w * 0.9, d * 0.9, 380, 760, mix('#4f6b4a', '#7d9b6a', 0.35), { front: 0.9, side: 0.74, top: 1.2, strokeWidth: 0.8 });
    add(-w * 0.12, d * 0.08, w * 0.7, d * 0.55, 760, 1120, mix('#58734d', '#9ab07d', 0.4), { front: 0.9, side: 0.72, top: 1.25, strokeWidth: 0.7 });
    add(w * 0.16, -d * 0.06, w * 0.55, d * 0.45, 900, 1240, mix('#4c6544', '#879c6e', 0.4), { front: 0.9, side: 0.72, top: 1.2, strokeWidth: 0.7 });
    return parts;
  }
  if (kind === 'mirror') {
    add(0, 0, w, Math.max(40, d), 850, 1850, mix(stone, '#b9c7c9', 0.55), { front: 0.9, side: 0.78, top: 1.1, strokeWidth: 2 });
    add(0, 0, w * 0.94, Math.max(20, d * 0.7), 880, 1810, mix('#9fb7bb', '#e7f0f0', 0.5), { front: 1, side: 0.9, top: 1.05, strokeWidth: 0.6 });
    return parts;
  }
  if (kind === 'tv_wall' || kind === 'tv_stand') {
    if (kind === 'tv_stand') {
      add(0, 0, w, d, 0, Math.min(h, 500), mix(wood, '#2b2926', 0.4), { top: 1.25 });
      add(0, 0, w * 0.64, Math.max(50, d * 0.24), 520, 1180, '#17191b', { front: 1, side: 0.8, top: 1.15, strokeWidth: 1.6 });
    } else {
      add(0, 0, w, Math.max(55, d), 900, 1700, '#17191b', { front: 1, side: 0.8, top: 1.1, strokeWidth: 1.6 });
    }
    return parts;
  }
  if (cat === 'soft') {
    add(0, 0, w, d, 55, 360, mix(textile, '#000000', 0.12), { top: 1.06 });
    add(0, 0, w * 0.94, d * 0.82, 360, 455, textile, { front: 1.04, side: 0.86, top: 1.16 });
    add(0, -d / 2 + Math.min(145, d * 0.16), w, Math.min(210, d * 0.22), 360, Math.min(h, 880), mix(textile, '#000000', 0.06), { front: 0.94, side: 0.8, top: 1.08 });
    const arm = Math.min(175, w * 0.1);
    add(-w / 2 + arm / 2, 0, arm, d, 360, Math.min(h, 680), mix(textile, '#ffffff', 0.05), { front: 0.98, side: 0.84, top: 1.1 });
    add(w / 2 - arm / 2, 0, arm, d, 360, Math.min(h, 680), mix(textile, '#ffffff', 0.05), { front: 0.98, side: 0.84, top: 1.1 });
    const cushions = Math.max(1, Math.round(w / 900));
    for (let i = 0; i < cushions; i += 1) {
      const x = -w / 2 + (w / cushions) * (i + 0.5);
      add(x, -d * 0.06, (w / cushions) * 0.78, d * 0.56, 455, 535, mix(textile, '#ffffff', 0.12), { front: 1.02, side: 0.88, top: 1.18, strokeWidth: 0.8 });
    }
    return parts;
  }
  if (cat === 'sleep') {
    add(0, 0, w, d, 40, 300, mix(wood, '#2b2622', 0.55), { top: 1.12 });
    add(0, 0, w * 0.94, d * 0.92, 300, 520, mix(stone, '#ffffff', 0.45), { front: 1.04, side: 0.88, top: 1.12 });
    add(0, -d / 2 - 25, w * 0.98, 110, 0, 980, mix(wood, palette.textile, 0.34), { front: 0.96, side: 0.8, top: 1.14 });
    add(0, d * 0.12, w * 0.9, d * 0.52, 520, 610, mix(textile, '#ffffff', 0.1), { front: 1.02, side: 0.9, top: 1.15 });
    for (const side of [-1, 1]) {
      add(side * w * 0.22, -d * 0.28, w * 0.3, d * 0.2, 520, 690, mix(stone, '#ffffff', 0.7), { front: 1.04, side: 0.94, top: 1.16, strokeWidth: 0.8 });
    }
    return parts;
  }
  if (cat === 'dining' || cat === 'work') {
    const leg = Math.min(75, w * 0.07);
    const topZ = Math.max(300, h - 70);
    add(0, 0, w, d, topZ, h, mix(wood, '#ffffff', 0.14), { top: 1.2, front: 1, side: 0.84 });
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        add(sx * (w / 2 - leg * 1.1), sy * (d / 2 - leg * 1.1), leg, leg, 0, topZ, metal, { top: 0.9, front: 0.9, side: 0.75, strokeWidth: 0.7 });
      }
    }
    return parts;
  }
  if (kind === 'kitchen_counter' || kind === 'sink' || kind === 'hob') {
    add(0, 0, w, d, 0, Math.min(h, 860), mix(stone, wood, 0.32), { top: 1.0, front: 0.92, side: 0.8 });
    add(0, 0, w * 1.01, d * 1.02, Math.min(h, 860), Math.min(h, 920), stone, { top: 1.24, front: 1.04, side: 0.9 });
    if (kind === 'sink') add(0, 0, w * 0.62, d * 0.55, 900, 935, mix(metal, '#ffffff', 0.3), { top: 1.1, front: 0.9, side: 0.8 });
    if (kind === 'hob') {
      for (const [x, y] of [[-0.25, -0.2], [0.25, -0.2], [-0.25, 0.2], [0.25, 0.2]]) {
        add(w * x, d * y, Math.min(170, w * 0.2), Math.min(170, d * 0.28), 920, 932, '#23262a', { top: 1, front: 0.8, side: 0.7, strokeWidth: 0.5 });
      }
    }
    return parts;
  }
  if (cat === 'bath') {
    add(0, 0, w, d, 0, Math.min(h, 560), mix(stone, '#ffffff', 0.55), { top: 1.14, front: 1.02, side: 0.9 });
    add(0, 0, w * 0.82, d * 0.72, Math.min(h, 560), Math.min(h, 590), mix(stone, '#ffffff', 0.8), { top: 1.2, front: 1.04, side: 0.92, strokeWidth: 0.7 });
    if (kind === 'wc') add(0, -d * 0.32, w * 0.8, d * 0.3, 0, 780, mix(stone, '#ffffff', 0.65), { top: 1.12, front: 1, side: 0.88 });
    return parts;
  }
  if (cat === 'decor') {
    add(0, 0, w, d, 0, Math.max(120, h), mix(wood, accent, 0.28), { top: 1.16, front: 0.98, side: 0.82 });
    return parts;
  }
  // storage/media: корпус с дверцами и тёмной ручкой
  add(0, 0, w, d, 0, Math.min(h, 1150), mix(wood, palette.ceiling, 0.2), { top: 1.14, front: 0.98, side: 0.8 });
  add(0, d / 2 + 8, w * 0.9, 18, 80, Math.max(160, Math.min(h, 1050) - 80), mix(wood, '#ffffff', 0.22), { top: 0.9, front: 1.06, side: 0.82, strokeWidth: 0.6 });
  const doors = w > 1200 ? 2 : 1;
  for (let i = 1; i < doors; i += 1) {
    add(-w / 2 + (w / doors) * i, d / 2 + 16, 12, 14, 100, Math.min(h, 1050) - 100, shade(wood, 0.55), { top: 0.8, front: 0.8, side: 0.7, strokeWidth: 0.4 });
  }
  add(w * 0.22, d / 2 + 22, 22, 22, Math.min(h, 950), Math.min(h, 1040), metal, { top: 0.9, front: 0.9, side: 0.7, strokeWidth: 0.4 });
  return parts;
}

/* --- пол: заливка, доски/плитка и ковры ----------------------------------- */

function roomFloorSvg(room, palette, index, to) {
  const poly = (room.poly || []).map(([x, y]) => project(x, y, 0));
  if (poly.length < 3 || polyArea2D(poly) < 1) return '';
  const points = poly.map((p) => to(p)).join(' ');
  const tile = /керамогранит|плитк|кафель|мрамор/i.test(String(room.floor || ''));
  const base = tile ? mix(palette.stone, '#CFC8BB', 0.45) : mix(palette.floor, '#B07D4F', 0.44);
  const clip = `floor-${index}`;
  const bbox = {
    minX: Math.min(...room.poly.map((p) => p[0])),
    maxX: Math.max(...room.poly.map((p) => p[0])),
    minY: Math.min(...room.poly.map((p) => p[1])),
    maxY: Math.max(...room.poly.map((p) => p[1])),
  };
  const lines = [];
  const line = (a, b) => {
    const [x1, y1] = a.split(',');
    const [x2, y2] = b.split(',');
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  };
  const spacing = tile ? 600 : 185;
  const stroke = tile ? rgba('#ffffff', 0.2) : rgba('#2b1d12', 0.28);
  if (tile) {
    for (let x = Math.ceil(bbox.minX / spacing) * spacing; x <= bbox.maxX; x += spacing) {
      lines.push(line(to(project(x, bbox.minY - 200, 2)), to(project(x, bbox.maxY + 200, 2))));
    }
    for (let y = Math.ceil(bbox.minY / spacing) * spacing; y <= bbox.maxY; y += spacing) {
      lines.push(line(to(project(bbox.minX - 200, y, 2)), to(project(bbox.maxX + 200, y, 2))));
    }
  } else {
    for (let y = Math.ceil(bbox.minY / spacing) * spacing; y <= bbox.maxY; y += spacing) {
      lines.push(line(to(project(bbox.minX - 200, y, 2)), to(project(bbox.maxX + 200, y, 2))));
    }
  }
  return `<clipPath id="${clip}"><polygon points="${points}"/></clipPath>
  <polygon points="${points}" fill="${base}"/>
  <g clip-path="url(#${clip})" stroke="${stroke}" stroke-width="1.1">${lines.join('')}</g>
  <polygon points="${points}" fill="#ffe8c2" opacity=".045"/>`;
}

function rugSvg(item, palette, to) {
  const def = CATALOG[item.kind] || CATALOG.rug;
  const w = Number(item.w) || def[0];
  const d = Number(item.d) || def[1];
  const cx = Number(item.x || 0) + w / 2;
  const cy = Number(item.y || 0) + d / 2;
  const rot = Number(item.rot) || 0;
  const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, y]) => {
    const r = rotate(cx + x, cy + y, cx, cy, rot);
    return project(r.x, r.y, 8);
  });
  if (polyArea2D(corners) < 1) return '';
  const points = corners.map((p) => to(p)).join(' ');
  const innerPts = [[-w / 2 + 120, -d / 2 + 120], [w / 2 - 120, -d / 2 + 120], [w / 2 - 120, d / 2 - 120], [-w / 2 + 120, d / 2 - 120]].map(([x, y]) => {
    const r = rotate(cx + x, cy + y, cx, cy, rot);
    return project(r.x, r.y, 9);
  });
  const inner = polyArea2D(innerPts) >= 1
    ? `<polygon points="${innerPts.map((p) => to(p)).join(' ')}" fill="none" stroke="${rgba('#ffffff', 0.32)}" stroke-width="2" stroke-dasharray="10 8"/>`
    : '';
  return `<polygon points="${points}" fill="${mix(palette.textile, palette.accent, 0.34)}" stroke="${rgba('#000000', 0.25)}" stroke-width="1.5"/>${inner}`;
}

/* --- стены с проёмами ------------------------------------------------------ */

function wallSegments(wall, openings) {
  const t = Math.max(40, Number(wall.t ?? 150));
  const horizontal = Math.abs(wall.y1 - wall.y2) < 1;
  const vertical = Math.abs(wall.x1 - wall.x2) < 1;
  if (!horizontal && !vertical) return [];
  const min = horizontal ? Math.min(wall.x1, wall.x2) : Math.min(wall.y1, wall.y2);
  const max = horizontal ? Math.max(wall.x1, wall.x2) : Math.max(wall.y1, wall.y2);
  const fixed = horizontal ? (wall.y1 + wall.y2) / 2 : (wall.x1 + wall.x2) / 2;
  const relevant = (openings || []).filter((o) => {
    if (horizontal ? o.dir !== 'h' : o.dir !== 'v') return false;
    const along = horizontal ? o.x : o.y;
    const across = horizontal ? o.y : o.x;
    return Math.abs(across - fixed) < Math.max(220, t * 1.8) && along + Number(o.w || 0) > min && along < max;
  }).map((o) => ({
    start: clamp(horizontal ? o.x : o.y, min, max),
    end: clamp((horizontal ? o.x : o.y) + Number(o.w || 0), min, max),
    kind: o.kind,
    sill: Number(o.sill ?? 900),
    height: Number(o.h ?? (o.kind === 'door' ? 2100 : 1500)),
  })).sort((a, b) => a.start - b.start);

  const segments = [];
  let cursor = min;
  for (const opening of relevant) {
    if (opening.start > cursor + 2) segments.push({ from: cursor, to: opening.start, opening: null });
    segments.push({ from: opening.start, to: opening.end, opening });
    cursor = Math.max(cursor, opening.end);
  }
  if (cursor < max - 2) segments.push({ from: cursor, to: max, opening: null });
  return segments.map((segment) => ({ ...segment, horizontal, fixed, t }));
}

function wallSvg(wall, openings, palette, bbox) {
  const parts = [];
  const segments = wallSegments(wall, openings);
  const nearX = Math.abs(Math.max(wall.x1, wall.x2) - bbox.maxX) < 450;
  const nearY = Math.abs(Math.max(wall.y1, wall.y2) - bbox.maxY) < 450;
  const near = (nearX && Math.abs(wall.x1 - wall.x2) < 1) || (nearY && Math.abs(wall.y1 - wall.y2) < 1);
  const cut = near ? 180 : 900; // срез ниже спинки дивана: интерьер читается как разрез
  const wallColor = palette.wall;
  for (const segment of segments) {
    const length = Math.max(20, segment.to - segment.from);
    if (segment.opening) {
      const o = segment.opening;
      if (o.kind === 'window' && cut > o.sill + 40) {
        const z0 = o.sill;
        const z1 = Math.min(cut, o.sill + o.height);
        // стекло и переплёт на плоскости стены
        const cx = segment.horizontal ? (segment.from + segment.to) / 2 : segment.fixed;
        const cy = segment.horizontal ? segment.fixed : (segment.from + segment.to) / 2;
        const w = segment.horizontal ? length : 60;
        const d = segment.horizontal ? 60 : length;
        for (const p of boxFaces(cx, cy, w, d, z0, z1, 0, mix(palette.ceiling, '#8fb4c4', 0.42), { top: 1.1, front: 1, side: 0.85, strokeWidth: 0.9, opacity: 0.92 })) parts.push(p);
        const frame = segment.horizontal
          ? boxFaces(cx, cy, length + 30, 70, z1 - 35, z1, 0, palette.metal, { strokeWidth: 0.5 })
          : boxFaces(cx, cy, 70, length + 30, z1 - 35, z1, 0, palette.metal, { strokeWidth: 0.5 });
        for (const p of frame) parts.push(p);
      } else if (o.kind === 'door' && cut > 100) {
        // Проём оставляем открытым: закрытое полотно в разрезе только прячет
        // комнату. Порог обозначает границу.
        const cx = segment.horizontal ? (segment.from + segment.to) / 2 : segment.fixed;
        const cy = segment.horizontal ? segment.fixed : (segment.from + segment.to) / 2;
        const w = segment.horizontal ? length : 90;
        const d = segment.horizontal ? 90 : length;
        for (const p of boxFaces(cx, cy, w, d, 0, 28, 0, mix(palette.wood, '#2b2119', 0.2), { top: 1.05, front: 0.95, side: 0.8, strokeWidth: 0.6 })) parts.push(p);
      }
      continue;
    }
    const cx = segment.horizontal ? (segment.from + segment.to) / 2 : segment.fixed;
    const cy = segment.horizontal ? segment.fixed : (segment.from + segment.to) / 2;
    const w = segment.horizontal ? length : segment.t;
    const d = segment.horizontal ? segment.t : length;
    for (const p of boxFaces(cx, cy, w, d, 0, cut, 0, wallColor, { top: 1.18, front: 0.94, side: 0.8 })) parts.push(p);
    // плинтус читается как тонкая светлая полоса у пола
    if (!near) {
      const baseColor = mix(palette.ceiling, '#ffffff', 0.2);
      for (const p of boxFaces(cx, cy, w + 4, d + 4, 0, 90, 0, baseColor, { top: 1.05, front: 1.02, side: 0.9, strokeWidth: 0.5 })) parts.push(p);
    }
  }
  return parts;
}

/* --- сборка кадра ---------------------------------------------------------- */

export function heroSvg(spec, options = {}) {
  const palette = { ...DEFAULT_PALETTE };
  for (const [key, value] of Object.entries(spec?.style?.palette || {})) {
    if (key in palette) palette[key] = hex(value, palette[key]);
  }
  const walls = Array.isArray(spec.walls) ? spec.walls : [];
  const rooms = Array.isArray(spec.rooms) ? spec.rooms : [];
  const furniture = Array.isArray(spec.furniture) ? spec.furniture : [];
  const openings = Array.isArray(spec.openings) ? spec.openings : [];
  const points = walls.flatMap((w) => [[w.x1, w.y1], [w.x2, w.y2]]);
  const bbox = points.length
    ? {
      minX: Math.min(...points.map((p) => p[0])) - 250,
      maxX: Math.max(...points.map((p) => p[0])) + 250,
      minY: Math.min(...points.map((p) => p[1])) - 250,
      maxY: Math.max(...points.map((p) => p[1])) + 250,
    }
    : { minX: -500, maxX: 500, minY: -500, maxY: 500 };

  const faces = [];
  for (const wall of walls) faces.push(...wallSvg(wall, openings, palette, bbox));
  for (const item of furniture) {
    if (String(item.kind) === 'rug') continue;
    if (String(item.kind) === 'door') continue;
    faces.push(...furnitureParts(item, palette));
  }
  faces.sort((a, b) => a.depth - b.depth);

  // Совсем тонкие грани после поворота могут выродиться в линию. resvg на
  // полигоне нулевой площади падает, да и рисовать там нечего.
  const drawFaces = faces.filter((item) => polyArea2D(item.points.map((p) => project(p.x, p.y, p.z))) >= 2);

  const floorPoints = rooms.flatMap((room) => (room.poly || []).map(([x, y]) => project(x, y, 0)));
  const allProjected = [...floorPoints, ...faces.flatMap((f) => f.points.map((p) => project(p.x, p.y, p.z)))];
  if (!allProjected.length) allProjected.push(project(0, 0, 0));
  const xs = allProjected.map((p) => p.X);
  const ys = allProjected.map((p) => p.Y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const marginX = 70;
  const marginTop = 80;
  const marginBottom = 70;
  const k = Math.min((W - marginX * 2) / Math.max(1, maxX - minX), (H - marginTop - marginBottom) / Math.max(1, maxY - minY));
  const ox = (W - (maxX - minX) * k) / 2 - minX * k;
  const oy = marginTop + (H - marginTop - marginBottom - (maxY - minY) * k) / 2 - minY * k;
  const to = (p) => `${(ox + p.X * k).toFixed(2)},${(oy + p.Y * k).toFixed(2)}`;

  const areaTotal = rooms.reduce((sum, room) => sum + area(room.poly || []), 0);
  const title = String(spec.project || '').replace(/[<>&"]/g, '');
  const subtitle = [spec.object, areaTotal ? `${num(areaTotal, 1)} м²` : '', `${rooms.length} пом.`].filter(Boolean).join(' · ');

  const svg = [];
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Визуализация интерьера">`);
  svg.push(`<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#181a1d"/><stop offset=".52" stop-color="#202124"/><stop offset="1" stop-color="#2a2723"/>
    </linearGradient>
    <radialGradient id="warm" cx=".55" cy=".4" r=".75">
      <stop offset="0" stop-color="#8f6a47" stop-opacity=".3"/><stop offset=".55" stop-color="#8f6a47" stop-opacity=".08"/><stop offset="1" stop-color="#8f6a47" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx=".5" cy=".46" r=".72">
      <stop offset=".5" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity=".52"/>
    </radialGradient>
    <linearGradient id="bottomFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#101113" stop-opacity="0"/><stop offset="1" stop-color="#101113" stop-opacity=".78"/>
    </linearGradient>
  </defs>`);
  svg.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#warm)"/>`);
  // едва заметная сетка, чтобы фон не был плоским
  const grid = [];
  for (let x = 40; x < W; x += 80) grid.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`);
  for (let y = 40; y < H; y += 80) grid.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`);
  svg.push(`<g stroke="#ffffff" stroke-opacity=".025" stroke-width="1">${grid.join('')}</g>`);

  // тёплый свет из окон — мягкое пятно под сценой
  svg.push(`<ellipse cx="${W * 0.55}" cy="${H * 0.62}" rx="${W * 0.38}" ry="${H * 0.24}" fill="#d8b17d" opacity=".045"/>`);

  for (const [index, room] of rooms.entries()) svg.push(roomFloorSvg(room, palette, index, to));
  for (const item of furniture) if (String(item.kind) === 'rug') svg.push(rugSvg(item, palette, to));

  // тени на полу
  for (const item of furniture) {
    if (String(item.kind) === 'rug' || String(item.kind) === 'mirror' || String(item.kind) === 'tv_wall') continue;
    const def = CATALOG[item.kind] || CATALOG.soft;
    const w = Number(item.w) || def[0];
    const d = Number(item.d) || def[1];
    const cx = Number(item.x || 0) + w / 2;
    const cy = Number(item.y || 0) + d / 2;
    const rot = Number(item.rot) || 0;
    for (const shadow of shadowFaces(null, cx, cy, w, d, rot)) {
      svg.push(`<polygon points="${shadow.points.map((p) => to(project(p.x, p.y, p.z))).join(' ')}" fill="#000000" opacity="${shadow.alpha}"/>`);
    }
  }

  for (const item of drawFaces) {
    const opacity = item.opacity < 1 ? ` opacity="${item.opacity}"` : '';
    svg.push(`<polygon points="${item.points.map((p) => to(project(p.x, p.y, p.z))).join(' ')}" fill="${item.fill}" stroke="${item.stroke}" stroke-width="${item.strokeWidth}"${opacity}/>`);
  }

  svg.push(`<rect width="${W}" height="${H}" fill="url(#vignette)"/>`);
  svg.push(`<rect y="${H - 250}" width="${W}" height="250" fill="url(#bottomFade)"/>`);

  // подпись — только латиница, чтобы кадр одинаково собирался без шрифтов
  const label = 'DSH OPEN  /  INTERIOR';
  svg.push(`<g font-family="Arial, Helvetica, sans-serif" fill="#efe7da">
    <text x="58" y="66" font-size="15" letter-spacing="4.2" opacity=".92">${label}</text>
    <text x="${W - 58}" y="66" font-size="12" letter-spacing="3" text-anchor="end" opacity=".55">ВИЗУАЛИЗАЦИЯ</text>
    <line x1="58" y1="82" x2="250" y2="82" stroke="#d8a27a" stroke-width="1.2" opacity=".8"/>
    <text x="58" y="${H - 46}" font-size="13" letter-spacing=".8" opacity=".62">${subtitle || '3D-визуализация интерьера'}</text>
  </g>`);
  svg.push(`<rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="18" fill="none" stroke="#ffffff" stroke-opacity=".13"/>`);
  svg.push('</svg>');
  return { svg: svg.join('\n'), width: W, height: H, area: areaTotal };
}

export default heroSvg;

#!/usr/bin/env node
/**
 * Аксонометрия интерьера без 3D-движка: стены и мебель как блоки, изометрия 30°,
 * painter-сортировка. Быстрый статичный объём для согласования планировки.
 *
 *   node axo.mjs spec.json out.svg [--height 2700]
 */
import fs from 'node:fs';
import path from 'node:path';
import { CATALOG, area, defs, esc, fitText, frameAndNotes, line, num, svgOpen, sheetFor, text, titleBlock } from './lib.mjs';

export function renderAxo(spec, opt = {}) {
  const sheet = sheetFor({ paper: spec.paper || 'A2', orientation: 'landscape', ...spec });
  const H = Number(opt.height || spec.heights?.wall || 2700);
  const WALL_H = H;
  const CUT = Number(opt.cut ?? spec.cut ?? 1150); // стены срезаем, иначе интерьер не виден
  const walls = spec.walls || [];
  const furniture = (spec.furniture || []).filter((f) => f.kind !== 'rug');
  const rooms = spec.rooms || [];
  const bbox = {
    minX: Math.min(...walls.map((w) => Math.min(w.x1, w.x2))) - 150,
    maxX: Math.max(...walls.map((w) => Math.max(w.x1, w.x2))) + 150,
    minY: Math.min(...walls.map((w) => Math.min(w.y1, w.y2))) - 150,
    maxY: Math.max(...walls.map((w) => Math.max(w.y1, w.y2))) + 150,
  };

  const C = Math.cos(Math.PI / 6);
  const S = Math.sin(Math.PI / 6);
  const proj = (x, y, z) => {
    const yy = bbox.maxY - y; // север вверх
    return { X: (x - yy) * C, Y: (x + yy) * S - z };
  };

  // собрать полигоны-грани
  const faces = [];
  const pushBox = (x0, y0, x1, y1, z0, z1, fill, label) => {
    const corners = [
      [x0, y0], [x1, y0], [x1, y1], [x0, y1],
    ];
    const box = (pts, f, zKey) => {
      faces.push({ pts: pts.map(([x, y, z]) => proj(x, y, z)), fill: f, key: (x0 + x1 + y0 + y1) / 2 + zKey, label });
    };
    // верх
    box([...corners.map(([x, y]) => [x, y, z1])], fill.top, 10000);
    // фронт (y = y1 — ближняя к зрителю сторона из-за разворота)
    box([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], fill.front, 0);
    // левая сторона (x = x0)
    box([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], fill.side, -1000);
  };

  const WALL_FILL = { top: '#4a4f56', front: '#33373d', side: '#282c31' };
  const FURN_FILL = { top: '#ffffff', front: '#e7e9ec', side: '#d3d7dc' };

  for (const w of walls) {
    const t = Number(w.t ?? 150) / 2;
    const x0 = Math.min(w.x1, w.x2) - (Math.abs(w.x1 - w.x2) < 1 ? t : 0);
    const x1 = Math.max(w.x1, w.x2) + (Math.abs(w.x1 - w.x2) < 1 ? t : 0);
    const y0 = Math.min(w.y1, w.y2) - (Math.abs(w.y1 - w.y2) < 1 ? t : 0);
    const y1 = Math.max(w.y1, w.y2) + (Math.abs(w.y1 - w.y2) < 1 ? t : 0);
    pushBox(x0, y0, x1, y1, 0, Math.min(CUT, WALL_H), WALL_FILL);
  }
  for (const f of furniture) {
    const def = CATALOG[f.kind] || CATALOG.sofa;
    const w = Number(f.w) || def[0];
    const d = Number(f.d) || def[1];
    const h = Number(f.h) || def[2];
    pushBox(Number(f.x), Number(f.y), Number(f.x) + w, Number(f.y) + d, 0, Math.min(h, WALL_H), FURN_FILL, f.name || def[3]);
  }

  faces.sort((a, b) => b.key - a.key);

  // вписать в лист
  const all = faces.flatMap((f) => f.pts);
  const minPX = Math.min(...all.map((p) => p.X));
  const maxPX = Math.max(...all.map((p) => p.X));
  const minPY = Math.min(...all.map((p) => p.Y));
  const maxPY = Math.max(...all.map((p) => p.Y));
  const legendW = 0;
  const a = sheet.area;
  const k = Math.max((maxPX - minPX) / (a.w - legendW - 6), (maxPY - minPY) / (a.h - 6));
  const ox = a.x + (a.w - (maxPX - minPX) / k) / 2 - minPX / k;
  const oy = a.y + (a.h - (maxPY - minPY) / k) / 2 - minPY / k;
  const to = (p) => `${(ox + p.X / k).toFixed(2)},${(oy + p.Y / k).toFixed(2)}`;

  const out = [svgOpen(sheet), defs()];
  // пол
  for (const r of rooms) {
    const pts = r.poly.map(([x, y]) => proj(x, y, 0)).map(to).join(' ');
    out.push(`<polygon points="${pts}" fill="#f7f3ea" stroke="none"/>`);
  }
  for (const f of faces) {
    out.push(`<polygon points="${f.pts.map(to).join(' ')}" fill="${f.fill}" stroke="${f.fill === WALL_FILL.top ? 'none' : '#8f959c'}" stroke-width="0.12"/>`);
  }
  // подписи комнат на полу (поверх заливок, под мебелью не критично)
  for (const r of rooms) {
    const cx = r.poly.reduce((s, p) => s + p[0], 0) / r.poly.length;
    const cy = r.poly.reduce((s, p) => s + p[1], 0) / r.poly.length;
    const p = proj(cx, cy, 0);
    const px = ox + p.X / k;
    const py = oy + p.Y / k;
    out.push(text(px, py, r.name, { size: 2.8, bold: true, halo: true, fill: '#2b3138' }));
    out.push(text(px, py + 3.2, `${num(area(r.poly), 1)} м²`, { size: 2.2, halo: true, fill: '#59616a' }));
  }

  const notes = [
    `Аксонометрия. Высота стен ${num(WALL_H, 0)} мм, срез на ${num(CUT, 0)} мм для читаемости. Мебель — габаритные блоки.`,
    'Проверка объёма до 3D-визуализации: пропорции комнат, проходы, высота мебели.',
  ];
  out.push(frameAndNotes(sheet, notes));
  out.push(titleBlock(sheet, { ...spec, sheetName: 'Аксонометрия', scaleText: 'б/м' }));
  out.push('</svg>');
  void area;
  void fitText;
  void line;
  void esc;
  return { svg: out.join('\n'), faces: faces.length };
}

if (process.argv[1] && process.argv[1].endsWith('axo.mjs')) {
  const [file, outArg] = process.argv.slice(2);
  if (!file) {
    console.error('Использование: node axo.mjs spec.json out.svg [--height 2700]');
    process.exit(2);
  }
  const spec = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''));
  const hIdx = process.argv.indexOf('--height');
  const height = hIdx > 0 ? Number(process.argv[hIdx + 1]) : undefined;
  const { svg, faces } = renderAxo(spec, { height });
  const out = path.resolve(outArg || file.replace(/\.json$/, '-аксонометрия.svg'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, svg, 'utf8');
  console.log(JSON.stringify({ out, faces, bytes: Buffer.byteLength(svg) }, null, 2));
}

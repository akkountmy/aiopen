#!/usr/bin/env node
/**
 * Развёртка стены (интерьерная): длина × высота, проёмы, мебель, зоны отделки,
 * высотные отметки и выноски материалов. Масштаб 1:50, лист A3.
 *
 *   node elevation.mjs wall.json out.svg
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  defs, dimChain, esc, fitText, frameAndNotes, line, num, rectSvg, sheetFor, svgOpen, text, titleBlock,
} from './lib.mjs';

export function renderElevation(spec) {
  const sheet = sheetFor(spec);
  const wall = spec.wall || spec;
  const L = Number(wall.length) || 4000;
  const H = Number(wall.height) || 2700;
  const legendW = 74;
  const area = { ...sheet.area, w: sheet.area.w - legendW, h: sheet.area.h - 12 };
  // масштаб: минимальный стандартный, при котором стена влезает в поле листа
  const need = Math.max(L / area.w, H / area.h);
  const STEPS = [10, 20, 25, 50, 100, 200];
  const k = Number(spec.scale) > 0 ? Number(spec.scale) : STEPS.find((s) => s >= need) || need;
  const pw = L / k;
  const ph = H / k;
  const ox = area.x + (area.w - pw) / 2;
  const oy = area.y + (area.h - ph) / 2 + ph; // низ стены
  const sx = (x) => ox + x / k;
  const sy = (h) => oy - h / k; // h — высота от пола
  const out = [svgOpen(sheet), defs()];

  /* --------------------------- стена -------------------------------- */
  out.push(`<rect x="${ox.toFixed(2)}" y="${(oy - ph).toFixed(2)}" width="${pw.toFixed(2)}" height="${ph.toFixed(2)}" fill="#fbfaf7" stroke="#111" stroke-width="0.4"/>`);
  // зоны отделки
  for (const f of wall.finishes || []) {
    const y1 = sy(Number(f.to) ?? H);
    const y2 = sy(Number(f.from) ?? 0);
    if (f.hatch) {
      out.push(`<rect x="${ox.toFixed(2)}" y="${y1.toFixed(2)}" width="${pw.toFixed(2)}" height="${(y2 - y1).toFixed(2)}" fill="url(#${f.hatch})" opacity="0.55"/>`);
    }
    if (f.label) out.push(text(ox + 2, y1 + 3.6, f.label, { size: 2, anchor: 'start', fill: '#4a5158' }));
  }
  // плинтус и потолочная линия
  const base = 80 / k;
  out.push(line(ox, sy(base), ox + pw, sy(base), 0.3));
  out.push(line(ox, sy(H - 1), ox + pw, sy(H - 1), 0.5));
  out.push(text(ox + pw - 1, sy(base) - 1, `плинтус ${num(wall.baseboard ?? 80, 0)} мм`, { size: 1.9, anchor: 'end', fill: '#555' }));

  /* --------------------------- проёмы -------------------------------- */
  for (const o of wall.openings || []) {
    const x = Number(o.x) || 0;
    const w = Number(o.w) || (o.type === 'window' ? 1500 : 900);
    const h = Number(o.h) || (o.type === 'window' ? 1500 : 2100);
    const sill = o.type === 'window' ? Number(o.sill ?? 900) : 0;
    const x1 = sx(x);
    const x2 = sx(x + w);
    out.push(`<rect x="${x1.toFixed(2)}" y="${sy(sill + h).toFixed(2)}" width="${(x2 - x1).toFixed(2)}" height="${(h / k).toFixed(2)}" fill="#ffffff" stroke="#111" stroke-width="0.35"/>`);
    if (o.type === 'window') {
      // импост и створки
      out.push(line(x1, sy(sill + h / 2), x2, sy(sill + h / 2), 0.15));
      out.push(line((x1 + x2) / 2, sy(sill + h), (x1 + x2) / 2, sy(sill), 0.15));
      out.push(line(x1 - 0.8, sy(sill), x2 + 0.8, sy(sill), 0.4));
      out.push(text((x1 + x2) / 2, sy(sill) + 3.2, `окно ${num(w, 0)}×${num(h, 0)}, от пола ${num(sill, 0)}`, { size: 1.9, halo: true }));
    } else {
      out.push(`<path d="M ${x1.toFixed(2)} ${sy(h).toFixed(2)} A ${(w / k).toFixed(2)} ${(w / k).toFixed(2)} 0 0 0 ${(x1 + w / k).toFixed(2)} ${sy(0).toFixed(2)}" fill="none" stroke="#111" stroke-width="0.2"/>`);
      out.push(text((x1 + x2) / 2, sy(0) + 3.6, `дверь ${num(w, 0)}×${num(h, 0)}`, { size: 1.9 }));
    }
  }

  /* --------------------------- мебель -------------------------------- */
  for (const f of wall.furniture || []) {
    const w = Number(f.w) || 1000;
    const h = Number(f.h) || 800;
    const legH = Number(f.legH ?? 0);
    const x1 = sx(Number(f.x) || 0);
    const y1 = sy(h);
    const r = { x: x1, y: y1, w: w / k, h: (h - legH) / k };
    out.push(rectSvg(r, '#ffffff', '#4b5258', 0.35));
    if (legH) {
      out.push(line(r.x + 1, r.y + r.h, r.x + 1, sy(0), 0.25));
      out.push(line(r.x + r.w - 1, r.y + r.h, r.x + r.w - 1, sy(0), 0.25));
    }
    const label = fitText(f.name || 'мебель', r.w - 1.6, 2);
    if (r.w > 8) out.push(text(r.x + r.w / 2, r.y + r.h / 2 + 0.8, label, { size: 2, fill: '#3d4349', halo: true }));
    out.push(text(r.x + r.w / 2, sy(0) + 3.4, `${num(w, 0)}×${num(h, 0)}`, { size: 1.8, fill: '#6b7278' }));
  }

  /* --------------------------- выноски ------------------------------- */
  const calW = 46;
  (wall.callouts || []).forEach((c, i) => {
    const px = sx(Number(c.x) || 0);
    const py = sy(Number(c.h) || 0);
    const tx = Math.min(ox + pw - calW + 8, px + 16);
    const ty = Math.max(oy - ph + 4, py - 12);
    const label = fitText(`${i + 1}. ${c.text || `поз. ${i + 1}`}`, calW - 2, 1.85);
    out.push(`<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="2.1" fill="#fff" stroke="#111" stroke-width="0.3"/>`);
    out.push(text(px, py + 0.8, String(i + 1), { size: 2.2, bold: true }));
    out.push(line(px + 2.1, py - 1.5, tx, ty + 3, 0.15));
    out.push(rectSvg({ x: tx, y: ty, w: calW, h: 6.4 }, '#ffffff', '#111', 0.15));
    out.push(`<rect x="${tx.toFixed(2)}" y="${ty.toFixed(2)}" width="${calW}" height="6.4" fill="#ffffff" stroke="#111" stroke-width="0.15" opacity="0.94"/>`);
    out.push(text(tx + 1.2, ty + 3.9, label, { size: 1.85, anchor: 'start' }));
  });

  /* --------------------------- размеры ------------------------------- */
  const coords = [0, L];
  for (const o of wall.openings || []) {
    coords.push(Number(o.x) || 0, (Number(o.x) || 0) + (Number(o.w) || 0));
  }
  for (const f of wall.furniture || []) {
    coords.push(Number(f.x) || 0, (Number(f.x) || 0) + (Number(f.w) || 0));
  }
  const bottomY = Math.min(sheet.h - 22, sy(0) + 10);
  out.push(dimChain(coords, bottomY, { k, sx, sy, bbox: { minX: 0, maxX: L, minY: 0, maxY: H } }, 'h'));
  out.push(line(sx(0), bottomY + 6, sx(L), bottomY + 6, 0.2));
  out.push(text(sx(L / 2), bottomY + 5, num(L, 0), { size: 2.4, bold: true }));

  // высотные отметки слева
  const levels = [0, ...[...(wall.openings || [])].flatMap((o) => (o.type === 'window' ? [Number(o.sill ?? 900), Number(o.sill ?? 900) + (Number(o.h) || 1500)] : [Number(o.h) || 2100])), H];
  const uniq = [...new Set(levels.map((v) => Math.round(v)))].filter((v) => v >= 0 && v <= H).sort((a, b) => a - b);
  const lx = Math.max(8, sx(0) - 14);
  for (let i = 0; i < uniq.length - 1; i++) {
    const a = uniq[i];
    const b = uniq[i + 1];
    if (b - a < 150) continue;
    out.push(line(lx, sy(a), lx, sy(b), 0.18));
    out.push(line(lx - 1.2, sy(a), lx + 1.2, sy(a), 0.18));
    out.push(line(lx - 1.2, sy(b), lx + 1.2, sy(b), 0.18));
    out.push(text(lx - 1.6, (sy(a) + sy(b)) / 2 + 0.8, num(b - a, 0), { size: 2, rotate: -90 }));
  }
  out.push(text(lx - 4, sy(H), `H=${num(H, 0)}`, { size: 2.2, anchor: 'end' }));

  /* ------------------------- ведомость ------------------------------- */
  const x = sheet.area.x + sheet.area.w - legendW + 2;
  let y = sheet.area.y + 2;
  out.push(text(x, y, 'ВЕДОМОСТЬ ОТДЕЛКИ', { size: 2.6, anchor: 'start', bold: true }));
  out.push(line(x, y + 1.4, x + legendW - 4, y + 1.4, 0.3));
  y += 5.8;
  const rows = wall.schedule || [];
  rows.forEach((r, i) => {
    out.push(text(x, y, String(i + 1), { size: 2.2, anchor: 'start' }));
    out.push(text(x + 5, y, fitText(r.material || '', legendW - 16, 2.2), { size: 2.2, anchor: 'start' }));
    out.push(text(x + 5, y + 3.4, fitText(r.note || '', legendW - 16, 1.9), { size: 1.9, anchor: 'start', fill: '#666' }));
    y += 8.4;
  });
  if (!rows.length) {
    out.push(text(x, y, 'Отделка задаётся в schedule:', { size: 2, anchor: 'start', fill: '#666' }));
    out.push(text(x, y + 3.6, '[{material, note}]', { size: 1.9, anchor: 'start', fill: '#666' }));
  }

  /* -------------------------- примечания ----------------------------- */
  out.push(
    frameAndNotes(sheet, [
      'Развёртка стены. Размеры в мм, масштаб 1:50.',
      'Высоты — от чистого пола; отметки проёмов по факту обмеров.',
      'Зоны отделки и раскладка — по ведомости отделки.',
    ]),
  );
  out.push(titleBlock(sheet, { ...spec, sheetName: wall.name ? `Развёртка: ${wall.name}` : 'Развёртка стены', scaleText: `1:${Math.round(k)}` }));
  out.push('</svg>');
  return { svg: out.join('\n'), scale: `1:${Math.round(k)}` };
}

if (process.argv[1] && process.argv[1].endsWith('elevation.mjs')) {
  const [file, outArg] = process.argv.slice(2);
  if (!file) {
    console.error('Использование: node elevation.mjs wall.json out.svg');
    process.exit(2);
  }
  const spec = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''));
  const { svg, scale } = renderElevation(spec);
  const out = path.resolve(outArg || file.replace(/\.json$/, '-развёртка.svg'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, svg, 'utf8');
  console.log(JSON.stringify({ out, scale, bytes: Buffer.byteLength(svg), note: esc('') }, null, 2));
}

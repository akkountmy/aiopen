#!/usr/bin/env node
/**
 * План расстановки мебели / план полов / план потолка из одной спецификации комнаты.
 *
 *   node plan.mjs spec.json out.svg [--mode plan|floor|ceiling]
 *
 * Спецификация — миллиметры, стены по осевой линии с толщиной t.
 * Печатается без зависимостей, масштаб 1:50 по умолчанию, лист A3.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CATALOG, FONT, area, defs, dimChain, dimOverall, esc, fitText, frameAndNotes, line, makeTransform, num,
  rectSvg, sheetFor, svgOpen, text, titleBlock, wallRect,
} from './lib.mjs';

const FLOOR_FILL = {
  wood: '#f6ecdd', laminate: '#f7eee2', parquet: '#f4e8d6', tile: '#eef3f6', porcelain: '#eef3f6',
  carpet: '#efeae3', concrete: '#eeeeee',
};

const floorKind = (s = '') => {
  const t = s.toLowerCase();
  if (/плитк|керамогранит|porcelain|мозаик/.test(t)) return 'tile';
  if (/ковр|carpet/.test(t)) return 'carpet';
  if (/бетон|стяжк/.test(t)) return 'concrete';
  return 'wood';
};

export function renderPlan(spec, mode = 'plan') {
  const sheet = sheetFor(spec);
  const rooms = spec.rooms || [];
  const legendW = rooms.length ? 66 : 0;
  const areaBox = { ...sheet.area, w: sheet.area.w - legendW };
  const tr = makeTransform(spec, { ...sheet, area: areaBox });
  const out = [svgOpen(sheet), defs()];

  /* ---------------------------- помещения ---------------------------- */
  for (const r of rooms) {
    const pts = (r.poly || []).map(([x, y]) => `${tr.sx(x).toFixed(2)},${tr.sy(y).toFixed(2)}`).join(' ');
    const kind = floorKind(r.floor);
    const fill = mode === 'floor' || mode === 'ceiling' ? FLOOR_FILL[kind] : FLOOR_FILL.wood;
    out.push(`<polygon points="${pts}" fill="${fill}" stroke="#cfd6dd" stroke-width="0.2"/>`);
    if (mode === 'floor') {
      if (kind === 'tile') {
        const step = (Number(r.tile) || 600) / tr.k;
        const xs = r.poly.map((p) => p[0]);
        const ys = r.poly.map((p) => p[1]);
        const x0 = Math.min(...xs);
        const x1 = Math.max(...xs);
        const y0 = Math.min(...ys);
        const y1 = Math.max(...ys);
        out.push(`<g clip-path="none">`);
        for (let x = x0 + (Number(r.tile) || 600); x < x1; x += Number(r.tile) || 600) out.push(line(tr.sx(x), tr.sy(y0), tr.sx(x), tr.sy(y1), 0.12, '1 1'));
        for (let y = y0 + (Number(r.tile) || 600); y < y1; y += Number(r.tile) || 600) out.push(line(tr.sx(x0), tr.sy(y), tr.sx(x1), tr.sy(y), 0.12, '1 1'));
        out.push(`</g>`);
      } else if (kind === 'wood') {
        const y0 = Math.min(...r.poly.map((p) => p[1]));
        const y1 = Math.max(...r.poly.map((p) => p[1]));
        const x0 = Math.min(...r.poly.map((p) => p[0]));
        const x1 = Math.max(...r.poly.map((p) => p[0]));
        for (let y = y0 + 200; y < y1; y += 200) {
          out.push(line(tr.sx(x0), tr.sy(y), tr.sx(x1), tr.sy(y), 0.1, '0.8 0.8'));
        }
        void x1;
      }
    }
  }

  /* ------------------------------ стены ------------------------------ */
  for (const w of spec.walls || []) {
    const r = wallRect(w, tr);
    if (r.points) out.push(`<polygon points="${r.points}" fill="#3b3f45"/>`);
    else out.push(rectSvg(r, '#3b3f45'));
  }

  /* ---------------------------- проёмы ------------------------------- */
  for (const o of spec.openings || []) {
    const w = Number(o.w) || (o.kind === 'window' ? 1500 : 900);
    const t = Number(o.t) || 150;
    const th = t / tr.k;
    const cx = Number(o.x);
    const cy = Number(o.y);
    const vertical = o.dir === 'v';
    const cut = vertical
      ? { x: tr.sx(cx) - th / 2 - 0.3, y: tr.sy(cy) - w / 2 / tr.k, w: th + 0.6, h: w / tr.k }
      : { x: tr.sx(cx) - w / 2 / tr.k, y: tr.sy(cy) - th / 2 - 0.3, w: w / tr.k, h: th + 0.6 };
    out.push(rectSvg(cut, '#ffffff'));
    if (o.kind === 'window') {
      if (vertical) {
        out.push(line(tr.sx(cx) - th / 4, cut.y, tr.sx(cx) - th / 4, cut.y + cut.h, 0.25));
        out.push(line(tr.sx(cx) + th / 4, cut.y, tr.sx(cx) + th / 4, cut.y + cut.h, 0.25));
        out.push(line(tr.sx(cx), cut.y, tr.sx(cx), cut.y + cut.h, 0.12));
      } else {
        out.push(line(cut.x, tr.sy(cy) - th / 4, cut.x + cut.w, tr.sy(cy) - th / 4, 0.25));
        out.push(line(cut.x, tr.sy(cy) + th / 4, cut.x + cut.w, tr.sy(cy) + th / 4, 0.25));
        out.push(line(cut.x, tr.sy(cy), cut.x + cut.w, tr.sy(cy), 0.12));
      }
    } else {
      const r = w / tr.k;
      const hingeRight = o.hinge === 'right';
      const hx = vertical ? tr.sx(cx) : hingeRight ? tr.sx(cx) + r : tr.sx(cx) - r;
      const hy = vertical ? (hingeRight ? tr.sy(cy) + r : tr.sy(cy) - r) : tr.sy(cy);
      if (vertical) {
        const dirSign = o.swing === 'out' ? -1 : 1;
        out.push(line(hx, hy, hx + dirSign * r, hy, 0.3));
        out.push(`<path d="M ${hx + dirSign * r} ${hy} A ${r} ${r} 0 0 ${dirSign > 0 ? 0 : 1} ${hx} ${hy - (hingeRight ? r : -r)}" fill="none" stroke="#111" stroke-width="0.15"/>`);
      } else {
        const dirSign = o.swing === 'out' ? -1 : 1;
        out.push(line(hx, hy, hx, hy + dirSign * r, 0.3));
        out.push(`<path d="M ${hx} ${hy + dirSign * r} A ${r} ${r} 0 0 ${dirSign > 0 ? 1 : 0} ${hx + (hingeRight ? r : -r)} ${hy}" fill="none" stroke="#111" stroke-width="0.15"/>`);
      }
    }
  }

  /* ---------------------------- мебель ------------------------------- */
  for (const f of spec.furniture || []) {
    out.push(furnitureSvg(f, tr));
  }

  /* ------------------- светильники (план потолка) -------------------- */
  if (mode === 'ceiling') {
    for (const l of spec.lighting || []) {
      if (l.kind === 'line') {
        out.push(line(tr.sx(l.x1), tr.sy(l.y1), tr.sx(l.x2), tr.sy(l.y2), 1.1));
        out.push(text((tr.sx(l.x1) + tr.sx(l.x2)) / 2, tr.sy(l.y1) - 2.2, l.name || 'LED-линия', { size: 2, halo: true }));
      } else if (l.kind === 'chandelier') {
        const cx = tr.sx(l.x);
        const cy = tr.sy(l.y);
        out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="2.6" fill="#fff" stroke="#111" stroke-width="0.3"/>`);
        for (let i = 0; i < 8; i++) {
          const a = (Math.PI * i) / 4;
          out.push(line(cx + Math.cos(a) * 3.1, cy + Math.sin(a) * 3.1, cx + Math.cos(a) * 4.3, cy + Math.sin(a) * 4.3, 0.25));
        }
        out.push(text(cx, cy + 0.9, 'Л', { size: 2.4, bold: true }));
      } else {
        const cx = tr.sx(l.x);
        const cy = tr.sy(l.y);
        out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="1.5" fill="#fff" stroke="#111" stroke-width="0.3"/>`);
        out.push(line(cx - 1.9, cy, cx + 1.9, cy, 0.2));
        out.push(line(cx, cy - 1.9, cx, cy + 1.9, 0.2));
      }
    }
  }

  /* ------------------------- подписи комнат -------------------------- */
  rooms.forEach((r, i) => {
    const cx = r.poly.reduce((s, p) => s + p[0], 0) / r.poly.length;
    const cy = r.poly.reduce((s, p) => s + p[1], 0) / r.poly.length;
    const px = tr.sx(cx);
    const py = tr.sy(cy);
    out.push(text(px, py - 1.4, r.name, { size: 3.4, bold: true, halo: true }));
    out.push(text(px, py + 1.6, `${num(area(r.poly), 1)} м²`, { size: 2.6, halo: true }));
    if (r.floor) out.push(text(px, py + 4.4, r.floor, { size: 2, fill: '#555', halo: true }));
    out.push(`<circle cx="${px.toFixed(2)}" cy="${(py - 7).toFixed(2)}" r="2.6" fill="#fff" stroke="#111" stroke-width="0.3"/>`);
    out.push(text(px, py - 6.1, String(i + 1), { size: 2.6, bold: true }));
  });

  /* --------------------------- размеры ------------------------------- */
  const vWalls = (spec.walls || []).filter((w) => Math.abs(w.x2 - w.x1) < 1).map((w) => w.x1);
  const hWalls = (spec.walls || []).filter((w) => Math.abs(w.y2 - w.y1) < 1).map((w) => w.y1);
  const b = tr.bbox;
  const bottom = Math.min(sheet.h - 16, tr.sy(b.maxY) + 12);
  const leftAt = Math.max(8, tr.sx(b.minX) - 12);
  if (vWalls.length >= 2) {
    out.push(dimChain([b.minX, ...vWalls, b.maxX], bottom, tr, 'h'));
    out.push(dimOverall(tr, bottom + 7, 'h'));
  }
  if (hWalls.length >= 2) {
    out.push(dimChain([b.minY, ...hWalls, b.maxY], leftAt, tr, 'v'));
    out.push(dimOverall(tr, leftAt - 8, 'v'));
  }

  /* ------------------------- экспликация ----------------------------- */
  if (rooms.length) {
    const x = sheet.area.x + sheet.area.w - legendW + 2;
    let y = sheet.area.y + 2;
    out.push(text(x, y, 'ЭКСПЛИКАЦИЯ ПОМЕЩЕНИЙ', { size: 2.6, anchor: 'start', bold: true }));
    y += 4;
    out.push(line(x, y, x + legendW - 4, y, 0.3));
    out.push(text(x, y - 0.6, '№', { size: 2, anchor: 'start' }));
    out.push(text(x + 6, y - 0.6, 'Наименование', { size: 2, anchor: 'start' }));
    out.push(text(x + legendW - 4, y - 0.6, 'Площадь', { size: 2, anchor: 'end' }));
    y += 4.2;
    rooms.forEach((r, i) => {
      out.push(text(x, y, String(i + 1), { size: 2.4, anchor: 'start' }));
      out.push(text(x + 6, y, `${r.name}${r.floor ? ', ' + r.floor : ''}`.slice(0, 30), { size: 2.4, anchor: 'start' }));
      out.push(text(x + legendW - 4, y, `${num(area(r.poly), 2)} м²`, { size: 2.4, anchor: 'end' }));
      y += 4.2;
    });
    out.push(line(x, y - 2.6, x + legendW - 4, y - 2.6, 0.2));
    const total = rooms.reduce((s, r) => s + area(r.poly), 0);
    out.push(text(x, y + 1, 'Итого', { size: 2.6, anchor: 'start', bold: true }));
    out.push(text(x + legendW - 4, y + 1, `${num(total, 2)} м²`, { size: 2.6, anchor: 'end', bold: true }));
  }

  /* ---------------- ведомость светильников (потолок) ----------------- */
  if (mode === 'ceiling' && (spec.lighting || []).length) {
    const x = sheet.area.x + sheet.area.w - legendW + 2;
    const y = sheet.area.y + 2 + 4.2 * (rooms.length + 2) + 10;
    const counts = (spec.lighting || []).reduce((m, l) => {
      const k = l.kind === 'line' ? 'LED-линия' : l.kind === 'chandelier' ? 'Люстра' : 'Точечный светильник';
      m[k] = (m[k] || 0) + 1;
      return m;
    }, {});
    out.push(text(x, y, 'СВЕТИЛЬНИКИ', { size: 2.6, anchor: 'start', bold: true }));
    out.push(line(x, y + 1.4, x + legendW - 4, y + 1.4, 0.3));
    Object.entries(counts).forEach(([k, n], i) => {
      out.push(text(x, y + 5.4 + i * 4.2, `${k}`, { size: 2.2, anchor: 'start' }));
      out.push(text(x + legendW - 4, y + 5.4 + i * 4.2, `${n} шт.`, { size: 2.2, anchor: 'end' }));
    });
  }

  /* --------------------------- примечания ---------------------------- */
  const notes =
    mode === 'floor'
      ? ['План полов. Штриховкой показаны покрытия и раскладка; размеры в мм.', 'Пороги и подложка уточняются по узлам.', 'Площади помещений — по внутреннему контуру.']
      : mode === 'ceiling'
        ? ['План потолка. Высоты указаны от чистого пола, размеры в мм.', 'Светильники привязаны к осям помещений.', 'Тип потолка и отступ от перекрытия — по ведомости.']
        : ['План расстановки мебели. Размеры в мм, масштаб 1:50.', 'Размеры мебели — габаритные, с учётом открывания дверей.', 'Площади — по внутреннему контуру помещений.'];
  out.push(frameAndNotes(sheet, notes));
  out.push(titleBlock(sheet, { ...spec, sheetName: { plan: 'План расстановки', floor: 'План полов', ceiling: 'План потолка' }[mode], scaleText: tr.scaleText }));
  out.push('</svg>');
  return { svg: out.join('\n'), scale: tr.scaleText, total: rooms.reduce((s, r) => s + area(r.poly), 0), tr };
}

function furnitureSvg(f, tr) {
  const def = CATALOG[f.kind] || CATALOG.sofa;
  const w = Number(f.w) || def[0];
  const d = Number(f.d) || def[1];
  const x = tr.sx(Number(f.x));
  const y = tr.sy(Number(f.y));
  const pw = w / tr.k;
  const pd = d / tr.k;
  const rot = Number(f.rot) || 0;
  const cx = x + pw / 2;
  const cy = y + pd / 2;
  const g = [];
  const kind = f.kind;
  const cat = def[4];
  const soft = cat === 'soft' || cat === 'sleep';
  g.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${pw.toFixed(2)}" height="${pd.toFixed(2)}" fill="${soft ? '#ffffff' : '#fbfbfb'}" stroke="#5b6167" stroke-width="0.28" rx="0.4"/>`);
  const inset = 0.9;
  if (cat === 'soft') {
    g.push(line(x + 0.4, y + inset, x + pw - 0.4, y + inset, 0.2));
    g.push(line(cx, y + inset, cx, y + pd - 0.5, 0.12));
  } else if (cat === 'sleep') {
    const pillow = Math.min(pd * 0.32, pw / 3);
    g.push(rectSvg({ x: x + 0.8, y: y + 0.6, w: pw / 2 - 1.3, h: pillow }, '#fff', '#7d848b', 0.2));
    g.push(rectSvg({ x: cx + 0.5, y: y + 0.6, w: pw / 2 - 1.3, h: pillow }, '#fff', '#7d848b', 0.2));
    g.push(line(x + 0.6, y + pillow + 1.6, x + pw - 0.6, y + pillow + 1.6, 0.15, '1 1'));
  } else if (kind === 'wc') {
    g.push(`<ellipse cx="${cx}" cy="${(y + pd * 0.62).toFixed(2)}" rx="${(pw * 0.28).toFixed(2)}" ry="${(pd * 0.24).toFixed(2)}" fill="#fff" stroke="#5b6167" stroke-width="0.22"/>`);
    g.push(rectSvg({ x: x + pw * 0.18, y: y + 0.5, w: pw * 0.64, h: pd * 0.2 }, '#f2f2f2', '#5b6167', 0.2));
  } else if (kind === 'bath') {
    g.push(rectSvg({ x: x + 0.7, y: y + 0.7, w: pw - 1.4, h: pd - 1.4 }, '#f6f9fb', '#7d848b', 0.2));
    g.push(`<circle cx="${(x + 1.6).toFixed(2)}" cy="${cy.toFixed(2)}" r="0.45" fill="none" stroke="#7d848b" stroke-width="0.15"/>`);
  } else if (kind === 'shower') {
    g.push(line(x + 0.6, y + 0.6, x + pw - 0.6, y + pd - 0.6, 0.15));
    g.push(line(x + pw - 0.6, y + 0.6, x + 0.6, y + pd - 0.6, 0.15));
    g.push(`<circle cx="${(x + pw / 2).toFixed(2)}" cy="${(y + 0.9).toFixed(2)}" r="0.5" fill="#cfd8de" stroke="#5b6167" stroke-width="0.15"/>`);
  } else if (kind === 'bath_sink' || kind === 'sink') {
    const rx = Math.min(pw * 0.36, 2.6);
    const ry = Math.min(pd * 0.3, 1.6);
    g.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx.toFixed(2)}" ry="${ry.toFixed(2)}" fill="#fff" stroke="#5b6167" stroke-width="0.22"/>`);
  } else if (kind === 'hob') {
    for (const [dx, dy] of [[-1, -0.9], [1, -0.9], [-1, 0.9], [1, 0.9]]) {
      g.push(`<circle cx="${(cx + dx).toFixed(2)}" cy="${(cy + dy).toFixed(2)}" r="0.9" fill="none" stroke="#5b6167" stroke-width="0.18"/>`);
    }
  } else if (kind === 'fridge') {
    g.push(line(x, y + pd * 0.62, x + pw, y + pd * 0.62, 0.2));
  } else if (kind === 'wardrobe' || kind === 'wardrobe_slide') {
    g.push(line(x, y + 1.1, x + pw, y + 1.1, 0.2));
    g.push(line(cx, y + 1.1, cx, y + pd, 0.15));
  } else if (kind === 'rug') {
    g.push(line(x + 0.6, y + 0.6, x + pw - 0.6, y + pd - 0.6, 0.12, '1 1'));
    g.push(line(x + pw - 0.6, y + 0.6, x + 0.6, y + pd - 0.6, 0.12, '1 1'));
  } else if (kind === 'plant') {
    g.push(`<circle cx="${cx}" cy="${cy}" r="${(pw * 0.32).toFixed(2)}" fill="#eef5ee" stroke="#6f8a72" stroke-width="0.2"/>`);
  } else if (kind === 'tv_wall' || kind === 'mirror') {
    g.push(rectSvg({ x: x + 0.5, y: y + pd * 0.2, w: pw - 1, h: pd * 0.6 }, '#e9eef3', '#7d848b', 0.15));
  } else if (kind === 'radiator') {
    for (let i = 1; i < 8; i++) g.push(line(x + (pw * i) / 8, y + 0.3, x + (pw * i) / 8, y + pd - 0.3, 0.15));
  } else if (kind === 'kitchen_counter') {
    g.push(line(x, y + 0.5, x + pw, y + 0.5, 0.12, '2 1'));
  }
  if (f.label !== false && !['rug', 'plant', 'door', 'tv_wall', 'mirror', 'radiator'].includes(kind)) {
    const label = fitText(f.name || def[3], pw - 1.6, 2);
    if (pw > 9) g.push(text(cx, cy + 0.8, label, { size: 2, fill: '#3d4349' }));
    if (pw > 18) g.push(text(cx, cy + 3.2, `${w}×${d}`, { size: 1.8, fill: '#6b7278' }));
  }
  return `<g transform="rotate(${rot} ${cx.toFixed(2)} ${cy.toFixed(2)})">${g.join('')}</g>`;
}

/* ------------------------------- CLI -------------------------------- */
if (process.argv[1] && process.argv[1].endsWith('plan.mjs')) {
  const [file, outArg] = process.argv.slice(2);
  if (!file) {
    console.error('Использование: node plan.mjs spec.json out.svg [--mode plan|floor|ceiling]');
    process.exit(2);
  }
  const eq = process.argv.find((a) => a.startsWith('--mode='));
  const idx = process.argv.indexOf('--mode');
  const mode = eq ? eq.slice(7) : idx > 0 && process.argv[idx + 1] ? process.argv[idx + 1] : 'plan';
  const spec = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''));
  const { svg, scale, total } = renderPlan(spec, mode);
  const out = path.resolve(outArg || file.replace(/\.json$/, `-${mode}.svg`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, svg, 'utf8');
  console.log(JSON.stringify({ out, mode, scale, totalArea: Number(total.toFixed(2)), bytes: Buffer.byteLength(svg), font: FONT.includes('Arial') }, null, 2));
}

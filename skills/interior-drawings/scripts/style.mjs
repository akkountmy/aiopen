#!/usr/bin/env node
/**
 * Лист «Палитра и материалы» — связка референса, спека и 3D.
 *
 * Это не декоративная картинка: цвета отсюда читает scene.mjs, а решения
 * (материалы, свет, чего избегаем) — человек. Референс встраивается в SVG
 * как data-URI, поэтому лист остаётся одним файлом и открывается офлайн.
 *
 *   node style.mjs design.json design/style.svg
 */
import fs from 'node:fs';
import path from 'node:path';
import { PAPER, FONT, esc } from './lib.mjs';

const [file, outArg] = process.argv.slice(2);
if (!file) {
  console.error('Использование: node style.mjs spec.json out.svg');
  process.exit(2);
}
const specPath = path.resolve(file);
const out = path.resolve(outArg || path.join('design', 'style.svg'));
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8').replace(/^\uFEFF/, ''));

const [PW, PH] = PAPER.A3;
const W = PW;
const H = PH;
const INK = '#1E1C19';
const MUTED = '#6F6A61';
const LINE = '#D8D1C5';
const PAPER_BG = '#F6F2EA';
const ACCENT = '#9B5B43';

const style = spec.style || {};
const P = {
  wall: '#E8E1D5', ceiling: '#F7F4EE', floor: '#C9A87C', accent: '#B5654A',
  textile: '#8C8577', wood: '#B98A5A', metal: '#9A9A96', stone: '#D8D2C6',
  ...(style.palette || {}),
};
const M = {
  floor: 'инженерная доска', walls: 'матовая краска', ceiling: 'натяжной, сатин',
  fronts: 'шпон дуба', textile: 'рогожка, лён', metal: 'брашированная сталь',
  ...(style.materials || {}),
};
const L = { mood: 'тёплый вечерний свет, 2700 K', kelvin: 2700, ...(style.lighting || {}) };
const rooms = Array.isArray(spec.rooms) ? spec.rooms : [];
const furniture = Array.isArray(spec.furniture) ? spec.furniture : [];
const styleName = style.name || 'Современный нейтральный';
const project = spec.project || 'Интерьер';
const object = spec.object || '';
const area = style.area || rooms.reduce((sum, r) => sum + Number(r.area || 0), 0);

function mm(x) { return Number(x).toFixed(2); }
function t(x, y, s, o = {}) {
  const size = o.size ?? 2.4;
  return `<text x="${mm(x)}" y="${mm(y)}" font-family="${FONT}" font-size="${size}" fill="${o.fill || INK}"${
    o.bold ? ' font-weight="700"' : ''
  }${o.italic ? ' font-style="italic"' : ''} text-anchor="${o.anchor || 'start'}"${
    o.spacing ? ` letter-spacing="${o.spacing}"` : ''
  }>${esc(s)}</text>`;
}
function wrap(s, width = 54, max = 3) {
  const words = String(s || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    if ((cur + ' ' + word).trim().length <= width) cur = (cur + ' ' + word).trim();
    else { if (cur) lines.push(cur); cur = word; }
    if (lines.length >= max) break;
  }
  if (cur && lines.length < max) lines.push(cur);
  if (words.join(' ').length > lines.join(' ').length && lines.length) lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) + '…';
  return lines;
}
function paragraph(s, x, y, o = {}) {
  const size = o.size ?? 2.2;
  const lh = o.lh ?? 3.4;
  return wrap(s, o.width ?? 54, o.max ?? 3)
    .map((line, i) => t(x, y + i * lh, line, { size, fill: o.fill || MUTED }))
    .join('');
}
function hair(x1, y1, x2, y2, color = LINE, w = 0.25) {
  return `<line x1="${mm(x1)}" y1="${mm(y1)}" x2="${mm(x2)}" y2="${mm(y2)}" stroke="${color}" stroke-width="${w}"/>`;
}

/* ---------- референс: встраиваем файл, если он рядом со спеком ---------- */
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
function referenceData() {
  const raw = String(style.reference || '').trim();
  if (!raw || /^https?:/i.test(raw) || raw.startsWith('data:')) return null;
  const candidates = [
    path.isAbsolute(raw) ? raw : path.resolve(path.dirname(specPath), raw),
    path.resolve(process.cwd(), raw),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
      const ext = path.extname(p).toLowerCase();
      if (!MIME[ext]) continue;
      const size = fs.statSync(p).size;
      if (size > 4.4 * 1024 * 1024) return { error: 'референс больше 4,4 МБ', name: path.basename(p) };
      return {
        name: path.basename(p),
        href: `data:${MIME[ext]};base64,${fs.readFileSync(p).toString('base64')}`,
      };
    } catch {
      /* пробуем следующий путь */
    }
  }
  return { error: 'файл референса не найден', name: raw };
}
const ref = referenceData();

/* ---------- палитра ---------- */
const PALETTE = [
  ['wall', 'Стены'], ['ceiling', 'Потолок'], ['floor', 'Пол'], ['wood', 'Дерево'],
  ['accent', 'Акцент'], ['textile', 'Текстиль'], ['metal', 'Металл'], ['stone', 'Камень'],
];

function paletteBlock(x, y) {
  const cw = 47;
  const ch = 30;
  let s = '';
  PALETTE.forEach(([key, label], i) => {
    const cx = x + (i % 4) * cw;
    const cy = y + Math.floor(i / 4) * ch;
    const color = P[key] || '#CCCCCC';
    s += `<rect x="${mm(cx)}" y="${mm(cy)}" width="42" height="19" rx="0.8" fill="${esc(color)}" stroke="${LINE}" stroke-width="0.22"/>`;
    s += t(cx, cy + 23.2, label, { size: 2.05, fill: INK });
    s += t(cx + 42, cy + 23.2, color.toUpperCase(), { size: 1.85, fill: MUTED, anchor: 'end' });
  });
  return s;
}

/* ---------- материалы ---------- */
const MAT_ROWS = [
  ['floor', 'Пол'], ['walls', 'Стены'], ['ceiling', 'Потолок'],
  ['fronts', 'Фасады'], ['textile', 'Текстиль'], ['metal', 'Металл'],
];
function materialsBlock(x, y) {
  let s = '';
  MAT_ROWS.forEach(([key, label], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const cx = x + col * 96;
    const cy = y + row * 12.2;
    s += `<circle cx="${mm(cx + 1.2)}" cy="${mm(cy - 1.1)}" r="1.15" fill="${esc(P[key === 'fronts' ? 'wood' : key] || P.wood)}"/>`;
    s += t(cx + 5, cy, label, { size: 2.05, bold: true });
    s += t(cx + 5, cy + 4.2, M[key] || '—', { size: 1.9, fill: MUTED });
  });
  return s;
}

/* ---------- нижний блок решений ---------- */
const defaults = [
  `Стены ${P.wall}, дерево ${P.wood}, акцент ${P.accent} — палитра держит взгляд на архитектуре, а не на декоре.`,
  `Материалы: ${M.floor}; ${M.walls}; ${M.fronts}.`,
  `Свет ${String(L.mood).toLowerCase()}${L.kelvin ? `, ${L.kelvin} K` : ''}; сценарии — общий, рабочий, акцентный.`,
  `Расстановка по факту плана: ${rooms.length} помещения, ${furniture.length} предметов; проходы не уже 700 мм.`,
];
const decisions = (Array.isArray(style.decisions) && style.decisions.length ? style.decisions : defaults).slice(0, 4);
function decisionsBlock(x, y, w) {
  let s = '';
  decisions.forEach((item, i) => {
    const cx = x + i * (w / 4);
    s += t(cx, y, String(i + 1).padStart(2, '0'), { size: 3.2, fill: ACCENT, bold: true });
    s += hair(cx, y + 3, cx + w / 4 - 7, y + 3, LINE, 0.25);
    s += paragraph(item, cx, y + 8, { width: 36, max: 4, size: 2.05, lh: 3.2 });
  });
  return s;
}

const avoid = (Array.isArray(style.avoid) && style.avoid.length ? style.avoid : [
  'холодный синий свет', 'мелкий декор без функции', 'разные оттенки белого', 'тяжёлые шторы в пол',
]).slice(0, 4);

/* ---------- компоновка A3 ---------- */
const X = 26;
const RIGHT = 394;
const TOP = 14;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`;
svg += `<rect width="${W}" height="${H}" fill="${PAPER_BG}"/>`;
svg += `<defs><clipPath id="refClip"><rect x="${X}" y="54" width="164" height="105" rx="1"/></clipPath></defs>`;
svg += `<rect x="5" y="5" width="${W - 25}" height="${H - 10}" fill="none" stroke="${INK}" stroke-width="0.7"/>`;

/* Шапка */
svg += t(X, TOP + 2, 'DSH OPEN · ДИЗАЙН-ПРОЕКТ', { size: 2.15, fill: ACCENT, bold: true, spacing: 0.9 });
svg += t(X, TOP + 11, project, { size: 8.2, bold: true });
svg += t(X, TOP + 18.5, styleName, { size: 4.1, fill: ACCENT });
const meta = [object, area ? `${area.toFixed(1)} м²` : '', `${rooms.length} помещения`, style.source === 'reference' ? 'по референсу' : 'по брифу'].filter(Boolean).join('  ·  ');
svg += t(X, TOP + 24.5, meta, { size: 2.2, fill: MUTED });
svg += t(RIGHT, TOP + 2, 'ЛИСТ 02 / 07', { size: 2.15, fill: MUTED, anchor: 'end', spacing: 0.6 });
svg += t(RIGHT, TOP + 11, 'ПАЛИТРА', { size: 7.2, bold: true, anchor: 'end' });
svg += t(RIGHT, TOP + 17, 'И МАТЕРИАЛЫ', { size: 7.2, bold: true, anchor: 'end' });
svg += hair(X, 46, RIGHT, 46, INK, 0.45);

/* Референс */
svg += t(X, 52, 'РЕФЕРЕНС', { size: 2.1, fill: ACCENT, bold: true, spacing: 0.8 });
if (ref && ref.href) {
  svg += `<image href="${ref.href}" x="${X}" y="54" width="164" height="105" preserveAspectRatio="xMidYMid slice" clip-path="url(#refClip)"/>`;
  svg += `<rect x="${X}" y="145" width="164" height="14" fill="rgba(20,18,15,.58)"/>`;
  svg += t(X + 4, 154.4, style.referenceName || ref.name, { size: 2.05, fill: '#fff' });
} else {
  /* нет файла — честный мудборд из палитры, а не пустая рамка */
  svg += `<rect x="${X}" y="54" width="164" height="105" fill="#EAE4D8" stroke="${LINE}" stroke-width="0.3"/>`;
  const keys = ['wall', 'floor', 'wood', 'accent', 'textile', 'stone'];
  keys.forEach((key, i) => {
    const cw = i < 3 ? 54.6 : 54.6;
    const cx = X + (i % 3) * cw;
    const cy = 54 + Math.floor(i / 3) * 52.5;
    svg += `<rect x="${mm(cx)}" y="${mm(cy)}" width="54.6" height="52.5" fill="${esc(P[key])}"/>`;
  });
  svg += `<rect x="${X}" y="145" width="164" height="14" fill="rgba(20,18,15,.58)"/>`;
  svg += t(X + 4, 154.4, ref?.error ? 'Референс: файл не найден — палитра из брифа' : 'Референс не приложен — палитра из брифа', { size: 1.95, fill: '#fff' });
}
svg += paragraph(style.summary || 'Палитра и материалы собраны из брифа и проверены на плане: цвета повторяются в отделке, мебели и свете, поэтому проект читается как одно целое.', X, 168, { width: 66, max: 5, size: 2.25, lh: 3.7, fill: INK });
svg += t(X, 190, 'ПРИНЦИП', { size: 2.1, fill: ACCENT, bold: true, spacing: 0.8 });
svg += paragraph('Три цвета держат пространство, четвёртый — акцент. Материалы выбираются по тактильности и износу: пол и фасады работают, текстиль смягчает, металл собирает линии.', X, 196, { width: 68, max: 4, size: 2.05, lh: 3.3 });

/* Палитра */
svg += t(202, 52, 'ПАЛИТРА', { size: 2.1, fill: ACCENT, bold: true, spacing: 0.8 });
svg += paletteBlock(202, 56);

/* Материалы */
svg += hair(202, 123, RIGHT, 123, LINE, 0.3);
svg += t(202, 129, 'МАТЕРИАЛЫ', { size: 2.1, fill: ACCENT, bold: true, spacing: 0.8 });
svg += materialsBlock(202, 136);

/* Свет */
svg += hair(202, 170, RIGHT, 170, LINE, 0.3);
svg += t(202, 176, 'СВЕТ', { size: 2.1, fill: ACCENT, bold: true, spacing: 0.8 });
svg += t(202, 182.5, L.mood || 'тёплый вечерний свет', { size: 2.5, bold: true });
svg += t(202, 188, `${L.kelvin || 2700} K · индекс цветопередачи Ra ≥ 90 · диммирование`, { size: 2.0, fill: MUTED });
const layers = Array.isArray(L.layers) && L.layers.length ? L.layers : ['общий верхний', 'рабочий у столешницы', 'акцентный и подсветка полок'];
svg += paragraph(layers.join(' · '), 202, 193, { width: 88, max: 2, size: 1.95, lh: 3.1 });

/* Решения */
svg += hair(X, 211, RIGHT, 211, INK, 0.4);
svg += t(X, 218, 'РЕШЕНИЯ', { size: 2.1, fill: ACCENT, bold: true, spacing: 0.8 });
svg += decisionsBlock(X, 222, 368);

/* Чего избегаем */
svg += hair(X, 247, 260, 247, LINE, 0.3);
svg += t(X, 253, 'ЧЕГО ИЗБЕГАЕМ', { size: 2.0, fill: MUTED, bold: true, spacing: 0.6 });
avoid.forEach((item, i) => {
  const cx = X + i * 58;
  svg += `<rect x="${mm(cx)}" y="256" width="54" height="7.2" rx="3.6" fill="#fff" stroke="${LINE}" stroke-width="0.25"/>`;
  const label = item.length > 30 ? item.slice(0, 29) + '…' : item;
  svg += t(cx + 27, 260.9, label, { size: 1.8, fill: MUTED, anchor: 'middle' });
});

/* Штамп */
const bx = W - 5 - 150;
const by = H - 5 - 45;
const rows = [
  ['Проект', project],
  ['Объект', object || '—'],
  ['Лист', 'Палитра и материалы'],
  ['Масштаб', 'образцы 1:1'],
];
const lh = 45 / (rows.length + 1);
svg += `<rect x="${bx}" y="${by}" width="150" height="45" fill="#fff" stroke="${INK}" stroke-width="0.5"/>`;
svg += hair(bx, by + lh, bx + 150, by + lh, INK, 0.3);
rows.forEach(([k, v], i) => {
  const yy = by + lh * (i + 1);
  if (i) svg += hair(bx, yy, bx + 150, yy, LINE, 0.2);
  svg += t(bx + 3, yy + lh / 2 + 0.9, k, { size: 2.0, fill: MUTED });
  const value = String(v).length > 62 ? String(v).slice(0, 61) + '…' : String(v);
  svg += t(bx + 30, yy + lh / 2 + 1, value, { size: 2.2, bold: true });
});
svg += t(bx + 3, by + lh / 2 + 1, `DSH · ${new Date().toISOString().slice(0, 10)}`, { size: 2.2, bold: true });
svg += t(bx + 147, by + lh / 2 + 1, 'Интерьер', { size: 2.0, fill: MUTED, anchor: 'end' });
svg += t(X, 286, 'Цвета на листе — те же HEX, что использует 3D-сцена. Печать: матовый картон, без лака.', { size: 1.8, fill: MUTED });
svg += `</svg>`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg, 'utf8');
console.log(JSON.stringify({
  svg: out,
  bytes: Buffer.byteLength(svg),
  style: styleName,
  source: style.source || 'fallback',
  reference: ref?.href ? ref.name : null,
  palette: Object.keys(P).length,
}, null, 2));

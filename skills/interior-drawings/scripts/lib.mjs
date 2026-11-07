/**
 * Общая библиотека интерьерных чертежей: формат листа, геометрия, каталог мебели,
 * размерные цепи, штамп. Миллиметры модели -> миллиметры бумаги (масштаб 1:50 / 1:100).
 * Без зависимостей, чистый SVG.
 */

export const PAPER = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
};

export const FONT = "'Arial Narrow','Arial','Helvetica Neue',sans-serif";

/** Экранирование текста для SVG. */
export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Русская запись числа: 14,2 без хвостовых нулей. */
export const num = (v, digits = 2) => {
  const s = Number(v).toFixed(digits).replace(/\.?0+$/, '');
  return s.replace('.', ',');
};

export const area = (poly) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2 / 1e6; // м²
};

/**
 * Трансформация модели (мм) в лист (мм бумаги).
 * Подбирает масштаб под свободное поле, центрирует; принудительный scale — из спецификации.
 */
export function makeTransform(spec, sheet) {
  const scale = Number(spec.scale) || 50;
  const pts = [];
  for (const w of spec.walls || []) {
    const t = (w.t ?? 150) / 2;
    pts.push([w.x1 - t, w.y1 - t], [w.x2 + t, w.y2 + t], [w.x1 - t, w.y2 + t], [w.x2 + t, w.y1 - t]);
  }
  for (const f of spec.furniture || []) pts.push([f.x, f.y], [f.x + (f.w || 0), f.y + (f.d || 0)]);
  if (!pts.length) pts.push([0, 0], [1000, 1000]);
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxY = Math.max(...pts.map((p) => p[1]));
  const mw = maxX - minX || 1000;
  const mh = maxY - minY || 1000;
  const { x: x0, y: y0, w: availW, h: availH } = sheet.area;
  // k — сколько мм модели приходится на 1 мм бумаги; меньше 1:50 нельзя, если не влезает — крупнее
  const k = Math.max(scale, mw / availW, mh / availH);
  const pw = mw / k;
  const ph = mh / k;
  const ox = x0 + (availW - pw) / 2 - minX / k;
  const oy = y0 + (availH - ph) / 2 - minY / k;
  return {
    k,
    scaleText: k >= 99.5 ? '1:100' : k >= 49.5 ? '1:50' : k >= 24.5 ? '1:25' : `1:${Math.round(k)}`,
    sx: (x) => ox + x / k,
    sy: (y) => oy + y / k,
    /** Толщина линии, мм бумаги, не тоньше 0,18. */
    lw: (modelMm) => Math.max(0.18, modelMm / k),
    bbox: { minX, minY, maxX, maxY },
  };
}

/** Лист: рамка по ГОСТ 2.301 (20 мм слева, 5 мм с остальных), место под штамп. */
export function sheetFor(spec) {
  const [pw, ph] = PAPER[spec.paper] || PAPER.A3;
  const landscape = (spec.orientation || 'landscape') === 'landscape';
  const w = landscape ? pw : ph;
  const h = landscape ? ph : pw;
  const left = 20;
  const margin = 5;
  const block = { w: 150, h: 45 }; // место под штамп
  return {
    w,
    h,
    orientation: landscape ? 'landscape' : 'portrait',
    frame: { x: left, y: margin, w: w - left - margin, h: h - 2 * margin },
    block: { x: w - margin - block.w, y: h - margin - block.h, w: block.w, h: block.h },
    area: { x: left + 6, y: margin + 6, w: w - left - margin - 12, h: h - 2 * margin - block.h - 10 },
  };
}

/* Белый лист — часть самого SVG, а не оформление окна. Иначе прозрачные
   участки плана на тёмном фоне выглядят «чёрными дырами», а при печати
   подложку приходится добавлять вручную. */
export const svgOpen = (sheet) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.w}mm" height="${sheet.h}mm" viewBox="0 0 ${sheet.w} ${sheet.h}">` +
  `<rect x="0" y="0" width="${sheet.w}" height="${sheet.h}" fill="#ffffff"/>`;

export function defs() {
  return `<defs>
  <pattern id="hatch-tile" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="3" stroke="#b9c0c8" stroke-width="0.25"/>
  </pattern>
  <pattern id="hatch-wood" width="4" height="4" patternUnits="userSpaceOnUse">
    <line x1="0" y1="0" x2="4" y2="0" stroke="#c9b79c" stroke-width="0.35"/>
  </pattern>
  <pattern id="hatch-gypsum" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
    <line x1="0" y1="0" x2="0" y2="3" stroke="#8a939c" stroke-width="0.3"/>
  </pattern>
  <pattern id="hatch-insulation" width="5" height="5" patternUnits="userSpaceOnUse">
    <path d="M0 0 Q2.5 2.5 0 5 M5 0 Q2.5 2.5 5 5" fill="none" stroke="#9aa4ad" stroke-width="0.2"/>
  </pattern>
</defs>`;
}

/** Текст по центру с базовой линией. */
export function text(x, y, s, o = {}) {
  const size = o.size ?? 2.5;
  const halo = o.halo ? ` stroke="#fff" stroke-width="${(size * 0.42).toFixed(2)}" paint-order="stroke" stroke-linejoin="round"` : '';
  return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-family="${FONT}" font-size="${size}"${
    o.bold ? ' font-weight="700"' : ''
  } fill="${o.fill || '#111'}" text-anchor="${o.anchor || 'middle'}"${halo}${
    o.rotate ? ` transform="rotate(${o.rotate} ${x.toFixed(2)} ${y.toFixed(2)})"` : ''
  }${o.letter ? ` letter-spacing="${o.letter}"` : ''}>${esc(s)}</text>`;
}

/** Обрезка подписи по доступной ширине (мм бумаги), чтобы текст не вылезал из мебели. */
export function fitText(s, widthMm, size = 2) {
  const per = size * 0.52;
  const max = Math.max(2, Math.floor(widthMm / per));
  return s.length <= max ? s : s.slice(0, Math.max(2, max - 1)).trimEnd() + '…';
}

export const line = (x1, y1, x2, y2, sw = 0.2, dash = '') =>
  `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#111" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

/** Прямоугольник стены (отрезок с толщиной t), работаем в модели. */
export function wallRect(w, tr) {
  const t = w.t ?? 150;
  const x1 = tr.sx(w.x1);
  const y1 = tr.sy(w.y1);
  const x2 = tr.sx(w.x2);
  const y2 = tr.sy(w.y2);
  const th = t / tr.k;
  if (Math.abs(w.y2 - w.y1) < 1) {
    const x = Math.min(x1, x2);
    return { x, y: y1 - th / 2, w: Math.abs(x2 - x1), h: th, dir: 'h' };
  }
  if (Math.abs(w.x2 - w.x1) < 1) {
    const y = Math.min(y1, y2);
    return { x: x1 - th / 2, y, w: th, h: Math.abs(y2 - y1), dir: 'v' };
  }
  // диагональ: полигон со смещением по нормали
  const dx = w.x2 - w.x1;
  const dy = w.y2 - w.y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (t / 2);
  const ny = (dx / len) * (t / 2);
  const p = [
    [w.x1 + nx, w.y1 + ny],
    [w.x2 + nx, w.y2 + ny],
    [w.x2 - nx, w.y2 - ny],
    [w.x1 - nx, w.y1 - ny],
  ].map(([x, y]) => `${tr.sx(x).toFixed(2)},${tr.sy(y).toFixed(2)}`);
  return { points: p.join(' '), dir: 'd' };
}

export const rectSvg = (r, fill, stroke, sw = 0.25) =>
  `<rect x="${r.x.toFixed(2)}" y="${r.y.toFixed(2)}" width="${r.w.toFixed(2)}" height="${r.h.toFixed(2)}" fill="${fill}"${
    stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''
  }/>`;

/* --------------------------- каталог мебели --------------------------- */

/** kind: [ширина, глубина, высота, подпись, категория] — мм, типовые размеры. */
export const CATALOG = {
  sofa: [2200, 900, 850, 'Диван 3-местный', 'soft'],
  sofa_small: [1600, 900, 850, 'Диван 2-местный', 'soft'],
  sofa_corner: [2600, 1800, 850, 'Диван угловой', 'soft'],
  armchair: [800, 850, 780, 'Кресло', 'soft'],
  bed_single: [900, 2000, 500, 'Кровать 90×200', 'sleep'],
  bed_double: [1600, 2000, 500, 'Кровать 160×200', 'sleep'],
  bed_king: [1800, 2000, 500, 'Кровать 180×200', 'sleep'],
  nightstand: [450, 400, 550, 'Тумба прикроватная', 'storage'],
  wardrobe: [1200, 600, 2400, 'Шкаф 2-дверный', 'storage'],
  wardrobe_slide: [1800, 650, 2400, 'Шкаф-купе', 'storage'],
  dresser: [800, 450, 900, 'Комод', 'storage'],
  shelf: [800, 300, 1800, 'Стеллаж', 'storage'],
  bookshelf: [600, 300, 2000, 'Книжный шкаф', 'storage'],
  desk: [1400, 700, 750, 'Стол письменный', 'work'],
  desk_small: [1000, 600, 750, 'Стол письменный', 'work'],
  chair: [450, 450, 900, 'Стул', 'work'],
  office_chair: [600, 600, 1200, 'Кресло офисное', 'work'],
  dining_table: [1400, 800, 750, 'Стол обеденный', 'dining'],
  dining_table_big: [1800, 900, 750, 'Стол обеденный', 'dining'],
  round_table: [1100, 1100, 750, 'Стол круглый Ø1100', 'dining'],
  kitchen_counter: [3000, 600, 900, 'Кухонный фронт', 'kitchen'],
  sink: [800, 600, 900, 'Мойка', 'kitchen'],
  hob: [600, 500, 900, 'Варочная панель', 'kitchen'],
  fridge: [700, 700, 1900, 'Холодильник', 'kitchen'],
  dishwasher: [600, 600, 850, 'ПММ', 'kitchen'],
  washer: [600, 600, 850, 'Стиральная машина', 'kitchen'],
  wc: [400, 700, 800, 'Унитаз', 'bath'],
  bidet: [400, 600, 400, 'Биде', 'bath'],
  bath: [1700, 750, 550, 'Ванна', 'bath'],
  shower: [900, 900, 2100, 'Душевая', 'bath'],
  bath_sink: [600, 450, 850, 'Раковина', 'bath'],
  tv_stand: [1600, 400, 500, 'ТВ-тумба', 'media'],
  tv_wall: [1200, 60, 700, 'ТВ настенный', 'media'],
  coffee_table: [1100, 600, 420, 'Журнальный стол', 'dining'],
  rug: [2000, 1500, 10, 'Ковёр', 'decor'],
  plant: [500, 500, 1200, 'Растение', 'decor'],
  mirror: [800, 40, 1800, 'Зеркало', 'decor'],
  piano: [1500, 650, 1200, 'Пианино', 'decor'],
  door: [900, 150, 2100, 'Дверь', 'build'],
  radiator: [800, 120, 600, 'Радиатор', 'build'],
};

export function furniture(kind, tr) {
  const def = CATALOG[kind];
  if (!def) throw new Error(`неизвестная мебель: ${kind}`);
  return { w: def[0], d: def[1], h: def[2], label: def[3] };
}

/* --------------------------- размерные цепи --------------------------- */

/**
 * Размерная цепь по координатам модели.
 * dir 'h' — вдоль X (замер по Y), 'v' — вдоль Y (замер по X).
 */
export function dimChain(coords, at, tr, dir = 'h', opt = {}) {
  const xs = [...new Set(coords.map((c) => Math.round(c)))].sort((a, b) => a - b);
  const parts = [];
  const sw = 0.18;
  const size = opt.size ?? 2.2;
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i];
    const b = xs[i + 1];
    if (b - a < 500) continue;
    if (dir === 'h') {
      const x1 = tr.sx(a);
      const x2 = tr.sx(b);
      const y = at;
      parts.push(line(x1, y, x2, y, sw));
      parts.push(line(x1, y - 1.2, x1, y + 1.2, sw));
      parts.push(line(x2, y - 1.2, x2, y + 1.2, sw));
      parts.push(text((x1 + x2) / 2, y - 1.1, num(b - a, 0), { size, anchor: 'middle' }));
    } else {
      const y1 = tr.sy(a);
      const y2 = tr.sy(b);
      const x = at;
      parts.push(line(x, y1, x, y2, sw));
      parts.push(line(x - 1.2, y1, x + 1.2, y1, sw));
      parts.push(line(x - 1.2, y2, x + 1.2, y2, sw));
      parts.push(text(x - 1.1, (y1 + y2) / 2 + size / 3, num(b - a, 0), { size, rotate: -90 }));
    }
  }
  return parts.join('\n');
}

/** Выноска-размер по внешнему контуру: общий габарит. */
export function dimOverall(tr, at, dir, size = 2.4) {
  const b = tr.bbox;
  if (dir === 'h') {
    const x1 = tr.sx(b.minX);
    const x2 = tr.sx(b.maxX);
    return line(x1, at, x2, at, 0.18) + text((x1 + x2) / 2, at - 1.2, num(b.maxX - b.minX, 0), { size, bold: true });
  }
  const y1 = tr.sy(b.minY);
  const y2 = tr.sy(b.maxY);
  return line(at, y1, at, y2, 0.18) + text(at - 1.2, (y1 + y2) / 2, num(b.maxY - b.minY, 0), { size, bold: true, rotate: -90 });
}

/* ------------------------------- штамп ------------------------------- */

export function titleBlock(sheet, o) {
  const b = sheet.block;
  const x = b.x;
  const y = b.y;
  const rows = [
    ['Проект', o.project || 'Интерьер'],
    ['Объект', o.object || ''],
    ['Лист', o.sheetName || 'План'],
    ['Масштаб', o.scaleText || '1:50'],
  ];
  const lh = b.h / (rows.length + 1);
  let s = `<g id="stamp">`;
  s += `<rect x="${x}" y="${y}" width="${b.w}" height="${b.h}" fill="#fff" stroke="#111" stroke-width="0.5"/>`;
  s += line(x, y + lh, x + b.w, y + lh, 0.35);
  rows.forEach(([k, v], i) => {
    const yy = y + lh * (i + 1);
    if (i) s += line(x, yy, x + b.w, yy, 0.2);
    s += text(x + 3, yy + lh / 2 + 0.9, k, { size: 2.2, anchor: 'start', fill: '#555' });
    s += text(x + 32, yy + lh / 2 + 1, v, { size: 2.6, anchor: 'start', bold: true });
  });
  s += text(x + 3, y + lh / 2 + 1.1, `DSH · ${o.date || new Date().toISOString().slice(0, 10)}`, {
    size: 2.6,
    anchor: 'start',
    bold: true,
  });
  s += text(x + b.w - 3, y + lh / 2 + 1, 'Интерьер', { size: 2.2, anchor: 'end', fill: '#555' });
  s += `</g>`;
  return s;
}

export function frameAndNotes(sheet, notes = []) {
  const f = sheet.frame;
  let s = `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" fill="none" stroke="#111" stroke-width="0.8"/>`;
  if (!notes.length) return s;
  const x = sheet.area.x;
  const y = sheet.h - 8;
  notes.forEach((n, i) => {
    s += text(x, y + i * 4, n, { size: 2.1, anchor: 'start', fill: '#333' });
  });
  return s;
}

export const HEAD = 'не пустой';

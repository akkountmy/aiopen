/**
 * Генератор PDF без внешних зависимостей.
 *
 * PDF собирается вручную: страницы, текст и линии пишутся в поток контента, шрифты
 * (подмножества DejaVu Sans c кириллицей) встраиваются как CIDFontType2 с
 * кодировкой Identity-H. Так текст остаётся текстом: его можно выделить, скопировать
 * и извлечь поиском, а файл не зависит от шрифтов на компьютере читателя.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.resolve(HERE, '..', 'assets', 'fonts');
const REGULAR_FILE = 'DejaVuSans.subset.ttf';
const BOLD_FILE = 'DejaVuSans-Bold.subset.ttf';

const INK = '#1b1c21';
const MUTED = '#6b6d76';
const HAIRLINE = '#e2e2e8';
const ACCENT = '#d4564a';

const PAGE = {
  slide: { width: 960, height: 540 },
  document: { width: 595.28, height: 841.89 },
};

/* ───────────────────────────── шрифты ───────────────────────────── */

function readTables(buf) {
  const count = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < count; i += 1) {
    const base = 12 + i * 16;
    const tag = buf.toString('latin1', base, base + 4);
    tables[tag] = { offset: buf.readUInt32BE(base + 8), length: buf.readUInt32BE(base + 12) };
  }
  return tables;
}

/** Разбор cmap (формат 4 и 12) в карту «код символа → номер глифа». */
function readCmap(buf, cmap) {
  const map = new Map();
  const count = buf.readUInt16BE(cmap.offset + 2);
  const subtables = [];
  for (let i = 0; i < count; i += 1) {
    const base = cmap.offset + 4 + i * 8;
    const platform = buf.readUInt16BE(base);
    const encoding = buf.readUInt16BE(base + 2);
    const offset = cmap.offset + buf.readUInt32BE(base + 4);
    subtables.push({ platform, encoding, offset });
  }
  const preferred = [
    ...subtables.filter((s) => s.platform === 3 && s.encoding === 10),
    ...subtables.filter((s) => s.platform === 3 && s.encoding === 1),
    ...subtables.filter((s) => s.platform === 0),
    ...subtables,
  ];

  for (const table of preferred) {
    const format = buf.readUInt16BE(table.offset);
    if (format === 4) {
      const segCountX2 = buf.readUInt16BE(table.offset + 6);
      const segCount = segCountX2 / 2;
      const endBase = table.offset + 14;
      const startBase = endBase + segCountX2 + 2;
      const deltaBase = startBase + segCountX2;
      const rangeBase = deltaBase + segCountX2;
      for (let seg = 0; seg < segCount; seg += 1) {
        const end = buf.readUInt16BE(endBase + seg * 2);
        const start = buf.readUInt16BE(startBase + seg * 2);
        const delta = buf.readInt16BE(deltaBase + seg * 2);
        const rangeOffset = buf.readUInt16BE(rangeBase + seg * 2);
        if (start === 0xffff) continue;
        for (let code = start; code <= end; code += 1) {
          let gid;
          if (rangeOffset === 0) {
            gid = (code + delta) & 0xffff;
          } else {
            const address = rangeBase + seg * 2 + rangeOffset + (code - start) * 2;
            if (address + 1 >= buf.length) continue;
            gid = buf.readUInt16BE(address);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid) map.set(code, gid);
        }
      }
      if (map.size) return map;
      continue;
    }
    if (format === 12) {
      const groups = buf.readUInt32BE(table.offset + 12);
      for (let g = 0; g < groups; g += 1) {
        const base = table.offset + 16 + g * 12;
        const start = buf.readUInt32BE(base);
        const end = buf.readUInt32BE(base + 4);
        const firstGid = buf.readUInt32BE(base + 8);
        for (let code = start; code <= end && code <= 0x10ffff; code += 1) {
          map.set(code, firstGid + (code - start));
        }
      }
      if (map.size) return map;
    }
  }
  return map;
}

/** Табличные метрики шрифта: размеры, ширины глифов, соответствие символов глифам. */
function readFace(bytes) {
  const tables = readTables(bytes);
  const head = tables.head?.offset ?? 0;
  const hhea = tables.hhea?.offset ?? 0;
  const maxp = tables.maxp?.offset ?? 0;
  const os2 = tables['OS/2']?.offset ?? 0;
  const unitsPerEm = bytes.readUInt16BE(head + 18) || 1000;
  const xMin = bytes.readInt16BE(head + 36);
  const yMin = bytes.readInt16BE(head + 38);
  const xMax = bytes.readInt16BE(head + 40);
  const yMax = bytes.readInt16BE(head + 42);
  const numGlyphs = bytes.readUInt16BE(maxp + 4);
  const numberOfHMetrics = bytes.readUInt16BE(hhea + 34);
  const hmtx = tables.hmtx?.offset ?? 0;
  const widths = new Uint16Array(numGlyphs);
  let last = 0;
  for (let gid = 0; gid < numGlyphs; gid += 1) {
    if (gid < numberOfHMetrics) last = bytes.readUInt16BE(hmtx + gid * 4);
    widths[gid] = last;
  }
  let ascent = 0;
  let descent = 0;
  let capHeight = 0;
  if (os2) {
    const version = bytes.readUInt16BE(os2);
    ascent = bytes.readInt16BE(os2 + 68);
    descent = bytes.readInt16BE(os2 + 70);
    if (version >= 2) capHeight = bytes.readInt16BE(os2 + 88);
  }
  if (!ascent) ascent = Math.round(unitsPerEm * 0.8);
  if (!descent) descent = -Math.round(unitsPerEm * 0.2);
  if (!capHeight) capHeight = Math.round(ascent * 0.72);
  const cmapTable = tables.cmap;
  const map = cmapTable ? readCmap(bytes, cmapTable) : new Map();
  const reverse = new Map();
  for (const [code, gid] of map) if (!reverse.has(gid)) reverse.set(gid, code);
  return { bytes, unitsPerEm, ascent, descent, capHeight, numGlyphs, widths, map, reverse, bbox: [xMin, yMin, xMax, yMax] };
}

const faceCache = new Map();
function loadFace(file) {
  if (!faceCache.has(file)) {
    const bytes = fs.readFileSync(path.join(FONT_DIR, file));
    faceCache.set(file, readFace(bytes));
  }
  return faceCache.get(file);
}

const FALLBACKS = new Map([
  [0x00a0, ' '],
  [0x2009, ' '],
  [0x200a, ' '],
  [0x202f, ' '],
  [0x200b, ''],
  [0x2212, '-'],
  [0x2217, '*'],
]);

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** Строка → номера глифов; символы вне подмножества заменяются на безопасные. */
function toGlyphs(face, text) {
  const glyphs = [];
  for (const char of text) {
    let code = char.codePointAt(0);
    if (code < 0x20) code = 0x20;
    let gid = face.map.get(code);
    if (!gid) {
      const replacement = FALLBACKS.get(code);
      if (replacement !== undefined) {
        const alt = replacement.codePointAt(0);
        gid = alt !== undefined ? face.map.get(alt) : undefined;
      }
    }
    if (!gid) gid = face.map.get(0x3f) || 0;
    glyphs.push(gid);
  }
  return glyphs;
}

class PdfFont {
  constructor(face, name) {
    this.face = face;
    this.name = name;
  }

  width(text, size) {
    const { unitsPerEm, widths } = this.face;
    let units = 0;
    for (const gid of toGlyphs(this.face, text)) units += widths[gid] || 0;
    return (units / unitsPerEm) * size;
  }

  hex(text) {
    const glyphs = toGlyphs(this.face, text);
    const buf = Buffer.alloc(glyphs.length * 2);
    glyphs.forEach((gid, index) => buf.writeUInt16BE(gid, index * 2));
    return buf.toString('hex').toUpperCase();
  }

  lineHeight(size) {
    return (this.face.ascent - this.face.descent) / this.face.unitsPerEm * size;
  }

  baseline(size) {
    return (this.face.ascent / this.face.unitsPerEm) * size;
  }
}

/* ───────────────────────────── холст ───────────────────────────── */

function color(value) {
  const hex = String(value || '#000000').replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const num = Number.parseInt(full, 16);
  const r = ((num >> 16) & 0xff) / 255;
  const g = ((num >> 8) & 0xff) / 255;
  const b = (num & 0xff) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
}

const round = (value) => Math.round(value * 100) / 100;

/** Полотно страницы: координаты сверху-слева, как в вёрстке. */
class Canvas {
  constructor(width, height, fonts, used) {
    this.width = width;
    this.height = height;
    this.fonts = fonts;
    this.used = used;
    this.ops = [];
  }

  fill(x, y, w, h, fill) {
    this.ops.push(`${color(fill)} rg`, `${round(x)} ${round(this.height - y - h)} ${round(w)} ${round(h)} re f`);
  }

  line(x1, y1, x2, y2, { stroke = HAIRLINE, width = 1 } = {}) {
    this.ops.push(
      `${color(stroke)} RG`,
      `${round(width)} w`,
      `${round(x1)} ${round(this.height - y1)} m`,
      `${round(x2)} ${round(this.height - y2)} l`,
      'S',
    );
  }

  text(value, x, y, { font = 'regular', size = 12, fill = INK, spacing = 0, align = 'left' } = {}) {
    const face = font === 'bold' ? this.fonts.bold : this.fonts.regular;
    const text = normalizeText(value);
    if (!text) return 0;
    const width = face.width(text, size);
    let left = x;
    if (align === 'right') left = x - width;
    if (align === 'center') left = x - width / 2;
    const baseline = this.height - y - face.baseline(size);
    const usedSet = font === 'bold' ? this.used.bold : this.used.regular;
    for (const gid of toGlyphs(face.face, text)) usedSet.add(gid);
    const ops = [`${color(fill)} rg`, 'BT', `/${font === 'bold' ? 'F2' : 'F1'} ${round(size)} Tf`];
    if (spacing) ops.push(`${round(spacing)} Tc`);
    ops.push(`1 0 0 1 ${round(left)} ${round(baseline)} Tm`, `<${face.hex(text)}> Tj`);
    if (spacing) ops.push('0 Tc');
    ops.push('ET');
    this.ops.push(...ops);
    return width;
  }

  /** Разбиение строки по ширине — основа вёрстки абзацев и списков. */
  wrap(value, font, size, maxWidth) {
    const face = font === 'bold' ? this.fonts.bold : this.fonts.regular;
    const words = normalizeText(value).split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (face.width(candidate, size) <= maxWidth || !current) {
        current = candidate;
        continue;
      }
      lines.push(current);
      current = word;
    }
    if (current) lines.push(current);
    return lines;
  }

  toStream() {
    return this.ops.join('\n');
  }
}

/* ───────────────────────────── запись PDF ───────────────────────────── */

function streamObject(dict, data) {
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  const compressed = zlib.deflateSync(raw);
  return { dict: { ...dict, Length: compressed.length, Filter: '/FlateDecode' }, stream: compressed };
}

function pdfString(value) {
  const bytes = Buffer.from(String(value), 'utf16le');
  const swapped = Buffer.from(bytes);
  swapped.swap16();
  return `<FEFF${swapped.toString('hex').toUpperCase()}>`;
}

function writePdf(objects, info) {
  const chunks = [];
  let offset = 0;
  const push = (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    chunks.push(buf);
    offset += buf.length;
  };

  push('%PDF-1.7\n');
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(offset);
    const dict = `<< ${Object.entries(object.dict)
      .map(([key, value]) => (key === 'Filter' || key === 'Length' ? `/${key} ${value}` : `/${key} ${value}`))
      .join(' ')} >>`;
    push(`${index + 1} 0 obj\n${dict}\n`);
    if (object.stream) {
      push('stream\n');
      push(object.stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  });

  const xrefOffset = offset;
  const total = objects.length + 1;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (const position of offsets) xref += `${String(position).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${total} /Root ${info.root} 0 R /Info ${info.info} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/* ───────────────────────────── типографика слайдов ───────────────────────────── */

const SLIDE_LAYOUT = {
  margin: 64,
  accentBar: 7,
};

function buildSlideDeck({ title, subtitle, kicker, slides, cover }) {
  const fonts = {
    regular: new PdfFont(loadFace(REGULAR_FILE), 'regular'),
    bold: new PdfFont(loadFace(BOLD_FILE), 'bold'),
  };
  const used = { regular: new Set(), bold: new Set() };
  const { width, height } = PAGE.slide;
  const pages = [];
  const margin = SLIDE_LAYOUT.margin;
  const contentWidth = width - margin * 2;
  const deckTitle = normalizeText(title).trim();

  /**
   * Подбор размера пунктов: уменьшаем кегль, пока все пункты не влезут в отведённую
   * высоту. Возвращает и признак `fits` — если даже минимальный кегль не помогает,
   * хвост пунктов уходит на следующую страницу.
   */
  const fitBullets = (bullets, available) => {
    const measure = (size) => {
      const lineGap = size * 1.42;
      const itemGap = size * 0.85;
      const lines = bullets.map((bullet) => fitWrap(bullet, 'regular', size, contentWidth - 26));
      const total = lines.reduce((sum, item) => sum + item.length * lineGap + itemGap, 0);
      return { size, lineGap, itemGap, lines, total };
    };
    let best = null;
    for (const size of [21, 20, 19, 18, 17, 16, 15, 14, 13, 12]) {
      const candidate = measure(size);
      if (candidate.total <= available) return { ...candidate, fits: true };
      best = candidate;
    }
    return { ...best, fits: false };
  };

  const canvas = () => {
    const page = new Canvas(width, height, fonts, used);
    page.fill(0, 0, width, height, '#ffffff');
    return page;
  };

  const fitWrap = (value, font, size, maxWidth) => canvasWrap(fonts, used, value, font, size, maxWidth);

  const footer = (page, index, total) => {
    page.text(`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, width - margin, height - 40, {
      size: 9,
      fill: MUTED,
      align: 'right',
    });
  };

  /* надзаголовок страницы: у слайда свой подзаголовок-ярлык, иначе — название колоды */
  const headerLabel = ((kicker || '').trim() || deckTitle).toUpperCase();

  /* ── титульный слайд: только если попросили обложку или кроме заголовка слайдов нет ── */
  if (cover || !slides.length) {
    const page = canvas();
    page.fill(0, 0, SLIDE_LAYOUT.accentBar, height, ACCENT);
    const topKicker = (kicker || '').trim();
    let y = 118;
    if (topKicker) {
      page.text(topKicker.toUpperCase(), margin, y, { size: 12, fill: ACCENT, spacing: 2.2 });
      y += 40;
    }
    const titleSize = deckTitle.length > 60 ? 42 : 50;
    const titleLines = fitWrap(deckTitle, 'bold', titleSize, contentWidth - 40).slice(0, 3);
    for (const line of titleLines) {
      page.text(line, margin, y, { font: 'bold', size: titleSize, fill: INK });
      y += titleSize * 1.18;
    }
    y += 10;
    page.line(margin, y, margin + 120, y, { stroke: ACCENT, width: 4 });
    y += 26;
    const sub = normalizeText(subtitle).trim();
    if (sub) {
      for (const line of fitWrap(sub, 'regular', 21, contentWidth - 80).slice(0, 3)) {
        page.text(line, margin, y, { size: 21, fill: MUTED });
        y += 21 * 1.45;
      }
    }
    pages.push(page);
  }

  /* ── слайды с содержимым ── */
  slides.forEach((slide, slideIndex) => {
    let remaining = (slide.bullets || []).map((b) => normalizeText(b).trim()).filter(Boolean);
    let paragraphs = (slide.paragraphs || []).map((p) => normalizeText(p).trim()).filter(Boolean);
    const note = normalizeText(slide.note || '').trim();
    const slideTitle = normalizeText(slide.title || `Слайд ${slideIndex + 2}`).trim();
    let continuation = false;

    for (;;) {
      const page = canvas();
      page.fill(0, 0, SLIDE_LAYOUT.accentBar, height, ACCENT);

      /* шапка: надзаголовок, заголовок, волосяная линия */
      page.text(headerLabel, margin, 44, { size: 9, fill: MUTED, spacing: 1.1 });
      let y = 78;
      const titleSize = slideTitle.length > 54 ? 28 : slideTitle.length > 34 ? 32 : 36;
      for (const line of fitWrap(slideTitle, 'bold', titleSize, contentWidth).slice(0, 2)) {
        page.text(line, margin, y, { font: 'bold', size: titleSize, fill: INK });
        y += titleSize * 1.16;
      }
      y += 12;
      page.line(margin, y, width - margin, y, { stroke: HAIRLINE, width: 0.8 });
      const bodyTop = y + 30;
      const available = height - 82 - bodyTop;

      let usedHeight = 0;
      for (const paragraph of paragraphs) {
        const lines = fitWrap(paragraph, 'regular', 16, contentWidth);
        for (const line of lines) {
          if (usedHeight + 16 * 1.5 > available) break;
          page.text(line, margin, bodyTop + usedHeight, { size: 16, fill: MUTED });
          usedHeight += 16 * 1.5;
        }
        usedHeight += 8;
      }
      paragraphs = [];
      if (usedHeight) usedHeight += 14;

      if (remaining.length) {
        /* сначала пробуем вписать все пункты целиком */
        let fitted = fitBullets(remaining, available - usedHeight);
        if (!fitted.fits) {
          /* не влезает — показываем столько пунктов, сколько помещается при мелком кегле */
          const size = 13;
          const lineGap = size * 1.42;
          const itemGap = size * 0.85;
          let count = 0;
          let heightSoFar = 0;
          for (const bullet of remaining) {
            const lines = fitWrap(bullet, 'regular', size, contentWidth - 26);
            const block = lines.length * lineGap + itemGap;
            if (count > 0 && heightSoFar + block > available - usedHeight) break;
            heightSoFar += block;
            count += 1;
            if (heightSoFar > available - usedHeight) break;
          }
          count = Math.max(1, count);
          fitted = fitBullets(remaining.slice(0, count), available - usedHeight);
          remaining = remaining.slice(count);
        } else {
          remaining = [];
        }
        for (const lines of fitted.lines) {
          page.fill(margin + 2, bodyTop + usedHeight + fitted.size * 0.42, 5, 5, ACCENT);
          for (const [lineIndex, line] of lines.entries()) {
            page.text(line, margin + 26, bodyTop + usedHeight + lineIndex * fitted.lineGap, { size: fitted.size, fill: INK });
          }
          usedHeight += lines.length * fitted.lineGap + fitted.itemGap;
        }
      }

      if (note && !remaining.length) {
        page.text(note, margin, Math.min(bodyTop + usedHeight + 14, height - 88), { size: 12, fill: MUTED });
      }
      if (continuation) {
        page.text('продолжение', width - margin, 44, { size: 9, fill: MUTED, align: 'right' });
      }
      pages.push(page);
      if (!remaining.length) break;
      continuation = true;
      if (pages.length > 40) break;
    }
  });

  const totalPages = pages.length;
  pages.forEach((page, index) => footer(page, index, totalPages));

  return finalize({ pages, fonts, used, size: PAGE.slide });
}

function canvasWrap(fonts, used, value, font, size, maxWidth) {
  const page = new Canvas(0, 0, fonts, used);
  return page.wrap(value, font, size, maxWidth);
}

/* ───────────────────────────── документ A4 ───────────────────────────── */

function buildDocument({ title, subtitle, sections }) {
  const fonts = {
    regular: new PdfFont(loadFace(REGULAR_FILE), 'regular'),
    bold: new PdfFont(loadFace(BOLD_FILE), 'bold'),
  };
  const used = { regular: new Set(), bold: new Set() };
  const { width, height } = PAGE.document;
  const margin = 56;
  const contentWidth = width - margin * 2;
  const bottomLimit = height - 68;
  const pages = [];
  let page = null;
  let y = 0;

  const newPage = () => {
    page = new Canvas(width, height, fonts, used);
    page.fill(0, 0, width, height, '#ffffff');
    pages.push(page);
    y = margin + 12;
    return page;
  };

  const heading = (value) => {
    const lines = fitLines(value, 'bold', 15, contentWidth);
    for (const line of lines) {
      page.text(line, margin, y, { font: 'bold', size: 15, fill: INK });
      y += 15 * 1.35;
    }
    y += 6;
  };

  const paragraph = (value, { size = 11.5, fill = INK, lead = 1.55, gap = 9 } = {}) => {
    const lines = fitLines(value, 'regular', size, contentWidth);
    for (const line of lines) {
      if (y + size > bottomLimit) newPage();
      page.text(line, margin, y, { size, fill });
      y += size * lead;
    }
    y += gap;
  };

  const bullet = (value) => {
    const lines = fitLines(value, 'regular', 11.5, contentWidth - 20);
    const lead = 11.5 * 1.55;
    if (y + lead > bottomLimit) newPage();
    lines.forEach((line, index) => {
      if (y + 11.5 > bottomLimit) newPage();
      if (index === 0) page.fill(margin + 1, y + 5, 4, 4, ACCENT);
      page.text(line, margin + 20, y, { size: 11.5, fill: INK });
      y += lead;
    });
    y += 6;
  };

  const fitLines = (value, font, size, maxWidth) => canvasWrap(fonts, used, value, font, size, maxWidth);

  newPage();
  const docTitle = normalizeText(title).trim();
  const titleSize = docTitle.length > 70 ? 22 : 26;
  for (const line of fitLines(docTitle, 'bold', titleSize, contentWidth)) {
    page.text(line, margin, y, { font: 'bold', size: titleSize, fill: INK });
    y += titleSize * 1.25;
  }
  y += 6;
  const sub = normalizeText(subtitle).trim();
  if (sub) {
    for (const line of fitLines(sub, 'regular', 12, contentWidth)) {
      page.text(line, margin, y, { size: 12, fill: MUTED });
      y += 12 * 1.5;
    }
  }
  y += 10;
  page.line(margin, y, width - margin, y, { stroke: ACCENT, width: 3 });
  y += 26;

  for (const section of sections) {
    const head = normalizeText(section.heading || '').trim();
    if (head) {
      if (y + 60 > bottomLimit) newPage();
      heading(head);
    }
    for (const text of section.paragraphs || []) {
      if (normalizeText(text).trim()) paragraph(text);
    }
    for (const text of section.bullets || []) {
      if (normalizeText(text).trim()) bullet(text);
    }
    y += 4;
  }

  pages.forEach((current, index) => {
    current.text(docTitle.toUpperCase().slice(0, 70), margin, height - 42, { size: 8, fill: MUTED, spacing: 1 });
    current.text(`${index + 1} / ${pages.length}`, width - margin, height - 42, { size: 8, fill: MUTED, align: 'right' });
  });

  return finalize({ pages, fonts, used, size: PAGE.document });
}

/* ───────────────────────────── сборка файла ───────────────────────────── */

function finalize({ pages, fonts, used, size }) {
  const objects = [];
  const add = (object) => {
    objects.push(object);
    return objects.length;
  };

  /* шрифты: Type0 (Identity-H) + CIDFontType2 + дескриптор + файл шрифта + ToUnicode */
  const fontRefs = {};
  const buildFont = (key, font) => {
    const face = font.face;
    const scale = 1000 / face.unitsPerEm;
    const subset = key === 'bold' ? 'DSHPDB' : 'DSHPDA';
    const baseFont = `/${subset}+${key === 'bold' ? 'DejaVuSans-Bold' : 'DejaVuSans'}`;
    const gids = [...(key === 'bold' ? used.bold : used.regular)].sort((a, b) => a - b);
    if (!gids.length) gids.push(face.map.get(0x20) || 1);

    const widths = gids.map((gid) => `${gid} [${Math.round((face.widths[gid] || 0) * scale)}]`).join(' ');
    const fileId = add(
      streamObject(
        {
          Length1: face.bytes.length,
        },
        face.bytes,
      ),
    );
    const descriptorId = add({
      dict: {
        Type: '/FontDescriptor',
        FontName: baseFont,
        Flags: 32,
        FontBBox: `[${face.bbox.map((v) => Math.round(v * scale)).join(' ')}]`,
        ItalicAngle: 0,
        Ascent: Math.round(face.ascent * scale),
        Descent: Math.round(face.descent * scale),
        CapHeight: Math.round(face.capHeight * scale),
        StemV: 80,
        FontFile2: `${fileId} 0 R`,
      },
    });

    const cmapLines = gids
      .map((gid) => {
        const code = face.reverse.get(gid);
        if (code === undefined) return null;
        return `<${gid.toString(16).padStart(4, '0').toUpperCase()}> <${code.toString(16).padStart(4, '0').toUpperCase()}>`;
      })
      .filter(Boolean);
    const cmapChunks = [];
    for (let i = 0; i < cmapLines.length; i += 100) cmapChunks.push(cmapLines.slice(i, i + 100));
    const toUnicode = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /Adobe-Identity-UCS def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange',
      ...cmapChunks.flatMap((chunk) => [`${chunk.length} beginbfchar`, ...chunk, 'endbfchar']),
      'endcmap',
      'CMapName currentdict /CMap defineresource pop',
      'end',
      'end',
    ].join('\n');
    const toUnicodeId = add(streamObject({}, toUnicode));

    const cidId = add({
      dict: {
        Type: '/Font',
        Subtype: '/CIDFontType2',
        BaseFont: baseFont,
        CIDSystemInfo: '<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>',
        FontDescriptor: `${descriptorId} 0 R`,
        DW: 1000,
        W: `[${widths}]`,
        CIDToGIDMap: '/Identity',
      },
    });
    const type0Id = add({
      dict: {
        Type: '/Font',
        Subtype: '/Type0',
        BaseFont: baseFont,
        Encoding: '/Identity-H',
        DescendantFonts: `[${cidId} 0 R]`,
        ToUnicode: `${toUnicodeId} 0 R`,
      },
    });
    fontRefs[key] = type0Id;
    return type0Id;
  };

  buildFont('regular', fonts.regular);
  buildFont('bold', fonts.bold);

  const pageIds = [];
  for (const page of pages) {
    const contentId = add(streamObject({}, page.toStream()));
    const pageId = add({
      dict: {
        Type: '/Page',
        Parent: 'PAGES 0 R',
        MediaBox: `[0 0 ${page.width} ${page.height}]`,
        Resources: `<< /Font << /F1 ${fontRefs.regular} 0 R /F2 ${fontRefs.bold} 0 R >> /ProcSet [/PDF /Text] >>`,
        Contents: `${contentId} 0 R`,
      },
    });
    pageIds.push(pageId);
  }

  const pagesId = add({
    dict: {
      Type: '/Pages',
      Kids: `[${pageIds.map((id) => `${id} 0 R`).join(' ')}]`,
      Count: pageIds.length,
    },
  });
  for (const id of pageIds) objects[id - 1].dict.Parent = `${pagesId} 0 R`;

  const catalogId = add({ dict: { Type: '/Catalog', Pages: `${pagesId} 0 R` } });
  const infoId = add({
    dict: {
      Producer: pdfString('DSH Open Web'),
      Creator: pdfString('DSH Open Web'),
    },
  });

  return writePdf(objects, { root: catalogId, info: infoId });
}

/* ───────────────────────────── публичный интерфейс ───────────────────────────── */

/** Презентация: по странице на слайд (16:9); обложка — при cover: true или без слайдов. */
export function createPresentationPdf({ title, subtitle, kicker, slides, cover }) {
  const list = Array.isArray(slides) ? slides.filter(Boolean) : [];
  if (!normalizeText(title).trim() && !list.length) throw new Error('Нужен заголовок или хотя бы один слайд');
  return buildSlideDeck({ title, subtitle, kicker, slides: list, cover: Boolean(cover) });
}

/** Документ A4: заголовок и разделы с абзацами и списками. */
export function createDocumentPdf({ title, subtitle, sections }) {
  const list = Array.isArray(sections) ? sections.filter(Boolean) : [];
  if (!normalizeText(title).trim() && !list.length) throw new Error('Нужен заголовок или хотя бы один раздел');
  return buildDocument({ title, subtitle, sections: list });
}

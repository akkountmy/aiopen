/**
 * Профессиональный PDF на pdfkit: A4-документ и широкий PDF-дек 13,333×7,5 дюйма.
 *
 * Это заменяет ручной движок вёрстки, когда доступна библиотека: появляются
 * выравнивание по ширине, сноски-колонтитулы с номерами страниц, таблицы с
 * переносом текста и заливкой, KPI-блоки и простые диаграммы.
 */
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { COLORS, formatMoney, toList } from './theme.mjs';

const INCH = 72;
const A4 = { width: 595.28, height: 841.89, margins: { top: 58, bottom: 62, left: 64, right: 54 } };
const DECK = { width: 13.333 * INCH, height: 7.5 * INCH, margins: { top: 54, bottom: 54, left: 58, right: 58 } };
const PALETTE = ['D4564A', '10233F', '8A8C96', 'E0B04A', '4A7FB5', '7A9E5B'];

const FONT_DIR = path.join(import.meta.dirname, '..', '..', 'assets', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'DejaVuSans.subset.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.subset.ttf');

const hex = (value) => `#${String(value).replace(/^#/, '')}`;

// В подмножестве DejaVu нет греческого блока: Δ и родственники рисуются как .notdef.
// Подменяем их осмысленными эквивалентами, а прочие отсутствующие знаки — точкой-разделителем.
const GLYPH_FALLBACK = { 'Δ': 'Изм.', 'δ': 'изм.', 'Ω': 'Ом', 'π': 'п', 'Σ': 'Сумма' };

function guardGlyphs(doc) {
  const raw = doc.text.bind(doc);
  const supports = (codePoint) => {
    const font = doc._font?.font;
    return typeof font?.hasGlyphForCodePoint === 'function' ? font.hasGlyphForCodePoint(codePoint) : true;
  };
  doc.text = (value, ...rest) => {
    const str = String(value ?? '');
    if (!/[^\u0000-\u007f\u0400-\u04ff\u2000-\u206f\u20a0-\u20bf\u2190-\u21ff\u2200-\u22ff\u25a0-\u25ff\u00a0-\u00ff]/.test(str)) return raw(str, ...rest);
    const fixed = Array.from(str)
      .map((char) => {
        const codePoint = char.codePointAt(0);
        if (codePoint < 128 || supports(codePoint)) return char;
        return GLYPH_FALLBACK[char] ?? '·';
      })
      .join('');
    return raw(fixed, ...rest);
  };
}

function registerFonts(doc) {
  const hasRegular = fs.existsSync(FONT_REGULAR);
  const hasBold = fs.existsSync(FONT_BOLD);
  if (!hasRegular) throw new Error('нет шрифта DejaVuSans.subset.ttf — PDF без кириллицы не собираем');
  doc.registerFont('sans', FONT_REGULAR);
  doc.registerFont('sans-bold', hasBold ? FONT_BOLD : FONT_REGULAR);
  return { bold: hasBold };
}

const setFont = (doc, bold = false, size = 10.5, color = COLORS.ink) => {
  doc.font(bold ? 'sans-bold' : 'sans').fontSize(size).fillColor(hex(color));
};

function collect(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/* ------------------------------------------------------------------ таблицы */

function measureTable(doc, table, width) {
  const headers = (table.headers || []).map(String);
  const rows = (table.rows || []).filter((row) => Array.isArray(row) && row.length);
  const columns = Math.max(headers.length, ...rows.map((row) => row.length), 1);
  const numeric = new Set(
    (table.numericColumns?.length ? table.numericColumns : headers.map((_, i) => i).filter((i) => {
      const sample = rows.map((row) => row[i]).filter((v) => v !== '' && v !== null && v !== undefined);
      return sample.length > 0 && sample.every((v) => typeof v === 'number' || /^[-+]?[\d\s.,]+%?$/.test(String(v)));
    })).map(Number),
  );
  const weights = Array.from({ length: columns }, (_, i) => Math.max(0.95, Number(table.columnWeights?.[i]) || (i === 0 ? 2.2 : numeric.has(i) ? 1.15 : 1.5)));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const widths = weights.map((weight) => (width * weight) / totalWeight);
  return { headers, rows, columns, numeric, widths };
}

function tableRowHeight(doc, cells, widths, fontSize, padding, bold = false) {
  let height = 0;
  cells.forEach((cell, index) => {
    /* Жирный шрифт шире обычного: измеряем тем же начертанием, каким рисуем,
       иначе шапка переносится на строку больше и налезает на ячейки ниже. */
    setFont(doc, bold, fontSize);
    const inner = Math.max(10, widths[index] - padding * 2);
    height = Math.max(height, doc.heightOfString(String(cell ?? ''), { width: inner, lineGap: 1 }));
  });
  return height + padding * 2;
}

function drawTable(doc, table, { width, fontSize = 9.5, padding = 5, x } = {}) {
  const { headers, rows, columns, numeric, widths } = measureTable(doc, table, width);
  const x0 = typeof x === 'number' ? x : doc.page.margins.left;
  let y = doc.y + 4;
  const ensureSpace = (needed) => {
    if (y + needed > doc.page.height - doc.page.margins.bottom - 8) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  };

  if (headers.length) {
    const height = tableRowHeight(doc, headers, widths, fontSize, padding, true);
    ensureSpace(height);
    let x = x0;
    doc.save().rect(x0, y, width, height).fill(hex(COLORS.navy)).restore();
    headers.forEach((cell, index) => {
      setFont(doc, true, fontSize, COLORS.white);
      doc.text(String(cell), x + padding, y + padding, {
        width: widths[index] - padding * 2,
        align: numeric.has(index) ? 'right' : 'left',
        lineGap: 1,
      });
      x += widths[index];
    });
    y += height;
  }

  rows.forEach((row, rowIndex) => {
    const height = tableRowHeight(doc, row, widths, fontSize, padding);
    ensureSpace(height);
    if (rowIndex % 2 === 1) doc.save().rect(x0, y, width, height).fill(hex(COLORS.soft)).restore();
    let x = x0;
    row.forEach((cell, index) => {
      setFont(doc, false, fontSize);
      doc.text(String(cell ?? ''), x + padding, y + padding, {
        width: widths[index] - padding * 2,
        align: numeric.has(index) ? 'right' : 'left',
        lineGap: 1,
      });
      x += widths[index];
    });
    doc.save().moveTo(x0, y + height).lineTo(x0 + width, y + height).lineWidth(0.5).strokeColor(hex(COLORS.hairline)).stroke().restore();
    y += height;
  });

  if (headers.length || rows.length) {
    doc.save().rect(x0, y, width, 0.9).fill(hex(COLORS.navy)).restore();
  }
  doc.x = x0;
  doc.y = y + 12;
}

/* ------------------------------------------------------------- диаграммы */

function drawBarChart(doc, chart, box) {
  const categories = (chart.categories || []).map(String);
  const series = (chart.series || []).map((item) => ({ name: String(item.name ?? ''), values: (item.values || []).map((v) => Number(v) || 0) }));
  if (!categories.length || !series.length) return;
  const max = Math.max(...series.flatMap((item) => item.values), 1);
  const plot = { x: box.x + 46, y: box.y + 26, w: box.w - 58, h: box.h - 60 };
  setFont(doc, true, 9, COLORS.navy);
  if (chart.title) doc.text(chart.title, box.x, box.y);
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i += 1) {
    const y = plot.y + (plot.h * i) / gridLines;
    doc.save().moveTo(plot.x, y).lineTo(plot.x + plot.w, y).lineWidth(0.5).strokeColor(hex(COLORS.grid)).stroke().restore();
    const value = max * (1 - i / gridLines);
    setFont(doc, false, 7, COLORS.muted);
    doc.text(new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value), box.x, y - 4, { width: 38, align: 'right' });
  }
  const groupWidth = plot.w / categories.length;
  const barWidth = Math.min(26, (groupWidth * 0.62) / series.length);
  categories.forEach((label, categoryIndex) => {
    const center = plot.x + groupWidth * (categoryIndex + 0.5);
    series.forEach((item, seriesIndex) => {
      const value = item.values[categoryIndex] ?? 0;
      const height = Math.max(0.5, (value / max) * plot.h);
      const x = center - (barWidth * series.length) / 2 + seriesIndex * barWidth;
      doc.save().rect(x, plot.y + plot.h - height, barWidth - 1.5, height).fill(hex(PALETTE[seriesIndex % PALETTE.length])).restore();
    });
    setFont(doc, false, 7.5, COLORS.muted);
    doc.text(label, plot.x + groupWidth * categoryIndex, plot.y + plot.h + 6, { width: groupWidth, align: 'center' });
  });
  if (series.length > 1) {
    let legendX = plot.x;
    const legendY = plot.y + plot.h + 20;
    series.forEach((item, index) => {
      doc.save().rect(legendX, legendY + 1, 7, 7).fill(hex(PALETTE[index % PALETTE.length])).restore();
      setFont(doc, false, 8, COLORS.muted);
      doc.text(item.name, legendX + 11, legendY, { width: 120 });
      legendX += 11 + doc.widthOfString(item.name) + 16;
    });
  }
}

function drawLineChart(doc, chart, box) {
  const categories = (chart.categories || []).map(String);
  const series = (chart.series || []).map((item) => ({ name: String(item.name ?? ''), values: (item.values || []).map((v) => Number(v) || 0) }));
  if (!categories.length || !series.length) return;
  const max = Math.max(...series.flatMap((item) => item.values), 1);
  const plot = { x: box.x + 46, y: box.y + 26, w: box.w - 58, h: box.h - 60 };
  setFont(doc, true, 9, COLORS.navy);
  if (chart.title) doc.text(chart.title, box.x, box.y);
  for (let i = 0; i <= 4; i += 1) {
    const y = plot.y + (plot.h * i) / 4;
    doc.save().moveTo(plot.x, y).lineTo(plot.x + plot.w, y).lineWidth(0.5).strokeColor(hex(COLORS.grid)).stroke().restore();
  }
  const step = categories.length > 1 ? plot.w / (categories.length - 1) : 0;
  series.forEach((item, seriesIndex) => {
    doc.save().lineWidth(1.6).strokeColor(hex(PALETTE[seriesIndex % PALETTE.length]));
    item.values.forEach((value, index) => {
      const x = plot.x + step * index;
      const y = plot.y + plot.h - (value / max) * plot.h;
      if (index === 0) doc.moveTo(x, y);
      else doc.lineTo(x, y);
    });
    doc.stroke().restore();
    item.values.forEach((value, index) => {
      const x = plot.x + step * index;
      const y = plot.y + plot.h - (value / max) * plot.h;
      doc.save().circle(x, y, 1.9).fill(hex(PALETTE[seriesIndex % PALETTE.length])).restore();
    });
  });
  categories.forEach((label, index) => {
    setFont(doc, false, 7.5, COLORS.muted);
    doc.text(label, plot.x + step * index - 30, plot.y + plot.h + 6, { width: 60, align: 'center' });
  });
}

/* ------------------------------------------------------------------ блоки */

function drawKpiRow(doc, items, { width, y, x } = {}) {
  const count = Math.min(items.length, 4);
  if (!count) return y;
  const gap = 10;
  const boxWidth = (width - gap * (count - 1)) / count;
  const boxHeight = 56;
  const x0 = typeof x === 'number' ? x : doc.page.margins.left;
  items.slice(0, count).forEach((item, index) => {
    const x = x0 + index * (boxWidth + gap);
    doc.save().rect(x, y, boxWidth, boxHeight).fill(hex(COLORS.soft)).restore();
    doc.save().rect(x, y, boxWidth, 2.4).fill(hex(COLORS.accent)).restore();
    const value = String(item.value ?? '');
    let size = 15;
    while (size > 9 && doc.font('sans-bold').fontSize(size).widthOfString(value) > boxWidth - 22) size -= 0.5;
    setFont(doc, true, size, COLORS.navy);
    doc.text(value, x + 11, y + 11, { width: boxWidth - 20, lineBreak: false });
    /* Подпись уменьшаем, пока не влезет в одну строку: перенос за границу
       плашки читается как обрезанный текст. */
    const label = String(item.label ?? '').toUpperCase();
    let labelSize = 7.5;
    while (labelSize > 5.2 && doc.font('sans').fontSize(labelSize).widthOfString(label) + label.length * 0.4 > boxWidth - 20) labelSize -= 0.2;
    setFont(doc, false, labelSize, COLORS.muted);
    doc.text(label, x + 11, y + 34, { width: boxWidth - 20, characterSpacing: 0.4, lineBreak: false });
  });
  return y + boxHeight + 14;
}

function drawSectionBody(doc, section, { width }) {
  const x0 = doc.page.margins.left;
  for (const text of toList(section.paragraphs)) {
    setFont(doc, false, 10.5, COLORS.ink);
    /* Выключка по левому краю: pdfkit не переносит слова по слогам, и в
       выключенном абзаце между словами появляются «реки» из пробелов. */
    doc.text(text, x0, doc.y, { width, align: 'left', lineGap: 3.4, paragraphGap: 7 });
  }
  for (const item of toList(section.bullets)) {
    const y = doc.y;
    setFont(doc, true, 10.5, COLORS.accent);
    doc.text('•', x0, y, { width: 12, lineBreak: false });
    setFont(doc, false, 10.5, COLORS.ink);
    doc.text(item, x0 + 14, y, { width: width - 14, lineGap: 3, paragraphGap: 5 });
  }
  if (section.table) drawTable(doc, section.table, { width });
  if (section.chart) {
    const boxHeight = 200;
    if (doc.y + boxHeight > doc.page.height - doc.page.margins.bottom - 10) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
    const box = { x: x0, y: doc.y + 4, w: width, h: boxHeight };
    if (String(section.chart.type) === 'line') drawLineChart(doc, section.chart, box);
    else drawBarChart(doc, section.chart, box);
    doc.x = x0;
    doc.y = box.y + boxHeight + 8;
  }
  if (section.note) {
    setFont(doc, false, 8.5, COLORS.muted);
    doc.text(String(section.note), x0, doc.y, { width, lineGap: 2 });
  }
  doc.moveDown(0.6);
}

function drawSectionTable(doc, section, width) {
  if (section.kpi?.length) {
    const y = drawKpiRow(doc, section.kpi, { width, y: doc.y });
    doc.y = y;
  }
  drawSectionBody(doc, section, { width });
}

/* ------------------------------------------------------------------- A4 */

async function buildA4Document(spec) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: A4.margins,
    bufferPages: true,
    info: { Title: spec.title || 'Документ', Author: spec.author || 'DSH Open Web', Subject: spec.subtitle || '' },
  });
  const trace = process.env.DSH_PDF_DEBUG ? (label) => console.error(`[pdf] ${label} page=${doc.bufferedPageRange().count} y=${Math.round(doc.y)} x=${Math.round(doc.x)}`) : () => {};
  registerFonts(doc);
  guardGlyphs(doc);
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const cover = spec.cover === true && Boolean(spec.title);
  if (cover) {
    doc.y = doc.page.height * 0.26;
    if (spec.kicker) {
      setFont(doc, true, 9, COLORS.accent);
      doc.text(String(spec.kicker).toUpperCase(), doc.page.margins.left, doc.y, { width, characterSpacing: 1.4 });
      doc.moveDown(0.6);
    }
    setFont(doc, true, 27, COLORS.navy);
    doc.text(String(spec.title), doc.page.margins.left, doc.y, { width, lineGap: 3 });
    doc.moveDown(0.5);
    doc.save().moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + 120, doc.y).lineWidth(2.4).strokeColor(hex(COLORS.accent)).stroke().restore();
    doc.moveDown(0.7);
    if (spec.subtitle) {
      setFont(doc, false, 12, COLORS.ink);
      doc.text(String(spec.subtitle), doc.page.margins.left, doc.y, { width: width * 0.86, lineGap: 4 });
      doc.moveDown(0.8);
    }
    const meta = [spec.author, spec.date].filter(Boolean).join('  ·  ');
    if (meta) {
      setFont(doc, false, 9, COLORS.muted);
      doc.text(meta, doc.page.margins.left, doc.y, { width });
    }
    doc.addPage();
  } else if (spec.title) {
    if (spec.kicker) {
      setFont(doc, true, 8.5, COLORS.accent);
      doc.text(String(spec.kicker).toUpperCase(), { width, characterSpacing: 1.2 });
      doc.moveDown(0.35);
    }
    setFont(doc, true, 20, COLORS.navy);
    doc.text(String(spec.title), { width, lineGap: 2 });
    doc.moveDown(0.25);
    if (spec.subtitle) {
      setFont(doc, false, 11, COLORS.muted);
      doc.text(String(spec.subtitle), { width, lineGap: 3 });
    }
    doc.moveDown(0.5);
    doc.save().moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + width, doc.y).lineWidth(0.8).strokeColor(hex(COLORS.hairline)).stroke().restore();
    doc.moveDown(0.8);
  }

  const sections = Array.isArray(spec.sections) ? spec.sections : [];
  sections.forEach((section, index) => {
    if (index > 0) doc.moveDown(0.2);
    if (section.heading) {
      setFont(doc, true, 14, COLORS.navy);
      doc.text(String(section.heading), doc.page.margins.left, doc.y, { width, lineGap: 2 });
      doc.moveDown(0.45);
      trace(`heading ${JSON.stringify(section.heading).slice(0, 40)}`);
    }
    drawSectionTable(doc, section, width);
    trace(`section ${index} done`);
  });

  const range = doc.bufferedPageRange();
  const skipped = cover ? 1 : 0;
  const contentPages = range.count - skipped;
  for (let offset = 0; offset < range.count; offset += 1) {
    const pageIndex = range.start + offset;
    if (skipped && offset < skipped) continue;
    doc.switchToPage(pageIndex);
    const bottom = doc.page.margins.bottom;
    // Нулевой нижний отступ обязателен: иначе pdfkit считает колонтитул переполнением
    // и молча добавляет пустые страницы на каждый text().
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 34;
    doc.save().moveTo(doc.page.margins.left, y - 10).lineTo(doc.page.width - doc.page.margins.right, y - 10).lineWidth(0.6).strokeColor(hex(COLORS.hairline)).stroke().restore();
    setFont(doc, false, 8, COLORS.muted);
    if (spec.footerText) doc.text(String(spec.footerText), doc.page.margins.left, y, { width: width - 90, lineBreak: false });
    const label = `стр. ${offset - skipped + 1} из ${contentPages}`;
    doc.text(label, doc.page.width - doc.page.margins.right - 90, y, { width: 90, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }

  return collect(doc);
}

/* ----------------------------------------------------------- широкий PDF-дек */

function deckFrame(doc, spec, slide, meta) {
  doc.rect(0, 0, DECK.width, DECK.height).fill(hex(COLORS.white));
  const margin = DECK.margins.left;
  const width = DECK.width - margin - DECK.margins.right;
  if (slide.kicker) {
    setFont(doc, true, 8.5, COLORS.accent);
    doc.text(String(slide.kicker).toUpperCase(), margin, 44, { width, characterSpacing: 1.2 });
  }
  setFont(doc, true, 23, COLORS.navy);
  doc.text(String(slide.title || ''), margin, slide.kicker ? 60 : 48, { width: width * 0.94, lineGap: 1 });
  doc.save().moveTo(margin, DECK.height - 46).lineTo(DECK.width - DECK.margins.right, DECK.height - 46).lineWidth(0.7).strokeColor(hex(COLORS.hairline)).stroke().restore();
  setFont(doc, false, 8, COLORS.muted);
  if (spec.footerText) doc.text(String(spec.footerText), margin, DECK.height - 38, { width: width - 90, lineBreak: false });
  doc.text(`${meta.index + 1} / ${meta.total}`, DECK.width - DECK.margins.right - 90, DECK.height - 38, { width: 90, align: 'right', lineBreak: false });
}

function deckCover(doc, spec) {
  doc.rect(0, 0, DECK.width, DECK.height).fill(hex(COLORS.navy));
  doc.rect(0, 0, 12, DECK.height).fill(hex(COLORS.accent));
  const margin = DECK.margins.left + 14;
  const width = DECK.width - margin - DECK.margins.right;
  if (spec.kicker) {
    setFont(doc, true, 10, COLORS.accent);
    doc.text(String(spec.kicker).toUpperCase(), margin, DECK.height * 0.34, { width, characterSpacing: 1.8 });
  }
  setFont(doc, true, 34, COLORS.white);
  doc.text(String(spec.title || ''), margin, DECK.height * 0.4, { width: width * 0.92, lineGap: 2 });
  if (spec.subtitle) {
    setFont(doc, false, 13, 'C9CCD6');
    doc.text(String(spec.subtitle), margin, DECK.height * 0.4 + 78, { width: width * 0.72, lineGap: 4 });
  }
  const meta = [spec.author, spec.date].filter(Boolean).join('  ·  ');
  if (meta) {
    setFont(doc, false, 9, '9AA0AE');
    doc.text(meta, margin, DECK.height - 92, { width });
  }
}

async function buildDeck(spec) {
  const doc = new PDFDocument({
    size: [DECK.width, DECK.height],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    bufferPages: true,
    autoFirstPage: false,
    info: { Title: spec.title || 'Презентация', Author: spec.author || 'DSH Open Web', Subject: spec.subtitle || '' },
  });
  registerFonts(doc);
  guardGlyphs(doc);

  const slides = Array.isArray(spec.slides) ? spec.slides : [];
  const withCover = spec.cover !== false && Boolean(spec.title);
  const total = slides.length + (withCover ? 1 : 0);
  let index = 0;

  if (withCover) {
    doc.addPage({ size: [DECK.width, DECK.height], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    doc.switchToPage(doc.bufferedPageRange().count - 1);
    deckCover(doc, spec);
    index += 1;
  }

  const margin = DECK.margins.left;
  const width = DECK.width - margin - DECK.margins.right;

  for (const slide of slides) {
    doc.addPage({ size: [DECK.width, DECK.height], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    doc.switchToPage(doc.bufferedPageRange().count - 1);
    if (slide.layout === 'section') {
      doc.rect(0, 0, DECK.width, DECK.height).fill(hex(COLORS.navy));
      if (slide.kicker) {
        setFont(doc, true, 10, COLORS.accent);
        doc.text(String(slide.kicker).toUpperCase(), margin, DECK.height * 0.42, { width, characterSpacing: 1.6 });
      }
      setFont(doc, true, 30, COLORS.white);
      doc.text(String(slide.title || ''), margin, DECK.height * 0.46, { width: width * 0.8 });
      index += 1;
      continue;
    }

    deckFrame(doc, spec, slide, { index, total });
    const paragraphs = toList(slide.paragraphs);
    const bullets = toList(slide.bullets);
    const hasText = paragraphs.length + bullets.length > 0;
    const hasVisual = Boolean(slide.chart || slide.table);

    let y = slide.kicker ? 112 : 100;
    if (slide.kpi?.length) y = drawKpiRow(doc, slide.kpi, { width, y, x: margin });

    const textWidth = hasVisual ? width * 0.46 : width;
    doc.x = margin;
    doc.y = y;
    for (const text of paragraphs) {
      setFont(doc, false, 12, COLORS.ink);
      doc.text(text, margin, doc.y, { width: textWidth, lineGap: 3, paragraphGap: 5 });
    }
    for (const item of bullets) {
      const lineY = doc.y;
      setFont(doc, true, 12, COLORS.accent);
      doc.text('•', margin, lineY, { width: 12, lineBreak: false });
      setFont(doc, false, 12, COLORS.ink);
      doc.text(item, margin + 14, lineY, { width: textWidth - 14, lineGap: 3, paragraphGap: 4 });
    }
    if (slide.chart) {
      // Диаграмма занимает правую колонку, когда слева есть текст, и всю ширину, когда нет.
      const boxX = hasText ? margin + width * 0.52 : margin;
      const boxW = hasText ? width * 0.48 : width;
      const boxY = y + 14;
      const boxH = Math.max(180, Math.min(310, DECK.height - 86 - boxY));
      const box = { x: boxX, y: boxY, w: boxW, h: boxH };
      if (String(slide.chart.type) === 'line') drawLineChart(doc, slide.chart, box);
      else drawBarChart(doc, slide.chart, box);
    }
    if (slide.table) {
      doc.x = margin;
      doc.y = y + 6;
      drawTable(doc, slide.table, { width, fontSize: 10, x: margin });
    }
    index += 1;
  }

  return collect(doc);
}

/**
 * Собрать PDF.
 * @param {object} spec — {layout: 'document'|'slides', ...}
 * @returns {Promise<Buffer>}
 */
export async function buildPdfPro(spec = {}) {
  const layout = String(spec.layout || (Array.isArray(spec.slides) ? 'slides' : 'document')).toLowerCase();
  return layout === 'slides' || layout === 'presentation' ? buildDeck(spec) : buildA4Document(spec);
}

export { formatMoney };

/**
 * Профессиональная презентация (.pptx) на PptxGenJS.
 *
 * Слайд 13,333×7,5 дюйма, единая сетка и типографика: обложка, разделы,
 * тезисы, диаграммы, таблицы, KPI-полоса, заметки докладчика на каждом слайде.
 */
import PptxGenJS from 'pptxgenjs';
import { COLORS, SLIDE, SLIDE_TYPE, glueUnits, toList } from './theme.mjs';

const W = SLIDE.width;
const H = SLIDE.height;
const M = SLIDE.margin;
const CONTENT_W = W - M * 2;
const PALETTE = ['D4564A', '10233F', '8A8C96', 'E0B04A', '4A7FB5', '7A9E5B'];

const font = 'Segoe UI';
const text = (value, options = {}) => ({
  /* glueUnits: «1,48 млн ₽» и «10 недель» переносятся целиком. */
  text: glueUnits(String(value ?? '')),
  options: {
    fontFace: font,
    fontSize: options.fontSize ?? SLIDE_TYPE.body,
    bold: options.bold === true,
    color: options.color ?? COLORS.ink,
    charSpacing: options.charSpacing,
    breakLine: options.breakLine,
    bullet: options.bullet,
    align: options.align,
  },
});

/**
 * PptxGenJS принимает в addText только строку или массив фрагментов:
 * одиночный объект {text, options} он не оборачивает. Приводим вид слайда к «всегда массив»,
 * чтобы дальше можно было писать обычные объекты фрагментов.
 */
function newSlide(pptx) {
  const slide = pptx.addSlide();
  if (!slide.__wrappedText) {
    const raw = slide.addText.bind(slide);
    slide.addText = (value, options) => raw(Array.isArray(value) ? value : [value ?? ''], options);
    slide.__wrappedText = true;
  }
  return slide;
}

function background(slide, color) {
  slide.background = { color };
}

function footer(slide, { index, total, footerText }) {
  slide.addText(text(footerText || '', { fontSize: SLIDE_TYPE.caption, color: COLORS.muted }), {
    x: M,
    y: H - 0.55,
    w: CONTENT_W - 1,
    h: 0.3,
    valign: 'top',
  });
  slide.addText(text(`${index + 1} / ${total}`, { fontSize: SLIDE_TYPE.caption, color: COLORS.muted, align: 'right' }), {
    x: W - M - 1,
    y: H - 0.55,
    w: 1,
    h: 0.3,
    align: 'right',
    valign: 'top',
  });
  slide.addShape('line', {
    x: M,
    y: H - 0.62,
    w: CONTENT_W,
    h: 0,
    line: { color: COLORS.hairline, width: 0.75 },
  });
}

function heading(slide, { kicker, title, wide = false }) {
  if (kicker) {
    slide.addText(text(String(kicker).toUpperCase(), { fontSize: SLIDE_TYPE.caption, bold: true, color: COLORS.accent, charSpacing: 1.6 }), {
      x: M,
      y: 0.5,
      w: wide ? CONTENT_W : CONTENT_W * 0.8,
      h: 0.3,
      valign: 'top',
    });
  }
  const titleWidth = wide ? CONTENT_W : CONTENT_W * 0.86;
  /* Длинный заголовок при фиксированном кегле уходит на третью строку и
     наезжает на контент: шаг вниз на 2 pt, пока не уложится в две строки. */
  let titleSize = SLIDE_TYPE.title;
  while (titleSize > 24 && countLines(title, titleWidth, titleSize) > 2) titleSize -= 2;
  slide.addText(text(title, { fontSize: titleSize, bold: true, color: COLORS.navy }), {
    x: M,
    y: kicker ? 0.78 : 0.6,
    w: titleWidth,
    h: 1.05,
    valign: 'top',
  });
}

function bulletBlock(items, { fontSize = SLIDE_TYPE.body, color = COLORS.ink } = {}) {
  return items.map((item, index) =>
    text(item, {
      fontSize,
      color,
      bullet: true,
      breakLine: index < items.length - 1,
    }),
  );
}

function kpiRow(slide, items, { y = 1.95 } = {}) {
  const count = Math.min(items.length, 4);
  if (!count) return;
  const gap = 0.25;
  const width = (CONTENT_W - gap * (count - 1)) / count;
  items.slice(0, count).forEach((item, index) => {
    const x = M + index * (width + gap);
    slide.addShape('rect', {
      x,
      y,
      w: width,
      h: 1.5,
      fill: { color: COLORS.soft },
      line: { color: COLORS.soft, width: 0 },
    });
    slide.addShape('rect', {
      x,
      y,
      w: width,
      h: 0.05,
      fill: { color: COLORS.accent },
      line: { color: COLORS.accent, width: 0 },
    });
    slide.addText(text(item.value, { fontSize: 26, bold: true, color: COLORS.navy }), {
      x: x + 0.25,
      y: y + 0.25,
      w: width - 0.4,
      h: 0.7,
      valign: 'top',
    });
    slide.addText(text(String(item.label || '').toUpperCase(), { fontSize: 10, color: COLORS.muted, charSpacing: 1 }), {
      x: x + 0.25,
      y: y + 0.92,
      w: width - 0.4,
      h: 0.4,
      valign: 'top',
    });
  });
}

/** Естественная высота таблицы: не растягиваем строки на весь слайд. */
function naturalTableHeight(table) {
  const rows = Array.isArray(table?.rows) ? table.rows.length : 0;
  return Math.min(4.3, 0.42 * (rows + 1));
}

function tableBlock(slide, table, { x = M, y = 1.95, w = CONTENT_W, h } = {}) {
  const headers = (table.headers || []).map(String);
  const rows = (table.rows || []).filter((row) => Array.isArray(row) && row.length);
  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length), 1);
  const cellOptions = { fontSize: 12, fontFace: font, color: COLORS.ink, valign: 'middle' };
  const NUMERIC = /^[-+]?[\d\s.,]+\s*(%|₽|\$|€|x|×|шт\.?|мес\.?|нед\.?)?$/u;
  const numericColumns = Array.from({ length: columnCount }, (_, columnIndex) => {
    const sample = rows.map((row) => row[columnIndex]).filter((value) => value !== undefined && value !== null && value !== '');
    if (!sample.length) return false;
    const numeric = sample.filter((value) => typeof value === 'number' || NUMERIC.test(String(value).trim()));
    return numeric.length / sample.length >= 0.6;
  });
  /* Ширины по содержимому: текстовая колонка шире числовой, иначе
     «Содержание работ» ломается по три строки, а «1,5» занимает пол-слайда. */
  const weights = Array.from({ length: columnCount }, (_, columnIndex) => {
    const sample = [headers[columnIndex], ...rows.map((row) => row[columnIndex])]
      .filter((value) => value !== undefined && value !== null && value !== '')
      .map((value) => String(value).length);
    const average = sample.length ? sample.reduce((sum, value) => sum + value, 0) / sample.length : 8;
    return numericColumns[columnIndex] ? Math.min(1.4, Math.max(1.05, average / 10)) : Math.min(3, Math.max(1.6, average / 14));
  });
  const weightTotal = weights.reduce((sum, value) => sum + value, 0) || 1;
  const colW = weights.map((weight) => (w * weight) / weightTotal);
  const body = rows.map((row, rowIndex) =>
    Array.from({ length: columnCount }, (_, columnIndex) => ({
      text: String(row[columnIndex] ?? ''),
      options: {
        ...cellOptions,
        align: columnIndex === 0 || !numericColumns[columnIndex] ? 'left' : 'right',
        fill: { color: rowIndex % 2 === 1 ? 'F7F8FA' : COLORS.white },
      },
    })),
  );
  const head = [
    Array.from({ length: columnCount }, (_, columnIndex) => ({
      text: headers[columnIndex] ?? '',
      options: {
        ...cellOptions,
        bold: true,
        color: COLORS.white,
        fontSize: 12,
        fill: { color: COLORS.navy },
        align: columnIndex === 0 || !numericColumns[columnIndex] ? 'left' : 'right',
      },
    })),
  ];
  slide.addTable([...head, ...body], {
    x,
    y,
    w,
    h: h ?? Math.min(4.3, 0.42 * (body.length + 1)),
    colW,
    border: { type: 'solid', color: COLORS.grid, pt: 0.75 },
    margin: 0.1,
    autoPage: false,
  });
}

function chartBlock(slide, chart, box) {
  const kindMap = { bar: 'bar', column: 'bar', line: 'line', pie: 'pie', doughnut: 'doughnut', area: 'area' };
  const kind = kindMap[String(chart.type || 'column')] || 'bar';
  const series = (chart.series || []).map((item) => ({
    name: String(item.name ?? 'Ряд'),
    labels: (chart.categories || []).map(String),
    values: (item.values || []).map((value) => Number(value) || 0),
  }));
  if (!series.length) return;
  if (chart.title) {
    slide.addText(text(chart.title, { fontSize: 13, bold: true, color: COLORS.navy }), {
      x: box.x,
      y: box.y - 0.45,
      w: box.w,
      h: 0.35,
      valign: 'top',
    });
  }
  /* Один ряд — один цвет: иначе PowerPoint красит каждую точку своим цветом и
     диаграмма выглядит пёстро. В столбиках последний столбик (текущее значение)
     выделяем акцентом, остальные держим в основном цвете бренда. */
  const labels = (chart.categories || []).length || 1;
  let chartColors = PALETTE;
  if (kind !== 'pie' && kind !== 'doughnut' && series.length === 1) {
    chartColors =
      kind === 'bar'
        ? Array.from({ length: labels }, (_, index) => (index === labels - 1 ? COLORS.accent : COLORS.navy))
        : [COLORS.navy];
  }
  slide.addChart(kind, series, {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    chartColors,
    barDir: String(chart.type || 'column') === 'bar' ? 'bar' : 'col',
    barGrouping: 'clustered',
    showLegend: series.length > 1 || kind === 'pie' || kind === 'doughnut',
    legendPos: 'b',
    legendFontFace: font,
    legendFontSize: 10,
    showValue: chart.showValues === true,
    dataLabelFontFace: font,
    dataLabelFontSize: 10,
    catAxisLabelFontFace: font,
    catAxisLabelFontSize: 10,
    valAxisLabelFontFace: font,
    valAxisLabelFontSize: 10,
    catAxisLineShow: true,
    valAxisLineShow: false,
    valGridLine: { color: COLORS.grid, style: 'solid', size: 0.75 },
    valAxisLabelFormatCode: chart.format || '#,##0',
    showTitle: false,
  });
}

/** Сколько строк займёт заголовок при заданном кегле (жадный перенос по словам). */
function countLines(value, widthIn, fontSize, bold = true) {
  const perChar = fontSize * (bold ? 0.545 : 0.52) / 72; /* средняя ширина знака в дюймах */
  const limit = Math.max(1, Math.floor(widthIn / perChar));
  let lines = 1;
  let current = 0;
  for (const word of String(value ?? '').split(/\s+/).filter(Boolean)) {
    const length = word.length + (current > 0 ? 1 : 0);
    if (current > 0 && current + length > limit) {
      lines += 1;
      current = word.length;
    } else {
      current += length;
    }
  }
  return lines;
}

/** Кегль заголовка обложки: уменьшаем, пока текст не уложится в maxLines строк. */
function coverTitleSize(value, widthIn, base, maxLines = 3, min = 26) {
  let size = base;
  while (size > min && countLines(value, widthIn, size) > maxLines) size -= 2;
  return size;
}

function coverSlide(slide, spec) {
  background(slide, COLORS.navy);
  slide.addShape('rect', { x: 0, y: 0, w: 0.16, h: H, fill: { color: COLORS.accent }, line: { width: 0 } });
  if (spec.kicker) {
    slide.addText(text(String(spec.kicker).toUpperCase(), { fontSize: 12, bold: true, color: COLORS.accent, charSpacing: 2 }), {
      x: M + 0.2,
      y: 2.05,
      w: CONTENT_W,
      h: 0.35,
    });
  }
  const titleWidth = CONTENT_W - 0.4;
  const titleSize = coverTitleSize(spec.title || 'Презентация', titleWidth, SLIDE_TYPE.cover);
  const titleLines = countLines(spec.title || 'Презентация', titleWidth, titleSize);
  const titleHeight = (titleLines * titleSize * 1.22) / 72;
  slide.addText(text(spec.title || 'Презентация', { fontSize: titleSize, bold: true, color: COLORS.white }), {
    x: M + 0.2,
    y: 2.4,
    w: titleWidth,
    h: titleHeight + 0.12,
    valign: 'top',
  });
  if (spec.subtitle) {
    /* Подзаголовок ставим сразу под фактической высотой заголовка, а не по
       фиксированной координате: длинный заголовок иначе на него налезает. */
    const subtitleY = Math.min(2.4 + titleHeight + 0.18, H - 2.4);
    slide.addText(text(spec.subtitle, { fontSize: 16, color: 'C9CCD6' }), {
      x: M + 0.2,
      y: subtitleY,
      w: CONTENT_W - 1.6,
      h: Math.max(0.5, H - 1.6 - subtitleY),
      valign: 'top',
    });
  }
  const meta = [spec.author, spec.date].filter(Boolean).join(' · ');
  if (meta) {
    slide.addText(text(meta, { fontSize: 11, color: '9AA0AE' }), {
      x: M + 0.2,
      y: H - 1.1,
      w: CONTENT_W,
      h: 0.35,
    });
  }
}

function sectionSlide(slide, spec) {
  background(slide, COLORS.navy);
  if (spec.kicker) {
    slide.addText(text(String(spec.kicker).toUpperCase(), { fontSize: 12, bold: true, color: COLORS.accent, charSpacing: 2 }), {
      x: M,
      y: 2.9,
      w: CONTENT_W,
      h: 0.35,
    });
  }
  slide.addText(text(spec.title || '', { fontSize: 34, bold: true, color: COLORS.white }), {
    x: M,
    y: 3.25,
    w: CONTENT_W - 1,
    h: 1.2,
    valign: 'top',
  });
}

function contentSlide(slide, spec, meta) {
  const side = spec.kpi?.length || spec.chart || spec.table ? (spec.layout === 'split' ? true : Boolean(spec.side)) : false;
  heading(slide, { kicker: spec.kicker, title: spec.title });
  let bodyY = 1.95;
  if (spec.kpi?.length) {
    kpiRow(slide, spec.kpi, { y: bodyY });
    bodyY += 1.8;
  }
  const paragraphs = toList(spec.paragraphs);
  const bullets = toList(spec.bullets);
  const hasVisual = Boolean(spec.chart || spec.table);
  const textW = hasVisual ? CONTENT_W * 0.44 : CONTENT_W;
  if (paragraphs.length || bullets.length) {
    slide.addText(
      [
        ...paragraphs.map((item) => text(item, { fontSize: 15, color: COLORS.ink, breakLine: true })),
        ...bulletBlock(bullets),
      ],
      {
        x: M,
        y: bodyY,
        w: textW,
        h: Math.max(1.2, H - bodyY - 1.05),
        valign: 'top',
        paraSpaceAfter: 8,
        lineSpacingMultiple: 1.15,
      },
    );
  }
  if (spec.chart) {
    chartBlock(slide, spec.chart, {
      x: M + CONTENT_W * 0.5,
      y: bodyY + 0.35,
      w: CONTENT_W * 0.5,
      h: Math.max(2.6, H - bodyY - 1.4),
    });
  }
  if (spec.table) {
    /* С текстом слева таблица занимает правую половину, а не всю ширину. */
    const box = hasVisual && (paragraphs.length || bullets.length)
      ? { x: M + CONTENT_W * 0.5, y: bodyY, w: CONTENT_W * 0.5, h: naturalTableHeight(spec.table) }
      : { y: bodyY, h: naturalTableHeight(spec.table) };
    tableBlock(slide, spec.table, box);
  }
  footer(slide, meta);
}

function visualSlide(slide, spec, meta) {
  heading(slide, { kicker: spec.kicker, title: spec.title, wide: true });
  /* Теснота под графиком — самая частая причина наложения: сначала считаем,
     сколько места съедят KPI и тезисы, и только потом отдаём остаток графику. */
  let top = 2.35;
  if (spec.kpi?.length) {
    kpiRow(slide, spec.kpi);
    top = 3.6;
  }
  const bullets = toList(spec.bullets);
  const hasBullets = bullets.length > 0;
  const bottom = hasBullets ? 5.45 : H - 0.95;
  if (spec.chart) {
    chartBlock(slide, spec.chart, { x: M, y: top, w: CONTENT_W, h: Math.max(2.1, bottom - top) });
  } else if (spec.table) {
    tableBlock(slide, spec.table, { y: top, h: Math.min(naturalTableHeight(spec.table), bottom - top) });
  }
  if (hasBullets) {
    slide.addText(bulletBlock(bullets, { fontSize: 13 }), {
      x: M,
      y: H - 1.95,
      w: CONTENT_W,
      h: 1.1,
      valign: 'top',
      paraSpaceAfter: 4,
      lineSpacingMultiple: 1.1,
    });
  }
  footer(slide, meta);
}

function quoteSlide(slide, spec, meta) {
  background(slide, COLORS.soft);
  const line = String(spec.title || spec.quote || '');
  const textW = CONTENT_W - 0.9;
  const size = line.length > 120 ? 22 : 26;
  /* Высота линии при одинарном интервале 1.2 и запас 10% — так полоска совпадает с текстом. */
  const lineH = (size * 1.2 * 1.1) / 72;
  const textH = Math.min(H - 2.4, countLines(line, textW, size, false) * lineH + 0.1);
  const meta2 = [spec.author, spec.subtitle].filter(Boolean).join(' · ');
  const total = textH + (meta2 ? 0.55 : 0);
  const top = Math.max(1.2, (H - total) / 2 - 0.15);
  slide.addShape('rect', { x: M, y: top + 0.04, w: 0.08, h: Math.max(0.5, textH - 0.08), fill: { color: COLORS.accent }, line: { width: 0 } });
  slide.addText(text(line, { fontSize: size, bold: false, color: COLORS.navy }), {
    x: M + 0.45,
    y: top,
    w: textW,
    h: textH,
    valign: 'top',
    lineSpacingMultiple: 1.2,
  });
  if (meta2) {
    slide.addText(text(meta2, { fontSize: 12, color: COLORS.muted }), {
      x: M + 0.45,
      y: top + textH + 0.15,
      w: textW,
      h: 0.4,
    });
  }
  footer(slide, meta);
}

/**
 * Собрать .pptx.
 * @param {object} spec
 * @returns {Promise<Buffer>}
 */
export async function buildPptxPro(spec = {}) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'DSH_WIDE', width: W, height: H });
  pptx.layout = 'DSH_WIDE';
  pptx.author = spec.author || 'DSH Open Web';
  pptx.company = spec.company || '';
  pptx.title = spec.title || 'Презентация';
  pptx.subject = spec.subtitle || '';

  const slides = Array.isArray(spec.slides) ? spec.slides : [];
  const hasCover = spec.cover !== false && Boolean(spec.title);
  const meta = { total: slides.length + (hasCover ? 1 : 0), footerText: spec.footerText };

  if (hasCover) {
    const slide = newSlide(pptx);
    coverSlide(slide, spec);
    if (spec.footerText) {
      slide.addText(text(spec.footerText, { fontSize: SLIDE_TYPE.caption, color: '9AA0AE' }), {
        x: M + 0.2,
        y: H - 0.6,
        w: CONTENT_W,
        h: 0.3,
      });
    }
  }

  slides.forEach((raw, index) => {
    const slide = newSlide(pptx);
    /* Номер слайда — его настоящее место в файле: обложка тоже считается. */
    const slideMeta = { ...meta, index: index + (hasCover ? 1 : 0) };
    const layout = String(raw.layout || (raw.chart || raw.table ? 'visual' : 'content')).toLowerCase();
    if (layout === 'cover') coverSlide(slide, { ...spec, ...raw });
    else if (layout === 'section' || layout === 'divider') sectionSlide(slide, raw);
    else if (layout === 'quote') quoteSlide(slide, raw, slideMeta);
    else if (layout === 'visual' || layout === 'chart' || layout === 'table') visualSlide(slide, raw, slideMeta);
    else contentSlide(slide, raw, slideMeta);
    slide.addNotes(String(raw.note || raw.notes || ''));
  });

  return pptx.write({ outputType: 'nodebuffer' });
}

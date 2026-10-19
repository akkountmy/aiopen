/**
 * Профессиональная презентация (.pptx) на PptxGenJS.
 *
 * Слайд 13,333×7,5 дюйма, единая сетка и типографика: обложка, разделы,
 * тезисы, диаграммы, таблицы, KPI-полоса, заметки докладчика на каждом слайде.
 */
import PptxGenJS from 'pptxgenjs';
import { COLORS, SLIDE, SLIDE_TYPE, toList } from './theme.mjs';

const W = SLIDE.width;
const H = SLIDE.height;
const M = SLIDE.margin;
const CONTENT_W = W - M * 2;
const PALETTE = ['D4564A', '10233F', '8A8C96', 'E0B04A', '4A7FB5', '7A9E5B'];

const font = 'Segoe UI';
const text = (value, options = {}) => ({
  text: String(value ?? ''),
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
  slide.addText(text(title, { fontSize: SLIDE_TYPE.title, bold: true, color: COLORS.navy }), {
    x: M,
    y: kicker ? 0.78 : 0.6,
    w: wide ? CONTENT_W : CONTENT_W * 0.86,
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

function tableBlock(slide, table, { y = 1.95, h } = {}) {
  const headers = (table.headers || []).map(String);
  const rows = (table.rows || []).filter((row) => Array.isArray(row) && row.length);
  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length), 1);
  const cellOptions = { fontSize: 12, fontFace: font, color: COLORS.ink, valign: 'middle' };
  const body = rows.map((row, rowIndex) =>
    Array.from({ length: columnCount }, (_, columnIndex) => ({
      text: String(row[columnIndex] ?? ''),
      options: {
        ...cellOptions,
        align: columnIndex === 0 ? 'left' : 'right',
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
        align: columnIndex === 0 ? 'left' : 'right',
      },
    })),
  ];
  slide.addTable([...head, ...body], {
    x: M,
    y,
    w: CONTENT_W,
    h: h ?? Math.min(4.3, 0.42 * (body.length + 1)),
    colW: Array.from({ length: columnCount }, () => CONTENT_W / columnCount),
    border: { type: 'solid', color: COLORS.grid, pt: 0.75 },
    margin: 0.08,
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
  slide.addChart(kind, series, {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    chartColors: PALETTE,
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
  slide.addText(text(spec.title || 'Презентация', { fontSize: SLIDE_TYPE.cover, bold: true, color: COLORS.white }), {
    x: M + 0.2,
    y: 2.4,
    w: CONTENT_W - 0.4,
    h: 1.7,
    valign: 'top',
  });
  if (spec.subtitle) {
    slide.addText(text(spec.subtitle, { fontSize: 16, color: 'C9CCD6' }), {
      x: M + 0.2,
      y: 4.15,
      w: CONTENT_W - 1.6,
      h: 1.0,
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
    tableBlock(slide, spec.table, { y: bodyY, h: Math.max(1.5, H - bodyY - 1.0) });
  }
  footer(slide, meta);
}

function visualSlide(slide, spec, meta) {
  heading(slide, { kicker: spec.kicker, title: spec.title, wide: true });
  if (spec.kpi?.length) kpiRow(slide, spec.kpi);
  if (spec.chart) {
    chartBlock(slide, spec.chart, { x: M, y: 2.35, w: CONTENT_W, h: H - 3.1 });
  } else if (spec.table) {
    tableBlock(slide, spec.table);
  }
  const bullets = toList(spec.bullets);
  if (bullets.length) {
    slide.addText(bulletBlock(bullets, { fontSize: 13 }), {
      x: M,
      y: H - 1.55,
      w: CONTENT_W,
      h: 0.8,
      valign: 'top',
    });
  }
  footer(slide, meta);
}

function quoteSlide(slide, spec, meta) {
  background(slide, COLORS.soft);
  slide.addShape('rect', { x: M, y: 2.2, w: 0.08, h: 2.6, fill: { color: COLORS.accent }, line: { width: 0 } });
  slide.addText(text(spec.title || spec.quote || '', { fontSize: 26, bold: false, color: COLORS.navy }), {
    x: M + 0.4,
    y: 2.2,
    w: CONTENT_W - 0.8,
    h: 2.0,
    valign: 'top',
  });
  const meta2 = [spec.author, spec.subtitle].filter(Boolean).join(' · ');
  if (meta2) {
    slide.addText(text(meta2, { fontSize: 12, color: COLORS.muted }), {
      x: M + 0.4,
      y: 4.3,
      w: CONTENT_W - 0.8,
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
  const meta = { total: slides.length + (spec.cover === false || !spec.title ? 0 : 1), footerText: spec.footerText };

  if (spec.cover !== false && spec.title) {
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
    const slideMeta = { ...meta, index };
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

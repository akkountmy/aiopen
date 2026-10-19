/**
 * Профессиональный Word (.docx) на библиотеке `docx`.
 *
 * Что даёт по сравнению с ручной сборкой XML: настоящие стили, поле оглавления,
 * колонтитулы с номерами страниц, таблицы с повторяющейся шапкой и заливкой,
 * списки нумерацией Word, «не отрывать заголовок от абзаца».
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import { COLORS, DOC_TYPE, FONTS, safeText, toList } from './theme.mjs';

const TWIP_PER_CM = 567;
const PAGE_A4 = { width: Math.round(21 * TWIP_PER_CM), height: Math.round(29.7 * TWIP_PER_CM) };
const MARGIN = { top: 1247, bottom: 1247, left: 1361, right: 1134, header: 708, footer: 708 };
const BODY_WIDTH = PAGE_A4.width - MARGIN.left - MARGIN.right; // twips внутри полей

const run = (text, options = {}) =>
  new TextRun({
    text: String(text ?? ''),
    font: FONTS.sans,
    size: Math.round((options.size ?? DOC_TYPE.body) * 2),
    bold: options.bold === true,
    italics: options.italics === true,
    color: options.color ?? COLORS.ink,
    allCaps: options.caps === true,
    characterSpacing: options.caps ? 20 : undefined,
  });

const para = (text, options = {}) =>
  new Paragraph({
    children: Array.isArray(text) ? text : [run(text, options)],
    alignment: options.align,
    spacing: { before: options.before ?? 0, after: options.after ?? 120, line: options.line ?? 276 },
    keepNext: options.keepNext === true,
    keepLines: options.keepLines === true,
    indent: options.indent,
    border: options.border,
  });

const hairlineBorder = {
  bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.hairline, space: 4 },
};

function cellBorders(fillSides = {}) {
  const none = { style: BorderStyle.NONE, size: 0, color: 'auto' };
  return {
    top: fillSides.top ?? none,
    bottom: fillSides.bottom ?? none,
    left: none,
    right: none,
  };
}

const lineBorder = (color = COLORS.hairline, size = 4) => ({
  style: BorderStyle.SINGLE,
  size,
  color,
  space: 0,
});

function headerBlock({ title, kicker, subtitle, author, date, cover }) {
  if (!cover) {
    const children = [];
    if (kicker) children.push(para(kicker, { size: 9, bold: true, color: COLORS.accent, caps: true, after: 80 }));
    if (title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [run(title, { size: DOC_TYPE.title, bold: true, color: COLORS.navy })], spacing: { after: 160 } }));
    if (subtitle) children.push(para(subtitle, { size: DOC_TYPE.lede, color: COLORS.muted, after: 200 }));
    return children;
  }
  const children = [
    para('', { after: 1600 }),
    para(kicker || '', { size: 9, bold: true, color: COLORS.accent, caps: true, after: 160 }),
    new Paragraph({
      children: [run(title || 'Документ', { size: 34, bold: true, color: COLORS.navy })],
      spacing: { after: 200, line: 480 },
    }),
  ];
  if (subtitle) children.push(para(subtitle, { size: DOC_TYPE.lede, color: COLORS.ink, after: 320, line: 320 }));
  children.push(para('', { after: 240, border: { bottom: lineBorder(COLORS.navy, 6) } }));
  const meta = [author, date].filter(Boolean).join(' · ');
  if (meta) children.push(para(meta, { size: 9, color: COLORS.muted, after: 120 }));
  children.push(new Paragraph({ children: [new PageBreak()] }));
  return children;
}

function kpiBlock(items) {
  if (!items.length) return [];
  const cells = items.slice(0, 4).map(
    (item) =>
      new TableCell({
        width: { size: Math.round(100 / Math.min(items.length, 4)), type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLORS.soft },
        margins: { top: 140, bottom: 140, left: 160, right: 120 },
        borders: cellBorders({ top: lineBorder(COLORS.accent, 18) }),
        verticalAlign: VerticalAlign.CENTER,
        children: [
          para(String(item.value ?? ''), { size: 15, bold: true, color: COLORS.navy, after: 20 }),
          para(String(item.label ?? ''), { size: 8, color: COLORS.muted, caps: true, after: 0 }),
        ],
      }),
  );
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: { style: BorderStyle.NONE, size: 0, color: 'auto' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'auto' }, left: { style: BorderStyle.NONE, size: 0, color: 'auto' }, right: { style: BorderStyle.NONE, size: 0, color: 'auto' }, insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' }, insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' } },
      rows: [new TableRow({ children: cells })],
    }),
    para('', { after: 60 }),
  ];
}

function dataTable(table) {
  const headers = (table?.headers || []).map((value) => String(value ?? ''));
  const rows = (table?.rows || []).filter((row) => Array.isArray(row) && row.length);
  if (!headers.length && !rows.length) return [];
  const columns = Math.max(headers.length, ...rows.map((row) => row.length), 1);
  const numericColumns = new Set(
    (table.numericColumns?.length
      ? table.numericColumns
      : headers.map((_, index) => index).filter((index) => {
          const sample = rows.map((row) => row[index]).filter((value) => value !== '' && value !== null && value !== undefined);
          return sample.length > 0 && sample.every((value) => typeof value === 'number' || /^[-+]?[\d\s.,]+%?$/.test(String(value)));
        })
    ).map((index) => Number(index)),
  );
  const totalRow = table.totalRow === true;

  const headerRow = headers.length
    ? new TableRow({
        tableHeader: true,
        children: headers.map(
          (text, index) =>
            new TableCell({
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLORS.navy },
              margins: { top: 120, bottom: 120, left: 140, right: 140 },
              verticalAlign: VerticalAlign.CENTER,
              children: [
                para(text, {
                  size: DOC_TYPE.table,
                  bold: true,
                  color: COLORS.white,
                  after: 0,
                  align: numericColumns.has(index) ? AlignmentType.RIGHT : AlignmentType.LEFT,
                }),
              ],
            }),
        ),
      })
    : null;

  const bodyRows = rows.map((row, rowIndex) => {
    const isTotal = totalRow && rowIndex === rows.length - 1;
    return new TableRow({
      children: Array.from({ length: columns }, (_, index) => {
        const value = row[index] ?? '';
        return new TableCell({
          shading: isTotal ? { type: ShadingType.CLEAR, color: 'auto', fill: COLORS.soft } : undefined,
          margins: { top: 110, bottom: 110, left: 140, right: 140 },
          borders: cellBorders({ bottom: isTotal ? lineBorder(COLORS.navy, 8) : lineBorder(COLORS.hairline, 4) }),
          children: [
            para(String(value), {
              size: DOC_TYPE.table,
              bold: isTotal,
              after: 0,
              align: numericColumns.has(index) ? AlignmentType.RIGHT : AlignmentType.LEFT,
            }),
          ],
        });
      }),
    });
  });

  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: table.columnWidths?.length === columns ? table.columnWidths.map((w) => Math.round(Number(w) * TWIP_PER_CM)) : undefined,
      borders: { top: { style: BorderStyle.NONE, size: 0, color: 'auto' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'auto' }, left: { style: BorderStyle.NONE, size: 0, color: 'auto' }, right: { style: BorderStyle.NONE, size: 0, color: 'auto' }, insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' }, insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' } },
      rows: headerRow ? [headerRow, ...bodyRows] : bodyRows,
    }),
    para('', { after: 80 }),
  ];
}

function sectionBlock(section, index) {
  const children = [];
  const heading = safeText(section.heading);
  if (heading) {
    const level = index === 0 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_1;
    children.push(
      new Paragraph({
        heading: level,
        children: [run(heading, { size: DOC_TYPE.h1, bold: true, color: COLORS.navy })],
        spacing: { before: index === 0 ? 0 : 320, after: 140, line: 300 },
        keepNext: true,
      }),
    );
  }
  children.push(...kpiBlock(Array.isArray(section.kpi) ? section.kpi : []));
  for (const text of toList(section.paragraphs)) {
    children.push(para(text, { size: DOC_TYPE.body, line: 300, after: 140, align: AlignmentType.JUSTIFIED }));
  }
  for (const item of toList(section.bullets)) {
    children.push(
      new Paragraph({
        children: [run(item, { size: DOC_TYPE.body })],
        bullet: { level: 0 },
        spacing: { after: 80, line: 288 },
      }),
    );
  }
  const subheads = Array.isArray(section.subsections) ? section.subsections : [];
  for (const sub of subheads) {
    const subHeading = safeText(sub.heading);
    if (subHeading) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [run(subHeading, { size: DOC_TYPE.h2, bold: true, color: COLORS.navy })],
          spacing: { before: 200, after: 100, line: 288 },
          keepNext: true,
        }),
      );
    }
    for (const text of toList(sub.paragraphs)) children.push(para(text, { line: 296, after: 120, align: AlignmentType.JUSTIFIED }));
    for (const item of toList(sub.bullets)) {
      children.push(new Paragraph({ children: [run(item)], bullet: { level: 0 }, spacing: { after: 80, line: 288 } }));
    }
    if (sub.table) children.push(...dataTable(sub.table));
  }
  children.push(...dataTable(section.table));
  const note = safeText(section.note);
  if (note) children.push(para(note, { size: DOC_TYPE.caption, color: COLORS.muted, italics: true, after: 200 }));
  return children;
}

function headerLine({ headerText, title }) {
  const text = safeText(headerText || title);
  if (!text) return undefined;
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        border: hairlineBorder,
        spacing: { after: 60 },
        children: [run(text, { size: 8, color: COLORS.muted })],
      }),
    ],
  });
}

function footerLine({ footerText, pageNumbers }) {
  const showPages = pageNumbers !== false;
  const children = [
    run(safeText(footerText) || '', { size: 8, color: COLORS.muted }),
    run('\t', { size: 8 }),
  ];
  if (showPages) {
    children.push(run('стр. ', { size: 8, color: COLORS.muted }));
    children.push(new TextRun({ children: [PageNumber.CURRENT], font: FONTS.sans, size: 16, color: COLORS.muted }));
    children.push(run(' из ', { size: 8, color: COLORS.muted }));
    children.push(new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONTS.sans, size: 16, color: COLORS.muted }));
  }
  return new Footer({
    children: [
      new Paragraph({
        border: { top: lineBorder(COLORS.hairline, 4) },
        tabStops: [{ type: 'right', position: BODY_WIDTH }],
        spacing: { before: 80 },
        children,
      }),
    ],
  });
}

/**
 * Собрать .docx.
 * @param {object} spec — нормализованное описание документа.
 * @returns {Promise<Buffer>}
 */
export async function buildDocxPro(spec = {}) {
  const sections = Array.isArray(spec.sections) ? spec.sections : [];
  const cover = spec.cover === true && Boolean(spec.title);
  const children = [];
  children.push(...headerBlock({
    title: safeText(spec.title),
    kicker: safeText(spec.kicker),
    subtitle: safeText(spec.subtitle),
    author: safeText(spec.author),
    date: safeText(spec.date),
    cover,
  }));
  const toc = spec.toc === true && !cover;
  if (spec.toc === true) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [run('Содержание', { size: DOC_TYPE.h1, bold: true, color: COLORS.navy })],
        spacing: { after: 160 },
      }),
      new TableOfContents('Содержание', { hyperlink: true, headingStyleRange: '1-3' }),
      new Paragraph({ children: [new PageBreak()] }),
    );
  }
  sections.forEach((section, index) => {
    children.push(...sectionBlock(section || {}, index));
  });
  if (!sections.length && !children.length) children.push(para('Документ пуст.', { color: COLORS.muted }));

  const doc = new Document({
    creator: 'DSH Open Web',
    title: safeText(spec.title) || 'Документ',
    description: safeText(spec.subtitle),
    styles: {
      default: {
        document: {
          run: { font: FONTS.sans, size: Math.round(DOC_TYPE.body * 2), color: COLORS.ink },
          paragraph: { spacing: { line: 300, after: 140 } },
        },
      },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONTS.sans, size: Math.round(DOC_TYPE.h1 * 2), bold: true, color: COLORS.navy }, paragraph: { spacing: { before: 320, after: 140 }, keepNext: true, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONTS.sans, size: Math.round(DOC_TYPE.h2 * 2), bold: true, color: COLORS.navy }, paragraph: { spacing: { before: 240, after: 100 }, keepNext: true, outlineLevel: 1 } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONTS.sans, size: Math.round(DOC_TYPE.h3 * 2), bold: true, color: COLORS.navy }, paragraph: { spacing: { before: 200, after: 80 }, keepNext: true, outlineLevel: 2 } },
      ],
    },
    sections: [
      {
        properties: {
          page: { size: { width: PAGE_A4.width, height: PAGE_A4.height }, margin: MARGIN },
        },
        headers: { default: headerLine({ headerText: spec.headerText, title: spec.title }) },
        footers: { default: footerLine({ footerText: spec.footerText, pageNumbers: spec.pageNumbers }) },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

/**
 * Настоящие диаграммы Word: библиотека `docx` их не умеет, поэтому после сборки
 * документа дописываем в пакет часть `word/charts/chartN.xml`, встроенную книгу
 * с данными и заменяем абзац-маркер `[[CHART:n]]` на объект-диаграмму.
 *
 * Диаграмма остаётся живой: в Word работает «Изменить данные» (книга внутри файла),
 * меняются тип, подписи и цвета — это не картинка.
 */
import JSZip from 'jszip';
import { chartXml, rangeRef } from './xlsx-chart.mjs';

const EMU_PER_PX = 9525;
const SHEET_NAME = 'Данные';
const COLUMNS = 'ABCDEFGHIJ';

const xmlEscape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const columnName = (index) => COLUMNS[index] || `A${index}`;

/** Минимальная книга Excel с данными диаграммы: без неё «Изменить данные» не работает. */
async function buildDataWorkbook({ categories, series }) {
  const zip = new JSZip();
  const width = Math.max(categories.length, ...series.map((item) => item.values.length), 0);
  const rows = [];
  const nameCells = series
    .map((item, index) => `<c r="${columnName(index + 1)}1" t="inlineStr"><is><t>${xmlEscape(item.name ?? `Ряд ${index + 1}`)}</t></is></c>`)
    .join('');
  rows.push(`<row r="1">${nameCells}</row>`);
  for (let rowIndex = 0; rowIndex < width; rowIndex += 1) {
    const rowNumber = rowIndex + 2;
    const label = categories[rowIndex];
    const labelCell =
      label === undefined || label === null || label === ''
        ? ''
        : `<c r="A${rowNumber}" t="inlineStr"><is><t>${xmlEscape(label)}</t></is></c>`;
    const valueCells = series
      .map((item, index) => {
        const value = Number(item.values[rowIndex]);
        if (!Number.isFinite(value)) return '';
        return `<c r="${columnName(index + 1)}${rowNumber}"><v>${value}</v></c>`;
      })
      .join('');
    rows.push(`<row r="${rowNumber}">${labelCell}${valueCells}</row>`);
  }

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(SHEET_NAME)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`,
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Ссылки на диапазоны во встроенной книге: подписи — в A, значения — по колонкам. */
function seriesForChart(chart) {
  const categories = (chart.categories || []).map((item) => String(item ?? ''));
  const lastRow = Math.max(categories.length, ...chart.series.map((item) => item.values.length), 1) + 1;
  return chart.series.map((item, index) => {
    const column = columnName(index + 1);
    return {
      name: item.name,
      nameRef: rangeRef(SHEET_NAME, `$${column}$1`, `$${column}$1`),
      catRef: rangeRef(SHEET_NAME, '$A$2', `$A$${lastRow}`),
      valRef: rangeRef(SHEET_NAME, `$${column}$2`, `$${column}$${lastRow}`),
      values: item.values,
      categories,
    };
  });
}

/** Абзац с диаграммой: инлайн-объект внутри текста, ширина по полям страницы. */
function drawingParagraph({ relId, prId, widthPx, heightPx, name }) {
  const cx = Math.round(widthPx * EMU_PER_PX);
  const cy = Math.round(heightPx * EMU_PER_PX);
  return `<w:p><w:pPr><w:spacing w:before="140" w:after="180"/><w:jc w:val="center"/><w:keepNext w:val="false"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${prId}" name="${xmlEscape(name)}"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${relId}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/** Заменить абзац с маркером [[CHART:n]] на абзац с объектом-диаграммой. */
function replacePlaceholder(documentXml, index, paragraph) {
  const marker = `[[CHART:${index}]]`;
  const pattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let match;
  while ((match = pattern.exec(documentXml))) {
    if (!match[0].includes(marker)) continue;
    return `${documentXml.slice(0, match.index)}${paragraph}${documentXml.slice(match.index + match[0].length)}`;
  }
  /* Маркер потерялся (например, его съел XML-редактор) — диаграмму всё равно
     показываем, но в начале тела: лучше не там, чем никак. */
  return documentXml.replace(/<w:body>/, `<w:body>${paragraph}`);
}

function nextRelationshipId(rels) {
  let max = 0;
  for (const match of rels.matchAll(/Id="rId(\d+)"/g)) max = Math.max(max, Number(match[1]));
  return max + 1;
}

/**
 * Дописать в готовый .docx диаграммы.
 * @param {Buffer} buffer — документ, собранный библиотекой `docx`
 * @param {Array<{type:string,title:string,categories:string[],series:Array<{name:string,values:number[]}>,width?:number,height?:number}>} charts
 * @param {{widthPx?:number,heightPx?:number}} [options]
 * @returns {Promise<Buffer>}
 */
export async function injectWordCharts(buffer, charts = [], options = {}) {
  if (!Array.isArray(charts) || !charts.length) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  let documentXml = await zip.file('word/document.xml').async('string');
  let rels = await zip.file('word/_rels/document.xml.rels').async('string');
  let contentTypes = await zip.file('[Content_Types].xml').async('string');
  const overrides = [];
  const chartRels = [];
  let placed = 0;

  for (const [index, chart] of charts.entries()) {
    const number = index + 1;
    const series = seriesForChart(chart);
    const widthPx = Math.round(Number(chart.width) || options.widthPx || 620);
    const heightPx = Math.round(Number(chart.height) || options.heightPx || 340);
    const chartRelId = `rId${nextRelationshipId(rels)}`;
    const dataRelId = 'rId1';

    const chartBody = chartXml({ type: chart.type, title: chart.title, series });
    /* Ссылка на встроенную книгу: без неё Word показывает диаграмму, но
       не даёт её редактировать. */
    const chartPart = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${chartBody.replace(
      '</c:chartSpace>',
      `<c:externalData xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${dataRelId}"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`,
    )}`;

    zip.file(`word/charts/chart${number}.xml`, chartPart);
    zip.file(
      `word/charts/_rels/chart${number}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="${dataRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/chart${number}.xlsx"/></Relationships>`,
    );
    zip.file(`word/embeddings/chart${number}.xlsx`, await buildDataWorkbook({ categories: chart.categories || [], series }));
    overrides.push(
      `<Override PartName="/word/charts/chart${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
    );

    rels = rels.replace(
      '</Relationships>',
      `<Relationship Id="${chartRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart${number}.xml"/></Relationships>`,
    );
    chartRels.push({ relId: chartRelId, number });

    const paragraph = drawingParagraph({
      relId: chartRelId,
      prId: 900 + number,
      widthPx,
      heightPx,
      name: `Диаграмма ${number}`,
    });
    const next = replacePlaceholder(documentXml, index, paragraph);
    if (next !== documentXml) placed += 1;
    documentXml = next;
  }

  if (!contentTypes.includes('Extension="xlsx"')) {
    contentTypes = contentTypes.replace(
      /(<Types[^>]*>)/,
      '$1<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>',
    );
  }
  contentTypes = contentTypes.replace('</Types>', `${overrides.join('')}</Types>`);

  zip.file('word/document.xml', documentXml);
  zip.file('word/_rels/document.xml.rels', rels);
  zip.file('[Content_Types].xml', contentTypes);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export { SHEET_NAME, seriesForChart };

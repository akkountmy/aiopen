/**
 * Настоящие диаграммы Excel: в книгах, собранных ExcelJS, диаграмм нет вовсе,
 * поэтому после сборки дописываем в пакет части drawing/chart и связываем их с листом.
 * Работает через jszip и остаётся совместимым с Excel, LibreOffice и Google Sheets.
 */
import JSZip from 'jszip';

const CHART_TYPES = new Set(['bar', 'column', 'line', 'pie', 'area', 'doughnut']);
const PALETTE = ['D4564A', '10233F', '8A8C96', 'E0B04A', '4A7FB5', '7A9E5B', 'B4708A', '4FA3A0'];

const xmlEscape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const EMU_PER_PX = 9525;
const px = (value) => Math.round(Number(value) * EMU_PER_PX);

/** Адрес диапазона на листе: 'Лист'!$B$2:$B$5 */
function rangeRef(sheetName, from, to) {
  const quoted = `'${String(sheetName).replace(/'/g, "''")}'`;
  return `${quoted}!${from}${to === from ? '' : `:${to}`}`;
}

function seriesXml({ name, nameRef, catRef, valRef, values, categories, index, isPie, total }) {
  /* Один ряд — тёмно-синий, как в отчётах; палитра нужна только когда рядов
     несколько, иначе первая же красная серия выглядит как тревога. */
  const color = total === 1 && !isPie ? '10233F' : PALETTE[(isPie ? 0 : index) % PALETTE.length];
  const catPoints = categories.length
    ? `<c:cat><c:strRef><c:f>${xmlEscape(catRef)}</c:f><c:strCache><c:ptCount val="${categories.length}"/>${categories
        .map((label, i) => `<c:pt idx="${i}"><c:v>${xmlEscape(label)}</c:v></c:pt>`)
        .join('')}</c:strCache></c:strRef></c:cat>`
    : '';
  const valPoints = values.length
    ? `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values
        .map((value, i) => `<c:pt idx="${i}"><c:v>${Number(value) || 0}</c:v></c:pt>`)
        .join('')}</c:numCache>`
    : '';
  const namePart = name
    ? `<c:tx><c:strRef><c:f>${xmlEscape(nameRef)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEscape(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>`
    : '';
  /* У круговой диаграммы красим каждый сектор отдельно, у остальных — весь ряд. */
  const colors = isPie
    ? values
        .map(
          (_, i) =>
            `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${PALETTE[i % PALETTE.length]}"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`,
        )
        .join('')
    : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>`;
  return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>${namePart}${colors}${
    isPie ? '' : '<c:invertIfNegative val="0"/>'
  }${catPoints}<c:val><c:numRef><c:f>${xmlEscape(valRef)}</c:f>${valPoints}</c:numRef></c:val></c:ser>`;
}

const AX_IDS = '<c:axId val="111111111"/><c:axId val="222222222"/>';

function chartBody(kind, seriesXmlText) {
  switch (kind) {
    case 'pie':
      return `<c:pieChart><c:varyColors val="1"/>${seriesXmlText}<c:firstSliceAng val="0"/></c:pieChart>`;
    case 'doughnut':
      return `<c:doughnutChart><c:varyColors val="1"/>${seriesXmlText}<c:holeSize val="50"/><c:firstSliceAng val="0"/></c:doughnutChart>`;
    case 'line':
      return `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${seriesXmlText}<c:marker val="1"/><c:smooth val="0"/>${AX_IDS}</c:lineChart>`;
    case 'area':
      return `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${seriesXmlText}${AX_IDS}</c:areaChart>`;
    case 'bar':
      return `<c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/><c:varyColors val="0"/>${seriesXmlText}<c:gapWidth val="70"/><c:overlap val="-10"/>${AX_IDS}</c:barChart>`;
    case 'column':
    default:
      return `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${seriesXmlText}<c:gapWidth val="70"/><c:overlap val="-10"/>${AX_IDS}</c:barChart>`;
  }
}

function chartXml({ type, title, series, anchor }) {
  const kind = CHART_TYPES.has(type) ? type : 'column';
  const isPie = kind === 'pie' || kind === 'doughnut';
  const multiple = series.length > 1;
  const header = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>`;
  const titleXml = title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1200" b="1"><a:solidFill><a:srgbClr val="10233F"/></a:solidFill><a:latin typeface="Segoe UI"/></a:defRPr></a:pPr><a:r><a:rPr lang="ru-RU" sz="1200" b="1"><a:solidFill><a:srgbClr val="10233F"/></a:solidFill><a:latin typeface="Segoe UI"/></a:rPr><a:t>${xmlEscape(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
    : '<c:autoTitleDeleted val="1"/>';
  const legend = multiple || kind === 'pie' || kind === 'doughnut'
    ? '<c:legend><c:legendPos val="t"/><c:overlay val="0"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:latin typeface="Segoe UI"/></a:defRPr></a:pPr><a:endParaRPr lang="ru-RU"/></a:p></c:txPr></c:legend>'
    : '';
  const seriesXmlText = series.map((item, index) => seriesXml({ ...item, index, isPie, total: series.length })).join('');
  const plotInner = chartBody(kind, seriesXmlText);
  /* Длинные подписи по горизонтали ломаются посередине слова — при 8+ категориях
     поворачиваем их на 45° и уменьшаем кегль, как это делает сам Excel. */
  const categoryCount = (series[0]?.categories || []).length;
  const rotate = !isPie && kind !== 'bar' && categoryCount > 7;
  const catBody = rotate ? '<a:bodyPr rot="-2700000" vert="horz"/>' : '<a:bodyPr/>';
  const catFontSize = categoryCount > 12 ? 800 : 900;
  const catTxPr = `<c:txPr>${catBody}<a:lstStyle/><a:p><a:pPr><a:defRPr sz="${catFontSize}"><a:solidFill><a:srgbClr val="6B6D76"/></a:solidFill><a:latin typeface="Segoe UI"/></a:defRPr></a:pPr><a:endParaRPr lang="ru-RU"/></a:p></c:txPr>`;
  const axes = isPie
    ? ''
    : `<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/>${catTxPr}</c:catAx><c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="E2E2E8"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="111111111"/><c:crosses val="autoZero"/><c:crossBetween val="between"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:solidFill><a:srgbClr val="6B6D76"/></a:solidFill><a:latin typeface="Segoe UI"/></a:defRPr></a:pPr><a:endParaRPr lang="ru-RU"/></a:p></c:txPr></c:valAx>`;
  const footer = `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
  return `${header}${titleXml}<c:plotArea><c:layout/>${plotInner}${axes}</c:plotArea>${legend}${footer}`;
}

function drawingXml({ anchor, chartRelId }) {
  const { col: fromCol, row: fromRow, toCol, toRow } = anchor;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor><xdr:from><xdr:col>${fromCol}</xdr:col><xdr:colOff>${px(8)}</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>${px(8)}</xdr:rowOff></xdr:from><xdr:to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Диаграмма ${anchor.index}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${chartRelId}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
}

const colToIndex = (letters) => {
  let index = 0;
  for (const char of String(letters).toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
};

/** 'G2' → {col: 6, row: 1} */
function parseAnchorCell(cell) {
  const match = String(cell || 'G2').toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!match) return { col: 6, row: 1 };
  return { col: colToIndex(match[1]), row: Number(match[2]) - 1 };
}

/**
 * Дописать диаграммы в готовый .xlsx.
 * @param {Buffer} buffer — книга, собранная ExcelJS
 * @param {Array<object>} charts — [{sheetIndex, sheetName, type, title, position, width, height, categories:{from,to,cells}, series:[{name,nameRef,from,to,values}]}]
 * @returns {Promise<Buffer>}
 */
export async function injectCharts(buffer, charts = []) {
  if (!charts.length) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  const contentTypesPath = '[Content_Types].xml';
  let contentTypes = await zip.file(contentTypesPath).async('string');
  const overrides = [];
  const sheetDrawingRels = new Map(); // sheetIndex → {path, entries: []}

  for (const [index, chart] of charts.entries()) {
    const chartNumber = index + 1;
    const drawingNumber = index + 1;
    const anchor = {
      ...parseAnchorCell(chart.position),
      toCol: parseAnchorCell(chart.position).col + Math.max(4, Math.round((chart.width || 640) / 64)),
      toRow: parseAnchorCell(chart.position).row + Math.max(8, Math.round((chart.height || 320) / 20)),
      index: chartNumber,
    };
    zip.file(`xl/charts/chart${chartNumber}.xml`, chartXml({
      type: chart.type,
      title: chart.title,
      series: chart.series,
      anchor,
    }));
    zip.file(`xl/drawings/drawing${drawingNumber}.xml`, drawingXml({ anchor, chartRelId: 'rId1' }));
    zip.file(
      `xl/drawings/_rels/drawing${drawingNumber}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartNumber}.xml"/></Relationships>`,
    );
    overrides.push(`<Override PartName="/xl/charts/chart${chartNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
    overrides.push(`<Override PartName="/xl/drawings/drawing${drawingNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);

    const sheetIndex = Number(chart.sheetIndex) || 0;
    const relsPath = `xl/worksheets/_rels/sheet${sheetIndex + 1}.xml.rels`;
    const state = sheetDrawingRels.get(sheetIndex) || { path: relsPath, entries: [], drawingId: drawingNumber };
    state.entries.push({ id: `rIdChart${chartNumber}`, target: `../drawings/drawing${drawingNumber}.xml` });
    state.drawingId = drawingNumber;
    sheetDrawingRels.set(sheetIndex, state);
  }

  // Лист получает ссылку на drawing и Relationship
  for (const [sheetIndex, state] of sheetDrawingRels) {
    const sheetPath = `xl/worksheets/sheet${sheetIndex + 1}.xml`;
    let sheet = await zip.file(sheetPath).async('string');
    if (!/<drawing\b/.test(sheet)) {
      sheet = sheet.replace('</worksheet>', `<drawing r:id="${state.entries[0].id}"/></worksheet>`);
      zip.file(sheetPath, sheet);
    }
    const existing = zip.file(state.path);
    let rels = existing ? await existing.async('string') : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    for (const entry of state.entries) {
      if (rels.includes(`Id="${entry.id}"`)) continue;
      rels = rels.replace(
        '</Relationships>',
        `<Relationship Id="${entry.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="${entry.target}"/></Relationships>`,
      );
    }
    zip.file(state.path, rels);
  }

  contentTypes = contentTypes.replace('</Types>', `${overrides.join('')}</Types>`);
  zip.file(contentTypesPath, contentTypes);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export { rangeRef, parseAnchorCell, CHART_TYPES };

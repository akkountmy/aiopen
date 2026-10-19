/**
 * Профессиональный Excel (.xlsx) на ExcelJS + собственные диаграммы.
 *
 * Даёт то, чего нет в ручной сборке листов: живые формулы, форматы чисел,
 * закреплённые шапки, автофильтр, условное форматирование, оформление таблиц,
 * настройки печати и настоящие объекты-диаграммы внутри книги.
 */
import ExcelJS from 'exceljs';
import { COLORS, toList } from './theme.mjs';
import { injectCharts } from './xlsx-chart.mjs';

const argb = (value) => `FF${String(value).replace(/^#/, '').toUpperCase()}`;
const thin = { style: 'thin', color: { argb: argb(COLORS.hairline) } };
const medium = { style: 'medium', color: { argb: argb(COLORS.navy) } };

const isFormula = (value) => typeof value === 'string' && value.startsWith('=');

/**
 * Формат числа — в канонический вид. «# ##0», как пишут руками по-русски, Excel
 * применяет только к последним разрядам и показывает «20400 000»; запятая —
 * разделитель групп, который Excel сам рисует пробелом в русской локали.
 */
function normaliseNumFmt(format) {
  if (!format) return format;
  return String(format)
    .trim()
    .replace(/([#0])\s+([#0])/g, '$1,$2');
}

function normaliseCell(value) {
  if (isFormula(value)) return { formula: value.slice(1) };
  if (value === null || value === undefined || value === '') return null;
  return value;
}

function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function styleHeaderRow(row, columnCount) {
  row.height = 26;
  for (let index = 1; index <= columnCount; index += 1) {
    const cell = row.getCell(index);
    cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: argb(COLORS.white) } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(COLORS.navy) } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: argb(COLORS.navy) } } };
  }
}

function buildSheet(workbook, sheet, index) {
  const columns = Array.isArray(sheet.columns) ? sheet.columns : [];
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const hasHeader = sheet.header !== false && columns.length > 0;
  const columnCount = Math.max(columns.length, ...rows.map((row) => (Array.isArray(row) ? row.length : 0)), 1);

  const worksheet = workbook.addWorksheet(String(sheet.name || `Лист ${index + 1}`).slice(0, 31), {
    views: sheet.freeze === false ? [] : [{ state: 'frozen', ySplit: hasHeader ? 1 : 0, xSplit: Number(sheet.freezeColumns) || 0 }],
    pageSetup: {
      orientation: sheet.landscape === false ? 'portrait' : 'landscape',
      fitToPage: true,
      fitToWidth: Number(sheet.fitToWidth) || 1,
      fitToHeight: Number(sheet.fitToHeight) || 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
      horizontalCentered: false,
    },
    properties: { defaultRowHeight: 16 },
  });

  /* Ширины задаём колонкам, а шапку и данные добавляем строками вручную:
     так номер строки всегда известен и не зависит от автоматической шапки ExcelJS. */
  worksheet.columns = Array.from({ length: columnCount }, (_, columnIndex) => {
    const column = columns[columnIndex] || {};
    return {
      width: Number(column.width) || (columnIndex === 0 ? 24 : 16),
      style: {
        font: { name: 'Segoe UI', size: 10 },
        alignment: { vertical: 'middle', horizontal: column.align || (Number(column.numeric) ? 'right' : 'left'), wrapText: column.wrap !== false },
        numFmt: normaliseNumFmt(column.numFmt),
      },
    };
  });

  if (sheet.title) {
    const titleText = String(sheet.title).slice(0, 200);
    worksheet.mergeCells(1, 1, 1, columnCount);
    const cell = worksheet.getCell(1, 1);
    cell.value = titleText;
    cell.font = { name: 'Segoe UI', size: 14, bold: true, color: { argb: argb(COLORS.navy) } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    worksheet.getRow(1).height = 30;
  }

  let headerRowNumber = 0;
  if (hasHeader) {
    headerRowNumber = worksheet.rowCount + 1;
    worksheet.addRow(columns.map((column) => String(column.header ?? '')));
  }
  const firstDataRow = worksheet.rowCount + 1;
  for (const rowValues of rows) {
    const values = Array.from({ length: columnCount }, (_, columnIndex) => normaliseCell((rowValues || [])[columnIndex]));
    worksheet.addRow(values);
  }

  if (hasHeader) styleHeaderRow(worksheet.getRow(headerRowNumber), columnCount);

  const lastRow = worksheet.rowCount;
  /* «Итого» модель часто пишет обычной строкой, не помечая её флагом. Узнаём
     итог по подписи в первой колонке — иначе он попадает в диаграмму и
     последний столбец вырастает в разы, ломая масштаб. */
  const firstCell = worksheet.getRow(lastRow).getCell(1).value;
  const lastRowLabel = typeof firstCell === 'string' ? firstCell.trim() : '';
  const totalRowDetected = sheet.totalRow === true
    /* `\b` в JS считается по ASCII, поэтому после кириллицы границы слова нет:
       проверяем явно конец строки или разделитель. */
    || /^(итог|итого|всего|total)(\s|$|[:.,—-])/i.test(lastRowLabel);
  for (let rowNumber = firstDataRow; rowNumber <= lastRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const isTotal = totalRowDetected && rowNumber === lastRow;
    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
      const cell = row.getCell(columnIndex);
      const column = columns[columnIndex - 1] || {};
      if (column.numFmt) cell.numFmt = normaliseNumFmt(column.numFmt);
      cell.font = { name: 'Segoe UI', size: 10, bold: isTotal, color: { argb: argb(COLORS.ink) } };
      cell.alignment = { vertical: 'middle', horizontal: column.align || (Number(column.numeric) ? 'right' : 'left'), wrapText: column.wrap !== false };
      cell.border = isTotal ? { top: medium } : { bottom: thin };
      if (isTotal) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(COLORS.soft) } };
      /* Лёгкая полосатость: длинную таблицу читаешь по строке и не съезжаешь. */
      else if (sheet.banding !== false && (rowNumber - firstDataRow) % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(COLORS.band) } };
      }
    }
    /* Итог часто длиннее колонки («Итого за 12 месяцев»): высоту не фиксируем,
       иначе вторая строка подписи налезает на соседнюю строку. */
    if (!isTotal) row.height = 18;
  }

  if (hasHeader && sheet.autoFilter !== false && rows.length > 0) {
    worksheet.autoFilter = {
      from: { row: headerRowNumber, column: 1 },
      to: { row: headerRowNumber + rows.length, column: columnCount },
    };
  }

  const rules = Array.isArray(sheet.conditional) ? sheet.conditional : [];
  for (const rule of rules) {
    const range = String(rule.range || '').replace(/\$/g, '');
    if (!range) continue;
    worksheet.addConditionalFormatting({
      ref: range,
      rules: [
        {
          type: 'colorScale',
          cfvo: [{ type: 'min' }, { type: 'max' }],
          color: [{ argb: argb(rule.from || 'F8D7DA') }, { argb: argb(rule.to || 'D4EDDA') }],
        },
      ],
    });
  }

  if (sheet.note) {
    const noteRow = worksheet.rowCount + 2;
    /* Сноска идёт через всю таблицу: в одной узкой колонке она рвётся по слогам. */
    if (columnCount > 1) worksheet.mergeCells(noteRow, 1, noteRow, columnCount);
    /* Объединённую ячейку Excel по ширине не переносит — режем строку сами и
       вставляем явные переводы строк, тогда текст виден и в книге, и в печати. */
    const mergedWidth = columns.slice(0, columnCount).reduce((sum, column) => sum + (Number(column.width) || 12), 0);
    const charsPerLine = Math.max(20, Math.round(mergedWidth * 1.05));
    const words = String(sheet.note).split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
      if (current && current.length + 1 + word.length > charsPerLine) {
        lines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) lines.push(current);
    const cell = worksheet.getCell(noteRow, 1);
    cell.value = lines.join('\n');
    cell.font = { name: 'Segoe UI', size: 9, italic: true, color: { argb: argb(COLORS.muted) } };
    cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
    worksheet.getRow(noteRow).height = 12 * lines.length + 4;
  }

  worksheet.headerFooter = {
    oddFooter: `&L${String(sheet.footer || '')}&Rстр. &P из &N`,
  };
  worksheet.pageSetup.printTitlesRow = hasHeader ? `${headerRowNumber}:${headerRowNumber}` : undefined;

  return { worksheet, headerRowNumber, firstDataRow, lastRow, columnCount, totalRow: totalRowDetected };
}

/** Диаграмма из листа: категории в колонке categoriesColumn, значения — в valueColumns. */
function chartSpecFor(sheet, built, sheetIndex) {
  const chart = sheet.chart;
  if (!chart) return null;
  const categoriesColumn = Number(chart.categoriesColumn) || 1;
  const valueColumns = (Array.isArray(chart.valueColumns) && chart.valueColumns.length ? chart.valueColumns : [Math.min(categoriesColumn + 1, built.columnCount)]).map(Number);
  const from = built.firstDataRow;
  /* Строка «Итого» в диаграмму не идёт: итог — не точка ряда, из-за него
     последний столбец вырастает в разы и ломает масштаб всего графика. */
  const to = built.totalRow === true ? built.lastRow - 1 : built.lastRow;
  if (to < from) return null;
  const categories = [];
  for (let rowNumber = from; rowNumber <= to; rowNumber += 1) {
    const value = built.worksheet.getCell(rowNumber, categoriesColumn).value;
    categories.push(value === null || value === undefined ? '' : String(typeof value === 'object' ? value.result ?? '' : value));
  }
  const series = valueColumns.map((columnIndex) => {
    const values = [];
    for (let rowNumber = from; rowNumber <= to; rowNumber += 1) {
      const raw = built.worksheet.getCell(rowNumber, columnIndex).value;
      const resolved = raw && typeof raw === 'object' ? raw.result ?? 0 : raw;
      values.push(Number(resolved) || 0);
    }
    const headerValue = built.headerRowNumber ? built.worksheet.getCell(built.headerRowNumber, columnIndex).value : '';
    const letter = columnLetter(columnIndex - 1);
    return {
      name: headerValue ? String(headerValue) : `Ряд ${columnIndex}`,
      nameRef: `${quoteSheet(sheet.name)}!$${letter}$${built.headerRowNumber || 1}`,
      from: `$${letter}$${from}`,
      to: `$${letter}$${to}`,
      catRef: `${quoteSheet(sheet.name)}!$${columnLetter(categoriesColumn - 1)}$${from}:$${columnLetter(categoriesColumn - 1)}$${to}`,
      valRef: `${quoteSheet(sheet.name)}!$${letter}$${from}:$${letter}$${to}`,
      values,
      categories,
    };
  });
  return {
    sheetIndex,
    sheetName: sheet.name,
    type: chart.type || 'column',
    title: chart.title || '',
    position: chart.position || 'G2',
    width: Number(chart.width) || 640,
    height: Number(chart.height) || 320,
    series,
  };
}

const quoteSheet = (name) => `'${String(name || 'Лист 1').replace(/'/g, "''")}'`;

/**
 * Собрать книгу .xlsx.
 * @param {{sheets: Array<object>}} spec
 * @returns {Promise<Buffer>}
 */
export async function buildXlsxPro(spec = {}) {
  const sheets = Array.isArray(spec.sheets) ? spec.sheets : [];
  if (!sheets.length) throw new Error('Нужен хотя бы один лист');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DSH Open Web';
  workbook.lastModifiedBy = 'DSH Open Web';
  workbook.created = new Date();
  workbook.modified = new Date();
  /* Формулы считаются при открытии: иначе книга показывает пустые ячейки, пока
     пользователь не нажмёт F9, а диаграммы — значения из кэша (нули). */
  workbook.calcProperties = { fullCalcOnLoad: true };

  const charts = [];
  sheets.forEach((sheet, index) => {
    const built = buildSheet(workbook, sheet || {}, index);
    const chart = chartSpecFor(sheet || {}, built, index);
    if (chart) charts.push(chart);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return injectCharts(Buffer.from(buffer), charts);
}

export { toList };

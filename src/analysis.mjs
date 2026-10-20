/**
 * Анализ больших таблиц без Python: потоковый разбор CSV/XLSX, профилирование
 * колонок и агрегация в стиле SQL (group by + метрики).
 *
 * Зачем отдельный модуль: в облаке (Amvera, чистый Node) Python нет, а файлы в
 * 100+ тысяч строк обычным чтением не разобрать — `read_file` вернёт только
 * кусок. Здесь файл читается потоком: память зависит от числа групп, а не от
 * числа строк.
 *
 * Три режима:
 *  - sheets  — какие листы в книге (для XLSX) и какая в них шапка;
 *  - profile — что в данных: типы, пропуски, уникальные, диапазон, медиана,
 *              хвост (p95), частые значения. Первый шаг любого анализа;
 *  - query   — фильтры, составные группы (в том числе по месяцу/кварталу),
 *              метрики (sum/avg/median/p95/...), сортировка, лимит.
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

const MAX_ROWS = Number.POSITIVE_INFINITY;
const SAMPLE_SIZE = 20000;
const MAX_DISTINCT = 5000;
const MAX_METRIC_VALUES = 400000;

export const AGGREGATES = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max', 'median', 'p95', 'stddev'];

const FILTER_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'endsWith', 'in', 'notIn', 'between', 'empty', 'notEmpty']);

/* ---------------------------- значения и числа ---------------------------- */

const CURRENCY = /[₽$€₸¥£]|руб\.?|тенге|тг\.?/gi;

/** Число из «1 234 567,89», «12,5%», «$1,200» и обычного 1234.567. */
export function toNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  let text = String(value).trim();
  if (!text) return null;
  let percent = false;
  if (text.endsWith('%')) {
    percent = true;
    text = text.slice(0, -1);
  }
  text = text.replace(CURRENCY, '').replace(/[\s\u00a0\u202f']/g, '');
  const both = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text);
  if (both) text = text.replace(/,/g, '');
  else text = text.replace(',', '.');
  if (!/^[-+]?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(text)) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return percent ? number / 100 : number;
}

/** Дата из «2024-03-01», «01.03.2024», «1 мар 2024», ISO с временем. */
export function toDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    /* Excel хранит дату без часового пояса. exceljs отдаёт её как местную
       полночь, а дата, собранная в коде через Date.UTC, приходит как полночь
       UTC. Берём тот календарный день, который в своём поясе оказывается
       полуночью, и переводим его в UTC-полночь: ниже везде читаются UTC-части,
       иначе в поясе UTC+3 дата уезжает на день назад (1 января → 31 декабря,
       и в группировке появляется лишний месяц). */
    const localMidnight = value.getHours() === 0 && value.getMinutes() === 0;
    const year = localMidnight ? value.getFullYear() : value.getUTCFullYear();
    const month = localMidnight ? value.getMonth() : value.getUTCMonth();
    const day = localMidnight ? value.getDate() : value.getUTCDate();
    return new Date(Date.UTC(year, month, day));
  }
  if (typeof value === 'number') {
    // Excel-дата числом: серийный номер от 30.12.1899.
    if (value > 20000 && value < 80000) return new Date(Math.round((value - 25569) * 86400000));
    return null;
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(text);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)));
  m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(text);
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0)));
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  m = /^(\d{1,2})\s+([а-яё]{3,})\.?\s+(\d{4})$/i.exec(text);
  if (m) {
    const index = months.findIndex((name) => m[2].toLowerCase().startsWith(name));
    if (index >= 0) return new Date(Date.UTC(Number(m[3]), index, Number(m[1])));
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  // Встроенный парсер V8 слишком мягкий («Клиент 0» → 1999-12-31), поэтому
  // пускаем его только для строк, похожих на дату.
  const digits = (text.match(/\d/g) || []).length;
  const year = parsed.getUTCFullYear();
  if (digits < 6 || year < 1900 || year > 2100) return null;
  return parsed;
}

export function datePart(date, part) {
  const pad = (value) => String(value).padStart(2, '0');
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  switch (String(part || 'month').toLowerCase()) {
    case 'year':
      return String(year);
    case 'quarter':
      return `${year}-Q${Math.ceil(month / 3)}`;
    case 'month':
      return `${year}-${pad(month)}`;
    case 'week': {
      const start = new Date(Date.UTC(year, 0, 1));
      const week = Math.ceil(((date - start) / 86400000 + start.getUTCDay() + 1) / 7);
      return `${year}-W${pad(week)}`;
    }
    case 'day':
      return `${year}-${pad(month)}-${pad(date.getUTCDate())}`;
    default:
      return `${year}-${pad(month)}`;
  }
}

/* ------------------------------- чтение CSV ------------------------------- */

function pickDelimiter(sample) {
  const candidates = [';', ',', '\t', '|'];
  const firstLine = sample.split(/\r?\n/).find((line) => line.trim()) || '';
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** Потоковый разбор CSV: кавычки, "" внутри кавычек, переводы строк в полях. */
async function* csvRows(filePath, { delimiter, encoding = 'utf8' }) {
  const decoder = new TextDecoder(encoding === 'win1251' || encoding === 'windows-1251' ? 'windows-1251' : 'utf-8');
  const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
  let field = '';
  let row = [];
  let inQuotes = false;
  let pendingQuote = false;
  const push = () => {
    row.push(field);
    field = '';
  };
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (pendingQuote) {
          pendingQuote = false;
          if (ch === '"') {
            field += '"';
            continue;
          }
          inQuotes = false;
          // попали сюда — обрабатываем текущий символ как обычный
        } else if (ch === '"') {
          pendingQuote = true;
          continue;
        } else {
          field += ch;
          continue;
        }
      }
      if (ch === '"') inQuotes = true;
      else if (ch === delimiter) push();
      else if (ch === '\n') {
        push();
        yield row;
        row = [];
      } else if (ch !== '\r') field += ch;
    }
  }
  const tail = decoder.decode();
  if (tail) field += tail;
  if (field || row.length) {
    push();
    yield row;
  }
}

/* ------------------------------- чтение XLSX ------------------------------ */

function cellValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
  if (value.text != null && typeof value.text === 'string') return value.text;
  if (value.result != null) return value.result;
  if (value.error) return null;
  return null;
}

function rowToArray(row) {
  const values = Array.isArray(row.values) ? row.values.slice(1) : [];
  const out = [];
  for (let i = 0; i < values.length; i++) {
    let cell = values[i];
    if (cell && typeof cell === 'object' && !(cell instanceof Date)) cell = cellValue(cell);
    out.push(cell == null ? null : cell);
  }
  while (out.length && (out[out.length - 1] == null || out[out.length - 1] === '')) out.pop();
  return out;
}

const XLSX_MAX_BYTES = 40 * 1024 * 1024;

/**
 * Книга читается целиком (потоковый ридер ExcelJS теряет имена листов и падает
 * на части файлов), поэтому для .xlsx есть лимит размера. Большие объёмы —
 * это CSV: он разбирается потоком и не ограничен по числу строк.
 */
async function openWorkbook(filePath) {
  const size = fs.statSync(filePath).size;
  if (size > XLSX_MAX_BYTES) {
    throw new Error(
      `Книга ${(size / 1048576).toFixed(0)} МБ больше лимита ${XLSX_MAX_BYTES / 1048576} МБ для .xlsx. `
      + 'Сохрани нужный лист в CSV (или разбей на файлы по годам/месяцам) и анализируй CSV: он читается потоком без ограничения по строкам.',
    );
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook;
}

async function listSheets(filePath) {
  const workbook = await openWorkbook(filePath);
  return workbook.worksheets.map((worksheet) => {
    const header = [];
    const row = worksheet.getRow(1);
    for (let col = 1; col <= row.cellCount; col++) header.push(String(row.getCell(col).text ?? '').trim());
    while (header.length && !header[header.length - 1]) header.pop();
    return { name: worksheet.name, header, rows: Math.max(0, worksheet.actualRowCount - 1) };
  });
}

async function* xlsxRows(filePath, { sheet, headerRow = 1 }) {
  const workbook = await openWorkbook(filePath);
  const wanted = sheet == null || String(sheet).trim() === '' ? null : String(sheet).trim().toLowerCase();
  const worksheet = wanted == null
    ? workbook.worksheets[0]
    : workbook.worksheets.find((item) => item.name.trim().toLowerCase() === wanted) || workbook.worksheets[Number(wanted) - 1];
  if (!worksheet) throw new Error(`Лист «${sheet}» не найден. Есть листы: ${workbook.worksheets.map((item) => item.name).join(', ')}`);
  const start = Math.max(1, headerRow);
  const last = worksheet.actualRowCount || worksheet.rowCount || 0;
  if (last < start) return;
  const rows = worksheet.getRows(start, last - start + 1) || [];
  for (const row of rows) {
    if (!row) continue;
    yield rowToArray(row);
  }
}

/** Первые N байт файла как latin1-строка: нужны только для выбора разделителя. */function firstBytes(filePath, size) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const read = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, read).toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

/* --------------------------------- таблица -------------------------------- */

async function openTable(filePath, { sheet, delimiter, encoding, header = true, headerRow = 1 }) {
  const ext = path.extname(filePath).toLowerCase();
  const isXlsx = ext === '.xlsx' || ext === '.xlsm' || ext === '.xltx';
  if (!isXlsx && !['.csv', '.tsv', '.txt', '.dat'].includes(ext)) {
    throw new Error(`Поддерживаются .csv и .xlsx (а не ${ext || 'файл без расширения'})`);
  }
  let delimiterUsed = delimiter;
  if (!isXlsx && !delimiterUsed) {
    const sample = ext === '.tsv' ? 'a\tb' : firstBytes(filePath, 65536);
    delimiterUsed = ext === '.tsv' ? '\t' : pickDelimiter(sample);
  }
  const rows = isXlsx ? xlsxRows(filePath, { sheet, headerRow: header === false ? 0 : headerRow }) : csvRows(filePath, { delimiter: delimiterUsed, encoding });
  const iterator = rows[Symbol.asyncIterator]();
  let headerNames = null;
  const names = [];
  const take = header === false ? 0 : headerRow;
  if (take === 0) {
    const first = await iterator.next();
    if (first.done) return { columns: [], iterate: async function* () {}, delimiter: delimiterUsed, isXlsx, firstRow: null };
    headerNames = first.value;
  } else {
    for (let i = 0; i < take; i++) {
      const next = await iterator.next();
      if (next.done) break;
      headerNames = next.value;
    }
  }
  if (!headerNames) headerNames = [];
  for (let i = 0; i < headerNames.length; i++) {
    const name = String(headerNames[i] ?? '').trim();
    names.push(name || `K${i + 1}`);
  }
  // Дубли имён колонок делаем различимыми: иначе group by «молча» берёт первую.
  const seen = new Map();
  const columns = names.map((name) => {
    const count = (seen.get(name) || 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}_${count}`;
  });
  return {
    columns,
    delimiter: delimiterUsed,
    isXlsx,
    iterate: async function* () {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

/* -------------------------------- статистика ------------------------------- */

function emptyNumeric() {
  return { n: 0, sum: 0, sumSq: 0, min: Infinity, max: -Infinity, mean: 0 };
}

function addNumeric(acc, value) {
  acc.n += 1;
  acc.sum += value;
  acc.sumSq += value * value;
  if (value < acc.min) acc.min = value;
  if (value > acc.max) acc.max = value;
  acc.mean += (value - acc.mean) / acc.n;
}

function numericSummary(acc) {
  if (!acc.n) return null;
  const variance = acc.n > 1 ? Math.max(0, (acc.sumSq - acc.n * acc.mean * acc.mean) / (acc.n - 1)) : 0;
  return {
    n: acc.n,
    min: acc.min,
    max: acc.max,
    mean: round(acc.mean),
    sum: round(acc.sum),
    stddev: round(Math.sqrt(variance)),
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function round(value) {
  if (!Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (abs >= 1000) return Math.round(value * 100) / 100;
  if (abs >= 1) return Math.round(value * 10000) / 10000;
  return Math.round(value * 1e6) / 1e6;
}

class ColumnProfile {
  constructor(name) {
    this.name = name;
    this.filled = 0;
    this.empty = 0;
    this.numeric = emptyNumeric();
    this.numericCount = 0;
    this.dateCount = 0;
    this.dateMin = null;
    this.dateMax = null;
    this.distinct = new Set();
    this.distinctCapped = false;
    this.frequent = new Map();
    this.sample = [];
    this.lengths = emptyNumeric();
    this.numericValues = [];
    this.approx = false;
    this.firstSeen = [];
  }

  add(value) {
    const empty = value == null || value === '' || (typeof value === 'number' && Number.isNaN(value));
    if (empty) {
      this.empty += 1;
      return;
    }
    this.filled += 1;
    const asText = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();
    const number = toNumber(value);
    if (number != null) {
      this.numericCount += 1;
      addNumeric(this.numeric, number);
      if (this.numericValues.length < MAX_METRIC_VALUES) this.numericValues.push(number);
      else this.approx = true;
    } else {
      const date = toDate(value);
      if (date) {
        this.dateCount += 1;
        if (!this.dateMin || date < this.dateMin) this.dateMin = date;
        if (!this.dateMax || date > this.dateMax) this.dateMax = date;
      }
    }
    addNumeric(this.lengths, asText.length);
    if (!this.distinct.has(asText)) {
      if (this.distinct.size < MAX_DISTINCT) this.distinct.add(asText);
      else this.distinctCapped = true;
    }
    const count = (this.frequent.get(asText) || 0) + 1;
    if (count === 1 && this.frequent.size >= MAX_DISTINCT) {
      // не раздуваем словарь: новые редкие значения просто не запоминаем
    } else {
      this.frequent.set(asText, count);
    }
    if (this.firstSeen.length < 2 && !this.firstSeen.includes(asText)) this.firstSeen.push(asText);
  }

  summary(topN = 5) {
    const kind = this.numericCount >= Math.max(2, this.filled * 0.8)
      ? 'число'
      : this.dateCount >= Math.max(2, this.filled * 0.8)
        ? 'дата'
        : 'текст';
    const top = [...this.frequent.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([value, count]) => ({ value, count }));
    const numeric = numericSummary(this.numeric);
    let median = null;
    let p95 = null;
    if (this.numericValues.length) {
      const sorted = [...this.numericValues].sort((a, b) => a - b);
      median = round(quantile(sorted, 0.5));
      p95 = round(quantile(sorted, 0.95));
    }
    return {
      column: this.name,
      kind,
      filled: this.filled,
      empty: this.empty,
      distinct: this.distinctCapped ? `${this.distinct.size}+` : this.distinct.size,
      min: numeric ? round(numeric.min) : this.dateMin ? this.dateMin.toISOString().slice(0, 10) : null,
      max: numeric ? round(numeric.max) : this.dateMax ? this.dateMax.toISOString().slice(0, 10) : null,
      mean: numeric ? numeric.mean : null,
      median,
      p95,
      stddev: numeric ? numeric.stddev : null,
      sum: numeric ? numeric.sum : null,
      avgLength: this.lengths.n ? Math.round(this.lengths.mean) : null,
      top,
      approx: this.approx,
    };
  }
}

/* -------------------------------- агрегация ------------------------------- */

class MetricAccumulator {
  constructor(metric) {
    this.agg = metric.agg;
    this.column = metric.column || null;
    this.alias = metric.as || (metric.column ? `${metric.agg}_${metric.column}` : metric.agg);
    this.numeric = emptyNumeric();
    this.values = [];
    this.distinct = new Set();
    this.approx = false;
    this.first = undefined;
    this.last = undefined;
  }

  add(value) {
    if (this.agg === 'count') {
      if (this.column == null || (value != null && value !== '')) this.numeric.n += 1;
      return;
    }
    if (this.agg === 'countDistinct') {
      const text = value instanceof Date ? value.toISOString() : String(value ?? '');
      if (!this.distinct.has(text) && this.distinct.size < MAX_DISTINCT) this.distinct.add(text);
      return;
    }
    if (this.agg === 'min' || this.agg === 'max' || this.agg === 'first' || this.agg === 'last') {
      if (value == null || value === '') return;
      const number = toNumber(value);
      const comparable = number != null ? number : value instanceof Date ? value.getTime() : String(value);
      if (this.agg === 'first') {
        if (this.first === undefined) this.first = comparable;
        return;
      }
      if (this.agg === 'last') {
        this.last = comparable;
        return;
      }
      if (this.numeric.n === 0) {
        this.numeric.min = comparable;
        this.numeric.max = comparable;
      }
      this.numeric.n += 1;
      if (comparable < this.numeric.min) this.numeric.min = comparable;
      if (comparable > this.numeric.max) this.numeric.max = comparable;
      return;
    }
    const number = toNumber(value);
    if (number == null) return;
    addNumeric(this.numeric, number);
    if (this.agg === 'median' || this.agg === 'p95') {
      if (this.values.length < MAX_METRIC_VALUES) this.values.push(number);
      else this.approx = true;
    }
  }

  result() {
    switch (this.agg) {
      case 'count':
        return this.numeric.n;
      case 'countDistinct':
        return this.distinct.size;
      case 'sum':
        return this.numeric.n ? round(this.numeric.sum) : 0;
      case 'avg':
        return this.numeric.n ? round(this.numeric.mean) : null;
      case 'stddev': {
        const summary = numericSummary(this.numeric);
        return summary ? summary.stddev : null;
      }
      case 'min':
      case 'max':
      case 'first':
      case 'last': {
        if (this.agg === 'first' || this.agg === 'last') {
          const value = this.agg === 'first' ? this.first : this.last;
          return typeof value === 'number' ? round(value) : value ?? null;
        }
        if (!this.numeric.n) return null;
        const value = this.agg === 'min' ? this.numeric.min : this.numeric.max;
        return typeof value === 'number' ? round(value) : value;
      }
      case 'median': {
        if (!this.values.length) return null;
        const sorted = [...this.values].sort((a, b) => a - b);
        return round(quantile(sorted, 0.5));
      }
      case 'p95': {
        if (!this.values.length) return null;
        const sorted = [...this.values].sort((a, b) => a - b);
        return round(quantile(sorted, 0.95));
      }
      default:
        return null;
    }
  }
}

function normalizeGroupValue(value, part) {
  if (part) {
    const date = toDate(value);
    return date ? datePart(date, part) : null;
  }
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'number' ? value : String(value).trim();
}

function matchesFilter(value, filter) {
  const op = String(filter.op || 'eq');
  if (!FILTER_OPS.has(op)) throw new Error(`Неизвестное условие «${op}». Доступны: ${[...FILTER_OPS].join(', ')}`);
  if (op === 'empty') return value == null || value === '';
  if (op === 'notEmpty') return !(value == null || value === '');
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').trim().toLowerCase();
  const operand = filter.value;
  if (op === 'contains') return text.includes(String(operand ?? '').toLowerCase());
  if (op === 'startsWith') return text.startsWith(String(operand ?? '').toLowerCase());
  if (op === 'endsWith') return text.endsWith(String(operand ?? '').toLowerCase());
  if (op === 'in' || op === 'notIn') {
    const list = (Array.isArray(operand) ? operand : String(operand ?? '').split(','))
      .map((item) => String(item).trim().toLowerCase())
      .filter(Boolean);
    const hit = list.includes(text);
    return op === 'in' ? hit : !hit;
  }
  if (op === 'between') {
    const list = Array.isArray(operand) ? operand : String(operand ?? '').split(',');
    const from = toNumber(list[0]);
    const to = toNumber(list[1]);
    const number = toNumber(value);
    if (from != null && to != null && number != null) return number >= from && number <= to;
    const left = toDate(list[0]);
    const right = toDate(list[1]);
    const date = toDate(value);
    if (left && right && date) return date >= left && date <= right;
    return text >= String(list[0] ?? '').toLowerCase() && text <= String(list[1] ?? '').toLowerCase();
  }
  const number = toNumber(value);
  const numericOperand = toNumber(operand);
  if (number != null && numericOperand != null) {
    if (op === 'eq') return number === numericOperand;
    if (op === 'ne') return number !== numericOperand;
    if (op === 'gt') return number > numericOperand;
    if (op === 'gte') return number >= numericOperand;
    if (op === 'lt') return number < numericOperand;
    if (op === 'lte') return number <= numericOperand;
  }
  const leftDate = toDate(value);
  const rightDate = toDate(operand);
  if (leftDate && rightDate) {
    const delta = leftDate.getTime() - rightDate.getTime();
    if (op === 'eq') return delta === 0;
    if (op === 'ne') return delta !== 0;
    if (op === 'gt') return delta > 0;
    if (op === 'gte') return delta >= 0;
    if (op === 'lt') return delta < 0;
    if (op === 'lte') return delta <= 0;
  }
  const other = String(operand ?? '').trim().toLowerCase();
  if (op === 'eq') return text === other;
  if (op === 'ne') return text !== other;
  if (op === 'gt') return text > other;
  if (op === 'gte') return text >= other;
  if (op === 'lt') return text < other;
  if (op === 'lte') return text <= other;
  return false;
}

/* --------------------------------- публичное ------------------------------- */

/**
 * Проанализировать таблицу.
 * @param {object} options
 * @param {string} options.filePath — абсолютный путь к .csv/.xlsx
 * @param {'profile'|'query'|'sheets'} [options.mode]
 */
export async function analyzeData(options = {}) {
  const filePath = String(options.filePath || '');
  if (!filePath) throw new Error('Не указан файл');
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('Это не файл');
  const mode = String(options.mode || 'profile').toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  const isXlsx = ext === '.xlsx' || ext === '.xlsm' || ext === '.xltx';

  if (mode === 'sheets') {
    if (!isXlsx) throw new Error('Режим sheets нужен только для книги .xlsx');
    const sheets = await listSheets(filePath);
    return { mode, file: path.basename(filePath), size: stat.size, sheets };
  }

  const table = await openTable(filePath, {
    sheet: options.sheet,
    delimiter: options.delimiter,
    encoding: options.encoding,
    header: options.header === false ? false : true,
    headerRow: Math.max(1, Number(options.headerRow) || 1),
  });
  const columns = table.columns;
  if (!columns.length) throw new Error('В таблице нет строк — анализировать нечего');
  if (!isXlsx && options.encoding) {
    /* кодировку уже учли в csvRows */
  }
  const indexOf = (name) => {
    const wanted = String(name).trim();
    const exact = columns.indexOf(wanted);
    if (exact >= 0) return exact;
    const lower = columns.findIndex((column) => column.toLowerCase() === wanted.toLowerCase());
    if (lower >= 0) return lower;
    throw new Error(`Нет колонки «${name}». Колонки: ${columns.join(', ')}`);
  };

  if (mode === 'profile') return await profileTable({ table, columns, filePath, stat, limit: Math.max(1, Math.min(columns.length, Number(options.limit) || columns.length)) });
  if (mode !== 'query') throw new Error(`Неизвестный режим «${mode}». Доступны: profile, query, sheets`);

  const filters = Array.isArray(options.filters) ? options.filters : [];
  const preparedFilters = filters.map((filter) => ({ ...filter, index: indexOf(filter.column) }));
  const groupBy = (Array.isArray(options.groupBy) ? options.groupBy : []).map((group) => {
    if (typeof group === 'string') return { column: group, index: indexOf(group), alias: group, part: null };
    return { column: group.column, index: indexOf(group.column), alias: group.as || group.column, part: group.part || null };
  });
  if (groupBy.length > 3) throw new Error('Группировка максимум по трём колонкам');
  const metricsRaw = Array.isArray(options.metrics) && options.metrics.length
    ? options.metrics
    : [{ agg: 'count' }];
  if (metricsRaw.length > 8) throw new Error('Метрик максимум 8');
  const metrics = metricsRaw.map((metric) => {
    const requested = String(metric.agg || 'count').trim();
    const canonical = AGGREGATES.find((name) => name.toLowerCase() === requested.toLowerCase())
      || (requested.toLowerCase() === 'distinct' ? 'countDistinct' : null)
      || (requested.toLowerCase() === 'count_distinct' ? 'countDistinct' : null);
    if (!canonical) throw new Error(`Неизвестная метрика «${requested}». Доступны: ${AGGREGATES.join(', ')}`);
    const column = metric.column ? columns[indexOf(metric.column)] : null;
    return { agg: canonical, column, valueIndex: column ? indexOf(column) : null, metric };
  });
  const limit = Math.max(1, Math.min(2000, Number(options.limit) || 50));
  const groups = new Map();
  let scanned = 0;
  let matched = 0;

  for await (const row of table.iterate()) {
    if (scanned >= MAX_ROWS) break;
    scanned += 1;
    if (preparedFilters.length && !preparedFilters.every((filter) => matchesFilter(row[filter.index], filter))) continue;
    matched += 1;
    const keyParts = groupBy.map((group) => normalizeGroupValue(row[group.index], group.part));
    const key = groupBy.length ? JSON.stringify(keyParts) : '[]';
    let bucket = groups.get(key);
    if (!bucket) {
      if (groups.size >= 200000) throw new Error('Слишком много групп (>200 000) — сузьте группировку');
      bucket = { keyParts, accumulators: metrics.map((metric) => new MetricAccumulator({ agg: metric.agg, column: metric.column, as: metric.metric.as })) };
      groups.set(key, bucket);
    }
    for (let i = 0; i < metrics.length; i++) {
      bucket.accumulators[i].add(metrics[i].valueIndex == null ? 1 : row[metrics[i].valueIndex]);
    }
  }

  const resultColumns = [
    ...groupBy.map((group) => group.alias),
    ...metrics.map((metric) => new MetricAccumulator({ agg: metric.agg, column: metric.column, as: metric.metric.as }).alias),
  ];
  let rows = [];
  for (const bucket of groups.values()) {
    const row = {};
    groupBy.forEach((group, i) => { row[group.alias] = bucket.keyParts[i]; });
    bucket.accumulators.forEach((accumulator, i) => { row[resultColumns[groupBy.length + i]] = accumulator.result(); });
    rows.push(row);
  }
  if (options.sort && options.sort.column) {
    const sortColumn = String(options.sort.column);
    const desc = options.sort.desc !== false;
    if (!resultColumns.includes(sortColumn)) throw new Error(`Сортировать можно по: ${resultColumns.join(', ')}`);
    rows.sort((a, b) => {
      const left = a[sortColumn];
      const right = b[sortColumn];
      if (left == null && right == null) return 0;
      if (left == null) return 1;
      if (right == null) return -1;
      if (typeof left === 'number' && typeof right === 'number') return desc ? right - left : left - right;
      return desc ? String(right).localeCompare(String(left), 'ru') : String(left).localeCompare(String(right), 'ru');
    });
  } else if (groupBy.length) {
    rows.sort((a, b) => String(a[groupBy[0].alias] ?? '').localeCompare(String(b[groupBy[0].alias] ?? ''), 'ru'));
  }
  const totalGroups = rows.length;
  const truncated = rows.length > limit;
  rows = rows.slice(0, limit);
  const approximations = [];
  for (const bucket of groups.values()) {
    for (const accumulator of bucket.accumulators) if (accumulator.approx) approximations.push(accumulator.alias);
  }
  return {
    mode,
    file: path.basename(filePath),
    sheet: options.sheet || null,
    delimiter: table.delimiter || null,
    columns: resultColumns,
    sourceColumns: columns,
    scanned,
    matched,
    totalGroups,
    truncated,
    rows,
    approx: [...new Set(approximations)],
  };
}

async function profileTable({ table, columns, filePath, stat }) {
  const profiles = columns.map((name) => new ColumnProfile(name));
  let scanned = 0;
  for await (const row of table.iterate()) {
    scanned += 1;
    for (let i = 0; i < profiles.length; i++) profiles[i].add(row[i]);
  }
  return {
    mode: 'profile',
    file: path.basename(filePath),
    size: stat.size,
    delimiter: table.delimiter || null,
    scanned,
    columns: columns.length,
    profiles: profiles.map((profile) => profile.summary()),
  };
}

/* ---------------------------------- вывод --------------------------------- */

function formatNumber(value) {
  if (value == null) return '—';
  if (typeof value !== 'number') return String(value);
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e12) return value.toExponential(3);
  if (Number.isInteger(value)) return String(value);
  if (abs >= 1000) return String(Math.round(value * 100) / 100);
  return String(Math.round(value * 10000) / 10000);
}

/** Текст для модели: компактные таблицы, без JSON-простыней. */
export function formatAnalysis(result) {
  if (!result) return 'Нет результата';
  if (result.mode === 'sheets') {
    const lines = [`Книга «${result.file}» — листов: ${result.sheets.length}.`];
    for (const sheet of result.sheets) {
      lines.push(`— ${sheet.name}: ${sheet.header.length} колонок${sheet.header.length ? ` (${sheet.header.slice(0, 12).join(' | ')})` : ''}`);
    }
    return lines.join('\n');
  }
  if (result.mode === 'profile') {
    const lines = [
      `Профиль «${result.file}»: строк ${result.scanned}, колонок ${result.columns}${result.delimiter ? `, разделитель «${result.delimiter === '\t' ? 'TAB' : result.delimiter}»` : ''}.`,
      'колонка | тип | заполнено | пусто | уникальных | мин | среднее | медиана | p95 | макс | частые',
    ];
    for (const profile of result.profiles) {
      const top = profile.top.slice(0, 3).map((item) => `${item.value}(${item.count})`).join(', ');
      lines.push([
        profile.column,
        profile.kind,
        profile.filled,
        profile.empty,
        profile.distinct,
        formatNumber(profile.min),
        formatNumber(profile.mean),
        formatNumber(profile.median),
        formatNumber(profile.p95),
        formatNumber(profile.max),
        top || '—',
      ].join(' | '));
    }
    if (result.profiles.some((profile) => profile.approx)) lines.push('(медиана и p95 — оценка по первым 400 000 значениям)');
    lines.push('Дальше: mode=query с groupBy/метриками или create_excel по этим колонкам.');
    return lines.join('\n');
  }
  const lines = [
    `Запрос по «${result.file}»: просмотрено ${result.scanned} строк, под фильтры попало ${result.matched}, групп ${result.totalGroups}${result.truncated ? ` (показаны первые ${result.rows.length})` : ''}.`,
    result.columns.join(' | '),
  ];
  for (const row of result.rows) {
    lines.push(result.columns.map((column) => formatNumber(row[column])).join(' | '));
  }
  if (!result.rows.length) lines.push('(пусто: под такие условия не попало ни одной строки)');
  if (result.approx.length) lines.push(`(приблизительно, по выборке: ${result.approx.join(', ')})`);
  return lines.join('\n');
}

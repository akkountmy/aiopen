import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/* Лёгкий вычислительный слой вместо Python: в облаке Python нет, а считать
   приходится много — пересчёты, разбор текста, чистка CSV, проверки сумм.
   Код исполняется в песочнице node:vm: без сети, без process, без require,
   с потолком по времени и по объёму чтения и записи. */

const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_WRITE_FILES = 40;
const MAX_WRITE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 20000;
const MAX_OUTPUT_LINES = 400;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 20000;

/** Функция-мост без прототипа: внутри песочницы у неё нет .constructor,
 *  через который можно дотянуться до Function хоста. */
function bare(fn) {
  Object.setPrototypeOf(fn, null);
  return Object.freeze(fn);
}

/** Путь внутри рабочего пространства проекта; выход за корень запрещён. */
function resolveInside(root, rel) {
  const clean = String(rel ?? '').trim();
  if (!clean) throw new Error('Пустой путь');
  if (path.isAbsolute(clean)) throw new Error('Нужен путь относительно проекта');
  const full = path.resolve(root, clean);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('Путь выходит за пределы проекта');
  }
  return full;
}

/* Всё, что модель может звать из песочницы как обычные функции. Всё это
   написано на обычном JS и живёт внутри контекста, поэтому не даёт доступа
   к объектам хоста. */
const PRELUDE = `
function __fmt(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try { return JSON.stringify(value); } catch (error) { return String(value); }
}
function print() {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) parts.push(__fmt(arguments[i]));
  __emit(parts.join(' '));
}
var log = print;
var console = {
  log: print,
  info: print,
  warn: function () { print('[warn]', Array.prototype.slice.call(arguments).join(' ')); },
  error: function () { print('[error]', Array.prototype.slice.call(arguments).join(' ')); },
};
function read(rel) { return __read(String(rel)); }
function readJson(rel) { return JSON.parse(__read(String(rel))); }
function write(rel, data) {
  var text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return __write(String(rel), text);
}
function append(rel, data) {
  var text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return __append(String(rel), text);
}
function ls(rel) { return JSON.parse(__list(String(rel || '.'))); }
function exists(rel) { return __exists(String(rel)); }
function sum(list) { var t = 0; for (var i = 0; i < list.length; i++) t += Number(list[i]) || 0; return t; }
function avg(list) { return list.length ? sum(list) / list.length : 0; }
function min(list) { return list.reduce(function (a, b) { return Number(b) < Number(a) ? b : a; }, list[0]); }
function max(list) { return list.reduce(function (a, b) { return Number(b) > Number(a) ? b : a; }, list[0]); }
function round(value, digits) { var k = Math.pow(10, digits == null ? 2 : digits); return Math.round(Number(value) * k) / k; }
function sorted(list) { return list.slice().sort(function (a, b) { return Number(a) - Number(b); }); }
function median(list) {
  if (!list.length) return NaN;
  var s = sorted(list);
  var mid = Math.floor(s.length / 2);
  return s.length % 2 ? Number(s[mid]) : (Number(s[mid - 1]) + Number(s[mid])) / 2;
}
function pct(list, p) {
  if (!list.length) return NaN;
  var s = sorted(list);
  var idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return Number(s[idx]);
}
function stdev(list) {
  if (list.length < 2) return 0;
  var m = avg(list);
  var acc = 0;
  for (var i = 0; i < list.length; i++) acc += Math.pow(Number(list[i]) - m, 2);
  return Math.sqrt(acc / (list.length - 1));
}
function groupBy(rows, key) {
  var out = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var name = typeof key === 'function' ? key(row) : row[key];
    if (name == null) continue;
    if (!out[name]) out[name] = [];
    out[name].push(row);
  }
  return out;
}
function __sniffDelimiter(text) {
  var firstLine = String(text).split('\\n')[0] || '';
  var candidates = [',', ';', '\\t', '|'];
  var best = ',';
  var bestCount = 0;
  for (var i = 0; i < candidates.length; i++) {
    var count = firstLine.split(candidates[i]).length - 1;
    if (count > bestCount) { bestCount = count; best = candidates[i]; }
  }
  return best;
}
function parseCsv(text, options) {
  var opts = options || {};
  var source = String(text).replace(/^\\uFEFF/, '');
  var delimiter = opts.delimiter || __sniffDelimiter(source);
  var rows = [];
  var field = '';
  var row = [];
  var quoted = false;
  for (var i = 0; i < source.length; i++) {
    var ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  rows = rows.filter(function (item) { return item.length > 1 || (item[0] && item[0].trim()); });
  if (!rows.length) return [];
  var header = rows[0].map(function (name) { return String(name).trim(); });
  return rows.slice(1).map(function (cells) {
    var obj = {};
    for (var j = 0; j < header.length; j++) obj[header[j]] = cells[j] === undefined ? '' : cells[j];
    return obj;
  });
}
function toCsv(rows) {
  if (!rows.length) return '';
  var header = Object.keys(rows[0]);
  function cell(value) {
    var text = value == null ? '' : String(value);
    return /[",;\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }
  var lines = [header.map(cell).join(',')];
  for (var i = 0; i < rows.length; i++) {
    lines.push(header.map(function (name) { return cell(rows[i][name]); }).join(','));
  }
  return lines.join('\\n');
}
function date(value) { return value === undefined ? new Date() : new Date(value); }
function today() { var d = new Date(); return d.toISOString().slice(0, 10); }
`;

/**
 * Исполняет JavaScript модели в песочнице.
 * @returns {{ output: string, files: string[], value: string, ms: number }}
 */
export async function runJavascript({ code, root, timeoutMs = DEFAULT_TIMEOUT_MS, signal, writeRoot = '' } = {}) {
  const source = String(code ?? '');
  if (!source.trim()) throw new Error('Пустой код');
  if (signal?.aborted) throw Object.assign(new Error('Остановлено'), { name: 'AbortError' });

  /* У субагента запись разрешена только в его папку: песочница идёт через то же
     правило, что и обычные инструменты, иначе run_js стал бы лазейкой. */
  const scope = writeRoot ? resolveInside(root, String(writeRoot)) : null;
  const writable = (full) => {
    if (!scope) return;
    if (full !== scope && !full.startsWith(scope + path.sep)) {
      throw new Error(`Писать можно только в свою папку «${String(writeRoot).replace(/\\/g, '/')}»`);
    }
  };

  const limit = Math.max(500, Math.min(MAX_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const lines = [];
  const files = [];
  let outputChars = 0;
  let readBytes = 0;
  let writeBytes = 0;

  const emit = (text) => {
    if (outputChars >= MAX_OUTPUT_CHARS) return;
    const chunk = String(text);
    const room = MAX_OUTPUT_CHARS - outputChars;
    outputChars += Math.min(chunk.length, room);
    lines.push(chunk.length > room ? `${chunk.slice(0, room)}…` : chunk);
  };

  const guardWrite = (rel, text) => {
    if (files.length >= MAX_WRITE_FILES) throw new Error(`Слишком много файлов за один запуск (предел ${MAX_WRITE_FILES})`);
    writeBytes += Buffer.byteLength(text, 'utf8');
    if (writeBytes > MAX_WRITE_BYTES) throw new Error('Слишком большой объём записи за один запуск');
    return rel;
  };

  const sandbox = {
    __emit: bare((text) => emit(text)),
    __read: bare((rel) => {
      const full = resolveInside(root, rel);
      const stat = fs.statSync(full);
      if (!stat.isFile()) throw new Error(`Это не файл: ${rel}`);
      readBytes += stat.size;
      if (readBytes > MAX_READ_BYTES) throw new Error('Слишком большой объём чтения за один запуск');
      if (stat.size > 32 * 1024 * 1024) throw new Error(`Файл слишком большой для песочницы: ${rel}`);
      return fs.readFileSync(full, 'utf8');
    }),
    __write: bare((rel, text) => {
      const full = resolveInside(root, rel);
      writable(full);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, 'utf8');
      if (!files.includes(rel)) files.push(rel);
      return guardWrite(rel, text);
    }),
    __append: bare((rel, text) => {
      const full = resolveInside(root, rel);
      writable(full);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.appendFileSync(full, text, 'utf8');
      if (!files.includes(rel)) files.push(rel);
      return guardWrite(rel, text);
    }),
    __list: bare((rel) => {
      const full = resolveInside(root, rel);
      const entries = fs.readdirSync(full, { withFileTypes: true });
      const out = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (out.length >= 1000) break;
        let size = 0;
        try {
          size = fs.statSync(path.join(full, entry.name)).size;
        } catch {
          size = 0;
        }
        out.push({ name: entry.name, dir: entry.isDirectory(), size });
      }
      return JSON.stringify(out);
    }),
    __exists: bare((rel) => {
      try {
        return fs.existsSync(resolveInside(root, rel));
      } catch {
        return false;
      }
    }),
  };

  const context = vm.createContext(sandbox, {
    name: 'run_js',
    codeGeneration: { strings: true, wasm: false },
  });
  vm.runInContext(PRELUDE, context, { timeout: 2000, filename: 'prelude.js' });

  const wrapper = `(function () {\n${source}\n})()`;
  const started = Date.now();
  let value = '';
  try {
    const returned = vm.runInContext(wrapper, context, {
      timeout: limit,
      filename: 'run_js.js',
      displayErrors: true,
    });
    if (returned !== undefined) value = formatValue(returned);
  } catch (error) {
    const name = error?.name || 'Error';
    if (name === 'TimeoutError' || /Script execution timed out/i.test(String(error?.message))) {
      throw new Error(`Код выполнялся дольше ${Math.round(limit / 1000)} с и был остановлен. Упрости вычисление или разбей его на части.`);
    }
    const message = String(error?.message || error);
    const stackLine = String(error?.stack || '')
      .split('\n')
      .find((line) => line.includes('run_js.js'));
    const where = stackLine ? ` (${stackLine.trim().replace(/^\s*at\s*/, '')})` : '';
    throw new Error(`${name}: ${message}${where}`);
  }

  let output = lines.slice(0, MAX_OUTPUT_LINES).join('\n');
  if (lines.length > MAX_OUTPUT_LINES) output += `\n… ещё ${lines.length - MAX_OUTPUT_LINES} строк`;
  if (!output && value) output = value;
  return { output: output || '', files, value, ms: Date.now() - started };
}

function formatValue(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text !== 'string') return String(value);
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  } catch {
    return String(value);
  }
}

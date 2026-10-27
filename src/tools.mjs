import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, LIMITS, MODEL } from './config.mjs';
import { checkDocument, formatCheckReport } from './doccheck.mjs';
import { memoryToolReply } from './memory.mjs';
import { skillBody, skillIds } from './skills.mjs';
import { detectKind, extractDocumentText } from './docparse.mjs';
import { analyzeData, formatAnalysis } from './analysis.mjs';
import { createDocumentPdf, createPresentationPdf } from './pdf.mjs';
import { docEngines, docIssues, makePdf, makePresentation, makeWord, makeWorkbook } from './doc/index.mjs';
import { imageInfo } from './doc/image-info.mjs';
import { describeImage } from './vision.mjs';
import { fetchUrl, webSearch, readPage, fetchMany, crawlSite, searchMany, scrapePage } from './search.mjs';
import { runJavascript } from './jsruntime.mjs';
import { checkPage, describePage } from './browser.mjs';
import { pageCheckNote, pageTemplate, staticPageChecks, staticIssueCount } from './pagecheck.mjs';
import { escapeHtml, formatBytes, safeName, truncate } from './util.mjs';
import { writeZip } from './zip.mjs';
import { ARCHIVE_LIMITS, archiveKind, extractArchiveTo, formatExtraction, gunzipTo } from './archive.mjs';
import { checkLinks, formatLinks, linksFromText } from './linkcheck.mjs';
import { compareDocuments, formatCompare } from './comparedocs.mjs';

/** Дата и авторитет источника — одной строкой, если DeepSeek их отдал. */
function searchBadge(result) {
  const facts = [];
  const date = String(result?.date || '').slice(0, 10);
  if (date) facts.push(date);
  if (Number.isFinite(result?.authority)) facts.push(`авторитет ${result.authority}/4`);
  return facts.length ? `${facts.join(' · ')}\n` : '';
}

/** Не даём инструментам заполнить диск до отказа: сервис должен оставаться рабочим. */
function ensureFreeSpace(extraBytes = 0) {
  try {
    const stats = fs.statfsSync(DATA_DIR);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (free < Number(extraBytes || 0) + LIMITS.minFreeBytes) {
      throw new Error('На диске сервиса мало места — удалите ненужные файлы.');
    }
  } catch (error) {
    if (error?.message?.startsWith('На диске')) throw error;
  }
}

const HIDDEN = new Set(['.dshow']);
/* Следы автопроверок не должны попадать в «Файлы проекта» пользователя даже
   если проверка упала до уборки. Шаблон намеренно узкий: только имена, которые
   генерируют сами тесты (hint-123456.docx, picker-123456.txt и т. п.). */
const TEST_ARTIFACT = /^(?:hint|picker|panels|drag-drop|flows)-\d{6}\.(?:docx|txt|xlsx|html|pdf)$/i;


export function resolveSafe(root, rel = '.') {
  const clean = String(rel || '.').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(root, clean);
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    const error = new Error('Путь выходит за пределы рабочего пространства');
    error.status = 400;
    throw error;
  }
  return target;
}

export function ensureDirFor(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

export function listTree(root, rel = '.', { depth = 3, maxEntries = 500 } = {}) {
  const base = resolveSafe(root, rel);
  const out = [];
  const walk = (dir, relPath, level) => {
    if (level > depth || out.length >= maxEntries) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (entry.name.startsWith('.') || HIDDEN.has(entry.name)) continue;
      if (TEST_ARTIFACT.test(entry.name)) continue;
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      const relName = relPath ? `${relPath}/${entry.name}` : entry.name;
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      const item = {
        name: entry.name,
        path: relName,
        dir: entry.isDirectory(),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };
      out.push(item);
      if (entry.isDirectory()) walk(full, relName, level + 1);
    }
  };
  if (base !== path.resolve(root)) {
    const stat = fs.existsSync(base) ? fs.statSync(base) : null;
    if (stat?.isFile()) return [{ name: path.basename(base), path: rel, dir: false, size: stat.size, modified: stat.mtime.toISOString() }];
  }
  walk(base, rel === '.' ? '' : rel, 0);
  return out;
}

export function readTextFile(root, rel, { maxChars = 200000 } = {}) {
  const full = resolveSafe(root, rel);
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error('Это не файл');
  if (stat.size > 12 * 1024 * 1024) throw new Error('Файл слишком большой для чтения целиком');
  const buf = fs.readFileSync(full);
  const kind = detectKind(rel);
  if (kind === 'binary' || kind === 'archive') {
    throw new Error(`Двоичный файл (${formatBytes(stat.size)}). Используйте read_document или analyze_image.`);
  }
  if (kind === 'image') throw new Error('Это изображение. Используйте analyze_image.');
  const text = buf.toString('utf8');
  return { text: truncate(text, maxChars), size: stat.size };
}

/* ------------------------- построение Office-файлов ------------------------- */

function xmlEscape(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function colName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function buildXlsx(sheets) {
  const files = [];
  const sheetEntries = sheets.map((sheet, idx) => ({ name: String(sheet.name || `Лист ${idx + 1}`).slice(0, 30), rows: sheet.rows || [] }));
  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ...sheetEntries.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    '</Types>',
  ].join('');
  files.push({ name: '[Content_Types].xml', data: contentTypes });
  files.push({
    name: '_rels/.rels',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  });
  const workbook = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>',
    ...sheetEntries.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`),
    '</sheets></workbook>',
  ].join('');
  files.push({ name: 'xl/workbook.xml', data: workbook });
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheetEntries.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheetEntries.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  });
  files.push({
    name: 'xl/styles.xml',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>',
  });
  sheetEntries.forEach((sheet, idx) => {
    const rowsXml = sheet.rows
      .map((row, r) => {
        const cells = (row || [])
          .map((value, c) => {
            if (value === null || value === undefined || value === '') return '';
            const ref = `${colName(c)}${r + 1}`;
            if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
            if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join('');
    const cols = Math.max(1, ...sheet.rows.map((r) => (r || []).length));
    files.push({
      name: `xl/worksheets/sheet${idx + 1}.xml`,
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${colName(cols - 1)}${Math.max(1, sheet.rows.length)}"/><sheetData>${rowsXml}</sheetData></worksheet>`,
    });
  });
  return writeZip(files);
}

export function buildDocx({ title, paragraphs = [], bullets = [], table = null }) {
  const body = [];
  if (title) {
    body.push(
      `<w:p><w:pPr><w:spacing w:after="200"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t xml:space="preserve">${xmlEscape(title)}</w:t></w:r></w:p>`,
    );
  }
  const para = (text) =>
    `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  const bullet = (text) =>
    `<w:p><w:pPr><w:spacing w:after="80"/><w:ind w:left="360"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">• ${xmlEscape(text)}</w:t></w:r></w:p>`;
  for (const text of paragraphs) if (String(text ?? '').trim()) body.push(para(text));
  for (const text of bullets) if (String(text ?? '').trim()) body.push(bullet(text));
  if (table && Array.isArray(table.rows) && table.rows.length) {
    const headers = table.headers || [];
    const cell = (text, bold) =>
      `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p></w:tc>`;
    const rowsXml = [];
    if (headers.length) rowsXml.push(`<w:tr>${headers.map((h) => cell(h, true)).join('')}</w:tr>`);
    for (const row of table.rows) rowsXml.push(`<w:tr>${(row || []).map((c) => cell(c, false)).join('')}</w:tr>`);
    body.push(
      `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rowsXml.join('')}</w:tbl>`,
    );
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701"/></w:sectPr></w:body></w:document>`;
  const files = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    { name: 'word/document.xml', data: document },
    {
      name: 'word/_rels/document.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    },
    {
      name: 'word/styles.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>',
    },
  ];
  return writeZip(files);
}

/* ------------------------------ Python ------------------------------ */

/* Песочница для run_python. Код из чата — это недоверенный ввод: он приходит
   от модели, которую можно уговорить прочитать /data/index.json (пароли других
   людей, переписки) или отправить что-нибудь наружу. Аудит-хук Python ставится
   до кода пользователя и запрещает читать служебные папки сервиса, писать вне
   папки проекта, открывать сокеты и запускать другие программы. Это не замена
   контейнеру, но убирает самые дешёвые пути утечки. */
const PYTHON_GUARD = `import os as _os, sys as _sys
_ROOT = _os.path.realpath(_os.getcwd())
_TMP = _os.path.realpath(_os.environ.get('TMPDIR') or _os.environ.get('TEMP') or '/tmp')
_DENY = tuple(_os.path.realpath(part) for part in ('/data', '/app', '/etc', '/root', '/home', '/proc'))
def _allowed(path, write):
    try:
        real = _os.path.realpath(path)
    except Exception:
        return True
    if real == _ROOT or real.startswith(_ROOT + _os.sep):
        return True
    if real == _TMP or real.startswith(_TMP + _os.sep):
        return not write
    for deny in _DENY:
        if real == deny or real.startswith(deny + _os.sep):
            return False
    return not write
def _hook(event, args):
    if event == 'open':
        target, mode, flags = args[0], args[1], args[2]
        if isinstance(target, int):
            return
        write = bool(isinstance(mode, str) and any(ch in mode for ch in 'wax+'))
        write = write or bool(isinstance(flags, int) and flags & (_os.O_WRONLY | _os.O_RDWR | _os.O_CREAT | _os.O_APPEND))
        if not _allowed(_os.fspath(target), write):
            raise PermissionError('run_python: доступ к этому пути закрыт, работай в папке проекта')
    elif event in ('socket.connect', 'socket.getaddrinfo', 'socket.bind', 'socket.sendto',
                   'subprocess.Popen', 'os.system', 'os.exec', 'os.spawn', 'os.posix_spawn',
                   'ctypes.dlopen', 'ctypes.dlsym'):
        raise PermissionError('run_python: сеть и запуск других программ здесь запрещены')
_sys.addaudithook(_hook)
`;

let pythonBin = null;

async function findPython() {
  if (pythonBin) return pythonBin;
  for (const candidate of ['python', 'py']) {
    const ok = await new Promise((resolve) => {
      const child = spawn(candidate, ['-c', 'print(1)'], { stdio: 'ignore', windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
    if (ok) {
      pythonBin = candidate;
      return candidate;
    }
  }
  throw new Error('Python не найден на этом компьютере');
}

/* Окружение для Python. Раньше дочернему процессу отдавался весь `process.env`,
   то есть вместе с ключом модели и прочими секретами сервиса: любой код,
   попавший в run_python (в контейнере он есть), мог их прочитать и отправить
   наружу. Теперь передаём только то, что нужно интерпретатору. */
function pythonEnv(cwd) {
  const base = process.env;
  const env = {
    PATH: base.PATH || base.Path || '',
    HOME: cwd,
    TMPDIR: base.TMPDIR || '/tmp',
    LANG: base.LANG || 'C.UTF-8',
    LC_ALL: base.LC_ALL || '',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  /* Windows без этих переменных не запускает процесс и не находит системные DLL. */
  for (const key of ['SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'ComSpec', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']) {
    if (base[key]) env[key] = base[key];
  }
  return env;
}

function runProcess(command, args, { cwd, timeoutMs, input }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, env: pythonEnv(cwd) });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 60000) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 20000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}`, killed });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/* ------------------- нормализация аргументов документов ------------------- *//** Диаграмма Word: одна схема на все места, где она допустима. */
const DOCX_CHART_SCHEMA = {
  type: 'object',
  description:
    'Настоящая диаграмма Word (её можно править в Word через «Изменить данные», это не картинка). Ставь, когда в тексте есть цифры по периодам или сравнение категорий.',
  properties: {
    type: { type: 'string', enum: ['column', 'bar', 'line', 'pie', 'doughnut', 'area'], description: 'column — столбцы, bar — горизонтальные полосы, line — динамика, pie/doughnut — доли, area — площади.' },
    title: { type: 'string', description: 'Заголовок диаграммы.' },
    categories: { type: 'array', items: { type: 'string' }, description: 'Подписи по оси X: периоды или названия.' },
    series: {
      type: 'array',
      description: 'Ряды данных. Значения — числа, а не строки.',
      items: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Название ряда для легенды.' }, values: { type: 'array', items: { type: 'number' } } },
        required: ['name', 'values'],
      },
    },
    width: { type: 'number', description: 'Ширина в пикселях, по умолчанию во всю ширину полей страницы.' },
    height: { type: 'number', description: 'Высота в пикселях, по умолчанию половина ширины.' },
  },
  required: ['type', 'series'],
};

/** Картинка из файлов проекта. */
const DOCX_IMAGE_SCHEMA = {
  type: 'object',
  description: 'Картинка из файлов проекта (PNG, JPEG, GIF, BMP). Путь — относительно корня проекта, как в list_files.',
  properties: {
    path: { type: 'string', description: 'Путь к файлу, например «assets/logo.png».' },
    caption: { type: 'string', description: 'Подпись под картинкой, необязательно.' },
    width: { type: 'number', description: 'Ширина в сантиметрах. По умолчанию — во всю ширину полей, но не больше натурального размера.' },
  },
  required: ['path'],
};

/** Список строк: принимаем массив, переводы строк и одиночную строку. */
function listOf(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter((item) => item.trim() !== '');
  if (typeof value === 'string') return value.split('\n').map((item) => item.trim()).filter(Boolean);
  return [];
}

function kpiOf(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && item.value !== undefined && item.value !== null && String(item.value).trim() !== '')
    .slice(0, 4)
    .map((item) => ({ value: String(item.value), label: String(item.label ?? '').trim() }));
}

function tableOf(value) {
  if (!value || !Array.isArray(value.rows) || !value.rows.length) return null;
  const headers = Array.isArray(value.headers) ? value.headers.map((item) => String(item ?? '')) : [];
  const rows = value.rows.filter((row) => Array.isArray(row) && row.length).map((row) => row.map((cell) => cell ?? ''));
  if (!rows.length) return null;
  return {
    headers,
    rows,
    totalRow: value.totalRow === true,
    numericColumns: Array.isArray(value.numericColumns) ? value.numericColumns.map(Number) : undefined,
    columnWidths: Array.isArray(value.columnWidths) ? value.columnWidths.map(Number) : undefined,
  };
}

/** Картинка из аргументов: путь обязателен, остальное необязательно. */
function imageOf(value) {
  if (!value) return null;
  const rel = String(value.path ?? '').trim();
  if (!rel) return null;
  return {
    path: rel,
    caption: value.caption ? String(value.caption) : undefined,
    width: Number(value.width) > 0 ? Number(value.width) : undefined,
  };
}

function imagesOf(value) {
  if (!Array.isArray(value)) return [];
  return value.map(imageOf).filter(Boolean);
}

/** Разделы документа → разделы про-спеки (с поддержкой простого режима). */
function sectionsOf(value) {
  const sections = Array.isArray(value)
    ? value.filter(Boolean).map((section) => {
        const subsections = Array.isArray(section.subsections)
          ? section.subsections.filter(Boolean).map((sub) => ({
              heading: sub.heading,
              paragraphs: listOf(sub.paragraphs),
              bullets: listOf(sub.bullets),
              table: tableOf(sub.table),
              chart: chartOf(sub.chart),
              charts: Array.isArray(sub.charts) ? sub.charts.map(chartOf).filter(Boolean) : [],
              image: imageOf(sub.image),
              images: imagesOf(sub.images),
            }))
          : [];
        return {
          heading: section.heading,
          paragraphs: listOf(section.paragraphs),
          bullets: listOf(section.bullets),
          kpi: kpiOf(section.kpi),
          subsections,
          table: tableOf(section.table),
          chart: chartOf(section.chart),
          charts: Array.isArray(section.charts) ? section.charts.map(chartOf).filter(Boolean) : [],
          image: imageOf(section.image),
          images: imagesOf(section.images),
          note: section.note,
        };
      })
    : [];
  return sections.filter(
    (section) =>
      section.heading ||
      section.paragraphs.length ||
      section.bullets.length ||
      section.table ||
      section.kpi.length ||
      section.chart ||
      section.charts.length ||
      section.image ||
      section.images.length,
  );
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const PX_PER_CM = 37.795;

/** Прочитать картинку проекта в байты: Word вставляет её внутрь файла. */
function loadImageBytes(item, root) {
  const rel = item.path;
  const full = assertInside(root, resolveSafe(root, rel));
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new Error(`Файл изображения не найден: ${rel}. Посмотри список файлов проекта через list_files.`);
  }
  const size = fs.statSync(full).size;
  if (size > MAX_IMAGE_BYTES) throw new Error(`Картинка «${rel}» больше 12 МБ — уменьши её перед вставкой`);
  const data = fs.readFileSync(full);
  const info = imageInfo(data);
  if (!info) throw new Error(`Файл «${rel}» не PNG, JPEG, GIF или BMP — Word такую картинку не покажет`);
  return {
    data,
    type: info.type,
    width: info.width,
    height: info.height,
    widthPx: item.width ? Math.round(Math.min(17, item.width) * PX_PER_CM) : undefined,
    caption: item.caption,
  };
}

/** Заменить пути картинок на их байты во всём документе (шапка, разделы, подразделы). */
function attachImages(spec, root) {
  const containers = [spec, ...spec.sections.flatMap((section) => [section, ...section.subsections])];
  for (const container of containers) {
    const list = [];
    if (container.image) list.push(container.image);
    if (Array.isArray(container.images)) list.push(...container.images);
    if (!list.length) continue;
    container.images = list.map((item) => loadImageBytes(item, root));
    delete container.image;
  }
  return spec;
}

function wordSpecFromArgs(args) {
  const sections = sectionsOf(args.sections);
  const paragraphs = listOf(args.paragraphs);
  const bullets = listOf(args.bullets);
  const table = tableOf(args.table);
  const image = imageOf(args.image);
  const images = imagesOf(args.images);
  if (!sections.length && (paragraphs.length || bullets.length || table || image || images.length)) {
    sections.push({ heading: '', paragraphs, bullets, kpi: [], subsections: [], table, note: '', image, images });
  }
  return {
    title: args.title,
    kicker: args.kicker,
    subtitle: args.subtitle,
    author: args.author,
    date: args.date,
    cover: args.cover === true,
    toc: args.toc === true,
    headerText: args.headerText,
    footerText: args.footerText,
    pageNumbers: args.pageNumbers !== false,
    image,
    images,
    sections,
  };
}

function chartOf(value) {
  if (!value || !Array.isArray(value.series) || !value.series.length) return null;
  const series = value.series
    .filter((item) => item && Array.isArray(item.values) && item.values.length)
    .map((item) => ({ name: String(item.name ?? 'Ряд'), values: item.values.map((number) => Number(number) || 0) }));
  if (!series.length) return null;
  return {
    type: String(value.type || 'column'),
    title: value.title,
    categories: listOf(value.categories),
    series,
    width: Number(value.width) > 0 ? Number(value.width) : undefined,
    height: Number(value.height) > 0 ? Number(value.height) : undefined,
  };
}

function slidesOf(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(Boolean)
    .map((slide) => ({
      layout: slide.layout ? String(slide.layout) : undefined,
      kicker: slide.kicker,
      title: slide.title,
      subtitle: slide.subtitle,
      paragraphs: listOf(slide.paragraphs),
      bullets: listOf(slide.bullets),
      kpi: kpiOf(slide.kpi),
      chart: chartOf(slide.chart),
      table: tableOf(slide.table),
      note: slide.note ?? slide.notes,
      footerText: slide.footerText,
    }))
    .filter((slide) => slide.title || slide.paragraphs.length || slide.bullets.length || slide.chart || slide.table || slide.kpi.length);
}

function pptxSpecFromArgs(args) {
  return {
    title: args.title,
    subtitle: args.subtitle,
    kicker: args.kicker,
    author: args.author,
    date: args.date,
    company: args.company,
    cover: args.cover !== false && Boolean(args.title),
    footerText: args.footerText,
    slides: slidesOf(args.slides),
  };
}

function pdfSpecFromArgs(args) {
  const layout = String(args.layout || '').toLowerCase() === 'slides' || (!Array.isArray(args.sections) && Array.isArray(args.slides)) ? 'slides' : 'document';
  const sections = sectionsOf(args.sections);
  const paragraphs = listOf(args.paragraphs);
  const bullets = listOf(args.bullets);
  if (layout === 'document' && !sections.length && (paragraphs.length || bullets.length || tableOf(args.table))) {
    sections.push({ heading: '', paragraphs, bullets, kpi: [], subsections: [], table: tableOf(args.table), note: '' });
  }
  const spec = {
    layout,
    title: args.title,
    kicker: args.kicker,
    subtitle: args.subtitle,
    subtitle2: args.subtitle2,
    author: args.author,
    date: args.date,
    footerText: args.footerText,
    /* обложка только по явному запросу: у короткого одностраничника она лишняя,
       а длинный отчёт модель просит с cover: true (см. стандарты в prompt.mjs) */
    cover: args.cover === true,
    slides: slidesOf(args.slides),
    sections,
  };
  if (layout === 'slides' && !spec.slides.length) throw new Error('Для PDF-презентации нужен хотя бы один слайд с заголовком или содержимым');
  if (layout === 'document' && !spec.sections.length) throw new Error('Для PDF-документа нужен хотя бы один раздел или абзац');
  return spec;
}

/* ------------------------------ инструменты ------------------------------ */

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'Показать файлы и папки рабочего пространства проекта. Возвращает дерево с размерами. Используй перед чтением файлов, если не знаешь структуру.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Относительный путь внутри проекта. По умолчанию корень.' },
          depth: { type: 'integer', description: 'Глубина просмотра, 1–5. По умолчанию 3.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Прочитать текстовый файл проекта целиком или фрагмент (по номерам строк).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь файла внутри проекта.' },
          offset: { type: 'integer', description: 'С какой строки начать (1 — первая).' },
          limit: { type: 'integer', description: 'Сколько строк прочитать, максимум 2000.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Создать или полностью перезаписать текстовый файл в проекте. Родительские папки создаются автоматически. Используй для любых отчётов, кода, CSV, MD, HTML.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь файла внутри проекта.' },
          content: { type: 'string', description: 'Полное содержимое файла.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description:
        'Дописать текст в конец файла (файл создаётся, если его нет). Используй для больших файлов: сначала write_file с первой частью, затем append_file с остальными частями по 4–8 КБ.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь файла внутри проекта.' },
          content: { type: 'string', description: 'Очередная часть содержимого.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Посчитать арифметическое выражение: + - * / % **, скобки, round, min, max, abs, sqrt, pow. Возвращает число.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Например: round(12000 * 0.6) или (4500 + 3000) * 1.2' },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Точечно изменить существующий текстовый файл: заменить old_text на new_text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string', description: 'Точный фрагмент, который нужно заменить.' },
          new_text: { type: 'string', description: 'Новый фрагмент.' },
          replace_all: { type: 'boolean', description: 'Заменить все вхождения.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_path',
      description: 'Удалить файл или папку внутри проекта.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_path',
      description: 'Переместить или переименовать файл/папку внутри проекта.',
      parameters: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_in_files',
      description: 'Поиск текста или регулярного выражения по файлам проекта.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Строка или регулярное выражение.' },
          path: { type: 'string', description: 'Где искать, по умолчанию весь проект.' },
          regex: { type: 'boolean' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_document',
      description:
        'Извлечь текст из документа проекта: DOCX, XLSX, PPTX, PDF, CSV, RTF, HTML, TXT. Используй для приложенных файлов и любых документов в проекте.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_data',
      description:
        'Анализ таблиц данных: CSV и XLSX. Читает файл потоком, поэтому работает и на 100 000+ строк, где read_file бесполезен. '
        + 'mode=profile — профиль колонок (типы, пропуски, уникальные, мин/среднее/медиана/p95/макс, частые значения); '
        + 'mode=query — фильтры + группировка (включая по месяцу/кварталу/году) + метрики sum/avg/min/max/median/p95/stddev/count/countDistinct + сортировка; '
        + 'mode=sheets — какие листы в книге. Сначала profile, потом query, результат — в create_excel.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к .csv или .xlsx в проекте.' },
          mode: { type: 'string', enum: ['profile', 'query', 'sheets'], description: 'Что сделать. По умолчанию profile.' },
          sheet: { type: 'string', description: 'Имя (или номер) листа для .xlsx. По умолчанию первый.' },
          delimiter: { type: 'string', description: 'Разделитель CSV: ; , tab |. По умолчанию определяется сам.' },
          encoding: { type: 'string', description: 'Кодировка CSV: utf8 (по умолчанию) или win1251.' },
          headerRow: { type: 'integer', description: 'Номер строки с шапкой, с 1. По умолчанию 1.' },
          filters: {
            type: 'array',
            description: 'Условия отбора: все должны выполняться.',
            items: {
              type: 'object',
              properties: {
                column: { type: 'string' },
                op: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'endsWith', 'in', 'notIn', 'between', 'empty', 'notEmpty'] },
                value: { description: 'Значение; для in/notIn — список или строка через запятую, для between — [от, до].' },
              },
              required: ['column', 'op'],
            },
          },
          groupBy: {
            type: 'array',
            description: 'До трёх колонок группировки (строкой или объектом с part для дат).',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    column: { type: 'string' },
                    as: { type: 'string', description: 'Имя колонки в результате.' },
                    part: { type: 'string', enum: ['year', 'quarter', 'month', 'week', 'day'], description: 'Разрезать дату по части.' },
                  },
                  required: ['column'],
                },
              ],
            },
          },
          metrics: {
            type: 'array',
            description: 'До восьми метрик. Без column — count строк.',
            items: {
              type: 'object',
              properties: {
                agg: { type: 'string', enum: ['count', 'countDistinct', 'sum', 'avg', 'min', 'max', 'median', 'p95', 'stddev'] },
                column: { type: 'string' },
                as: { type: 'string' },
              },
              required: ['agg'],
            },
          },
          sort: {
            type: 'object',
            description: 'Сортировка результата по колонке результата.',
            properties: {
              column: { type: 'string' },
              desc: { type: 'boolean', description: 'По убыванию, по умолчанию true.' },
            },
            required: ['column'],
          },
          limit: { type: 'integer', description: 'Сколько групп вернуть, 1–2000. По умолчанию 50.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_image',
      description:
        'Распознать изображение (скриншот, фото, скан) в проекте: дословный текст и подробное описание. Используй, когда на изображении нужно прочитать текст, цифры, таблицу или интерфейс.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          instruction: { type: 'string', description: 'Что именно нужно распознать (необязательно).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Найти актуальную информацию в интернете через DeepSeek Search: заголовки, ссылки, сниппеты, дата и авторитет источника. Можно передать несколько запросов сразу (queries) — они объединятся в одну выдачу без повторов. Для качества давай 2–4 разные формулировки и открывай первоисточники read_page/fetch_url: сниппет годится для выбора страницы, но не для цифр и цитат.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Один поисковый запрос.' },
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: 'Несколько запросов сразу, до 4 — для широкого охвата разных формулировок.',
          },
          limit: { type: 'integer', description: 'Сколько результатов на запрос, 1–10. По умолчанию 6.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Загрузить веб-страницу, PDF или API по ссылке и получить текст. Обычный GET идёт через DeepSeek Fetch (чистый Markdown, без браузера), POST и свои заголовки — напрямую, с запасной загрузкой.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          max_chars: { type: 'integer', description: 'Максимум символов, по умолчанию 24000.' },
          method: { type: 'string', description: 'GET (по умолчанию), POST, PUT или HEAD.' },
          body: { type: 'string', description: 'Тело запроса для POST/PUT (JSON или форма).' },
          headers: {
            type: 'object',
            description: 'Свои заголовки, например {"Content-Type":"application/json"} или {"Authorization":"Bearer …"}.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description:
        'Прочитать страницу как статью: заголовок, описание, оглавление, таблицы, ссылки и очищенный от меню текст. Работает без браузера — лучший выбор для больших и «шумных» страниц и для сбора ссылок перед crawl.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          max_chars: { type: 'integer', description: 'Максимум символов текста, по умолчанию 32000.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scrape_page',
      description:
        'Разобрать страницу профессионально: чистый Markdown с заголовками, списками и таблицами, либо текст, либо поля по CSS-селекторам (цена, название, ссылка, дата). Понимает selector@attr. Для сайтов на JavaScript включите render — страница отрисуется браузером. Бесплатно, без внешних API и ключей.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Полный адрес http(s)://…' },
          format: {
            type: 'string',
            enum: ['markdown', 'text', 'json'],
            description: 'markdown (по умолчанию), text или json для полей по селекторам.',
          },
          selectors: {
            type: 'object',
            description:
              'Поля для сбора, например {"title":"h1","price":".price","link":"a.buy@href","date":"time@datetime"}. Без него возвращается статья.',
          },
          render: { type: 'boolean', description: 'Отрисовать JavaScript в браузере (медленнее; в облаке может быть недоступно).' },
          wait_ms: { type: 'integer', description: 'Подождать после загрузки при render, мс, до 20000.' },
          wait_selector: { type: 'string', description: 'Дождаться элемента при render, например ".price".' },
          max_chars: { type: 'integer', description: 'Максимум символов результата, по умолчанию 30000.' },
          timeout_ms: { type: 'integer', description: 'Предел загрузки при render, мс, до 90000.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_many',
      description:
        'Загрузить до 6 ссылок параллельно и получить текст каждой. Быстрее, чем вызывать fetch_url по одной, и не срывается, если часть ссылок недоступна.',
      parameters: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: 'Ссылки, до 6.' },
          max_chars: { type: 'integer', description: 'Максимум символов на страницу, по умолчанию 8000.' },
        },
        required: ['urls'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'crawl',
      description:
        'Обойти сайт по внутренним ссылкам: до 20 страниц с одного домена, с ограничением глубины. Нужен, когда данных нет на одной странице — каталог, прайс, документация, список документов.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Стартовая страница.' },
          max_pages: { type: 'integer', description: 'Сколько страниц обойти, 1–20. По умолчанию 8.' },
          max_depth: { type: 'integer', description: 'Глубина переходов, 0–2. По умолчанию 1.' },
          max_chars: { type: 'integer', description: 'Максимум символов текста на страницу, по умолчанию 4000.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_page',
      description:
        'Проверить страницу перед сдачей: снимки на 390/768/1440 px прямо в файлах проекта плюс машинный отчёт — горизонтальная прокрутка, ошибки консоли, битые и внешние запросы, картинки без alt, отсутствие h1. Работает и для файла проекта (путь, например index.html), и для живого адреса. В окружении без браузера проверяет по коду: h1, alt, внешние и битые ссылки, фиксированные ширины, парность тегов — и честно пишет, что осталось непроверенным.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Путь к файлу проекта (index.html) или адрес https://…' },
          widths: { type: 'string', description: 'Ширины проверки через запятую. По умолчанию 390,768,1440.' },
          width: { type: 'integer', description: 'Одна ширина вместо набора, 320–2400.' },
          height: { type: 'integer', description: 'Высота окна, 320–2400. По умолчанию 900.' },
          full_page: { type: 'boolean', description: 'Снимать страницу целиком, а не первый экран.' },
          screenshot: { type: 'string', description: 'Имя снимка в проекте. По умолчанию screens/page-<ширина>.png.' },
          wait_ms: { type: 'integer', description: 'Подождать после загрузки, мс, до 20000.' },
          timeout_ms: { type: 'integer', description: 'Предел ожидания страницы, мс, до 90000.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'page_template',
      description:
        'Готовый каркас страницы (hero, 2–4 числа, карточки, таблица, финал, подвал, адаптив, видимая плашка ошибок): скопируй в проект и замени содержимое, а не собирай вёрстку с нуля. Возвращает один самодостаточный HTML-файл без внешних запросов.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_python',
      description:
        'Выполнить Python-код в папке проекта (если Python установлен; в облаке его нет — тогда используй run_js).',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: 'Полный код скрипта.' } },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_js',
      description:
        'Выполнить JavaScript в папке проекта — замена Python там, где его нет. В песочнице есть: read(path), readJson(path), write(path, text|object), append(path, text), ls(path), exists(path), print(...), parseCsv(text), toCsv(rows), read-файлы, sum/avg/median/pct/stdev/min/max/round/groupBy. Верни результат через return или print. Годится для пересчётов, чистки и сводок CSV/JSON, разбора текста, проверки сумм и долей, генерации CSV и MD. Тяжёлые таблицы (сотни тысяч строк) считай через analyze_data, а сюда подавай агрегаты.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Код на JavaScript. Тело функции: доступен return.' },
          timeout_ms: { type: 'integer', description: 'Предел времени, мс. По умолчанию 8000, максимум 20000.' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_agent',
      description:
        'Запустить 1–4 субагентов параллельно. Каждый работает в своём изолированном контексте и возвращает сжатый отчёт: чтение файлов, анализ данных, расчёты (run_js), поиск и загрузка страниц. Файлы создаёт основная задача. Используй для параллельного исследования, независимой перепроверки цифр и больших разборов, где одному агенту не хватает шагов.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'Задачи субагентов, от 1 до 4.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Короткое имя подзадачи.' },
                task: { type: 'string', description: 'Что сделать и что вернуть в отчёте.' },
              },
              required: ['task'],
            },
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ограничить набор инструментов подзадач (необязательно).',
          },
          context: { type: 'string', description: 'Общий контекст, который увидят все субагенты.' },
          concurrency: { type: 'integer', description: 'Сколько работать одновременно, 1–4. По умолчанию 3.' },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_excel',
      description:
        'Создать профессиональный файл Excel (.xlsx). Поддерживает: заголовок листа, шапку таблицы, форматы чисел (numFmt), живые формулы (значение строкой с «=» в начале: «=SUM(B2:B10)», «=B2/C2»), закреплённые колонки, автофильтр, итоговую строку, условное форматирование цветовой шкалой, сноску и настоящую диаграмму внутри листа. Один вызов собирает всю книгу. Используй для «сделай эксель / таблицу / смету / финмодель / выгрузку».',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Имя файла, например «Отчёт.xlsx».' },
          sheets: {
            type: 'array',
            description: 'Листы книги.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Название листа, до 31 символа.' },
                title: { type: 'string', description: 'Заголовок над таблицей (объединённая первая строка).' },
                columns: {
                  type: 'array',
                  description: 'Описание колонок; header становится шапкой таблицы, numFmt — форматом чисел.',
                  items: {
                    type: 'object',
                    properties: {
                      header: { type: 'string' },
                      width: { type: 'number', description: 'Ширина в символах, по умолчанию 24 для первой и 16 для остальных.' },
                      numFmt: { type: 'string', description: 'Формат Excel, например «#,##0.00», «0,0%», «dd.mm.yyyy».' },
                      numeric: { type: 'boolean', description: 'Числовая колонка: выравнивание вправо.' },
                      align: { type: 'string', enum: ['left', 'center', 'right'] },
                      wrap: { type: 'boolean', description: 'Перенос текста, по умолчанию включён.' },
                    },
                  },
                },
                rows: {
                  type: 'array',
                  description: 'Строки данных. Числа передавай числами, формулы — строкой с «=» в начале.',
                  items: { type: 'array', items: {} },
                },
                totalRow: { type: 'boolean', description: 'Оформить последнюю строку как «Итого».' },
                freezeColumns: { type: 'integer', description: 'Сколько первых колонок закрепить.' },
                autoFilter: { type: 'boolean', description: 'Автофильтр по шапке, по умолчанию включён.' },
                note: { type: 'string', description: 'Сноска под таблицей.' },
                conditional: {
                  type: 'array',
                  description: 'Цветовая шкала на диапазон (например, тепловая карта по выручке).',
                  items: {
                    type: 'object',
                    properties: {
                      range: { type: 'string', description: 'Диапазон, например «E5:E12».' },
                      from: { type: 'string', description: 'Цвет минимума, HEX без решётки.' },
                      to: { type: 'string', description: 'Цвет максимума, HEX без решётки.' },
                    },
                    required: ['range'],
                  },
                },
                chart: {
                  type: 'object',
                  description: 'Диаграмма, построенная по строкам листа.',
                  properties: {
                    type: { type: 'string', enum: ['column', 'bar', 'line', 'pie', 'doughnut', 'area'] },
                    title: { type: 'string' },
                    categoriesColumn: { type: 'integer', description: 'Номер колонки категорий, с 1.' },
                    valueColumns: { type: 'array', items: { type: 'integer' }, description: 'Номера колонок значений, с 1.' },
                    position: { type: 'string', description: 'Куда поставить диаграмму, например «G2».' },
                    width: { type: 'number', description: 'Ширина в пикселях, по умолчанию 640.' },
                    height: { type: 'number', description: 'Высота в пикселях, по умолчанию 320.' },
                  },
                  required: ['type'],
                },
              },
              required: ['name', 'rows'],
            },
          },
        },
        required: ['path', 'sheets'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_word',
      description:
        'Создать деловой документ Word (.docx): обложка, оглавление, разделы с подзаголовками, строка KPI, таблицы с повторяющейся шапкой, списки, настоящие диаграммы Word, картинки, колонтитулы с номерами страниц. Используй для «сделай вордовский файл / документ Word / отчёт / договор / коммерческое предложение».',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Имя файла, например «Отчёт.docx».' },
          title: { type: 'string', description: 'Заголовок документа.' },
          kicker: { type: 'string', description: 'Надзаголовок, 2–4 слова, капсом на обложке.' },
          subtitle: { type: 'string', description: 'Подзаголовок: суть документа одной строкой.' },
          author: { type: 'string', description: 'Автор или подразделение для обложки.' },
          date: { type: 'string', description: 'Дата на обложке, например «12 октября 2026».' },
          cover: { type: 'boolean', description: 'Сделать титульную страницу (только вместе с title).' },
          toc: { type: 'boolean', description: 'Добавить поле оглавления (обновится в Word по F9).' },
          headerText: { type: 'string', description: 'Текст верхнего колонтитула, по умолчанию заголовок.' },
          footerText: { type: 'string', description: 'Текст нижнего колонтитула слева.' },
          pageNumbers: { type: 'boolean', description: 'Показывать «стр. N из M», по умолчанию да.' },
          sections: {
            type: 'array',
            description: 'Разделы документа по порядку.',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string', description: 'Заголовок раздела.' },
                paragraphs: { type: 'array', items: { type: 'string' }, description: 'Абзацы по ширине страницы.' },
                bullets: { type: 'array', items: { type: 'string' }, description: 'Пункты списка.' },
                kpi: {
                  type: 'array',
                  description: 'Строка из 2–4 ключевых цифр под заголовком раздела.',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string', description: 'Крупное значение, например «184,6 млн ₽».' },
                      label: { type: 'string', description: 'Подпись капсом, 1–3 слова.' },
                    },
                    required: ['value', 'label'],
                  },
                },
                subsections: {
                  type: 'array',
                  description: 'Подразделы второго уровня.',
                  items: {
                    type: 'object',
                    properties: {
                      heading: { type: 'string' },
                      paragraphs: { type: 'array', items: { type: 'string' } },
                      bullets: { type: 'array', items: { type: 'string' } },
                      table: { type: 'object', properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } },
                      chart: DOCX_CHART_SCHEMA,
                      image: DOCX_IMAGE_SCHEMA,
                      images: { type: 'array', items: DOCX_IMAGE_SCHEMA },
                    },
                  },
                },
                chart: DOCX_CHART_SCHEMA,
                charts: { type: 'array', items: DOCX_CHART_SCHEMA, description: 'Несколько диаграмм подряд.' },
                image: DOCX_IMAGE_SCHEMA,
                images: { type: 'array', items: DOCX_IMAGE_SCHEMA, description: 'Несколько картинок подряд.' },
                table: {
                  type: 'object',
                  description: 'Таблица раздела: шапка и строки.',
                  properties: {
                    headers: { type: 'array', items: { type: 'string' } },
                    rows: { type: 'array', items: { type: 'array', items: {} } },
                    totalRow: { type: 'boolean', description: 'Последняя строка — «Итого», выделяется.' },
                    numericColumns: { type: 'array', items: { type: 'integer' }, description: 'Индексы числовых колонок с 0 для выравнивания вправо.' },
                    columnWidths: { type: 'array', items: { type: 'number' }, description: 'Ширины колонок в сантиметрах.' },
                  },
                },
                note: { type: 'string', description: 'Сноска под разделом.' },
              },
            },
          },
          paragraphs: { type: 'array', items: { type: 'string' }, description: 'Простой режим: абзацы без разделов.' },
          bullets: { type: 'array', items: { type: 'string' }, description: 'Простой режим: список без разделов.' },
          image: DOCX_IMAGE_SCHEMA,
          images: { type: 'array', items: DOCX_IMAGE_SCHEMA, description: 'Картинки сразу под шапкой (например, логотип).' },
          table: { type: 'object', description: 'Простой режим: одна таблица без разделов.', properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: {} } } } },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pptx',
      description:
        'Создать презентацию PowerPoint (.pptx) 16:9: обложка, разделители, слайды с тезисами, настоящие диаграммы PowerPoint, таблицы, KPI-строка и заметки докладчика. Используй для «сделай презентацию / слайды / питч-дек / pptx». Если просят именно PDF — используй create_pdf с layout «slides».',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Имя файла, например «Презентация.pptx».' },
          title: { type: 'string', description: 'Заголовок презентации и обложки.' },
          subtitle: { type: 'string', description: 'Подзаголовок обложки.' },
          kicker: { type: 'string', description: 'Надзаголовок обложки, 2–4 слова.' },
          author: { type: 'string', description: 'Автор для обложки и свойств файла.' },
          date: { type: 'string', description: 'Дата на обложке.' },
          cover: { type: 'boolean', description: 'Добавить обложку, по умолчанию да (если задан title).' },
          footerText: { type: 'string', description: 'Подпись внизу каждого слайда.' },
          slides: {
            type: 'array',
            description: 'Слайды по порядку.',
            items: {
              type: 'object',
              properties: {
                layout: { type: 'string', enum: ['cover', 'section', 'content', 'visual', 'quote'], description: 'cover — обложка, section — разделитель, content — тезисы, visual — крупная диаграмма/таблица, quote — цитата. По умолчанию выбирается по составу.' },
                kicker: { type: 'string', description: 'Надзаголовок слайда.' },
                title: { type: 'string', description: 'Заголовок слайда — утверждение, а не тема.' },
                paragraphs: { type: 'array', items: { type: 'string' } },
                bullets: { type: 'array', items: { type: 'string' }, description: 'Тезисы, 2–5 на слайд.' },
                kpi: {
                  type: 'array',
                  description: 'Строка ключевых цифр под заголовком.',
                  items: {
                    type: 'object',
                    properties: { value: { type: 'string' }, label: { type: 'string' } },
                    required: ['value', 'label'],
                  },
                },
                chart: {
                  type: 'object',
                  description: 'Диаграмма PowerPoint.',
                  properties: {
                    type: { type: 'string', enum: ['column', 'bar', 'line', 'pie', 'doughnut', 'area'] },
                    title: { type: 'string' },
                    categories: { type: 'array', items: { type: 'string' }, description: 'Подписи категорий.' },
                    series: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } },
                        required: ['name', 'values'],
                      },
                    },
                  },
                  required: ['type', 'series'],
                },
                table: {
                  type: 'object',
                  properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: {} } } },
                },
                note: { type: 'string', description: 'Заметки докладчика.' },
              },
            },
          },
        },
        required: ['path', 'slides'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pdf',
      description:
        'Создать настоящий PDF (.pdf). Презентация: layout «slides» — страница на слайд 16:9, поддерживает KPI, диаграммы (столбцы/линии), таблицы и заметки. Документ: layout «document» — A4 с обложкой, заголовками, абзацами, списками, KPI и таблицами. Используй для любой просьбы «сделай PDF».',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Имя файла, например «Презентация.pdf».' },
          layout: { type: 'string', enum: ['slides', 'document'], description: 'slides — презентация, document — документ A4.' },
          title: { type: 'string', description: 'Заголовок документа или обложки.' },
          subtitle: { type: 'string', description: 'Подзаголовок.' },
          kicker: { type: 'string', description: 'Надзаголовок обложки, 2–4 слова.' },
          author: { type: 'string', description: 'Автор или подразделение на обложке.' },
          date: { type: 'string', description: 'Дата на обложке.' },
          cover: { type: 'boolean', description: 'Титульная страница (для document по умолчанию да, если задан title).' },
          footerText: { type: 'string', description: 'Подпись внизу страниц и слайдов.' },
          slides: {
            type: 'array',
            description: 'Слайды презентации.',
            items: {
              type: 'object',
              properties: {
                layout: { type: 'string', enum: ['cover', 'section', 'content', 'visual', 'quote'] },
                kicker: { type: 'string' },
                title: { type: 'string' },
                paragraphs: { type: 'array', items: { type: 'string' } },
                bullets: { type: 'array', items: { type: 'string' } },
                kpi: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } }, required: ['value', 'label'] } },
                chart: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['column', 'bar', 'line'] },
                    title: { type: 'string' },
                    categories: { type: 'array', items: { type: 'string' } },
                    series: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['name', 'values'] } },
                  },
                  required: ['type', 'series'],
                },
                table: { type: 'object', properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: {} } } } },
                note: { type: 'string', description: 'Короткая подпись внизу слайда.' },
              },
            },
          },
          sections: {
            type: 'array',
            description: 'Разделы документа A4.',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                paragraphs: { type: 'array', items: { type: 'string' } },
                bullets: { type: 'array', items: { type: 'string' } },
                kpi: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } }, required: ['value', 'label'] } },
                table: { type: 'object', properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: {} } } } },
                chart: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['column', 'bar', 'line'] },
                    title: { type: 'string' },
                    categories: { type: 'array', items: { type: 'string' } },
                    series: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['name', 'values'] } },
                  },
                  required: ['type', 'series'],
                },
              },
            },
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Запомнить устойчивое предпочтение или правило пользователя навсегда (между диалогами). Пиши одной короткой фразой, например: «документы называет коротко и с расширением». Не запоминай содержимое текущей задачи и то, что уже лежит в файлах проекта.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Факт или правило, одной фразой, до 400 символов.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description:
        'Открыть полную инструкцию навыка по его id. Список навыков с описаниями есть в системном сообщении. Вызывай до начала работы над документом, таблицей, презентацией, PDF, сайтом или сбором данных со страниц.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Идентификатор навыка, например office-xlsx.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_document',
      description:
        'Проверить готовый .docx/.xlsx/.pptx/.pdf: целостность пакета, наличие текста, пустые ячейки, выход блоков за границы слайда. Возвращает отчёт. Используй, если файл правили вручную или нужно убедиться перед отдачей пользователю.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь файла внутри проекта.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_archive',
      description:
        'Распаковать архив .zip (или одиночный .gz) из проекта. По умолчанию распаковывает в скрытую рабочую папку `.dshow/work/unpacked/…`, чтобы служебные файлы не засоряли «Файлы проекта». Если пользователь просил распаковать архив для себя — укажи to с видимой папкой. Возвращает список файлов и пропущенных записей. Используй, когда приложили архив с документами, выгрузкой или проектом: распакуй, затем читай файлы read_document/analyze_data. .rar, .7z и .tar не поддерживаются — скажи об этом прямо.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к архиву внутри проекта, например «Материалы.zip».' },
          to: { type: 'string', description: 'Папка, куда распаковать. По умолчанию — скрытая `.dshow/work/unpacked/<имя архива>`. Укажи видимую папку, только если пользователь просил распаковать архив для себя.' },
          overwrite: { type: 'boolean', description: 'Перезаписывать существующие файлы. По умолчанию нет.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_links',
      description:
        'Проверить, живые ли ссылки: код ответа, редирект на другой сайт, закрытый или удалённый адрес. Ничего не скачивает и не читает тело страницы. Проверяй ссылки перед тем, как поставить их в отчёт, договор или ответ со источниками; мёртвую ссылку убери или замени.',
      parameters: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            description: 'Адреса для проверки, до 12 штук.',
            items: { type: 'string' },
          },
          path: { type: 'string', description: 'Либо путь к файлу или документу, из которого взять все ссылки.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_documents',
      description:
        'Сравнить две версии документа построчно и показать отличия: что удалено, что добавлено. Понимает .docx/.xlsx/.pptx/.pdf/.txt/.md/.html/.csv. Используй для «сравни версии договора/сметы/отчёта», «что изменилось после правок», а не читай оба файла целиком вручную.',
      parameters: {
        type: 'object',
        properties: {
          left: { type: 'string', description: 'Путь к первой (старой) версии.' },
          right: { type: 'string', description: 'Путь ко второй (новой) версии.' },
        },
        required: ['left', 'right'],
      },
    },
  },
];

export const TOOL_LABELS = {
  list_files: 'Просмотр файлов',
  read_file: 'Чтение файла',
  write_file: 'Создание файла',
  append_file: 'Дозапись файла',
  calculate: 'Расчёты',
  edit_file: 'Правка файла',
  delete_path: 'Удаление',
  move_path: 'Перемещение',
  find_in_files: 'Поиск по файлам',
  read_document: 'Разбор документа',
  analyze_data: 'Анализ данных',
  analyze_image: 'Распознавание изображения',
  web_search: 'Поиск в интернете',
  fetch_url: 'Загрузка страницы',
  read_page: 'Чтение страницы',
  fetch_many: 'Загрузка ссылок',
  crawl: 'Обход сайта',
  check_page: 'Проверка страницы в браузере',
  scrape_page: 'Разбор страницы',
  page_template: 'Каркас страницы',
  run_python: 'Расчёты',
  run_js: 'Расчёты',
  spawn_agent: 'Субагенты',
  create_excel: 'Создание Excel',
  create_word: 'Создание Word',
  create_pptx: 'Создание презентации',
  create_pdf: 'Создание PDF',
  remember: 'Память',
  use_skill: 'Навык',
  check_document: 'Проверка файла',
  extract_archive: 'Распаковка архива',
  check_links: 'Проверка ссылок',
  compare_documents: 'Сравнение документов',
};

/** Русское склонение по числу: 1 ссылка, 2 ссылки, 5 ссылок. */
function plural(count, one, few, many) {
  const n = Math.abs(Number(count) || 0) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function toolSummary(name, args) {
  if (!args || typeof args !== 'object') return '';
  switch (name) {
    case 'read_file':
    case 'read_document':
    case 'analyze_image':
    case 'delete_path':
      return args.path || '';
    case 'write_file':
    case 'create_excel':
    case 'create_word':
    case 'create_pptx':
    case 'create_pdf':
      return args.path || '';
    case 'move_path':
      return `${args.from || ''} → ${args.to || ''}`;
    case 'web_search':
      return String(args.query || (Array.isArray(args.queries) ? args.queries.join(' | ') : '')).slice(0, 120);
    case 'fetch_url':
      return `${args.method && args.method !== 'GET' ? `${String(args.method).toUpperCase()} ` : ''}${args.url || ''}`;
    case 'read_page':
      return args.url || '';
    case 'fetch_many': {
      const count = Array.isArray(args.urls) ? args.urls.length : 0;
      return count ? `${count} ${plural(count, 'ссылка', 'ссылки', 'ссылок')}` : '';
    }
    case 'crawl':
      return args.url || '';
    case 'check_page':
      return `${args.url || ''}${args.widths ? ` · ${args.widths}` : args.width ? ` · ${args.width} px` : ' · 390/768/1440 px'}`;
    case 'scrape_page': {
      const bits = [args.url || ''];
      const fields = args.selectors && typeof args.selectors === 'object' ? Object.keys(args.selectors).length : 0;
      if (fields) bits.push(`${fields} ${plural(fields, 'поле', 'поля', 'полей')}`);
      if (args.render) bits.push('JS');
      return bits.filter(Boolean).join(' · ');
    }
    case 'page_template':
      return 'готовый каркас';
    case 'analyze_data':
      return `${args.path || ''}${args.mode ? ` · ${args.mode}` : ''}`;
    case 'extract_archive':
      return `${args.path || ''}${args.to ? ` → ${args.to}` : ''}`;
    case 'check_links': {
      const count = Array.isArray(args.urls) ? args.urls.length : 0;
      if (count) return `${count} ${plural(count, 'ссылка', 'ссылки', 'ссылок')}`;
      return args.path ? `ссылки из ${args.path}` : '';
    }
    case 'compare_documents':
      return `${args.left || ''} ↔ ${args.right || ''}`;
    case 'find_in_files':
      return args.query || '';
    case 'run_python':
    case 'run_js': {
      const lines = String(args.code || '').split('\n').length;
      return `${lines} ${plural(lines, 'строка', 'строки', 'строк')} кода`;
    }
    case 'spawn_agent': {
      const list = Array.isArray(args.tasks) ? args.tasks : [];
      const names = list
        .map((item, index) => String(typeof item === 'string' ? item : item?.name || `Подзадача ${index + 1}`))
        .slice(0, 4);
      return names.join(', ');
    }
    case 'append_file':
      return args.path || '';
    case 'calculate':
      return String(args.expression || '').slice(0, 80);
    case 'list_files':
      return args.path || '.';
    default:
      return '';
  }
}

function assertInside(root, full) {
  const resolved = path.resolve(full);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error('Путь выходит за пределы проекта');
  }
  return resolved;
}

/* Инструменты, которые меняют файлы, и аргументы с путями. */
const WRITE_TARGETS = {
  write_file: ['path'],
  append_file: ['path'],
  edit_file: ['path'],
  delete_path: ['path'],
  move_path: ['from', 'to'],
  create_excel: ['path'],
  create_word: ['path'],
  create_pptx: ['path'],
  create_pdf: ['path'],
  check_page: ['screenshot'],
  /* Архив только читаем, пишем в папку распаковки: ограничивать path нельзя,
     иначе субагент не сможет развернуть архив, лежащий выше его папки. */
  extract_archive: ['to'],
};

/**
 * Куда можно писать. Основная задача пишет по всему проекту; у субагента
 * (ctx.writeRoot) есть только своя папка — иначе четыре воркера затирают файлы
 * друг друга и общий результат превращается в кашу.
 */
export function assertWriteScope(ctx, name, args) {
  const scope = String(ctx?.writeRoot || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!scope) return;
  const keys = WRITE_TARGETS[name];
  if (!keys) return;
  const root = ctx.workspace;
  const base = assertInside(root, resolveSafe(root, scope));
  for (const key of keys) {
    const value = String(args?.[key] ?? '').trim();
    if (!value) continue;
    const full = assertInside(root, resolveSafe(root, value));
    if (full !== base && !full.startsWith(base + path.sep)) {
      const error = new Error(
        `Твоя рабочая папка — «${scope}». Файлы за её пределы писать нельзя: положи результат в «${scope}/<имя файла>» и укажи путь в отчёте.`,
      );
      error.status = 400;
      throw error;
    }
  }
}

/** Безопасный калькулятор без доступа к окружению: только числа и базовые функции. */
function evaluateExpression(raw) {
  const source = String(raw)
    .replace(/[×х]/gi, '*')
    .replace(/÷/g, '/')
    .replace(/\^/g, '**')
    .replace(/\s+/g, '')
    .replace(/%/g, '/100');
  if (!source) throw new Error('Пустое выражение');
  if (!/^(?:[0-9+\-*/%().]|round|min|max|abs|sqrt|pow)+$/i.test(source)) {
    throw new Error('Выражение содержит недопустимые символы');
  }
  const fn = new Function(
    'round',
    'min',
    'max',
    'abs',
    'sqrt',
    'pow',
    `"use strict"; return (${source});`,
  );
  const value = fn(Math.round, Math.min, Math.max, Math.abs, Math.sqrt, Math.pow);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Не удалось посчитать выражение');
  return Math.round(value * 1e10) / 1e10;
}

let pythonChecked = null;

/** Есть ли Python в этом окружении (в облаке его нет). */
export function pythonAvailable() {
  if (!pythonChecked) {
    pythonChecked = findPython().then(
      () => true,
      () => false,
    );
  }
  return pythonChecked;
}

/** Инструменты, доступные в текущем окружении: без run_python, если Python не
 * установлен. check_page остаётся всегда — без браузера он проверяет страницу
 * по коду, а не исчезает из набора в середине задачи. */
export async function availableToolDefs() {
  const withPython = await pythonAvailable();
  let defs = TOOL_DEFS;
  if (!withPython) defs = defs.filter((tool) => tool.function.name !== 'run_python');
  return defs;
}

export async function executeTool(name, args, ctx) {
  const root = ctx.workspace;
  /* Субагент пишет только в свою папку: проверяем до записи, а не после. */
  assertWriteScope(ctx, name, args);
  switch (name) {
    case 'list_files': {
      const depth = Math.max(1, Math.min(5, Number(args.depth) || 3));
      const items = listTree(root, args.path || '.', { depth });
      if (!items.length) return { text: 'В проекте пока нет файлов.' };
      const lines = items.map((item) => `${item.dir ? '📁' : '📄'} ${item.path}${item.dir ? '/' : ` (${formatBytes(item.size)})`}`);
      return { text: lines.join('\n'), meta: { count: items.length } };
    }
    case 'read_file': {
      const full = assertInside(root, resolveSafe(root, args.path));
      const stat = fs.statSync(full);
      if (!stat.isFile()) throw new Error('Это не файл');
      const kind = detectKind(args.path);
      if (kind === 'image') throw new Error('Это изображение — используйте analyze_image');
      if (kind === 'binary' || kind === 'archive') throw new Error('Двоичный файл — используйте read_document');
      const text = fs.readFileSync(full, 'utf8');
      const lines = text.split(/\r?\n/);
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.max(1, Math.min(2000, Number(args.limit) || lines.length));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((line, i) => `${offset + i}: ${line}`).join('\n');
      return {
        text: `Файл ${args.path} (${lines.length} строк, ${formatBytes(stat.size)}):\n${truncate(numbered, LIMITS.maxFileTextChars)}`,
        meta: { size: stat.size },
      };
    }
    case 'write_file': {
      const rel = String(args.path || '').trim();
      if (!rel) throw new Error('Не указан путь');
      const full = assertInside(root, resolveSafe(root, rel));
      const content = String(args.content ?? '');
      if (content.length > 6 * 1024 * 1024) throw new Error('Слишком большой файл (максимум 6 МБ)');
      ensureDirFor(full);
      ensureFreeSpace(Buffer.byteLength(content));
      fs.writeFileSync(full, content, 'utf8');
      return { text: `Файл сохранён: ${rel} (${formatBytes(Buffer.byteLength(content))})`, meta: { path: rel, size: Buffer.byteLength(content), created: true } };
    }
    case 'append_file': {
      const rel = String(args.path || '').trim();
      if (!rel) throw new Error('Не указан путь');
      const full = assertInside(root, resolveSafe(root, rel));
      const content = String(args.content ?? '');
      if (!content) throw new Error('Пустая часть содержимого');
      const existing = fs.existsSync(full) ? fs.statSync(full).size : 0;
      if (existing + Buffer.byteLength(content) > 6 * 1024 * 1024) throw new Error('Слишком большой файл (максимум 6 МБ)');
      ensureDirFor(full);
      ensureFreeSpace(Buffer.byteLength(content));
      fs.appendFileSync(full, content, 'utf8');
      const total = existing + Buffer.byteLength(content);
      return { text: `Дописано в ${rel}: ${formatBytes(Buffer.byteLength(content))} (итого ${formatBytes(total)})`, meta: { path: rel, size: total, appended: true } };
    }
    case 'calculate': {
      const expression = String(args.expression || '').trim();
      if (!expression) throw new Error('Пустое выражение');
      const value = evaluateExpression(expression);
      return { text: `Результат: ${value}` };
    }
    case 'edit_file': {
      const full = assertInside(root, resolveSafe(root, args.path));
      const text = fs.readFileSync(full, 'utf8');
      const oldText = String(args.old_text ?? '');
      if (!oldText) throw new Error('Пустой old_text');
      const count = text.split(oldText).length - 1;
      if (count === 0) throw new Error('Фрагмент не найден в файле');
      if (count > 1 && !args.replace_all) throw new Error(`Фрагмент встречается ${count} раз — уточните или включите replace_all`);
      const next = args.replace_all ? text.split(oldText).join(String(args.new_text ?? '')) : text.replace(oldText, String(args.new_text ?? ''));
      ensureFreeSpace(Buffer.byteLength(next));
      fs.writeFileSync(full, next, 'utf8');
      return { text: `Изменено вхождений: ${args.replace_all ? count : 1}`, meta: { path: args.path, edited: true } };
    }
    case 'delete_path': {
      const full = assertInside(root, resolveSafe(root, args.path));
      if (full === path.resolve(root)) throw new Error('Нельзя удалить корень проекта');
      if (!fs.existsSync(full)) throw new Error('Файл не найден');
      fs.rmSync(full, { recursive: true, force: true });
      return { text: `Удалено: ${args.path}`, meta: { path: args.path } };
    }
    case 'move_path': {
      const from = assertInside(root, resolveSafe(root, args.from));
      const to = assertInside(root, resolveSafe(root, args.to));
      if (!fs.existsSync(from)) throw new Error('Исходный файл не найден');
      ensureDirFor(to);
      fs.renameSync(from, to);
      return { text: `Перемещено: ${args.from} → ${args.to}`, meta: { path: args.to } };
    }
    case 'find_in_files': {
      const base = args.path ? resolveSafe(root, args.path) : root;
      const query = String(args.query || '');
      if (!query) throw new Error('Пустой запрос');
      let matcher;
      if (args.regex) {
        const re = new RegExp(query, 'gi');
        matcher = (line) => re.test(line);
      } else {
        const lower = query.toLowerCase();
        matcher = (line) => line.toLowerCase().includes(lower);
      }
      const results = [];
      const scanFile = (full) => {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          return;
        }
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return;
        const kind = detectKind(full);
        if (kind === 'binary' || kind === 'archive' || kind === 'image') return;
        let text = '';
        try {
          text = fs.readFileSync(full, 'utf8');
        } catch {
          return;
        }
        const rel = path.relative(root, full).replace(/\\/g, '/');
        text.split(/\r?\n/).forEach((line, idx) => {
          if (results.length < 60 && matcher(line)) {
            results.push(`${rel}:${idx + 1}: ${truncate(line.trim(), 240)}`);
          }
        });
      };
      if (fs.existsSync(base) && fs.statSync(base).isFile()) {
        scanFile(base);
        return { text: results.length ? results.join('\n') : 'Ничего не найдено.', meta: { count: results.length } };
      }
      const walk = (dir) => {
        if (results.length >= 60) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else {
            scanFile(full);
            if (results.length >= 60) return;
          }
        }
      };
      walk(base);
      return { text: results.length ? results.join('\n') : 'Ничего не найдено.', meta: { count: results.length } };
    }
    case 'read_document': {
      const full = assertInside(root, resolveSafe(root, args.path));
      const buf = fs.readFileSync(full);
      const parsed = extractDocumentText(buf, args.path, '', { maxChars: LIMITS.maxFileTextChars });
      if (!parsed.text) {
        return { text: `Не удалось извлечь текст. ${parsed.warnings.join(' ')}`, meta: { path: args.path } };
      }
      return {
        text: `Документ ${args.path} (${parsed.kind}):\n${parsed.text}${parsed.warnings.length ? `\n\nПримечания: ${parsed.warnings.join(' ')}` : ''}`,
        meta: { path: args.path, kind: parsed.kind },
      };
    }
    case 'analyze_data': {
      const full = assertInside(root, resolveSafe(root, args.path));
      const stat = fs.statSync(full);
      if (!stat.isFile()) throw new Error('Это не файл');
      const result = await analyzeData({
        filePath: full,
        mode: args.mode,
        sheet: args.sheet,
        delimiter: args.delimiter,
        encoding: args.encoding,
        headerRow: args.headerRow,
        filters: args.filters,
        groupBy: args.groupBy,
        metrics: args.metrics,
        sort: args.sort,
        limit: args.limit,
      });
      const text = formatAnalysis(result);
      return {
        text: truncate(text, 20000),
        meta: {
          path: args.path,
          mode: result.mode,
          rows: result.scanned ?? result.rows?.length ?? 0,
          matched: result.matched ?? null,
        },
      };
    }
    case 'analyze_image': {
      const full = assertInside(root, resolveSafe(root, args.path));
      const ext = path.extname(args.path).toLowerCase().slice(1);      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png';
      const result = await describeImage({
        buffer: fs.readFileSync(full),
        mime,
        name: args.path,
        instruction: args.instruction,
        signal: ctx.signal,
      });
      return { text: `Распознавание ${args.path}:\n${result.text}`, meta: { path: args.path, vision: true } };
    }
    case 'web_search': {
      const limit = Math.max(1, Math.min(10, Number(args.limit) || 6));
      const queries = Array.isArray(args.queries) ? args.queries : [args.query].filter(Boolean);
      if (!queries.length) throw new Error('Нужен поисковый запрос');
      if (queries.length > 1) {
        /* Поиск отдаётся по максимальному качеству: на каждый вариант
           формулировки берём больше адресов, а не два-три сниппета. */
        const found = await searchMany(queries, { perQuery: Math.max(3, Math.min(limit, 8)) });
        if (!found.results.length) {
          return { text: `Поиск не дал результатов.${found.failures.length ? `\nОшибки: ${found.failures.join('; ')}` : ''}` };
        }
        const body = found.results
          .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${searchBadge(r)}${r.snippet}\n(запрос: ${r.query})`)
          .join('\n\n');
        return {
          text: `Запросы: ${found.queries.join(' | ')}\n\n${body}`,
          meta: { count: found.results.length, failed: found.failures.length },
        };
      }
      const results = await webSearch(queries[0], limit);
      if (!results.length) return { text: 'Поиск не дал результатов.' };
      return {
        text: results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${searchBadge(r)}${r.snippet}`).join('\n\n'),
        meta: { count: results.length },
      };
    }
    case 'fetch_url': {
      const page = await fetchUrl(args.url, {
        maxChars: Math.min(60000, Number(args.max_chars) || 24000),
        method: args.method || 'GET',
        headers: args.headers && typeof args.headers === 'object' ? args.headers : {},
        body: typeof args.body === 'string' ? args.body : null,
      });
      const head = `Страница ${page.url} (${page.status || 200}${page.kind !== 'text' ? `, ${page.kind}` : ''})${page.title ? ` — ${page.title}` : ''}`;
      return { text: `${head}\n\n${page.text}`, meta: { url: page.url, bytes: page.bytes } };
    }
    case 'read_page': {
      const page = await readPage(args.url, { maxChars: Math.min(60000, Number(args.max_chars) || 32000) });
      const parts = [`URL: ${page.url}`];
      if (page.title) parts.push(`Заголовок: ${page.title}`);
      if (page.description) parts.push(`Описание: ${page.description}`);
      if (page.headings?.length) {
        parts.push(`Структура:\n${page.headings.map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${h.text}`).join('\n')}`);
      }
      if (page.tables?.length) {
        const tables = page.tables
          .slice(0, 3)
          .map((rows, index) => `Таблица ${index + 1}:\n${rows.map((row) => row.join(' | ')).join('\n')}`)
          .join('\n\n');
        parts.push(tables);
      }
      if (page.links?.length) {
        const links = page.links.slice(0, 15).map((link) => `- ${link.text ? `${link.text} — ` : ''}${link.href}`);
        parts.push(`Ссылки (${page.links.length}):\n${links.join('\n')}`);
      }
      parts.push(`Текст:\n${page.text}`);
      return { text: parts.join('\n\n'), meta: { url: page.url, chars: page.chars } };
    }
    case 'scrape_page': {
      const format = ['markdown', 'text', 'json'].includes(args.format) ? args.format : 'markdown';
      const page = await scrapePage(args.url, {
        format,
        maxChars: Math.min(80000, Math.max(1000, Number(args.max_chars) || 30000)),
        selectors: args.selectors && typeof args.selectors === 'object' && !Array.isArray(args.selectors) ? args.selectors : null,
        render: Boolean(args.render),
        waitMs: Math.min(20000, Math.max(0, Number(args.wait_ms) || 0)),
        waitSelector: typeof args.wait_selector === 'string' ? args.wait_selector : '',
        timeoutMs: Math.min(90000, Math.max(5000, Number(args.timeout_ms) || 45000)),
      });
      const head = `URL: ${page.url}${page.title ? `\nЗаголовок: ${page.title}` : ''}`;
      if (page.fields) {
        return {
          text: `${head}\n\n${JSON.stringify(page.fields, null, 2)}`,
          meta: { url: page.url, fields: Object.keys(page.fields).length, engine: page.engine, chars: page.chars },
        };
      }
      if (format === 'json') {
        const data = {
          url: page.url,
          title: page.title,
          description: page.description,
          byline: page.byline,
          publishedTime: page.publishedTime,
          lang: page.lang,
          headings: page.headings,
          tables: page.tables,
          links: page.links,
          text: page.text,
        };
        return { text: JSON.stringify(data, null, 2), meta: { url: page.url, engine: page.engine, chars: page.chars } };
      }
      return {
        text: `${head}${page.description ? `\nОписание: ${page.description}` : ''}\n\n${page.text}`,
        meta: { url: page.url, engine: page.engine, chars: page.chars, markdown: format === 'markdown' },
      };
    }
    case 'fetch_many': {
      const pages = await fetchMany(args.urls, { maxChars: Math.min(20000, Number(args.max_chars) || 8000) });
      const ok = pages.filter((page) => !page.error).length;
      const body = pages
        .map((page, index) =>
          page.error
            ? `### ${index + 1}. ${page.url}\nНе удалось загрузить: ${page.error}`
            : `### ${index + 1}. ${page.title || page.url}\n${page.url}\n\n${page.text}`,
        )
        .join('\n\n');
      return { text: `Загружено ${ok} из ${pages.length}\n\n${body}`, meta: { ok, total: pages.length } };
    }
    case 'crawl': {
      const result = await crawlSite(args.url, {
        maxPages: Number(args.max_pages) || 8,
        maxDepth: Number.isFinite(Number(args.max_depth)) ? Number(args.max_depth) : 1,
        maxChars: Math.min(12000, Number(args.max_chars) || 4000),
      });
      const body = result.pages
        .map((page, index) =>
          page.error
            ? `### ${index + 1}. ${page.url}\nОшибка: ${page.error}`
            : `### ${index + 1}. ${page.title || page.url}\n${page.url}\n\n${page.text}`,
        )
        .join('\n\n');
      return {
        text: `Обход ${result.start}: страниц ${result.pages.length}, найдено ссылок ${result.found}\n\n${body}`,
        meta: { pages: result.pages.length, found: result.found },
      };
    }
    case 'check_page': {
      const result = await checkPage(args.url, {
        root,
        widths: args.widths !== undefined ? String(args.widths) : Number(args.width) || undefined,
        height: Number(args.height) || 900,
        fullPage: Boolean(args.full_page),
        screenshot: String(args.screenshot || ''),
        waitMs: Number(args.wait_ms) || 0,
        timeoutMs: Number(args.timeout_ms) || 30000,
      });
      const variants = result.variants || [];
      const failed = variants.filter((variant) => variant.overflow || variant.consoleErrors.length || variant.broken.length || variant.external.length).length;
      return {
        text: describePage(result),
        meta: {
          mode: result.mode,
          engine: result.engine || null,
          reason: result.reason || '',
          widths: result.widths,
          screenshots: variants.map((variant) => variant.screenshot),
          failedWidths: failed,
          staticIssues: staticIssueCount(result.static || {}),
          note: pageCheckNote(result),
        },
      };
    }
    case 'page_template': {
      const html = pageTemplate();
      const facts = staticPageChecks(html);
      return {
        text: `Каркас страницы (${facts.chars} знаков, h1: «${facts.h1}»)\n\n${html}`,
        meta: { chars: facts.chars },
      };
    }
    case 'run_python': {
      const code = String(args.code || '');
      if (!code.trim()) throw new Error('Пустой код');
      let bin;
      try {
        bin = await findPython();
      } catch {
        throw new Error('Python в этом окружении недоступен. Для расчётов используй run_js (JavaScript в папке проекта) или calculate, для таблиц — analyze_data и create_excel, для текста и кода — write_file.');
      }
      const tmpDir = path.join(root, '.dshow');
      fs.mkdirSync(tmpDir, { recursive: true });
      const scriptPath = path.join(tmpDir, `run_${Date.now()}.py`);
      fs.writeFileSync(scriptPath, `${PYTHON_GUARD}\n${code}`, 'utf8');
      /* -B: не писать __pycache__ в папку проекта. Окружение уже отфильтровано,
         поэтому -E/-I не нужны, а -I вдобавок запрещал бы импорт своих модулей
         из папки проекта. */
      const result = await runProcess(bin, ['-B', scriptPath], {
        cwd: root,
        timeoutMs: LIMITS.pythonTimeoutMs,
      });
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* ignore */
      }
      const parts = [];
      if (result.stdout.trim()) parts.push(`Вывод:\n${truncate(result.stdout.trim(), 20000)}`);
      if (result.stderr.trim()) parts.push(`Ошибки:\n${truncate(result.stderr.trim(), 8000)}`);
      if (result.killed) parts.push('Выполнение остановлено по таймауту (60 с).');
      if (!parts.length) parts.push(`Код завершился с кодом ${result.code} и без вывода.`);
      return { text: parts.join('\n\n'), meta: { code: result.code, killed: result.killed } };
    }
    case 'run_js': {
      const result = await runJavascript({
        code: args.code,
        root,
        timeoutMs: args.timeout_ms,
        signal: ctx.signal,
        writeRoot: ctx.writeRoot,
      });
      const parts = [];
      if (result.output.trim()) parts.push(`Вывод:\n${truncate(result.output.trim(), 16000)}`);
      if (result.files.length) parts.push(`Файлы сохранены: ${result.files.join(', ')}`);
      if (!parts.length) parts.push('Код выполнился без вывода. Верни результат через return или print(...).');
      return { text: parts.join('\n\n'), meta: { ms: result.ms, files: result.files } };
    }
    case 'spawn_agent': {
      if (typeof ctx.spawnAgent !== 'function') {
        throw new Error('Субагенты доступны только внутри основной задачи — сделай эту часть сам.');
      }
      const reports = await ctx.spawnAgent(args);
      const blocks = reports.map((report) =>
        report.error
          ? `### ${report.name}\nСубагент не справился: ${report.error}`
          : `### ${report.name}\n${report.text || 'Пустой отчёт.'}`,
      );
      const failed = reports.filter((report) => report.error).length;
      const tail = failed
        ? `\n\nНе справились: ${reports.filter((report) => report.error).map((report) => report.name).join(', ')}. Сделай эту часть сам.`
        : '';
      return {
        text: `Отчёты субагентов (${reports.length}, ошибок ${failed}):\n\n${blocks.join('\n\n')}${tail}`,
        meta: { count: reports.length, failed },
      };
    }
    case 'create_excel': {
      const rel = String(args.path || 'report.xlsx');
      if (!rel.toLowerCase().endsWith('.xlsx')) throw new Error('Имя файла должно заканчиваться на .xlsx');
      const sheets = Array.isArray(args.sheets) ? args.sheets.filter((sheet) => sheet && Array.isArray(sheet.rows)) : [];
      if (!sheets.length) throw new Error('Нужен хотя бы один лист с строками rows');
      const { buffer: buf, engine } = await makeWorkbook(sheets, buildXlsx);
      ensureFreeSpace(buf.length);
      const full = assertInside(root, resolveSafe(root, rel));
      ensureDirFor(full);
      fs.writeFileSync(full, buf);
      const rows = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
      const charts = sheets.filter((sheet) => sheet.chart).length;
      const parts = [`${sheets.length} лист(ов)`, `${rows} строк`];
      if (charts) parts.push(`диаграмм: ${charts}`);
      const check = await checkDocument(full);
      return {
        text: `Excel создан: ${rel} (${parts.length ? parts.join(', ') : 'пусто'}, ${Math.max(1, Math.round(buf.length / 1024))} КБ)\n${formatCheckReport(check)}`,
        meta: { path: rel, created: true, engine, check: { ok: check.ok, errors: check.errors, warnings: check.warnings } },
      };
    }
    case 'create_word': {
      const rel = String(args.path || 'document.docx');
      if (!rel.toLowerCase().endsWith('.docx')) throw new Error('Имя файла должно заканчиваться на .docx');
      ensureFreeSpace(LIMITS.minFreeBytes);
      const spec = wordSpecFromArgs(args);
      attachImages(spec, root);
      const { buffer: buf, engine } = await makeWord(spec, buildDocx);
      const full = assertInside(root, resolveSafe(root, rel));
      ensureDirFor(full);
      fs.writeFileSync(full, buf);
      const containers = [spec, ...spec.sections.flatMap((section) => [section, ...section.subsections])];
      const images = containers.reduce((sum, item) => sum + (item.images?.length || 0), 0);
      const charts = spec.sections.reduce((sum, section) => sum + (section.chart ? 1 : 0) + (section.charts?.length || 0), 0);
      const detail = [`разделов: ${spec.sections.length}`];
      if (spec.cover) detail.push('обложка');
      if (spec.toc) detail.push('оглавление');
      if (charts) detail.push(`диаграмм: ${charts}`);
      if (images) detail.push(`картинок: ${images}`);
      const check = await checkDocument(full);
      return {
        text: `Word создан: ${rel} (${detail.join(', ')}, ${Math.max(1, Math.round(buf.length / 1024))} КБ)\n${formatCheckReport(check)}`,
        meta: { path: rel, created: true, engine, check: { ok: check.ok, errors: check.errors, warnings: check.warnings } },
      };
    }
    case 'create_pptx': {
      const rel = String(args.path || 'presentation.pptx');
      if (!rel.toLowerCase().endsWith('.pptx')) throw new Error('Имя файла должно заканчиваться на .pptx');
      ensureFreeSpace(LIMITS.minFreeBytes);
      const spec = pptxSpecFromArgs(args);
      if (!spec.slides.length) throw new Error('Нужен хотя бы один слайд с заголовком или содержимым');
      const { buffer: buf, engine } = await makePresentation(spec);
      const full = assertInside(root, resolveSafe(root, rel));
      ensureDirFor(full);
      fs.writeFileSync(full, buf);
      const total = spec.slides.length + (spec.cover && spec.title ? 1 : 0);
      const check = await checkDocument(full);
      return {
        text: `Презентация создана: ${rel} (слайдов: ${total}, ${Math.max(1, Math.round(buf.length / 1024))} КБ)\n${formatCheckReport(check)}`,
        meta: { path: rel, created: true, engine, slides: total, check: { ok: check.ok, errors: check.errors, warnings: check.warnings } },
      };
    }
    case 'create_pdf': {
      const rel = String(args.path || 'document.pdf');
      if (!rel.toLowerCase().endsWith('.pdf')) throw new Error('Имя файла должно заканчиваться на .pdf');
      ensureFreeSpace(LIMITS.minFreeBytes);
      const spec = pdfSpecFromArgs(args);
      const { buffer: buf, engine, layout } = await makePdf(spec, { document: createDocumentPdf, slides: createPresentationPdf });
      if (!buf.length) throw new Error('Не удалось собрать PDF: нет содержимого');
      const full = assertInside(root, resolveSafe(root, rel));
      ensureDirFor(full);
      fs.writeFileSync(full, buf);
      const pages = (buf.toString('latin1').match(/\/Type \/Page(?!s)/g) || []).length;
      const kind = layout === 'slides' ? 'презентация' : 'документ A4';
      const check = await checkDocument(full);
      return {
        text: `PDF создан: ${rel} (${kind}, ${pages} стр., ${Math.max(1, Math.round(buf.length / 1024))} КБ)\n${formatCheckReport(check)}`,
        meta: { path: rel, created: true, pages, engine, layout, check: { ok: check.ok, errors: check.errors, warnings: check.warnings } },
      };
    }
    case 'remember': {
      const text = String(args.text || '');
      if (typeof ctx.remember !== 'function') {
        return { text: 'Память сейчас недоступна: запись не сохранится.', meta: { stored: false } };
      }
      const outcome = ctx.remember(text);
      return {
        text: memoryToolReply(outcome),
        meta: { stored: Boolean(outcome.added), total: outcome.total },
      };
    }
    case 'use_skill': {
      const id = String(args.id || '').trim();
      const body = skillBody(id);
      if (!body.ok) {
        return { text: `${body.text}\nДоступные навыки: ${skillIds().join(', ')}.`, meta: { skill: id, found: false } };
      }
      return { text: body.text, meta: { skill: body.id, found: true } };
    }
    case 'check_document': {
      const rel = String(args.path || '');
      if (!rel) throw new Error('Нужен путь к файлу');
      const full = assertInside(root, resolveSafe(root, rel));
      if (!fs.existsSync(full)) throw new Error(`Файла ${rel} нет в проекте`);
      const check = await checkDocument(full);
      return {
        text: `${rel}:\n${formatCheckReport(check)}`,
        meta: { path: rel, ok: check.ok, errors: check.errors, warnings: check.warnings },
      };
    }
    case 'extract_archive': {
      const rel = String(args.path || '');
      if (!rel) throw new Error('Нужен путь к архиву');
      const full = assertInside(root, resolveSafe(root, rel));
      if (!fs.existsSync(full)) throw new Error(`Архива ${rel} нет в проекте`);
      if (!fs.statSync(full).isFile()) throw new Error(`«${rel}» — это папка, а не архив`);
      const kind = archiveKind(rel);
      if (kind === 'unsupported') {
        throw new Error('Поддерживается только .zip (и одиночный .gz). Для .rar, .7z и .tar попроси пользователя пересобрать архив в zip.');
      }
      const size = fs.statSync(full).size;
      if (size > LIMITS.maxAttachmentBytes) {
        throw new Error(`Архив больше ${Math.round(LIMITS.maxAttachmentBytes / 1024 / 1024)} МБ — такой не разворачиваю. Попроси прислать частями.`);
      }
      const base = path.basename(rel);
      const requestedFolder = String(args.to || '').trim();
      const defaultFolder =
        (kind === 'gz' ? base.replace(/\.gz$/i, '').replace(/\.[^.]+$/, '') : base.replace(/\.zip$/i, '')) ||
        'архив';
      const folder = requestedFolder || `.dshow/work/unpacked/${defaultFolder}`;
      const target = assertInside(root, resolveSafe(root, folder));
      /* Запас на диске: распаковка может дать в разы больше, чем сам архив. */
      ensureFreeSpace(Math.min(size * 4, ARCHIVE_LIMITS.maxTotalBytes));
      if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
        throw new Error(`«${folder}» — это файл проекта, а не папка. Укажи другую папку в to.`);
      }
      const buf = fs.readFileSync(full);
      const result = kind === 'gz'
        ? gunzipTo(buf, target, path.basename(rel), { overwrite: Boolean(args.overwrite) })
        : await extractArchiveTo(buf, target, { overwrite: Boolean(args.overwrite) });
      const listed = result.files.slice(0, 10).map((file) => `${folder}/${file.path}`);
      return {
        text: `${formatExtraction(result, { folder })}${listed.length ? `\nДальше читай так: ${listed.map((p) => `read_document «${p}»`).join(', ')}` : ''}`,
        meta: { path: rel, folder, files: result.files.length, skipped: result.skipped.length, bytes: result.totalBytes },
      };
    }
    case 'check_links': {
      let urls = Array.isArray(args.urls) ? args.urls.map((item) => String(item || '')).filter(Boolean) : [];
      if (!urls.length && args.path) {
        const rel = String(args.path);
        const full = assertInside(root, resolveSafe(root, rel));
        if (!fs.existsSync(full)) throw new Error(`Файла ${rel} нет в проекте`);
        if (!fs.statSync(full).isFile()) throw new Error(`«${rel}» — это папка: укажи файл со ссылками`);
        if (fs.statSync(full).size > LIMITS.maxParseBytes) {
          throw new Error(`Файл больше ${Math.round(LIMITS.maxParseBytes / 1024 / 1024)} МБ — столько в память не беру. Дай ссылки списком в urls.`);
        }
        const ext = path.extname(full).toLowerCase();
        const text = ['.txt', '.md', '.html', '.htm', '.csv', '.json'].includes(ext)
          ? fs.readFileSync(full, 'utf8')
          : extractDocumentText(fs.readFileSync(full), rel, '', { maxChars: LIMITS.maxFileTextChars }).text || '';
        urls = linksFromText(text);
      }
      if (!urls.length) throw new Error('Не нашёл ссылок: передай urls или укажи файл со ссылками');
      const results = await checkLinks(urls);
      const alive = results.filter((item) => item.state === 'alive').length;
      const dead = results.filter((item) => item.state === 'dead').length;
      return {
        text: formatLinks(results),
        meta: { total: results.length, alive, dead, unknown: results.length - alive - dead },
      };
    }
    case 'compare_documents': {
      const leftRel = String(args.left || '');
      const rightRel = String(args.right || '');
      if (!leftRel || !rightRel) throw new Error('Нужны оба файла: left и right');
      const leftFull = assertInside(root, resolveSafe(root, leftRel));
      const rightFull = assertInside(root, resolveSafe(root, rightRel));
      if (!fs.existsSync(leftFull)) throw new Error(`Файла ${leftRel} нет в проекте`);
      if (!fs.existsSync(rightFull)) throw new Error(`Файла ${rightRel} нет в проекте`);
      for (const [label, file] of [['left', leftFull], ['right', rightFull]]) {
        if (!fs.statSync(file).isFile()) throw new Error(`«${label}» — это папка, а нужно имя файла`);
        if (fs.statSync(file).size > LIMITS.maxParseBytes) {
          throw new Error(
            `Файл ${label} больше ${Math.round(LIMITS.maxParseBytes / 1024 / 1024)} МБ — сравнивать такие целиком не буду. Разбей документ по разделам или выгрузи текст.`,
          );
        }
      }
      const result = compareDocuments(fs.readFileSync(leftFull), fs.readFileSync(rightFull), {
        nameLeft: leftRel,
        nameRight: rightRel,
      });
      return {
        text: formatCompare(result),
        meta: { left: leftRel, right: rightRel, changed: result.changed, added: result.added, removed: result.removed, exact: result.exact, truncated: result.truncated },
      };
    }
    default:
      throw new Error(`Инструмент ${name} недоступен`);
  }
}

export function workspaceFileInfo(root, rel) {
  const full = resolveSafe(root, rel);
  if (!fs.existsSync(full)) return null;
  const stat = fs.statSync(full);
  return { name: path.basename(full), path: rel, size: stat.size, modified: stat.mtime.toISOString(), dir: stat.isDirectory() };
}

export function sanitizeRelative(rel) {
  return safeName(String(rel || '').replace(/\\/g, '/')).replace(/^\/+/, '');
}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, LIMITS, MODEL } from './config.mjs';
import { detectKind, extractDocumentText } from './docparse.mjs';
import { describeImage } from './vision.mjs';
import { fetchUrl, webSearch } from './search.mjs';
import { escapeHtml, formatBytes, safeName, truncate } from './util.mjs';
import { writeZip } from './zip.mjs';

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

function runProcess(command, args, { cwd, timeoutMs, input }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
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
      description: 'Найти актуальную информацию в интернете. Возвращает заголовки, ссылки и сниппеты.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', description: 'Сколько результатов, 1–10. По умолчанию 6.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Загрузить веб-страницу, PDF или файл по ссылке и получить текст.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          max_chars: { type: 'integer', description: 'Максимум символов, по умолчанию 24000.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_python',
      description:
        'Выполнить Python-код в папке проекта (если Python установлен; в облаке его может не быть). Для простых расчётов используй calculate, для обработки данных — стандартные библиотеки.',
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
      name: 'create_excel',
      description: 'Создать файл Excel (.xlsx) в проекте из таблиц: список листов с строками.',
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
                name: { type: 'string' },
                rows: { type: 'array', items: { type: 'array', items: {} } },
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
      description: 'Создать документ Word (.docx) в проекте: заголовок, абзацы, списки, таблица.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Имя файла, например «Отчёт.docx».' },
          title: { type: 'string' },
          paragraphs: { type: 'array', items: { type: 'string' } },
          bullets: { type: 'array', items: { type: 'string' } },
          table: {
            type: 'object',
            properties: {
              headers: { type: 'array', items: { type: 'string' } },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
        required: ['path'],
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
  analyze_image: 'Распознавание изображения',
  web_search: 'Поиск в интернете',
  fetch_url: 'Загрузка страницы',
  run_python: 'Расчёты',
  create_excel: 'Создание Excel',
  create_word: 'Создание Word',
};

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
      return args.path || '';
    case 'move_path':
      return `${args.from || ''} → ${args.to || ''}`;
    case 'web_search':
      return args.query || '';
    case 'fetch_url':
      return args.url || '';
    case 'find_in_files':
      return args.query || '';
    case 'run_python':
      return `${String(args.code || '').split('\n').length} строк кода`;
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

/** Инструменты, доступные в текущем окружении: без run_python, если Python не установлен. */
export async function availableToolDefs() {
  const withPython = await pythonAvailable();
  return withPython ? TOOL_DEFS : TOOL_DEFS.filter((tool) => tool.function.name !== 'run_python');
}

export async function executeTool(name, args, ctx) {
  const root = ctx.workspace;
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
    case 'analyze_image': {
      const full = assertInside(root, resolveSafe(root, args.path));
      const ext = path.extname(args.path).toLowerCase().slice(1);
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/png';
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
      const results = await webSearch(args.query, Math.max(1, Math.min(10, Number(args.limit) || 6)));
      if (!results.length) return { text: 'Поиск не дал результатов.' };
      return {
        text: results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n'),
        meta: { count: results.length },
      };
    }
    case 'fetch_url': {
      const page = await fetchUrl(args.url, { maxChars: Math.min(60000, Number(args.max_chars) || 24000) });
      return { text: `Страница ${page.url}\n\n${page.text}`, meta: { url: page.url, bytes: page.bytes } };
    }
    case 'run_python': {
      const code = String(args.code || '');
      if (!code.trim()) throw new Error('Пустой код');
      let bin;
      try {
        bin = await findPython();
      } catch {
        throw new Error('Python в этом окружении недоступен. Для расчётов используй calculate, для таблиц — create_excel, для текста и кода — write_file.');
      }
      const tmpDir = path.join(root, '.dshow');
      fs.mkdirSync(tmpDir, { recursive: true });
      const scriptPath = path.join(tmpDir, `run_${Date.now()}.py`);
      fs.writeFileSync(scriptPath, code, 'utf8');
      const result = await runProcess(bin, [scriptPath], {
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
    case 'create_excel': {
      const rel = String(args.path || 'report.xlsx');
      if (!rel.toLowerCase().endsWith('.xlsx')) throw new Error('Имя файла должно заканчиваться на .xlsx');
      const sheets = Array.isArray(args.sheets) ? args.sheets : [];
      if (!sheets.length) throw new Error('Нужен хотя бы один лист');
      const buf = buildXlsx(sheets);
      ensureFreeSpace(buf.length);
      const full = assertInside(root, resolveSafe(root, rel));
      ensureDirFor(full);
      fs.writeFileSync(full, buf);
      const rows = sheets.reduce((sum, s) => sum + (s.rows?.length || 0), 0);
      return { text: `Excel создан: ${rel} (${sheets.length} лист(ов), ${rows} строк)`, meta: { path: rel, created: true } };
    }
    case 'create_word': {
      const rel = String(args.path || 'document.docx');
      if (!rel.toLowerCase().endsWith('.docx')) throw new Error('Имя файла должно заканчиваться на .docx');
      ensureFreeSpace(LIMITS.minFreeBytes);
      const buf = buildDocx({
        title: args.title,
        paragraphs: Array.isArray(args.paragraphs) ? args.paragraphs : [],
        bullets: Array.isArray(args.bullets) ? args.bullets : [],
        table: args.table,
      });
      const full = assertInside(root, resolveSafe(root, rel));
      ensureDirFor(full);
      fs.writeFileSync(full, buf);
      return { text: `Word создан: ${rel}`, meta: { path: rel, created: true } };
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

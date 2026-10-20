import path from 'node:path';
import zlib from 'node:zlib';
import { readZip } from './zip.mjs';

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm',
  'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h',
  'cpp', 'hpp', 'cs', 'php', 'sh', 'ps1', 'bat', 'cmd', 'sql', 'ini', 'cfg', 'conf', 'log',
  'srt', 'vtt', 'tex', 'r', 'lua', 'swift', 'dart', 'toml', 'env', 'gitignore', 'srt',
]);

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'avif']);

export function fileExt(name) {
  return String(name || '').toLowerCase().split('.').pop() || '';
}

export function detectKind(name, mime = '') {
  const ext = fileExt(name);
  if (String(mime).startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'docx' || ext === 'docm') return 'docx';
  if (ext === 'doc') return 'doc-legacy';
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (ext === 'xls') return 'xls-legacy';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'ppt') return 'ppt-legacy';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'rtf') return 'rtf';
  if (ext === 'zip' || ext === 'rar' || ext === '7z' || ext === 'gz' || ext === 'tar') return 'archive';
  if (String(mime).startsWith('text/') || TEXT_EXT.has(ext)) return 'text';
  if (ext === 'odt' || ext === 'ods' || ext === 'odp') return 'openoffice';
  return 'binary';
}

export function decodeText(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3);
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('windows-1251').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

export function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

function stripXml(xml) {
  return decodeEntities(
    String(xml)
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* Предупреждение о частях архива, которые не распакованы из-за размера. */
const TOO_BIG_NOTE = '\n\n[Часть файла слишком велика для чтения — скачайте файл, чтобы увидеть её.]';

function docxText(buf) {
  const zip = readZip(buf);
  const parts = [];
  const main = zip.get('word/document.xml');
  if (main) parts.push(stripXml(main.toString('utf8')));
  if (zip.skippedCount) parts.push(TOO_BIG_NOTE);
  for (const [name, data] of zip) {
    if (/^word\/(header|footer)\d*\.xml$/.test(name)) {
      const text = stripXml(data.toString('utf8'));
      if (text) parts.push(`[${name.includes('header') ? 'Колонтитул' : 'Нижний колонтитул'}] ${text}`);
    }
    if (name === 'docProps/core.xml') {
      const title = data.toString('utf8').match(/<dc:title>([\s\S]*?)<\/dc:title>/);
      if (title?.[1]?.trim()) parts.unshift(`Заголовок документа: ${decodeEntities(title[1].trim())}`);
    }
  }
  return parts.join('\n\n');
}

function sharedStrings(zip) {
  const file = zip.get('xl/sharedStrings.xml');
  if (!file) return [];
  const xml = file.toString('utf8');
  const items = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1]));
    items.push(texts.join(''));
  }
  return items;
}

function sheetPaths(zip) {
  const map = new Map();
  const workbook = zip.get('xl/workbook.xml');
  const rels = zip.get('xl/_rels/workbook.xml.rels');
  const relMap = new Map();
  if (rels) {
    for (const m of rels.toString('utf8').matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g)) {
      relMap.set(m[1], m[2].replace(/^\/?xl\//, '').replace(/^\//, ''));
    }
    for (const m of rels.toString('utf8').matchAll(/<Relationship[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g)) {
      relMap.set(m[2], m[1].replace(/^\/?xl\//, '').replace(/^\//, ''));
    }
  }
  if (workbook) {
    for (const m of workbook.toString('utf8').matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
      const target = relMap.get(m[2]) || `worksheets/sheet${map.size + 1}.xml`;
      map.set(m[1], `xl/${target}`);
    }
  }
  if (map.size === 0) {
    let i = 1;
    while (zip.has(`xl/worksheets/sheet${i}.xml`)) {
      map.set(`Лист ${i}`, `xl/worksheets/sheet${i}.xml`);
      i++;
    }
  }
  return map;
}

function xlsxText(buf, limits) {
  const zip = readZip(buf);
  const strings = sharedStrings(zip);
  const sheets = sheetPaths(zip);
  const out = [];
  for (const [sheetName, sheetPath] of sheets) {
    const file = zip.get(sheetPath);
    if (!file) continue;
    const xml = file.toString('utf8');
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellMatch[1];
        const body = cellMatch[2];
        const type = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';
        let value = '';
        if (type === 's') {
          const idx = Number((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1]);
          value = strings[idx] ?? '';
        } else if (type === 'inlineStr') {
          value = decodeEntities([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
        } else if (type === 'str') {
          value = decodeEntities((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
        } else {
          value = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
        }
        cells.push(String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim());
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join('\t'));
      if (rows.length >= limits.maxRows) break;
    }
    out.push(`## Лист «${sheetName}»\n${rows.join('\n') || '(пусто)'}`);
  }
  return out.join('\n\n');
}

function pptxText(buf) {
  const zip = readZip(buf);
  const slides = [...zip.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const out = [];
  for (const name of slides) {
    const num = name.match(/slide(\d+)\.xml/)[1];
    const text = stripXml(zip.get(name).toString('utf8'));
    if (text) out.push(`## Слайд ${num}\n${text}`);
  }
  return out.join('\n\n');
}

/* Текст из PDF: читаем потоки страниц и вытаскиваем строки из операторов Tj/TJ.
   Разбор намеренно посимвольный и линейный. Регулярное выражение с вложенными
   квантификаторами на большом потоке уходит в катастрофический перебор и
   замораживает весь сервер — так уже случалось на обычном PDF. */
const PDF_MAX_STREAMS = 400;
const PDF_MAX_CONTENT = 4 * 1024 * 1024;
const PDF_MAX_PIECES = 120000;

function pdfStreamTexts(buf) {
  const raw = buf.toString('latin1');
  const chunks = [];
  let total = 0;
  let from = 0;
  while (chunks.length < PDF_MAX_STREAMS && total < PDF_MAX_CONTENT) {
    const head = raw.indexOf('stream', from);
    if (head < 0) break;
    const tail = raw.indexOf('endstream', head + 6);
    if (tail < 0) break;
    let bodyStart = head + 6;
    if (raw[bodyStart] === '\r') bodyStart += 1;
    if (raw[bodyStart] === '\n') bodyStart += 1;
    const body = buf.subarray(bodyStart, tail);
    let text = '';
    try {
      text = zlib.inflateSync(body).toString('latin1');
    } catch {
      try {
        text = zlib.inflateRawSync(body).toString('latin1');
      } catch {
        text = body.toString('latin1');
      }
    }
    chunks.push(text);
    total += text.length;
    from = tail + 9;
  }
  return chunks.join('\n');
}

function pdfText(buf) {
  const content = pdfStreamTexts(buf);
  const pieces = [];
  const limit = Math.min(content.length, PDF_MAX_CONTENT);
  let i = 0;
  while (i < limit && pieces.length < PDF_MAX_PIECES) {
    const code = content.charCodeAt(i);
    if (code === 0x28 /* ( */) {
      /* Строковый литерал: учитываем вложенные скобки и экранирование. */
      let depth = 1;
      let value = '';
      i += 1;
      while (i < limit && depth > 0) {
        const char = content[i];
        if (char === '\\') {
          const next = content[i + 1];
          if (next >= '0' && next <= '7') {
            let oct = '';
            let k = i + 1;
            while (k < limit && oct.length < 3 && content[k] >= '0' && content[k] <= '7') {
              oct += content[k];
              k += 1;
            }
            value += String.fromCharCode(parseInt(oct, 8) & 0xff);
            i = k;
            continue;
          }
          if (next === 'n') value += '\n';
          else if (next === 'r') value += '\r';
          else if (next === 't') value += '\t';
          else if (next === '\n') {
            /* перенос строки внутри литерала — просто продолжение */
          } else if (next !== undefined) value += next;
          i += next === undefined ? 1 : 2;
          continue;
        }
        if (char === '(') depth += 1;
        if (char === ')') {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        value += char;
        i += 1;
      }
      pieces.push(value);
      continue;
    }
    if (code === 0x54 /* T */) {
      /* Операторы, которые переносят строку: T*, Td, TD. */
      if (content.startsWith('T*', i)) {
        pieces.push('\n');
        i += 2;
        continue;
      }
      if (content.startsWith('Td', i) || content.startsWith('TD', i)) {
        pieces.push('\n');
        i += 2;
        continue;
      }
    }
    i += 1;
  }
  let text = pieces.join('').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // Кириллица в PDF часто кодируется через CMap: если латиница бессмысленна — оставляем как есть.
  const printable = text.replace(/[^\p{L}\p{N}\s.,;:!?%()\-–—«»"']/gu, '');
  if (printable.length < text.length * 0.5) text = printable;
  return text;
}

/* Проверка «текст читается человеком». В PDF со встроенной таблицей символов
   (CMap) байты строк не совпадают с буквами: получается мусор из символов
   Latin-1 и управляющих кодов. Такой текст показывать нельзя — лучше честно
   сказать «откройте файл в программе просмотра». */
function pdfTextIsReadable(text) {
  const chars = [...text];
  if (!chars.length) return false;
  let readable = 0;
  for (const char of chars) {
    const code = char.charCodeAt(0);
    if ((code >= 32 && code < 127) || (code >= 0x400 && code <= 0x4ff)) readable += 1;
    else if (char === '\n' || char === '\t' || char === '«' || char === '»' || char === '–' || char === '—') readable += 1;
  }
  return readable / chars.length >= 0.9;
}

function rtfText(buf) {
  let text = decodeText(buf);
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  text = text.replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((Number(n) + 65536) % 65536));
  text = text.replace(/\\par[d]?/g, '\n').replace(/\\tab/g, '\t');
  text = text.replace(/\{\\\*[^{}]*\}/g, '');
  text = text.replace(/\\[a-zA-Z]+-?\d* ?/g, '');
  text = text.replace(/[{}]/g, '');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function htmlText(buf) {
  const html = decodeText(buf);
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Извлекает текст из документа. Возвращает { kind, text, warnings }.
 */
export function extractDocumentText(buf, name, mime = '', limits = {}) {
  const kind = detectKind(name, mime);
  const cfg = { maxRows: 400, maxChars: 48000, ...limits };
  const warnings = [];
  let text = '';
  try {
    switch (kind) {
      case 'docx':
        text = docxText(buf);
        break;
      case 'xlsx':
        text = xlsxText(buf, cfg);
        break;
      case 'pptx':
        text = pptxText(buf);
        break;
      case 'pdf': {
        text = pdfText(buf);
        if (!text || text.replace(/\s/g, '').length < 20) {
          text = '';
          warnings.push('В PDF не найден текстовый слой (возможно, это скан или фотографии страниц).');
        } else if (!pdfTextIsReadable(text)) {
          text = '';
          warnings.push('Текст в PDF закодирован встроенным шрифтом — прочитать его внутри сервиса нельзя. Откройте файл в программе просмотра или скачайте.');
        }
        break;
      }
      case 'rtf':
        text = rtfText(buf);
        break;
      case 'html':
        text = htmlText(buf);
        break;
      case 'text':
        text = decodeText(buf);
        break;
      case 'openoffice':
        warnings.push('Формат OpenDocument не поддерживается напрямую — сохраните файл как PDF/DOCX.');
        break;
      case 'doc-legacy':
      case 'xls-legacy':
      case 'ppt-legacy':
        warnings.push('Устаревший бинарный формат Office: текст не извлекается. Сохраните файл в формате DOCX/XLSX/PDF.');
        break;
      case 'image':
        warnings.push('Это изображение — используйте распознавание изображения.');
        break;
      default:
        warnings.push('Двоичный формат: текст не извлекается.');
    }
  } catch (error) {
    warnings.push(`Не удалось разобрать файл: ${error.message}`);
  }
  if (text.length > cfg.maxChars) {
    text = `${text.slice(0, cfg.maxChars)}\n…[документ сокращён до ${cfg.maxChars} символов]`;
    warnings.push('Документ очень большой — показана только часть.');
  }
  return { kind, text: text.trim(), warnings };
}

export function kindLabel(kind) {
  return (
    {
      image: 'изображение',
      docx: 'документ Word',
      xlsx: 'таблица Excel',
      pptx: 'презентация',
      pdf: 'PDF',
      text: 'текст',
      html: 'HTML',
      rtf: 'RTF',
      archive: 'архив',
      openoffice: 'OpenDocument',
      binary: 'файл',
    }[kind] || 'файл'
  );
}

export function isImage(name, mime) {
  return detectKind(name, mime) === 'image';
}

export function baseName(filePath) {
  return path.basename(filePath);
}

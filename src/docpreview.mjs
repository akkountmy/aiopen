/* Разбор файлов для окна просмотра: не «плоский текст в <pre>», а структура,
   которую интерфейс рисует как настоящий документ — заголовки, абзацы с
   выделением, списки, таблицы, листы книги, слайды.

   Модуль только читает файл и возвращает простые данные без HTML: разметку
   собирает браузер, поэтому текст из файла никогда не попадает в страницу как
   разметка. */
import { readZip } from './zip.mjs';
import { decodeEntities } from './docparse.mjs';

export { decodeEntities };

const DEFAULTS = {
  maxBlocks: 1200,
  maxChars: 200000,
  maxRows: 300,
  maxColumns: 40,
  maxSheets: 8,
  maxSlides: 60,
  maxCells: 8000,
};

function limitOf(options, key) {
  const value = Number(options?.[key]);
  return Number.isFinite(value) && value > 0 ? value : DEFAULTS[key];
}

function clip(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

/* -------------------------------- docx -------------------------------- */

/* Пройти по телу документа: абзацы и таблицы идут вперемешку, таблица может
   содержать абзацы, поэтому ищем закрывающий тег с учётом вложенности. */
function bodyBlocks(xml) {
  const body = (xml.match(/<w:body>([\s\S]*)<\/w:body>/) || [])[1] || xml;
  const out = [];
  let i = 0;
  while (i < body.length) {
    const p = body.indexOf('<w:p', i);
    const t = body.indexOf('<w:tbl', i);
    if (p < 0 && t < 0) break;
    const isTable = t >= 0 && (p < 0 || t < p);
    if (isTable) {
      let depth = 0;
      let from = t;
      let at = t;
      while (at < body.length) {
        const open = body.indexOf('<w:tbl', at);
        const close = body.indexOf('</w:tbl>', at);
        if (close < 0) break;
        if (open >= 0 && open < close) {
          depth += 1;
          at = open + 6;
          continue;
        }
        depth -= 1;
        at = close + 8;
        if (depth === 0) break;
      }
      out.push({ kind: 'table', xml: body.slice(from, at) });
      i = at;
      continue;
    }
    const close = body.indexOf('</w:p>', p);
    const selfClosing = /^<w:p\b[^>]*\/>/.test(body.slice(p, p + 200));
    if (selfClosing) {
      out.push({ kind: 'para', xml: body.slice(p, p + body.slice(p).indexOf('>') + 1) });
      i = p + body.slice(p).indexOf('>') + 1;
      continue;
    }
    if (close < 0) break;
    out.push({ kind: 'para', xml: body.slice(p, close + 6) });
    i = close + 6;
  }
  return out;
}

function numberingFormats(zip) {
  /* Нумерация нужна, чтобы список 1) 2) 3) не превратился в точки. */
  const file = zip.get('word/numbering.xml');
  const formats = new Map();
  if (!file) return formats;
  const xml = file.toString('utf8');
  const abstracts = new Map();
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const lvl = m[2].match(/<w:lvl\b[^>]*w:ilvl="0"[^>]*>([\s\S]*?)<\/w:lvl>/);
    const fmt = lvl ? (lvl[1].match(/<w:numFmt w:val="([^"]+)"/) || [])[1] : '';
    abstracts.set(m[1], fmt || 'bullet');
  }
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const abs = (m[2].match(/<w:abstractNumId w:val="(\d+)"/) || [])[1];
    formats.set(m[1], abstracts.get(abs) || 'bullet');
  }
  return formats;
}

const RUN_TOKEN = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/>|<w:tab\b[^>]*\/>/g;

function runText(xml) {
  let text = '';
  let m;
  RUN_TOKEN.lastIndex = 0;
  while ((m = RUN_TOKEN.exec(xml))) {
    if (m[1] !== undefined) text += decodeEntities(m[1]);
    else if (m[0].startsWith('<w:br')) text += '\n';
    else text += '\t';
  }
  return text;
}

function runProps(runXml) {
  const rPr = (runXml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || '';
  const bold = /<w:b(?![^>]*w:val="(?:0|false|off)")[^>]*\/>/.test(rPr);
  const italic = /<w:i(?![^>]*w:val="(?:0|false|off)")[^>]*\/>/.test(rPr);
  const underline = /<w:u\b[^>]*w:val="(?!none)/.test(rPr);
  const strike = /<w:strike\b[^>]*\/>/.test(rPr);
  return { bold, italic, underline, strike };
}

function paragraphRuns(pXml) {
  const runs = [];
  for (const m of pXml.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)) {
    const text = runText(m[1]);
    if (!text) continue;
    const props = runProps(m[1]);
    const last = runs[runs.length - 1];
    if (last && last.bold === props.bold && last.italic === props.italic && last.underline === props.underline && last.strike === props.strike) {
      last.text += text;
    } else {
      runs.push({ text, ...props });
    }
  }
  /* Пометки вроде bold: false в каждом куске только раздувают ответ. */
  return runs.map((run) => {
    const out = { text: run.text };
    if (run.bold) out.bold = true;
    if (run.italic) out.italic = true;
    if (run.underline) out.underline = true;
    if (run.strike) out.strike = true;
    return out;
  });
}

/* Word пишет выравнивание по-разному: «both» в настоящих документах и
   «justify» в сгенерированных. Приводим к трём классам окна просмотра. */
function alignClass(jc) {
  if (jc === 'center') return 'center';
  if (jc === 'right' || jc === 'end') return 'right';
  if (jc === 'both' || jc === 'justify' || jc === 'distribute') return 'justify';
  return '';
}

function paragraphMeta(pXml) {
  const pPr = (pXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || '';
  const style = (pPr.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '';
  const outline = (pPr.match(/<w:outlineLvl w:val="(\d+)"/) || [])[1];
  const jc = (pPr.match(/<w:jc w:val="([^"]+)"/) || [])[1] || '';
  const numId = (pPr.match(/<w:numId w:val="(\d+)"/) || [])[1] || '';
  const ilvl = Number((pPr.match(/<w:ilvl w:val="(\d+)"/) || [])[1] || 0);
  let level = 0;
  const heading = style.match(/^(?:Heading|Заголовок)\s*(\d)/i) || style.match(/^heading(\d)$/i);
  if (heading) level = Number(heading[1]);
  else if (style === 'Title') level = 1;
  else if (style === 'Subtitle') level = 2;
  else if (outline !== undefined && /^\d+$/.test(outline)) level = Number(outline) + 1;
  return { level, align: alignClass(jc), numId, ilvl, style };
}

function docxModel(zip, options) {
  const main = zip.get('word/document.xml');
  if (!main) return null;
  const xml = main.toString('utf8');
  const formats = numberingFormats(zip);
  const maxBlocks = limitOf(options, 'maxBlocks');
  const maxChars = limitOf(options, 'maxChars');
  const blocks = [];
  let chars = 0;
  let truncated = false;

  const push = (block, size) => {
    if (blocks.length >= maxBlocks || chars >= maxChars) {
      truncated = true;
      return false;
    }
    chars += size;
    blocks.push(block);
    return true;
  };

  let list = null;
  const flushList = () => {
    if (list && list.items.length) blocks.push(list);
    list = null;
  };

  for (const block of bodyBlocks(xml)) {
    if (block.kind === 'table') {
      flushList();
      const rows = [];
      for (const tr of block.xml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
        if (rows.length >= 200) {
          truncated = true;
          break;
        }
        const cells = [];
        for (const tc of tr[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
          if (cells.length >= 20) {
            truncated = true;
            break;
          }
          const lines = [];
          for (const p of tc[1].matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
            const runs = paragraphRuns(p[0]);
            if (runs.length) lines.push(runs);
          }
          cells.push(lines.length ? lines : [[{ text: '' }]]);
        }
        if (cells.length) rows.push(cells);
      }
      if (rows.length) {
        push({ type: 'table', header: true, rows }, 200);
      }
      continue;
    }
    const runs = paragraphRuns(block.xml);
    const text = runs.map((run) => run.text).join('');
    if (!text.trim()) {
      flushList();
      continue;
    }
    const meta = paragraphMeta(block.xml);
    if (meta.level) {
      flushList();
      push({ type: 'heading', level: Math.min(meta.level, 6), runs }, text.length);
      continue;
    }
    if (meta.numId && meta.numId !== '0') {
      const ordered = formats.get(meta.numId) !== 'bullet';
      if (!list || list.ordered !== ordered || list.level !== meta.ilvl) {
        flushList();
        list = { type: 'list', ordered, level: meta.ilvl, items: [] };
      }
      list.items.push({ runs });
      chars += text.length;
      if (list.items.length >= 200) {
        truncated = true;
        flushList();
      }
      continue;
    }
    flushList();
    const out = { type: 'para', runs };
    if (meta.align) out.align = meta.align;
    push(out, text.length);
  }
  flushList();

  /* Колонтитулы и свойства документа — отдельной строкой под содержимым. */
  const extras = [];
  for (const [name, data] of zip) {
    if (/^word\/footer\d*\.xml$/.test(name)) {
      const text = decodeEntities(String(data.toString('utf8')).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (text) extras.push({ title: 'Нижний колонтитул', text: clip(text, 200).text });
    }
  }
  if (zip.skippedCount) extras.push({ title: 'Часть файла', text: 'Слишком велика для чтения — скачайте файл целиком.' });
  return { blocks, extras, truncated };
}

/* -------------------------------- xlsx -------------------------------- */

function sharedStringsOf(zip) {
  const file = zip.get('xl/sharedStrings.xml');
  if (!file) return [];
  const items = [];
  for (const m of file.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1])).join('');
    items.push(text);
  }
  return items;
}

function sheetTargets(zip) {
  const map = new Map();
  const workbook = zip.get('xl/workbook.xml');
  const rels = zip.get('xl/_rels/workbook.xml.rels');
  const relMap = new Map();
  if (rels) {
    for (const m of rels.toString('utf8').matchAll(/<Relationship[^>]*\/>/g)) {
      const id = (m[0].match(/Id="([^"]+)"/) || [])[1];
      const target = (m[0].match(/Target="([^"]+)"/) || [])[1];
      if (id && target) relMap.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
    }
  }
  if (workbook) {
    for (const m of workbook.toString('utf8').matchAll(/<sheet\b[^>]*\/>/g)) {
      const name = decodeEntities((m[0].match(/name="([^"]*)"/) || [])[1] || '');
      const id = (m[0].match(/r:id="([^"]+)"/) || [])[1];
      if (!name) continue;
      map.set(name, `xl/${relMap.get(id) || `worksheets/sheet${map.size + 1}.xml`}`);
    }
  }
  if (map.size === 0) {
    let i = 1;
    while (zip.has(`xl/worksheets/sheet${i}.xml`)) {
      map.set(`Лист ${i}`, `xl/worksheets/sheet${i}.xml`);
      i += 1;
    }
  }
  return map;
}

function columnIndex(ref) {
  const letters = String(ref).replace(/[^A-Z]/gi, '').toUpperCase();
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return Math.max(0, index - 1);
}

function xlsxModel(zip, options) {
  const strings = sharedStringsOf(zip);
  const sheets = [];
  const maxRows = limitOf(options, 'maxRows');
  const maxSheets = limitOf(options, 'maxSheets');
  const maxColumns = limitOf(options, 'maxColumns');
  let cells = 0;
  for (const [name, target] of sheetTargets(zip)) {
    if (sheets.length >= maxSheets) break;
    const file = zip.get(target);
    if (!file) continue;
    const xml = file.toString('utf8');
    const rows = [];
    let truncated = false;
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      const row = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellMatch[1];
        const body = cellMatch[2];
        const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
        const index = ref ? columnIndex(ref) : row.length;
        if (index >= maxColumns) continue;
        const type = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';
        let value = '';
        if (type === 's') {
          value = strings[Number((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1])] ?? '';
        } else if (type === 'inlineStr') {
          value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1])).join('');
        } else if (type === 'str') {
          value = decodeEntities((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
        } else if (type === 'b') {
          value = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] === '1' ? 'да' : 'нет';
        } else if (type === 'e') {
          value = decodeEntities((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
        } else {
          value = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
        }
        value = String(value).replace(/\r?\n/g, ' ').trim();
        if (!value) continue;
        while (row.length < index) row.push('');
        row[index] = value;
        cells += 1;
        if (cells >= limitOf(options, 'maxCells')) {
          truncated = true;
          break;
        }
      }
      if (row.some((value) => value !== '')) rows.push(row);
      if (truncated) break;
    }
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    sheets.push({ name, rows, width, truncated });
  }
  /* Строки одинаковой длины: пустые ячейки не должны «съезжать» в вёрстке. */
  for (const sheet of sheets) {
    for (const row of sheet.rows) while (row.length < sheet.width) row.push('');
  }
  return { sheets };
}

/* -------------------------------- pptx -------------------------------- */

function pptxModel(zip, options) {
  const maxSlides = limitOf(options, 'maxSlides');
  const names = [...zip.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)\.xml/)[1]) - Number(b.match(/(\d+)\.xml/)[1]));
  const slides = [];
  for (const name of names) {
    if (slides.length >= maxSlides) break;
    const xml = zip.get(name).toString('utf8');
    const lines = [];
    for (const p of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
      const text = [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((x) => decodeEntities(x[1])).join('').trim();
      if (text) lines.push(text);
    }
    if (!lines.length) continue;
    slides.push({ number: Number(name.match(/(\d+)\.xml/)[1]), title: lines[0], lines: lines.slice(1) });
  }
  return { slides, total: names.length };
}

/* -------------------------------- csv --------------------------------- */

function splitCsvLine(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',' || char === ';') {
      cells.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  cells.push(value);
  return cells.map((cell) => cell.trim());
}

function csvModel(text, options) {
  const maxRows = limitOf(options, 'maxRows');
  const maxColumns = limitOf(options, 'maxColumns');
  const rows = [];
  let truncated = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const cells = splitCsvLine(line);
    rows.push(cells.slice(0, maxColumns));
    if (cells.length > maxColumns) truncated = true;
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  for (const row of rows) while (row.length < width) row.push('');
  return { rows, width, truncated };
}

/* ------------------------------ точка входа ---------------------------- */

export function previewDocument(buf, name, options = {}) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const maxChars = limitOf(options, 'maxChars');
  const base = { name, format: 'text', warnings: [] };

  const textual = (format) => {
    const { text, truncated } = clip(decodeEntities(String(buf.toString('utf8')).replace(/^\uFEFF/, '')), maxChars);
    if (truncated) base.warnings.push('Показано начало файла — он длиннее окна просмотра.');
    return { ...base, format, text };
  };

  try {
    if (ext === 'docx' || ext === 'docm') {
      const zip = readZip(buf);
      const model = docxModel(zip, options);
      if (model) {
        if (model.truncated) base.warnings.push('Документ длиннее окна просмотра — показано начало.');
        return { ...base, format: 'docx', blocks: model.blocks, extras: model.extras };
      }
    }
    if (ext === 'xlsx' || ext === 'xlsm') {
      const model = xlsxModel(readZip(buf), options);
      if (model.sheets.length) {
        if (model.sheets.some((sheet) => sheet.truncated)) base.warnings.push('Лист длиннее окна просмотра — показаны первые строки.');
        return { ...base, format: 'xlsx', sheets: model.sheets };
      }
    }
    if (ext === 'pptx' || ext === 'pptm') {
      const model = pptxModel(readZip(buf), options);
      if (model.slides.length) {
        if (model.total > model.slides.length) base.warnings.push(`Показаны первые ${model.slides.length} слайдов из ${model.total}.`);
        return { ...base, format: 'pptx', slides: model.slides };
      }
    }
  } catch (error) {
    base.warnings.push(`Не удалось разобрать файл: ${error.message}`);
  }

  if (ext === 'csv' || ext === 'tsv') {
    const { text } = clip(buf.toString('utf8').replace(/^\uFEFF/, ''), maxChars);
    const model = ext === 'tsv'
      ? { rows: text.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split('\t')), width: 0, truncated: false }
      : csvModel(text, options);
    if (model.rows.length) return { ...base, format: 'table', rows: model.rows, width: model.width, truncated: model.truncated };
  }
  if (ext === 'html' || ext === 'htm') return { ...base, format: 'html' };
  if (ext === 'md' || ext === 'markdown') return textual('markdown');
  if (ext === 'json') return textual('json');
  if (/^(txt|log|ini|yml|yaml|xml|conf|env|js|mjs|ts|css|py|ps1|sh|sql|bat)$/.test(ext)) {
    return textual(ext === 'js' || ext === 'mjs' || ext === 'ts' || ext === 'css' || ext === 'py' || ext === 'ps1' || ext === 'sh' || ext === 'sql' || ext === 'bat' ? 'code' : 'text');
  }
  return null;
}

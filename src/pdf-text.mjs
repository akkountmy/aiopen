/**
 * Текст из PDF для просмотра, разбора и озвучки.
 *
 * Простой разбор «достать строки из Tj» работает только там, где шрифты
 * однобайтовые и совпадают с ASCII. У книг и отчётов из Word/InDesign текст
 * лежит кодами шрифта, а настоящие буквы — в таблице ToUnicode внутри файла.
 * Раньше такой PDF честно отказывался разбираться («шрифт закодирован
 * встроенной таблицей»). Здесь читаем ToUnicode, а кодировку выбираем для
 * каждого шрифта по частотному профилю русского текста: у книги несколько
 * шрифтов, и одна таблица на всех даёт «доПемжцюаеййъхъ» вместо слов.
 *
 * Разбор намеренно линейный: никаких регулярных выражений с вложенными
 * квантификаторами на больших потоках — однажды такое выражение заморозило
 * весь сервер на обычном PDF.
 */
import zlib from 'node:zlib';

const MAX_STREAMS = 1200;
/* Потолок на всё распакованное: книга со страницами и таблицами шрифтов
   укладывается в десятки мегабайт, а картинки пропускаем по словарю. */
const MAX_CONTENT = 48 * 1024 * 1024;
const MAX_STRINGS = 200_000;
/* Распакованный поток ограничиваем отдельно: маленький PDF может развернуться
   в гигабайты, а распаковка синхронная и держит весь сервис. */
const MAX_STREAM = 8 * 1024 * 1024;
/* Сколько байт шрифта набираем для выбора кодировки. */
const SAMPLE_BYTES = 40_000;

/* Кириллица в PDF без таблицы ToUnicode почти всегда лежит в cp1251:
   латинская раскладка на таких строках даёт мусор. */
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';

/* Частоты букв русского текста — по ним отличаем слова от случайных букв. */
const RU_FREQ = {
  о: 0.1097, е: 0.0845, а: 0.0801, и: 0.0735, н: 0.067, т: 0.0626, с: 0.0547,
  р: 0.0473, в: 0.0454, л: 0.044, к: 0.0349, м: 0.0321, д: 0.0298, п: 0.0281,
  у: 0.0262, я: 0.0201, ы: 0.019, ь: 0.0174, г: 0.017, з: 0.0165, б: 0.0159,
  ч: 0.0144, й: 0.0121, х: 0.0097, ж: 0.0094, ш: 0.0073, ю: 0.0064, ц: 0.0048,
  щ: 0.0036, э: 0.0032, ф: 0.0026, ъ: 0.0004, ё: 0.0004,
};

const PUNCTUATION = '.,;:!?%()«»—–"\'/-+№[]';

function cp1251Byte(byte) {
  if (byte < 0x80) return String.fromCharCode(byte);
  if (byte === 0x98) return ' ';
  const char = CP1251_HIGH[byte - 0x80];
  return char === undefined ? '' : char;
}

function cp1252Byte(byte) {
  if (byte < 0x80) return String.fromCharCode(byte);
  if (byte < 0xa0) return '';
  return String.fromCharCode(byte);
}

/**
 * Все потоки файла: распакованные zlib — текстом, остальные — как есть.
 *
 * Идём по объектам «N 0 obj … endobj», а не по первому попавшемуся слову
 * stream: в сжатом PDF двоичные данные картинок содержат это слово, и поиск
 * «stream … endstream» терял почти все страницы книги (нашлись две из ста
 * восьмидесяти). Картинки пропускаем по словарю — они для текста не нужны.
 */
export function pdfStreams(buf) {
  const raw = buf.toString('latin1');
  const chunks = [];
  let total = 0;
  const objectRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while (chunks.length < MAX_STREAMS && total < MAX_CONTENT && (match = objectRe.exec(raw))) {
    const start = match.index + match[0].length;
    const objectEnd = raw.indexOf('endobj', start);
    const stop = objectEnd < 0 ? raw.length : objectEnd;
    const streamAt = raw.indexOf('stream', start);
    if (streamAt < 0 || streamAt > stop) {
      objectRe.lastIndex = Math.max(stop, objectRe.lastIndex);
      continue;
    }
    const dict = raw.slice(start, streamAt);
    if (/\/Subtype\s*\/Image/.test(dict)) {
      objectRe.lastIndex = Math.max(stop, objectRe.lastIndex);
      continue;
    }
    let bodyStart = streamAt + 6;
    if (raw[bodyStart] === '\r') bodyStart += 1;
    if (raw[bodyStart] === '\n') bodyStart += 1;
    const bodyStop = raw.lastIndexOf('endstream', stop);
    const bodyEnd = bodyStop > bodyStart ? bodyStop : stop;
    const body = buf.subarray(bodyStart, bodyEnd);
    let text;
    try {
      text = zlib.inflateSync(body, { maxOutputLength: MAX_STREAM }).toString('latin1');
    } catch {
      try {
        text = zlib.inflateRawSync(body, { maxOutputLength: MAX_STREAM }).toString('latin1');
      } catch {
        text = body.toString('latin1');
      }
    }
    chunks.push(text);
    total += text.length;
    objectRe.lastIndex = Math.max(stop, objectRe.lastIndex);
  }
  return chunks;
}

/* ------------------------------ таблицы ToUnicode ----------------------------- */

function hexBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

/** Цель в CMap — строка UTF-16BE: два байта на символ. */
function utf16Text(bytes) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  if (bytes.length % 2 === 1) out += String.fromCharCode(bytes[bytes.length - 1]);
  return out;
}

function codeNumber(bytes) {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

function blockRanges(text, begin, end) {
  const out = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(begin, from);
    if (start < 0) break;
    const stop = text.indexOf(end, start + begin.length);
    if (stop < 0) break;
    out.push(text.slice(start + begin.length, stop));
    from = stop + end.length;
  }
  return out;
}

/** Таблицы «код шрифта → символ» из всех потоков файла. */
export function parseCMaps(streams) {
  const maps = [];
  for (const text of streams) {
    if (text.indexOf('begincmap') < 0) continue;
    const map = new Map();
    let width = 0;

    for (const block of blockRanges(text, 'beginbfchar', 'endbfchar')) {
      let i = 0;
      while (i < block.length) {
        const open = block.indexOf('<', i);
        if (open < 0) break;
        const close = block.indexOf('>', open);
        if (close < 0) break;
        const source = hexBytes(block.slice(open + 1, close));
        const targetOpen = block.indexOf('<', close);
        const targetClose = targetOpen < 0 ? -1 : block.indexOf('>', targetOpen);
        if (targetOpen < 0 || targetClose < 0) break;
        const target = utf16Text(hexBytes(block.slice(targetOpen + 1, targetClose)));
        if (source.length && target) {
          width = Math.max(width, source.length);
          map.set(`${source.length}:${codeNumber(source)}`, target);
        }
        i = targetClose + 1;
      }
    }

    for (const block of blockRanges(text, 'beginbfrange', 'endbfrange')) {
      let i = 0;
      while (i < block.length) {
        const open = block.indexOf('<', i);
        if (open < 0) break;
        const close = block.indexOf('>', open);
        if (close < 0) break;
        const low = hexBytes(block.slice(open + 1, close));
        const highOpen = block.indexOf('<', close);
        const highClose = highOpen < 0 ? -1 : block.indexOf('>', highOpen);
        if (highOpen < 0 || highClose < 0) break;
        const high = hexBytes(block.slice(highOpen + 1, highClose));
        if (low.length !== high.length) {
          i = highClose + 1;
          continue;
        }
        const first = codeNumber(low);
        const last = codeNumber(high);
        const span = last - first;
        if (span < 0 || span > 65_535) {
          i = highClose + 1;
          continue;
        }
        width = Math.max(width, low.length);
        const afterHigh = block.slice(highClose + 1);
        const targetOpen = afterHigh.indexOf('<');
        const listOpen = afterHigh.indexOf('[');
        if (listOpen >= 0 && (targetOpen < 0 || listOpen < targetOpen)) {
          /* Перечисление целей: <lo> <hi> [<a> <b> …] — по одной на код. */
          const listClose = afterHigh.indexOf(']', listOpen);
          if (listClose < 0) break;
          const list = blockRanges(afterHigh.slice(listOpen + 1, listClose), '<', '>');
          list.forEach((item, index) => {
            if (index > span) return;
            const target = utf16Text(hexBytes(item));
            if (target) map.set(`${low.length}:${first + index}`, target);
          });
          i = highClose + 1 + listClose + 1;
          continue;
        }
        if (targetOpen >= 0) {
          const targetClose = afterHigh.indexOf('>', targetOpen);
          if (targetClose < 0) break;
          const base = hexBytes(afterHigh.slice(targetOpen + 1, targetClose));
          for (let step = 0; step <= span; step += 1) {
            /* Приращение идёт по последнему байту цели — так записано в PDF. */
            const target = base.slice();
            let carry = step;
            let k = target.length - 1;
            while (k >= 0 && carry > 0) {
              const sum = target[k] + carry;
              target[k] = sum & 0xff;
              carry = sum >> 8;
              k -= 1;
            }
            const decoded = utf16Text(target);
            if (decoded) map.set(`${low.length}:${first + step}`, decoded);
          }
          i = targetClose + 1;
          continue;
        }
        i = highClose + 1;
      }
    }

    if (map.size) maps.push({ width: width || 2, map });
  }
  return maps;
}

/* ------------------------------- кодировки ------------------------------- */

function decodeWithCMap(bytes, entry) {
  const { width, map } = entry;
  let out = '';
  for (let i = 0; i + width <= bytes.length; i += width) {
    const piece = bytes.slice(i, i + width);
    out += map.get(`${width}:${codeNumber(piece)}`) ?? '';
  }
  return out;
}

function decodeWithCP1251(bytes) {
  let out = '';
  for (const byte of bytes) out += cp1251Byte(byte);
  return out;
}

function decodeWithCP1252(bytes) {
  let out = '';
  for (const byte of bytes) out += cp1252Byte(byte);
  return out;
}

/**
 * Насколько текст похож на русскую прозу: пересечение частотного профиля с
 * таблицей частот букв. Случайные кириллические буквы дают около 0,1, живой
 * текст — 0,6–0,9. Этого хватает, чтобы отличить верную таблицу шрифта от
 * соседней, которая тоже состоит из кириллицы.
 */
export function russianScore(text) {
  if (!text) return -1;
  let total = 0;
  let junk = 0;
  const counts = new Map();
  for (const char of text.toLowerCase()) {
    total += 1;
    counts.set(char, (counts.get(char) ?? 0) + 1);
    if (!/[\p{L}\p{N}\s]/u.test(char) && PUNCTUATION.indexOf(char) < 0) junk += 1;
  }
  if (!total) return -1;
  let overlap = 0;
  for (const [letter, share] of Object.entries(RU_FREQ)) {
    overlap += Math.min((counts.get(letter) ?? 0) / total, share);
  }
  overlap += Math.min((counts.get(' ') ?? 0) / total, 0.16) * 0.6;
  return overlap - junk / total;
}

/** Кандидаты на раскодирование одного шрифта: его таблица, cp1251, cp1252. */
function decoderCandidates(maps) {
  const candidates = maps.map((entry) => ({
    name: `cmap${entry.width}`,
    decode: (bytes) => decodeWithCMap(bytes, entry),
  }));
  candidates.push({ name: 'cp1251', decode: decodeWithCP1251 });
  candidates.push({ name: 'cp1252', decode: decodeWithCP1252 });
  return candidates;
}

/** Выбирает кодировку по образцу текста этого шрифта. */
function bestDecoder(sample, maps) {
  let best = decoderCandidates(maps)[0];
  let bestScore = -2;
  for (const candidate of decoderCandidates(maps)) {
    const score = russianScore(candidate.decode(sample));
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return { decode: best.decode, name: best.name, score: bestScore };
}

/* ------------------------------ разбор команд ------------------------------ */

/** Строка из литерала в скобках: понимает экранирование и вложенные скобки. */
function readLiteral(text, start) {
  let i = start + 1;
  let depth = 1;
  const bytes = [];
  while (i < text.length && depth > 0) {
    const char = text[i];
    if (char === '\\') {
      const next = text[i + 1];
      if (next >= '0' && next <= '7') {
        let oct = '';
        let k = i + 1;
        while (k < text.length && oct.length < 3 && text[k] >= '0' && text[k] <= '7') {
          oct += text[k];
          k += 1;
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        i = k;
        continue;
      }
      if (next === '\r' || next === '\n') {
        /* Обратная косая в конце строки — продолжение литерала: символа нет.
           Именно этим портились слова: «орг\⏎анизаций» читалось как лишняя
           буква, потому что код 0x0d в шрифте — это «т». */
        i += next === '\r' && text[i + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (next === 'n') bytes.push(0x0a);
      else if (next === 'r') bytes.push(0x0d);
      else if (next === 't') bytes.push(0x09);
      else if (next === 'b') bytes.push(0x08);
      else if (next === 'f') bytes.push(0x0c);
      else if (next === '\n') {
        /* перенос строки внутри литерала — продолжение строки */
      } else if (next !== undefined) bytes.push(next.charCodeAt(0) & 0xff);
      i += next === undefined ? 1 : 2;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
    bytes.push(char.charCodeAt(0) & 0xff);
    i += 1;
  }
  return { bytes, end: i };
}

/**
 * Достаёт строки из одного потока контента: Tj и TJ (строка в массиве с
 * кернингом), шестнадцатеричные строки <…>, переносы строк по Td/TD/T* и Tm,
 * одинарные кавычки.
 *
 * Помнит текущий шрифт (/F1 12 Tf) вместе с номером страницы: имена ресурсов
 * вроде /T1_1 в PDF свои на каждой странице, и «один шрифт на весь документ»
 * подставлял таблицу соседней страницы — отсюда лишние буквы посреди слова
 * («оргтанизаций», «инвестиционнтого»).
 */
function collectContent(text, records, page, pageDecoders) {
  const size = text.length;
  let i = 0;
  let last = null;
  let lastName = '';
  let font = '';
  let inArray = false;
  let array = [];
  const separate = (value) => {
    const lastRecord = records[records.length - 1];
    if (lastRecord && lastRecord.kind === 'sep' && lastRecord.value === value) return;
    records.push({ kind: 'sep', value });
  };
  const emit = (bytes) => {
    if (!bytes.length) return;
    const decoder = pageDecoders ? pageDecoders.get(font) ?? null : null;
    records.push({ kind: 'text', font: `${page}:${font}`, bytes, decoder });
  };
  while (i < size) {
    const code = text.charCodeAt(i);
    if (code <= 0x20) {
      i += 1;
      continue;
    }
    if (code === 0x25) {
      const stop = text.indexOf('\n', i);
      i = stop < 0 ? size : stop + 1;
      continue;
    }
    if (code === 0x28) {
      const { bytes, end } = readLiteral(text, i);
      i = end;
      if (inArray) array.push({ type: 'string', bytes });
      else last = bytes;
      continue;
    }
    if (code === 0x3c) {
      if (text[i + 1] === '<') {
        i += 2;
        continue;
      }
      const stop = text.indexOf('>', i);
      if (stop < 0) break;
      const bytes = hexBytes(text.slice(i + 1, stop));
      i = stop + 1;
      if (inArray) array.push({ type: 'string', bytes });
      else last = bytes;
      continue;
    }
    if (code === 0x3e) {
      i += text[i + 1] === '>' ? 2 : 1;
      continue;
    }
    if (code === 0x5b) {
      inArray = true;
      array = [];
      i += 1;
      continue;
    }
    if (code === 0x5d) {
      inArray = false;
      i += 1;
      continue;
    }
    if (code === 0x2f) {
      let k = i + 1;
      while (k < size && text.charCodeAt(k) > 0x20 && '[]<>/()%'.indexOf(text[k]) < 0) k += 1;
      lastName = text.slice(i + 1, k);
      i = k;
      continue;
    }
    if ((code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2d || code === 0x2e) {
      let k = i;
      while (k < size) {
        const c = text.charCodeAt(k);
        if ((c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x2b || c === 0x2d) k += 1;
        else break;
      }
      const value = Number(text.slice(i, k));
      i = k;
      if (inArray) array.push({ type: 'number', value });
      continue;
    }
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x27 || code === 0x22) {
      if (code === 0x27 || code === 0x22) {
        i += 1;
        separate('\n');
        if (last) emit(last);
        last = null;
        continue;
      }
      let k = i;
      while (k < size) {
        const c = text.charCodeAt(k);
        if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2a) k += 1;
        else break;
      }
      const op = text.slice(i, k);
      i = k;
      if (op === 'Tf') {
        font = lastName;
        lastName = '';
      } else if (op === 'Tj') {
        if (last) emit(last);
        last = null;
      } else if (op === 'TJ') {
        for (const item of array) {
          if (item.type === 'string') emit(item.bytes);
          else if (Number.isFinite(item.value) && item.value < -120) separate(' ');
        }
        array = [];
        last = null;
      } else if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'Tm') {
        separate('\n');
      }
      continue;
    }
    i += 1;
  }
}

function looksLikeContent(text) {
  return text.indexOf('BT') >= 0 && (text.indexOf('Tj') >= 0 || text.indexOf('TJ') >= 0);
}

/* ------------------- структурный разбор: страницы, шрифты, потоки ------------------- */

/**
 * Правильный путь: страница знает, какой шрифт у каждого имени ресурса
 * (/T1_0), а шрифт — свою таблицу ToUnicode. Тогда каждая строка читается
 * именно своей таблицей, без догадок по частоте букв. Догадки остаются только
 * как резерв, когда структура файла не разбирается (сломанный xref, сшитые
 * страницы).
 */
function objectTable(raw) {
  const objects = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = re.exec(raw))) {
    const num = Number(match[1]);
    const start = match.index + match[0].length;
    const end = raw.indexOf('endobj', start);
    const stop = end < 0 ? raw.length : end;
    if (!objects.has(num)) objects.set(num, { start, stop });
    re.lastIndex = Math.max(stop, re.lastIndex);
  }
  return objects;
}

/**
 * Объекты, упакованные в «объектные потоки» (/ObjStm): в сжатом PDF именно
 * там лежат страницы и их ресурсы, отдельных «N 0 obj» для них нет. Внутри
 * потока — заголовок из пар «номер смещение» и сами объекты подряд.
 */
function objectStreamTexts(raw, objects) {
  const packed = new Map();
  for (const [num, object] of objects) {
    const head = raw.slice(object.start, Math.min(object.start + 400, object.stop));
    if (head.indexOf('/ObjStm') < 0) continue;
    const text = streamText(raw, object);
    if (!text) continue;
    const count = Number((/\/N\s+(\d+)/.exec(head) ?? [])[1]);
    const first = Number((/\/First\s+(\d+)/.exec(head) ?? [])[1]);
    if (!count || !Number.isFinite(first)) continue;
    const pairs = text.slice(0, first).match(/-?\d+/g) ?? [];
    const numbers = [];
    const offsets = [];
    for (let i = 0; i + 1 < pairs.length && numbers.length < count; i += 2) {
      numbers.push(Number(pairs[i]));
      offsets.push(Number(pairs[i + 1]));
    }
    for (let i = 0; i < numbers.length; i += 1) {
      const start = first + offsets[i];
      const end = i + 1 < numbers.length ? first + offsets[i + 1] : text.length;
      if (start < end) packed.set(numbers[i], text.slice(start, end));
    }
  }
  return packed;
}

/** Тело объекта по номеру: из объектного потока или прямо из файла. */
function makeBodyLookup(raw, objects) {
  const packed = objectStreamTexts(raw, objects);
  const lookup = (num) => {
    if (packed.has(num)) return packed.get(num);
    const object = objects.get(num);
    return object ? raw.slice(object.start, object.stop) : null;
  };
  lookup.packed = packed;
  return lookup;
}

function skipSpace(text, i) {
  while (i < text.length && text.charCodeAt(i) <= 0x20) i += 1;
  return i;
}

function readNameToken(text, i) {
  let k = i + 1;
  while (k < text.length && ' \t\r\n/[]<>()'.indexOf(text[k]) < 0) k += 1;
  return { name: text.slice(i + 1, k), end: k };
}

/** Конец сбалансированной конструкции: «<<…>>» или «[…]». */
function balancedEnd(text, i, open, close) {
  let depth = 0;
  let k = i;
  while (k < text.length) {
    if (text.startsWith(open, k)) {
      depth += 1;
      k += open.length;
      continue;
    }
    if (text.startsWith(close, k)) {
      depth -= 1;
      k += close.length;
      if (!depth) return k;
      continue;
    }
    if (text[k] === '(') {
      const literal = readLiteral(text, k);
      k = literal.end;
      continue;
    }
    k += 1;
  }
  return -1;
}

/** Значение по ключу словаря: ссылка, вложенный словарь, массив, имя, число. */
function rawValueAt(text, key) {
  const needle = `/${key}`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return null;
    const after = text[at + needle.length];
    if (after !== undefined && /[A-Za-z0-9]/.test(after)) {
      from = at + needle.length;
      continue;
    }
    const i = skipSpace(text, at + needle.length);
    if (i >= text.length) return null;
    if (text.startsWith('<<', i)) {
      const end = balancedEnd(text, i, '<<', '>>');
      return end < 0 ? null : { kind: 'dict', text: text.slice(i, end) };
    }
    if (text[i] === '[') {
      const end = balancedEnd(text, i, '[', ']');
      return end < 0 ? null : { kind: 'array', text: text.slice(i, end) };
    }
    if (text[i] === '/') {
      const { name } = readNameToken(text, i);
      return { kind: 'name', name };
    }
    const ref = /^(\d+)\s+\d+\s+R\b/.exec(text.slice(i, i + 40));
    if (ref) return { kind: 'ref', num: Number(ref[1]) };
    const number = /^[-+]?\d+(?:\.\d+)?/.exec(text.slice(i, i + 40));
    if (number) return { kind: 'number', value: Number(number[0]) };
    return null;
  }
}

/** Словарь по значению (вложенный текст или разыменованный объект). */
function resolveDict(bodyFor, value) {
  if (!value) return null;
  if (value.kind === 'dict') return value.text;
  if (value.kind === 'ref') return bodyFor(value.num);
  return null;
}

/** Распакованный текст потока объекта. */
function streamText(raw, object) {
  if (!object) return '';
  const at = raw.indexOf('stream', object.start);
  if (at < 0 || at > object.stop) return '';
  let start = at + 6;
  if (raw[start] === '\r') start += 1;
  if (raw[start] === '\n') start += 1;
  const stop = raw.lastIndexOf('endstream', object.stop);
  const end = stop > start ? stop : object.stop;
  const body = Buffer.from(raw.slice(start, end), 'latin1');
  try {
    return zlib.inflateSync(body, { maxOutputLength: MAX_STREAM }).toString('latin1');
  } catch {
    try {
      return zlib.inflateRawSync(body, { maxOutputLength: MAX_STREAM }).toString('latin1');
    } catch {
      return raw.slice(start, end);
    }
  }
}

/** Страницы в порядке документа: обходим дерево /Pages от каталога. */
function pageOrder(bodyFor, objects) {
  const pages = [];
  const seen = new Set();
  const walk = (num) => {
    if (!num || seen.has(num)) return;
    seen.add(num);
    const body = bodyFor(num);
    if (!body) return;
    if (/\/Type\s*\/Pages\b/.test(body)) {
      const kids = rawValueAt(body, 'Kids');
      if (kids && kids.kind === 'array') {
        for (const item of kids.text.match(/\d+\s+\d+\s+R/g) ?? []) walk(Number(item.split(/\s+/)[0]));
      }
      return;
    }
    if (/\/Type\s*\/Page\b/.test(body)) pages.push(num);
  };
  for (const [num] of objects) {
    const body = bodyFor(num);
    if (body && /\/Type\s*\/Catalog\b/.test(body)) {
      const root = rawValueAt(body, 'Pages');
      if (root && root.kind === 'ref') walk(root.num);
      if (pages.length) break;
    }
  }
  if (!pages.length) {
    for (const [num] of objects) {
      const body = bodyFor(num);
      if (body && /\/Type\s*\/Page\b/.test(body)) pages.push(num);
    }
  }
  return pages;
}

const GLYPH_NAMES = {
  period: '.', comma: ',', colon: ':', semicolon: ';', hyphen: '-', 'hyphen.cap': '-',
  endash: '–', 'endash.cap': '–', emdash: '—', minus: '−', space: ' ', nbspace: ' ',
  bullet: '•', numero: '№', parenleft: '(', parenright: ')', percent: '%',
  quotedbl: '"', quotesingle: "'", slash: '/', zero: '0', one: '1', two: '2',
  three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

/** Имя глифа в PDF → символ. */
function glyphText(name) {
  if (/^uni[0-9A-Fa-f]{4}$/.test(name)) return String.fromCharCode(parseInt(name.slice(3), 16));
  if (/^u[0-9A-Fa-f]{4,6}$/.test(name)) return String.fromCodePoint(parseInt(name.slice(1), 16));
  const known = GLYPH_NAMES[name];
  if (known) return known;
  if (name.length === 1) return name;
  if (name.includes('_')) return name.split('_').map(glyphText).join('');
  return '';
}

/** Резервная таблица кодов: /Encoding /Differences с именами глифов. */
function differencesDecoder(encodingText) {
  const differences = rawValueAt(encodingText, 'Differences');
  if (!differences || differences.kind !== 'array') return null;
  const map = new Map();
  let code = 0;
  for (const token of differences.text.match(/\/[^\s/<>\[\]()]+|-?\d+/g) ?? []) {
    if (token.startsWith('/')) {
      map.set(code, glyphText(token.slice(1)));
      code += 1;
    } else {
      const value = Number(token);
      if (Number.isFinite(value) && value >= 0) code = value;
    }
  }
  if (!map.size) return null;
  return (bytes) => {
    let out = '';
    for (const byte of bytes) out += map.get(byte) ?? '';
    return out;
  };
}

/** Чем читать строки конкретного шрифта: ToUnicode, иначе /Differences. */
function fontDecoder(raw, objects, bodyFor, fontNum, cache) {
  if (cache.has(fontNum)) return cache.get(fontNum);
  let decoder = null;
  const body = bodyFor(fontNum);
  if (body) {
    const toUnicode = rawValueAt(body, 'ToUnicode');
    if (toUnicode && toUnicode.kind === 'ref') {
      const text = streamText(raw, objects.get(toUnicode.num));
      const maps = text ? parseCMaps([text]) : [];
      if (maps.length) decoder = (bytes) => decodeWithCMap(bytes, maps[0]);
    }
    if (!decoder) {
      const encoding = rawValueAt(body, 'Encoding');
      const encodingText = resolveDict(bodyFor, encoding);
      if (encodingText) decoder = differencesDecoder(encodingText);
    }
  }
  cache.set(fontNum, decoder);
  return decoder;
}

/** Таблица «имя ресурса → декодер» для страницы. */
function pageDecoders(raw, objects, bodyFor, pageNum, cache) {
  const out = new Map();
  const body = bodyFor(pageNum);
  if (!body) return out;
  const resources = resolveDict(bodyFor, rawValueAt(body, 'Resources'));
  if (!resources) return out;
  const fontDict = resolveDict(bodyFor, rawValueAt(resources, 'Font'));
  if (!fontDict) return out;
  for (const entry of fontDict.match(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g) ?? []) {
    const match = /^\/([^\s/<>\[\]()]+)\s+(\d+)/.exec(entry);
    const decoder = fontDecoder(raw, objects, bodyFor, Number(match[2]), cache);
    if (decoder) out.set(match[1], decoder);
  }
  return out;
}

/** Номера объектов с содержимым страницы. */
function pageContents(bodyFor, pageNum) {
  const body = bodyFor(pageNum);
  if (!body) return [];
  const value = rawValueAt(body, 'Contents');
  if (!value) return [];
  if (value.kind === 'ref') return [value.num];
  if (value.kind === 'array') {
    return (value.text.match(/\d+\s+\d+\s+R/g) ?? []).map((item) => Number(item.split(/\s+/)[0]));
  }
  return [];
}

/** Текст по структуре файла; null — если структура не разобралась. */
function structuredRecords(buf) {
  const raw = buf.toString('latin1');
  const objects = objectTable(raw);
  const bodyFor = makeBodyLookup(raw, objects);
  const pages = pageOrder(bodyFor, objects);
  if (!pages.length) return null;
  const fontCache = new Map();
  const records = [];
  let index = 0;
  for (const pageNum of pages) {
    const decoders = pageDecoders(raw, objects, bodyFor, pageNum, fontCache);
    for (const contentNum of pageContents(bodyFor, pageNum)) {
      const text = streamText(raw, objects.get(contentNum));
      if (!text || !looksLikeContent(text)) continue;
      collectContent(text, records, index, decoders);
      if (records.length >= MAX_STRINGS) break;
    }
    index += 1;
    if (records.length >= MAX_STRINGS) break;
  }
  if (!records.length) return null;
  return { records, objects, pages, raw, bodyFor };
}

/** Склеиваем строки, разорванные вёрсткой: перенос посреди фразы — пробел. */
function tidy(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    /* перенос слова через строку: «лизинго⏎-⏎вой», «республикан⏎-⏎47⏎скую».
       Номер страницы, попавший внутрь слова, — мусор, его выбрасываем. */
    .replace(/([а-яёa-z])[ \t]*\n[ \t]*-[ \t]*\n[ \t]*(?:\d{1,3}[ \t]*\n[ \t]*)?([а-яёa-z])/g, '$1$2')
    /* перенос прилепленным дефисом: «при-⏎близилась» → «приблизилась» */
    .replace(/([а-яёa-z])-[ \t]*\n[ \t]*(?:\d{1,3}[ \t]*\n[ \t]*)?([а-яёa-z])/g, '$1$2')
    .replace(/ *(?:\n *){3,}/g, '\n\n')
    .replace(/([а-яёa-z,;:])\n(?=[а-яёa-z(])/g, '$1 ')
    .replace(/\u0000/g, '')
    .trim();
}

/** Похоже ли на настоящий русский текст: иначе это байты, прочитанные не той
    кодировкой — их нельзя показывать и тем более озвучивать. */
function plausible(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return text.length > 0;
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu) ?? [];
  if (cyrillic.length / letters.length < 0.3) return true;
  return russianScore(text) >= 0.45;
}

/** Текст PDF целиком: сначала по структуре файла, иначе — догадками. */
export function pdfText(buf) {
  return pdfExtract(buf).text;
}

/**
 * Текст вместе с причиной отказа: 'empty' — нет текстового слоя (скан),
 * 'encoded' — текст есть, но прочитать его нечем (шрифт без таблицы).
 */
export function pdfExtract(buf) {
  let sawText = false;
  const accept = (text) => {
    if (!text) return null;
    /* Проверяем по буквам без пробелов: короткий PDF с одной строкой тоже
       должен читаться, поэтому порог низкий. */
    if (text.replace(/\s/g, '').length < 20) return null;
    sawText = true;
    if (pdfTextIsReadable(text) && plausible(text)) return { text, reason: '' };
    return null;
  };

  const structured = structuredRecords(buf);
  const byStructure = accept(structured ? tidy(recordsText([], structured.records).text) : '');
  if (byStructure) return byStructure;

  const { maps, records } = pdfRecords(buf);
  const byGuess = accept(tidy(recordsText(maps, records).text));
  if (byGuess) return byGuess;

  return { text: '', reason: sawText ? 'encoded' : 'empty' };
}

/** Записи разбора: строки с их шрифтом и разделители, плюс таблицы шрифтов. */
export function pdfRecords(buf) {
  const streams = pdfStreams(buf);
  const maps = parseCMaps(streams);
  const records = [];
  let page = 0;
  for (const stream of streams) {
    if (!looksLikeContent(stream)) continue;
    collectContent(stream, records, page);
    page += 1;
    if (records.length >= MAX_STRINGS) break;
  }
  return { streams, maps, records };
}

/**
 * Раскодированные записи. Если у записи есть свой декодер (шрифт найден по
 * структуре страницы) — читаем им, иначе выбираем кодировку по образцу.
 */
export function recordsText(maps, records, trace) {
  /* Образец на каждый шрифт страницы: по нему видно, какая таблица даёт слова. */
  const samples = new Map();
  for (const record of records) {
    if (record.kind !== 'text' || record.decoder) continue;
    let sample = samples.get(record.font);
    if (!sample) {
      sample = [];
      samples.set(record.font, sample);
    }
    for (const byte of record.bytes) {
      if (sample.length >= SAMPLE_BYTES) break;
      sample.push(byte);
    }
  }
  const decoders = new Map();
  for (const [font, sample] of samples) {
    const chosen = bestDecoder(sample, maps ?? []);
    /* Короткий кусок без единого узнаваемого слова — это декоративная
       надпись или колонтитул чужого шрифта. Лучше не озвучивать мусор
       («яцьсиМйдзс»), чем вставлять его в книгу. */
    if (sample.length < 200 && chosen.score < 0.25) continue;
    decoders.set(font, chosen.decode);
  }
  const fallback = bestDecoder([], maps ?? []).decode;

  const parts = [];
  let skipped = 0;
  for (const record of records) {
    if (record.kind === 'sep') {
      parts.push(record.value);
      continue;
    }
    const decode = record.decoder ?? decoders.get(record.font) ?? fallback;
    if (!record.decoder && !decoders.has(record.font) && record.bytes.length > 20) skipped += 1;
    const text = decode(record.bytes);
    if (trace) trace.push({ font: record.font, text, hex: Buffer.from(record.bytes).toString('hex') });
    parts.push(text);
  }
  return { text: parts.join(''), skipped };
}

/** Проверка «текст читается человеком» — на случай, если кодировку не нашли. */
export function pdfTextIsReadable(text) {
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

export const __testing = { hexBytes, utf16Text, tidy, russianScore, CP1251_HIGH, structuredRecords, pageOrder, objectTable, makeBodyLookup, pageDecoders, fontDecoder, pageContents, rawValueAt, resolveDict };

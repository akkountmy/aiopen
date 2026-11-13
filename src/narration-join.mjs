/**
 * Склейка готовых частей озвучки в один MP3 — без синтеза и без правки текста.
 *
 * Зачем отдельный шаг, а не «озвучить ещё раз одним файлом». Живой случай:
 * книга на 65 минут вышла двумя частями, человек попросил «соберите в один
 * файл». Повторная озвучка решает другую задачу — она заново читает текст и
 * потому легко уезжает в другую редакцию (сокращённый текст, другой голос,
 * другие паузы), и время синтеза тоже платится заново. Склейка же берёт ровно
 * то, что уже наговорено: те же слова, тот же голос, тот же темп.
 *
 * MP3 склеивается на уровне кадров: у наших частей одинаковые частота, канал и
 * битрейт, поэтому достаточно убрать служебные теги (ID3) и сложить кадры
 * подряд. Ничего не перекодируется, звук не деградирует.
 *
 * Проверка перед тем, как что-то убрать: склейка сверяется по числу кадров и
 * длительности — сумма частей должна совпасть с результатом. Только после
 * этого исходные части уходят в скрытый архив `.dshow/archive/narration/…`
 * (на диске остаются, в «Файлах проекта» не мешают). Если что-то не сошлось,
 * части остаются на месте, а вызывающий получает ошибку с причиной.
 */

import fs from 'node:fs';
import path from 'node:path';
import { trimBase } from './narration-plan.mjs';

/* «Книга — часть 3 из 12.mp3». Регэксп терпим к дефису и регистру: имена
   прошлых версий сервиса отличались. */
const PART_RE = /^(?<prefix>.+?)[ \t]*[—–-][ \t]*часть[ \t]+(?<index>\d{1,3})[ \t]+из[ \t]+(?<total>\d{1,3})\.mp3$/iu;

const BITRATES = {
  '1-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

/** Размер ID3v2-тега в начале файла (0, если тега нет). */
function id3Size(buffer) {
  if (buffer.length < 10 || buffer.subarray(0, 3).toString('latin1') !== 'ID3') return 0;
  const size =
    ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
  return 10 + size;
}

/**
 * Разбирает MP3 по кадрам: длительность, число кадров, формат первого кадра и
 * чистые аудиоданные (без ID3v2 и без хвостового ID3v1).
 */
export function scanMp3(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const start = id3Size(buffer);
  let end = buffer.length;
  if (end - start > 128 && buffer.subarray(end - 128, end - 125).toString('latin1') === 'TAG') end -= 128;

  let offset = start;
  let frames = 0;
  let seconds = 0;
  let format = null;
  while (offset + 4 <= end) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }
    const versionBits = (buffer[offset + 1] >> 3) & 0x03;
    const layerBits = (buffer[offset + 1] >> 1) & 0x03;
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : versionBits === 0 ? 25 : 0;
    const layer = 4 - layerBits;
    if (!version || !layer || layer > 3) {
      offset += 1;
      continue;
    }
    const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
    const rateIndex = (buffer[offset + 2] >> 2) & 0x03;
    const mode = (buffer[offset + 3] >> 6) & 0x03;
    if (!bitrateIndex || bitrateIndex === 15 || rateIndex === 3) {
      offset += 1;
      continue;
    }
    const table = BITRATES[`${version === 25 ? 2 : version}-${layer}`];
    const bitrate = table ? table[bitrateIndex] * 1000 : 0;
    const sampleRate = SAMPLE_RATES[version][rateIndex];
    if (!bitrate || !sampleRate) {
      offset += 1;
      continue;
    }
    const padding = (buffer[offset + 2] >> 1) & 0x01;
    const coefficient = layer === 1 ? 12 : version === 1 ? 144 : 72;
    const frameLength = Math.floor((coefficient * bitrate) / sampleRate) + padding;
    if (frameLength <= 4 || offset + frameLength > end) {
      offset += 1;
      continue;
    }
    const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
    seconds += samples / sampleRate;
    frames += 1;
    if (!format) format = { version, layer, sampleRate, bitrate, channels: mode === 3 ? 1 : 2 };
    else if (format.sampleRate !== sampleRate || format.channels !== (mode === 3 ? 1 : 2) || format.layer !== layer) {
      /* Разный формат внутри одного файла — склеивать нельзя, получится треск. */
      return { frames, seconds, format, mixed: true, audio: buffer.subarray(start, end) };
    }
    offset += frameLength;
  }
  return {
    frames,
    seconds: Number(seconds.toFixed(3)),
    format,
    mixed: false,
    audio: buffer.subarray(start, end),
    cleanStart: start,
  };
}

/** Насколько имя части похоже на имя документа: у длинных названий база усечена. */
function prefixScore(prefix, base) {
  const trimmed = String(prefix).replace(/[….]+$/, '').trim();
  if (!trimmed) return 0;
  if (base.startsWith(trimmed)) return trimmed.length;
  /* Сравниваем по началу: имя документа могло быть длиннее лимита. */
  let same = 0;
  while (same < trimmed.length && same < base.length && trimmed[same] === base[same]) same += 1;
  return same >= Math.min(12, base.length) ? same : 0;
}

/**
 * Части озвучки этого документа: по именам в его папке, по возрастанию номера.
 * Возвращает только полный комплект — 1..N без пропусков.
 */
export function listNarrationParts(full) {
  const dir = path.dirname(full);
  const base = trimBase(path.basename(full, path.extname(full)));
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { base, dir, parts: [], complete: false, candidates: 0 };
  }
  const groups = new Map();
  for (const name of entries) {
    const match = name.match(PART_RE);
    if (!match) continue;
    const score = prefixScore(match.groups.prefix, base);
    if (!score) continue;
    const key = `${score}\u0000${match.groups.prefix}`;
    if (!groups.has(key)) groups.set(key, { score, prefix: match.groups.prefix, items: [], total: 0 });
    const group = groups.get(key);
    group.items.push({ index: Number(match.groups.index), name, path: path.join(dir, name) });
    group.total = Number(match.groups.total);
  }
  if (!groups.size) return { base, dir, parts: [], complete: false, candidates: 0 };

  const best = [...groups.values()].sort((a, b) => b.score - a.score || b.items.length - a.items.length)[0];
  const parts = best.items.sort((a, b) => a.index - b.index);
  const numbers = parts.map((part) => part.index);
  const complete =
    parts.length === best.total &&
    numbers.every((number, position) => number === position + 1);
  return { base, dir, parts, total: best.total, complete, candidates: best.items.length };
}

/** Скрытая папка, куда уезжают уже ненужные файлы: в проекте их не видно. */
export function narrationArchiveDir(dir, stamp = Date.now()) {
  return path.join(dir, '.dshow', 'archive', 'narration', String(stamp));
}

/** Переносит файл в архив. Ошибку возвращает строкой — вызывающий решает. */
function archiveFile(file, archiveDir) {
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    const target = path.join(archiveDir, path.basename(file));
    fs.rmSync(target, { force: true });
    try {
      fs.renameSync(file, target);
    } catch {
      /* Разные тома (бывает с примонтированным /data): копируем и убираем. */
      fs.copyFileSync(file, target);
      fs.rmSync(file, { force: true });
    }
    return '';
  } catch (error) {
    return error.message || String(error);
  }
}

/**
 * Склеивает части в один MP3 рядом с документом.
 *
 * @param {string} full      путь к исходному документу (по нему ищутся части)
 * @param {object} options
 * @param {string} [options.archiveDir] куда убрать части после успешной склейки
 * @param {string} [options.name]       имя результата (по умолчанию имя документа)
 * @returns {{already: boolean, name: string, path: string, size: number, seconds: number,
 *            duration: string, parts: string[], archived: string[], warnings: string[]}}
 */
export function joinNarrationParts(full, { archiveDir = '', name = '', keepParts = false } = {}) {
  const target = path.resolve(full);
  const dir = path.dirname(target);
  const base = trimBase(name || path.basename(target, path.extname(target)));
  const singleName = `${base}.mp3`;
  const singlePath = path.join(dir, singleName);
  const found = listNarrationParts(target);
  const warnings = [];

  if (!found.parts.length) {
    /* Частей нет — возможно, книга уже склеена (или озвучена одним файлом). */
    if (fs.existsSync(singlePath) && fs.statSync(singlePath).size > 2000) {
      const scan = scanMp3(fs.readFileSync(singlePath));
      return {
        already: true,
        name: singleName,
        path: singlePath,
        size: fs.statSync(singlePath).size,
        seconds: scan?.seconds || 0,
        duration: '',
        parts: [],
        archived: [],
        warnings,
      };
    }
    throw new Error(
      `Не нашёл частей озвучки для «${path.basename(target)}»: в папке нет ни одного файла «… — часть N из M.mp3» и нет «${singleName}».`,
    );
  }
  if (!found.complete) {
    const numbers = found.parts.map((part) => part.index).join(', ');
    throw new Error(
      `Части «${found.prefix || base}» неполные: нашлись №${numbers}${found.total ? ` из ${found.total}` : ''}. ` +
        'Склеивать неполный комплект нельзя — в книге был бы пропуск. Дождитесь окончания озвучки.',
    );
  }

  const scans = [];
  for (const part of found.parts) {
    const buffer = fs.readFileSync(part.path);
    const scan = scanMp3(buffer);
    if (!scan || !scan.frames) throw new Error(`«${part.name}» не читается как MP3.`);
    if (scan.mixed) throw new Error(`«${part.name}» содержит разные форматы звука — склейка без перекодирования невозможна.`);
    scans.push({ ...part, scan, buffer });
  }
  const first = scans[0].scan.format;
  for (const item of scans.slice(1)) {
    if (item.scan.format.sampleRate !== first.sampleRate || item.scan.format.channels !== first.channels) {
      throw new Error(
        `Части записаны по-разному («${scans[0].name}»: ${first.sampleRate} Гц, ${first.channels} канал(а); ` +
          `«${item.name}»: ${item.scan.format.sampleRate} Гц, ${item.scan.format.channels}): без перекодирования склейка даст треск.`,
      );
    }
  }

  const audio = Buffer.concat(scans.map((item) => item.scan.audio));
  const expectedFrames = scans.reduce((sum, item) => sum + item.scan.frames, 0);
  const expectedSeconds = Number(scans.reduce((sum, item) => sum + item.scan.seconds, 0).toFixed(3));

  const temp = path.join(dir, `.${singleName}.part`);
  fs.writeFileSync(temp, audio);
  const check = scanMp3(fs.readFileSync(temp));
  if (!check || check.frames !== expectedFrames || Math.abs(check.seconds - expectedSeconds) > 0.5) {
    fs.rmSync(temp, { force: true });
    throw new Error(
      `Склейка не сошлась: ожидалось ${expectedFrames} кадров и ${expectedSeconds} с, получилось ` +
        `${check?.frames || 0} кадров и ${check?.seconds || 0} с. Части оставил как есть.`,
    );
  }
  /* Замена атомарная: читатель никогда не увидит «половину» книги. */
  fs.renameSync(temp, singlePath);
  const size = fs.statSync(singlePath).size;

  const archived = [];
  if (!keepParts) {
    const box = archiveDir || narrationArchiveDir(dir);
    for (const item of scans) {
      const problem = archiveFile(item.path, box);
      if (problem) warnings.push(`Часть «${item.name}» не убралась в архив: ${problem}`);
      else archived.push(item.name);
    }
  }

  return {
    already: false,
    name: singleName,
    path: singlePath,
    size,
    seconds: check.seconds,
    duration: '',
    parts: scans.map((item) => item.name),
    archived,
    warnings,
  };
}

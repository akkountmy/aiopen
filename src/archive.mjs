import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';

/* Разбор архива, который принёс пользователь. Своя распаковка не нужна: jszip уже
   стоит в зависимостях, читает обычный zip, zip64 и архивы с data descriptor.
   Всё ограничено: чужой архив не должен забить диск сервиса или разложить файлы
   вне папки проекта. */

export const ARCHIVE_LIMITS = {
  maxFiles: 400,
  maxEntryBytes: 48 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

/* Служебный мусор из macOS/Windows и каталоги, которые в проекте не нужны. */
const SKIP_ANY = /(^|\/)(__MACOSX|\.git|\.svn|node_modules)(\/|$)/i;
const SKIP_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.gitignore)$/i;

/** Что за архив по имени файла: 'zip' | 'gz' | 'unsupported'. */
export function archiveKind(name = '') {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.gz') && !lower.endsWith('.tar.gz')) return 'gz';
  return 'unsupported';
}

/**
 * Имя записи внутри архива, приведённое к безопасному относительному пути.
 * Возвращает '' для записей, которые нельзя распаковывать.
 */
export function safeEntryName(raw = '') {
  const unified = String(raw).replace(/\\/g, '/');
  if (SKIP_ANY.test(unified) || SKIP_FILE.test(unified)) return '';
  const parts = [];
  for (const piece of unified.split('/')) {
    const part = piece.trim();
    if (!part || part === '.') continue;
    if (part === '..') return ''; // выход из папки — такую запись не трогаем
    if (part.includes(':') || part.startsWith('~')) return ''; // «C:», «~» — не путь внутри проекта
    parts.push(part);
  }
  return parts.join('/');
}

/**
 * Распаковывает zip (или .gz одиночный файл) в targetDir.
 * Никогда не бросает на «плохом» файле внутри архива: такие записи уходят в skipped.
 */
export async function extractArchiveTo(buffer, targetDir, { overwrite = false, limits = ARCHIVE_LIMITS } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Пустой архив');
  const root = path.resolve(targetDir);
  const files = [];
  const skipped = [];
  let totalBytes = 0;

  const writeEntry = (rel, data) => {
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) {
      skipped.push({ name: rel, reason: 'путь вне папки проекта' });
      return false;
    }
    if (fs.existsSync(full) && !overwrite) {
      skipped.push({ name: rel, reason: 'файл уже есть' });
      return false;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    files.push({ path: rel, bytes: data.length });
    totalBytes += data.length;
    return true;
  };

  const zip = await loadZip(buffer);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);

  for (const entry of entries) {
    const rel = safeEntryName(entry.name);
    if (!rel) continue;
    if (files.length >= limits.maxFiles) {
      skipped.push({ name: rel, reason: `лимит ${limits.maxFiles} файлов` });
      continue;
    }
    if (totalBytes >= limits.maxTotalBytes) {
      skipped.push({ name: rel, reason: 'лимит общего размера' });
      continue;
    }
    /* Размер из заголовка записи — быстрая отсечка, но верить ей нельзя:
       архив может её занизить. Настоящий предел держит потоковое чтение. */
    const declared = Number(entry?._data?.uncompressedSize || 0);
    if (declared > limits.maxEntryBytes) {
      skipped.push({ name: rel, reason: `файл больше ${Math.round(limits.maxEntryBytes / 1024 / 1024)} МБ` });
      continue;
    }
    let data;
    try {
      const read = await readEntryLimited(entry, limits.maxEntryBytes);
      if (read.tooLarge) {
        skipped.push({ name: rel, reason: `файл больше ${Math.round(limits.maxEntryBytes / 1024 / 1024)} МБ` });
        continue;
      }
      data = read.data;
    } catch (error) {
      skipped.push({ name: rel, reason: `не читается: ${error?.message || 'ошибка распаковки'}` });
      continue;
    }
    if (totalBytes + data.length > limits.maxTotalBytes) {
      skipped.push({ name: rel, reason: 'лимит общего размера' });
      continue;
    }
    writeEntry(rel, data);
  }

  return { files, skipped, totalBytes, entries: entries.length };
}

/** Одиночный .gz: один файл внутри, имя — без .gz. */
export function gunzipTo(buffer, targetDir, fileName = 'файл', { overwrite = false } = {}) {
  let data;
  try {
    data = zlib.gunzipSync(buffer, { maxOutputLength: ARCHIVE_LIMITS.maxEntryBytes });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(String(error?.message))) {
      throw new Error(`Файл после распаковки больше ${Math.round(ARCHIVE_LIMITS.maxEntryBytes / 1024 / 1024)} МБ — такой .gz не разворачиваю.`);
    }
    throw new Error('Файл .gz не открывается: он повреждён или это не gzip. Попроси пересобрать архив в .zip.');
  }
  const rel = safeEntryName(String(fileName).replace(/\.gz$/i, '')) || 'распакованный-файл';
  const root = path.resolve(targetDir);
  const full = path.resolve(root, rel);
  if (!(full === root || full.startsWith(root + path.sep))) throw new Error('Путь выходит за пределы папки проекта');
  if (fs.existsSync(full) && !overwrite) {
    return { files: [], skipped: [{ name: rel, reason: 'файл уже есть' }], totalBytes: 0, entries: 1 };
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
  return { files: [{ path: rel, bytes: data.length }], skipped: [], totalBytes: data.length, entries: 1 };
}

/* zip открывается целиком в память (он и так пришёл буфером), но ломаный или
   зашифрованный файл должен давать русскую причину, а не английский стек jszip. */
async function loadZip(buffer) {
  try {
    return await JSZip.loadAsync(buffer);
  } catch (error) {
    const raw = String(error?.message || '');
    if (/encrypt/i.test(raw)) {
      throw new Error('Архив с паролем: такие zip не открываю — попроси прислать без пароля.');
    }
    throw new Error('Архив не открывается: файл повреждён или это не zip. Попроси пересобрать архив в .zip.');
  }
}

/* Читаем запись потоком и обрываемся на пределе: заявленный размер в архиве
   может быть занижен, и распаковка «бомбы» не должна съесть память сервиса. */
async function readEntryLimited(entry, maxBytes) {
  if (typeof entry.nodeStream !== 'function') {
    const data = await entry.async('nodebuffer');
    return data.length > maxBytes ? { tooLarge: true } : { data };
  }
  const stream = entry.nodeStream('nodebuffer');
  const chunks = [];
  let total = 0;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish({ tooLarge: true });
        try {
          stream.destroy();
        } catch {
          /* поток уже закрыт */
        }
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => finish({ data: Buffer.concat(chunks, total) }));
    stream.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** Текстовая сводка распаковки для ответа инструмента. */
export function formatExtraction(result, { folder = '' } = {}) {
  const count = result.files.length;
  const placed = folder ? `в папку ${folder}` : 'в проект';
  const head = count
    ? `Распаковано ${count} ${plural(count, 'файл', 'файла', 'файлов')} ${placed} (${formatSize(result.totalBytes)}).`
    : `Ничего не распаковано${folder ? ` в папку ${folder}` : ''}.`;
  /* Пути печатаем от корня проекта — ровно такими, какие принимают read_document
     и analyze_data. Иначе модель зовёт их без папки и получает «файла нет». */
  const full = (rel) => (folder ? `${folder.replace(/\/+$/, '')}/${rel}` : rel);
  const list = result.files.slice(0, 40).map((file) => `— ${full(file.path)} (${formatSize(file.bytes)})`);
  const more = count > 40 ? `…и ещё ${count - 40}` : '';
  const skip = result.skipped.length
    ? `\nПропущено: ${result.skipped
        .slice(0, 12)
        .map((item) => `${item.name} — ${item.reason}`)
        .join('; ')}${result.skipped.length > 12 ? ` …и ещё ${result.skipped.length - 12}` : ''}`
    : '';
  return [head, list.join('\n'), more, skip].filter(Boolean).join('\n');
}

function plural(count, one, few, many) {
  const n = Math.abs(Number(count) || 0) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} КБ`;
  return `${Math.round(size / 1024 / 102.4) / 10} МБ`;
}

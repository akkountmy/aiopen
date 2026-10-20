/**
 * Сводка по файлам проекта для системного сообщения.
 *
 * Зачем: человек загружает или перетаскивает файл в проект, чтобы показать его
 * ассистенту. Без сводки модель видит пустой проект и отвечает «файл получен» или
 * спрашивает, что с ним делать. Здесь мы на каждом ходу собираем компактную
 * картину рабочей папки: имя, тип, размер, когда файл появился, а для свежих
 * файлов — ещё и первый фрагмент текста (документы Word/Excel/PowerPoint/PDF,
 * простой текст), размеры картинок и состав архивов.
 *
 * Правила экономии:
 *  - в список попадают последние MAX_LISTED файлов по времени изменения;
 *  - фрагмент читается только у свежих файлов и только в пределах бюджета
 *    PREVIEW_TOTAL символов и PREVIEW_READ_BUDGET байт;
 *  - разбор кешируется по «путь + размер + mtime», поэтому повторные ходы не
 *    перечитывают те же документы.
 */
import fs from 'node:fs';
import path from 'node:path';

import { detectKind, extractDocumentText, kindLabel } from './docparse.mjs';
import { imageInfo } from './doc/image-info.mjs';
import { readZip } from './zip.mjs';

/** Свежий = появился или изменён недавно: считаем, что это и есть тема задачи. */
const FRESH_MS = 6 * 60 * 60 * 1000;
const MAX_LISTED = 40;
const MAX_DEPTH = 4;
const PREVIEW_CHARS = 700;
const PREVIEW_TOTAL = 7000;
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const PREVIEW_READ_BUDGET = 24 * 1024 * 1024;
const SCAN_MAX_FILES = 4000;
const CACHE_LIMIT = 400;

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '__pycache__']);

const previewCache = new Map();

function cacheKey(rel, size, mtimeMs) {
  return `${rel}|${size}|${Math.round(mtimeMs)}`;
}

function rememberPreview(key, value) {
  if (!key) return;
  if (previewCache.size >= CACHE_LIMIT) {
    const oldest = previewCache.keys().next().value;
    previewCache.delete(oldest);
  }
  previewCache.set(key, value);
}

function walk(dir, rel, out, depth) {
  if (out.length >= SCAN_MAX_FILES || depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, relPath, out, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    out.push({ rel: relPath, full, size: stat.size, mtimeMs: stat.mtimeMs });
    if (out.length >= SCAN_MAX_FILES) return;
  }
}

const sizeLabel = (bytes) => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
};

/** «только что», «12 мин назад», «сегодня 14:05», «вчера 09:30», «11.10.2026». */
function whenLabel(mtimeMs, now) {
  const diff = now - mtimeMs;
  if (diff < 90 * 1000) return 'только что';
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 60000))} мин назад`;
  const date = new Date(mtimeMs);
  const today = new Date(now);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const sameDay =
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
  if (sameDay) return `сегодня ${clock}`;
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  if (
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()
  ) {
    return `вчера ${clock}`;
  }
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

/** Одна строка вместо простыни: сводка не должна занимать пол-промпта. */
function oneLine(text, limit = 260) {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

/** Строка-описание таблицы: листы, их размер и заголовки — без остального текста. */
function sheetSummary(text) {
  const blocks = String(text || '').split(/\n(?=## Лист )/);
  const parts = [];
  for (const block of blocks) {
    const head = block.match(/^## Лист «(.+?)»\s*\n?/);
    const name = head ? head[1] : 'Лист 1';
    const rows = block
      .replace(/^## Лист «.+?»\s*\n?/, '')
      .split('\n')
      .filter((line) => line.trim());
    if (!rows.length) {
      parts.push(`лист «${name}» пустой`);
      continue;
    }
    const cols = Math.max(...rows.map((line) => line.split('\t').length));
    const header = rows[0]
      .split('\t')
      .map((cell) => cell.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(' | ');
    parts.push(`лист «${name}»: ${rows.length} строк × ${cols} столбцов${header ? `, заголовки: ${header}` : ''}`);
  }
  return parts.join('; ');
}

function slideCount(text) {
  const count = (String(text || '').match(/^## Слайд /gm) || []).length;
  return count ? `${count} слайдов` : '';
}

function archiveSummary(buf) {
  try {
    const entries = readZip(buf);
    const names = [...entries.keys()].filter((name) => !name.endsWith('/'));
    const shown = names.slice(0, 6).join(', ');
    return `архив: ${names.length} ${names.length === 1 ? 'файл' : 'файлов'}${shown ? ` — ${shown}${names.length > 6 ? ', …' : ''}` : ''}`;
  } catch {
    return '';
  }
}

/**
 * Что внутри файла — коротким пересказом. Возвращает '' если разобрать нечего.
 * Тяжёлые и слишком большие файлы не читаем: агент возьмёт их инструментом.
 */
function describeContent(file, kind, budget) {
  if (file.size > PREVIEW_MAX_BYTES) return '';
  const key = cacheKey(file.rel, file.size, file.mtimeMs);
  const cached = previewCache.get(key);
  if (cached !== undefined) return cached;
  let buf;
  try {
    buf = fs.readFileSync(file.full);
  } catch {
    return '';
  }
  if (budget.left < buf.length) {
    const note = '(файл большой — полностью прочитаю инструментом read_file)';
    rememberPreview(key, note);
    return note;
  }
  budget.left -= buf.length;

  let summary = '';
  try {
    if (kind === 'image') {
      const info = imageInfo(buf);
      summary = info ? `изображение ${String(info.type).toUpperCase()} ${info.width}×${info.height} px` : '';
    } else if (kind === 'archive') {
      summary = archiveSummary(buf);
    } else {
      const parsed = extractDocumentText(buf, file.rel, '', { maxChars: PREVIEW_CHARS * 2, maxRows: 40 });
      const text = oneLine(parsed.text);
      if (kind === 'xlsx') {
        const sheets = sheetSummary(parsed.text);
        summary = [sheets, text ? `фрагмент: «${oneLine(text, 260)}»` : ''].filter(Boolean).join('. ');
      } else if (kind === 'pptx') {
        const slides = slideCount(parsed.text);
        summary = [slides, text ? `фрагмент: «${oneLine(text, 260)}»` : ''].filter(Boolean).join('. ');
      } else if (text) {
        summary = `фрагмент: «${text}»`;
      }
      if (!summary && parsed.warnings.length) summary = parsed.warnings[0];
    }
  } catch {
    summary = '';
  }
  const result = oneLine(summary, PREVIEW_CHARS + 400);
  rememberPreview(key, result);
  return result;
}

/**
 * Сводка по рабочей папке проекта.
 *
 * @param {string} workspace абсолютный путь корня проекта
 * @param {{ now?: number, freshMs?: number, skipPaths?: string[] }} [options]
 *   skipPaths — файлы, которые уже целиком переданы в сообщении (вложения),
 *   их повторно не пересказываем.
 * @returns {{ text: string, files: number, fresh: number, freshPaths: string[] }}
 */
export function projectFilesBrief(workspace, options = {}) {
  const now = Number(options.now) || Date.now();
  const freshMs = Number(options.freshMs) || FRESH_MS;
  const skip = new Set((options.skipPaths || []).map((rel) => String(rel).replace(/\\/g, '/')));
  const all = [];
  walk(workspace, '', all, 0);
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const listed = all.slice(0, MAX_LISTED);
  if (!listed.length) return { text: '', files: 0, fresh: 0, freshPaths: [] };

  const budget = { left: PREVIEW_READ_BUDGET };
  const previewBudget = { left: PREVIEW_TOTAL };
  const freshPaths = [];
  const lines = [];
  let freshCount = 0;

  listed.forEach((file, index) => {
    const kind = detectKind(file.rel);
    const label = kindLabel(kind);
    const fresh = now - file.mtimeMs < freshMs;
    if (fresh) freshCount += 1;
    const freshNote = fresh ? ` · свежий (${whenLabel(file.mtimeMs, now)})` : ` · ${whenLabel(file.mtimeMs, now)}`;
    lines.push(`${index + 1}) ${file.rel} — ${label}, ${sizeLabel(file.size)}${freshNote}`);

    /* Вложение уже целиком в сообщении — но знать его путь полезно, рассказ не повторяем. */
    if (skip.has(file.rel)) {
      lines.push('   (содержимое уже передано в сообщении выше)');
      return;
    }
    if (!fresh || previewBudget.left <= 0) return;
    const content = describeContent(file, kind, budget);
    if (!content) return;
    previewBudget.left -= content.length;
    if (fresh) freshPaths.push(file.rel);
    lines.push(`   ${content}`);
  });

  const header = freshCount
    ? `Файлы проекта: всего ${all.length}, показаны ${listed.length} самых свежих. «Свежий» — файл загрузили или изменили недавно: человек принёс его для этой задачи.`
    : `Файлы проекта: всего ${all.length}, показаны ${listed.length} самых свежих. Свежих файлов сейчас нет.`;
  const tail =
    all.length > listed.length ? `\n…и ещё ${all.length - listed.length} файлов старее — их видно через list_files.` : '';
  return {
    text: `${header}\n${lines.join('\n')}${tail}`,
    files: all.length,
    fresh: freshCount,
    freshPaths,
  };
}

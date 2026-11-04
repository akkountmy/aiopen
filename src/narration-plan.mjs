/**
 * Имена файлов озвучки: книга превращается в несколько MP3-частей и один Word
 * с текстом. Имена короткие и предсказуемые — по ним видно, что это одна книга:
 *
 *   Белорусский рынок лизинга 2025 — обзор — часть 3 из 12.mp3
 *   Белорусский рынок лизинга 2025 — обзор.docx
 *
 * Повторная озвучка перезаписывает свои же файлы, а не плодит «(озвучка 2)»:
 * иначе папка проекта зарастает копиями одной книги.
 */

import path from 'node:path';

/** Длина имени без расширения: длинный заголовок книги усекаем многоточием. */
const MAX_BASE = 62;
const ELLIPSIS = '…';

export function trimBase(base, limit = MAX_BASE) {
  const value = String(base || 'озвучка').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value || 'озвучка';
  const cut = value.slice(0, limit - 1).trimEnd();
  return `${cut}${ELLIPSIS}`;
}

/** Имя одной части: суффикс остаётся коротким, расширение — в конце. */
export function partFileName(base, index, total) {
  const suffix = total > 1 ? ` — часть ${index} из ${total}.mp3` : '.mp3';
  /* Суффикс важнее начала названия: под него оставляем место всегда. */
  return `${trimBase(base, MAX_BASE - suffix.length)}${suffix}`;
}

/** Пути всех файлов озвучки в папке исходника. */
export function planNarrationFiles(full, total) {
  const dir = path.dirname(full);
  const base = path.basename(full, path.extname(full));
  const parts = [];
  for (let index = 1; index <= Math.max(1, total); index += 1) {
    parts.push({ index, label: total > 1 ? `Часть ${index} из ${total}` : '', path: path.join(dir, partFileName(base, index, total)) });
  }
  return {
    parts,
    word: path.join(dir, `${trimBase(base)}.docx`),
  };
}

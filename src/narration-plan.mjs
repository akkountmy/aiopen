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

import fs from 'node:fs';
import path from 'node:path';

/** Длина имени без расширения: длинный заголовок книги усекаем многоточием. */
const MAX_BASE = 62;
const ELLIPSIS = '…';
const LEDGER = path.join('.dshow', 'narration-own.json');

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

/**
 * План файлов плюс уборка прошлой озвучки того же исходника.
 *
 * Если книга подросла или человек выбрал другую длину части, число частей
 * меняется — и от прошлого раза остаются «часть 13 из 13.mp3» рядом с новыми
 * «часть 13 из 14.mp3». Убираем только то, что создали сами: в `.dshow/
 * narration-own.json` лежит список файлов, выданных для этого исходника.
 */
export function claimNarrationFiles(full, total, { root } = {}) {
  const plan = planNarrationFiles(full, total);
  const projectRoot = root ? path.resolve(root) : '';
  if (!projectRoot) return plan;

  const ledgerPath = path.join(projectRoot, LEDGER);
  let ledger = {};
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) || {};
  } catch {
    ledger = {};
  }
  const key = path.relative(projectRoot, path.resolve(full)) || path.basename(full);
  const next = [...plan.parts.map((part) => path.relative(projectRoot, part.path)), path.relative(projectRoot, plan.word)];
  const previous = Array.isArray(ledger[key]) ? ledger[key] : [];

  for (const rel of previous) {
    if (next.includes(rel)) continue;
    const abs = path.resolve(projectRoot, rel);
    /* Только внутри проекта и только файлы: чужое не трогаем никогда. */
    if (!abs.startsWith(`${projectRoot}${path.sep}`)) continue;
    try {
      if (fs.statSync(abs).isFile()) fs.rmSync(abs);
    } catch {
      /* файла уже нет — убирать нечего */
    }
  }

  ledger[key] = next;
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
  } catch {
    /* без списка озвучка всё равно работает — просто не уберём лишнее */
  }
  return plan;
}

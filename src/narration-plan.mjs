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

/** Список файлов прошлой озвучки этого исходника из журнала `.dshow`. */
function readLedger(projectRoot, key) {
  const ledgerPath = path.join(projectRoot, LEDGER);
  let ledger = {};
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) || {};
  } catch {
    ledger = {};
  }
  return { ledgerPath, ledger, previous: Array.isArray(ledger[key]) ? ledger[key] : [] };
}

/** Файлы прошлой озвучки, которых нет в новом плане: только внутри проекта. */
export function staleNarrationFiles(previous, next, root) {
  const projectRoot = root ? path.resolve(root) : '';
  if (!projectRoot) return [];
  const out = [];
  for (const rel of previous || []) {
    if (!rel || next.includes(rel)) continue;
    const abs = path.resolve(projectRoot, rel);
    /* Только внутри проекта и только файлы: чужое не трогаем никогда. */
    if (!abs.startsWith(`${projectRoot}${path.sep}`)) continue;
    out.push({ rel, abs });
  }
  return out;
}

/** Звук, который должен быть настоящим файлом, а не пустышкой. Документы (Word)
 *  проверяем только на существование: docx в пару килобайт — нормальный. */
const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i;
const AUDIO_MIN_BYTES = 1024;

/**
 * Убирает файлы прошлой озвучки — но только когда замена уже на месте.
 *
 * Раньше уборка шла сразу, в момент заявки на файлы: старый MP3 удалялся до
 * того, как новый был записан. Стоило синтезу упасть или заданию отмениться —
 * и в папке проекта не оставалось ничего: человек видел «файла нет» там, где
 * минуту назад была готовая книга. Теперь удаление — отдельный шаг в самом
 * конце: `sweep()` вызывается, когда задание действительно готово. И даже
 * тогда убираются лишь те файлы, чья замена уже лежит на диске с настоящим
 * звуком; иначе не убирается ничего.
 */
export function sweepNarrationFiles(previous, next, { root } = {}) {
  const projectRoot = root ? path.resolve(root) : '';
  const removed = [];
  const kept = [];
  const stale = staleNarrationFiles(previous, next, root);
  if (!stale.length) return { removed, kept };
  /* Замена должна быть на месте: отсутствующий файл или MP3 без звука — не замена. */
  const missing = next.filter((rel) => {
    let size = -1;
    try {
      size = fs.statSync(path.resolve(projectRoot, rel)).size;
    } catch {
      return true;
    }
    return AUDIO_RE.test(rel) && size < AUDIO_MIN_BYTES;
  });
  if (missing.length) return { removed, kept: stale.map((item) => item.rel) };
  for (const item of stale) {
    try {
      if (fs.statSync(item.abs).isFile()) {
        fs.rmSync(item.abs);
        removed.push(item.rel);
      }
    } catch {
      /* файла уже нет — убирать нечего */
    }
  }
  return { removed, kept };
}

/**
 * План файлов плюс отложенная уборка прошлой озвучки того же исходника.
 *
 * Если книга подросла или человек выбрал другую длину части, число частей
 * меняется — и от прошлого раза остаются «часть 13 из 13.mp3» рядом с новыми
 * «часть 13 из 14.mp3». Убираем только то, что создали сами (`.dshow/
 * narration-own.json`), и только по команде `sweep()`, когда новая озвучка уже
 * готова. Возвращаем функцию, а не удаляем сразу: между заявкой и готовым
 * файлом задание может упасть, и тогда стирать старое было бы нечем заменить.
 */
export function claimNarrationFiles(full, total, { root } = {}) {
  const plan = planNarrationFiles(full, total);
  const projectRoot = root ? path.resolve(root) : '';
  if (!projectRoot) return plan;

  const key = path.relative(projectRoot, path.resolve(full)) || path.basename(full);
  const next = [...plan.parts.map((part) => path.relative(projectRoot, part.path)), path.relative(projectRoot, plan.word)];
  const { ledgerPath, ledger, previous } = readLedger(projectRoot, key);

  ledger[key] = next;
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
  } catch {
    /* без списка озвучка всё равно работает — просто не уберём лишнее */
  }
  const sweep = () => sweepNarrationFiles(previous, next, { root: projectRoot });
  return { ...plan, previous, sweep };
}

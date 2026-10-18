/**
 * Короткие ссылки на файлы проекта для внешних приложений.
 *
 * Word/Excel/PowerPoint скачивают файл сами по протоколу ms-word / ms-excel /
 * ms-powerpoint: приложение обращается к адресу без cookie браузера и без
 * заголовков сессии. Поэтому на файл выдаётся отдельная ссылка со своим сроком
 * жизни; постоянный адрес файла и сессия сервиса наружу не попадают.
 *
 * Длина адреса — не косметика. Excel отказывается открыть файл, если путь к нему
 * длиннее 218 знаков, и сообщает «Доступ к файлу невозможен». Поэтому в ссылке нет
 * ни подписи, ни кириллицы в процентном кодировании: только короткий случайный
 * идентификатор (22 знака) и ASCII-имя файла. Соответствие «идентификатор → файл»
 * живёт в памяти сервера и умирает вместе с перезапуском — ссылка и так одноразовая.
 */
import crypto from 'node:crypto';
import path from 'node:path';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TICKETS = 2000;

/** Префикс, по которому маршрутизатор узнаёт ссылки для внешних приложений. */
export const OPEN_PREFIX = '/o/';

const tickets = new Map(); // идентификатор -> { projectId, relPath, expires }

function purge() {
  const now = Date.now();
  for (const [id, ticket] of tickets) if (ticket.expires < now) tickets.delete(id);
  while (tickets.size > MAX_TICKETS) tickets.delete(tickets.keys().next().value);
}

export function issueOpenLink({ projectId, relPath, ttlMs = DEFAULT_TTL_MS }) {
  purge();
  const id = crypto.randomBytes(16).toString('base64url');
  tickets.set(id, {
    projectId: String(projectId),
    relPath: String(relPath),
    expires: Date.now() + ttlMs,
  });
  return id;
}

/** Возвращает { projectId, relPath } или null, если ссылка неизвестна/просрочена. */
export function resolveOpenLink(id) {
  const ticket = tickets.get(String(id || ''));
  if (!ticket) return null;
  if (ticket.expires < Date.now()) {
    tickets.delete(id);
    return null;
  }
  return { projectId: ticket.projectId, relPath: ticket.relPath };
}

/* Кириллица в адресе занимает по шесть знаков на букву (%D0%9A), поэтому имя файла
   для ссылки переводим в латиницу. Excel берёт имя из последнего отрезка адреса —
   так в его заголовке остаётся узнаваемое имя, а не набор процентов. */
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Имя файла без кириллицы и пробелов: до 24 знаков основы плюс расширение. */
export function asciiFileName(name) {
  const original = String(name || '');
  const ext = path.extname(original).toLowerCase();
  const base = ext ? original.slice(0, original.length - ext.length) : original;
  let out = '';
  for (const char of base.toLowerCase()) {
    if (TRANSLIT[char] !== undefined) out += TRANSLIT[char];
    else if (/[a-z0-9]/.test(char)) out += char;
    else if (/[\s_-]/.test(char)) out += '-';
  }
  out = out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32).replace(/-$/, '');
  if (!out) out = 'file';
  return out + ext;
}

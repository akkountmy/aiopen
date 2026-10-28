import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { nowIso, readJson, uid, writeJson } from './util.mjs';
import { minskWallToMs } from './notifyschedule.mjs';

/* Отложенные рассылки уведомлений.
 *
 * Администратор пишет объявление и выбирает не только получателей, но и день с
 * временем. Время вводится по Минску: сервис живёт в Минске, а контейнер — в
 * UTC, поэтому храним готовый ISO-момент, а не «настенные» строки.
 *
 * Записи лежат отдельным файлом в каталоге данных: они обязаны переживать
 * перезапуск контейнера. Статусы:
 *   scheduled — ждёт своего времени;
 *   sending   — отправка уже началась (защита от второго тика);
 *   sent      — ушла хотя бы на одно устройство;
 *   failed    — отправить не удалось (нет получателей, ошибка push-службы);
 *   missed    — время прошло, пока сервис был недоступен дольше суток;
 *   canceled  — отменена администратором.
 */

export const PUSH_SCHEDULE_FILE = path.join(DATA_DIR, 'push-schedule.json');
export const PUSH_SCHEDULE_TZ = 'Europe/Minsk';
/* Если сервис перезапускался и момент прошёл — ещё сутки догоняем расписание.
   Позже объявление уже неактуально: честнее показать «пропущено». */
export const PUSH_LATE_LIMIT_MS = 24 * 60 * 60 * 1000;
/* Дальше года вперёд планировать нечего: почти наверняка это опечатка в годе. */
export const PUSH_MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
/* Минимальный запас: пока админ нажмёт «Запланировать», минута успеет пройти. */
export const PUSH_MIN_AHEAD_MS = 30 * 1000;
const MAX_ITEMS = 120;
const MAX_HISTORY = 40;
const SENDING_STALE_MS = 5 * 60 * 1000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const STATUSES = new Set(['scheduled', 'sending', 'sent', 'failed', 'missed', 'canceled']);

const cleanText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function cleanDate(value) {
  const match = DATE_RE.exec(String(value || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function cleanTime(value) {
  const match = TIME_RE.exec(String(value || '').trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Время в Минске (дата + ЧЧ:ММ) → UTC-миллисекунды. */
export function pushSendAtMs(date, time) {
  const day = cleanDate(date);
  const clock = cleanTime(time);
  if (!day || !clock) return null;
  return minskWallToMs(day.year, day.month, day.day, clock.hour, clock.minute);
}

export function readPushSchedule() {
  const raw = readJson(PUSH_SCHEDULE_FILE, null);
  const list = Array.isArray(raw?.items) ? raw.items : [];
  const items = [];
  for (const value of list) {
    if (!value || typeof value !== 'object') continue;
    const id = String(value.id || '');
    const sendAt = Date.parse(value.sendAt);
    if (!id || !Number.isFinite(sendAt)) continue;
    const status = STATUSES.has(value.status) ? value.status : 'scheduled';
    items.push({
      id,
      title: cleanText(value.title).slice(0, 80),
      text: String(value.text ?? '').trim().slice(0, 300),
      all: value.all === true,
      userIds: [...new Set((Array.isArray(value.userIds) ? value.userIds : []).map(String).filter(Boolean))],
      sendAt: new Date(sendAt).toISOString(),
      createdAt: value.createdAt || null,
      createdBy: value.createdBy || null,
      status,
      startedAt: value.startedAt || null,
      sentAt: value.sentAt || null,
      canceledAt: value.canceledAt || null,
      canceledBy: value.canceledBy || null,
      result: value.result && typeof value.result === 'object' ? value.result : null,
      skipped: Number(value.skipped) || 0,
      error: value.error ? String(value.error).slice(0, 300) : null,
    });
  }
  return items;
}

function writePushSchedule(items) {
  /* Плановые записи не выбрасываем никогда; историю подрезаем, чтобы файл не
     рос бесконечно. Сортируем по времени отправки — так проще читать. */
  const scheduled = items.filter((item) => item.status === 'scheduled' || item.status === 'sending');
  const history = items
    .filter((item) => !scheduled.includes(item))
    .sort((a, b) => Date.parse(b.sentAt || b.canceledAt || b.sendAt) - Date.parse(a.sentAt || a.canceledAt || a.sendAt))
    .slice(0, MAX_HISTORY);
  const trimmed = [...scheduled, ...history]
    .sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt))
    .slice(0, MAX_ITEMS);
  writeJson(PUSH_SCHEDULE_FILE, { version: 1, items: trimmed });
  return trimmed;
}

function publicView(item) {
  return { ...item };
}

/** Список для панели: сначала ближайшие, потом недавняя история. */
export function listPushSchedule(nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  const items = readPushSchedule();
  const pending = items
    .filter((item) => item.status === 'scheduled' || item.status === 'sending')
    .sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt));
  const history = items
    .filter((item) => item.status !== 'scheduled' && item.status !== 'sending')
    .sort((a, b) => Date.parse(b.sentAt || b.canceledAt || b.sendAt) - Date.parse(a.sentAt || a.canceledAt || a.sendAt))
    .slice(0, 8);
  const next = pending[0] || null;
  return {
    items: [...pending, ...history].map(publicView),
    pending: pending.length,
    nextAt: next ? next.sendAt : null,
    tz: PUSH_SCHEDULE_TZ,
    now: new Date(now).toISOString(),
  };
}

/** Строгая проверка: ошибку надо показать администратору, а не проглотить. */
export function createPushSchedule(input, { createdBy = '', now = nowIso() } = {}) {
  const body = input && typeof input === 'object' ? input : {};
  const title = cleanText(body.title);
  if (!title) throw new Error('Укажите заголовок уведомления');
  if (title.length > 80) throw new Error('Заголовок длиннее 80 символов');
  const text = String(body.text ?? body.body ?? '').trim();
  if (!text) throw new Error('Укажите текст уведомления');
  if (text.length > 300) throw new Error('Текст длиннее 300 символов');

  const all = body.all === true;
  const userIds = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(String).filter(Boolean))];
  if (!all && !userIds.length) {
    throw new Error('Отметьте хотя бы одного получателя');
  }

  const sendAt = pushSendAtMs(body.date, body.time);
  if (sendAt === null) {
    throw new Error('Укажите дату и время отправки');
  }
  const nowMs = Date.parse(now) || Date.now();
  if (sendAt <= nowMs) {
    throw new Error('Время отправки уже прошло — выберите более позднее');
  }
  if (sendAt < nowMs + PUSH_MIN_AHEAD_MS) {
    throw new Error('До отправки меньше 30 секунд — выберите время на минуту позже');
  }
  if (sendAt > nowMs + PUSH_MAX_AHEAD_MS) {
    throw new Error('Дата дальше чем на год — выберите ближайшую');
  }

  const item = {
    id: uid('ps_'),
    title,
    text,
    all,
    userIds: all ? [] : userIds,
    sendAt: new Date(sendAt).toISOString(),
    createdAt: now,
    createdBy: String(createdBy || '').slice(0, 80) || null,
    status: 'scheduled',
    startedAt: null,
    sentAt: null,
    canceledAt: null,
    canceledBy: null,
    result: null,
    skipped: 0,
    error: null,
  };
  const items = readPushSchedule();
  items.push(item);
  writePushSchedule(items);
  return publicView(item);
}

/** Отмена — только пока рассылка ждёт. Отправленную отменить нельзя. */
export function cancelPushSchedule(id, { by = '', now = nowIso() } = {}) {
  const wanted = String(id || '').trim();
  if (!wanted) throw new Error('Рассылка не найдена');
  const items = readPushSchedule();
  const item = items.find((entry) => entry.id === wanted);
  if (!item) throw new Error('Рассылка не найдена');
  if (item.status !== 'scheduled') {
    throw new Error('Эту рассылку уже нельзя отменить');
  }
  item.status = 'canceled';
  item.canceledAt = now;
  item.canceledBy = String(by || '').slice(0, 80) || null;
  writePushSchedule(items);
  return publicView(item);
}

/** Забираем запись в работу: второй тик её уже не увидит. */
export function claimPushSchedule(id, { now = nowIso() } = {}) {
  const items = readPushSchedule();
  const item = items.find((entry) => entry.id === id);
  if (!item || item.status !== 'scheduled') return null;
  item.status = 'sending';
  item.startedAt = now;
  writePushSchedule(items);
  return publicView(item);
}

/** Итог отправки. Ошибка сохраняется рядом с результатом — её видно в панели. */
export function finishPushSchedule(id, patch = {}) {
  const items = readPushSchedule();
  const item = items.find((entry) => entry.id === id);
  if (!item) return null;
  const status = STATUSES.has(patch.status) ? patch.status : 'failed';
  item.status = status;
  item.sentAt = patch.sentAt || null;
  item.result = patch.result || null;
  item.skipped = Number(patch.skipped) || 0;
  item.error = patch.error ? String(patch.error).slice(0, 300) : null;
  writePushSchedule(items);
  return publicView(item);
}

/** Что пора отправлять. Поздние записи тоже возвращаем — решение принимает тик. */
export function duePushSchedule(nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  return readPushSchedule()
    .filter((item) => item.status === 'scheduled' && Date.parse(item.sendAt) <= now)
    .sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt));
}

/* После падения контейнера запись могла остаться в «sending», хотя отправка не
   завершилась. Помечаем такие честно неудачными, чтобы они не зависли навсегда. */
export function recoverPushSchedule(nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  const items = readPushSchedule();
  let changed = 0;
  for (const item of items) {
    if (item.status !== 'sending') continue;
    const started = Date.parse(item.startedAt || item.sendAt) || 0;
    if (now - started < SENDING_STALE_MS) continue;
    item.status = 'failed';
    item.error = 'Отправка прервана перезапуском сервиса';
    changed += 1;
  }
  if (changed) writePushSchedule(items);
  return changed;
}

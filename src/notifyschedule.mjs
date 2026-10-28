import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { nowIso, readJson, writeJson } from './util.mjs';

/* Когда показывать окно «Узнай о новых возможностях DSH Open».
 *
 * Расписание задаёт администратор в панели, а не жёсткий код: сервис живёт в
 * Минске, и ночью будить человека вопросом об уведомлениях незачем. Три
 * режима:
 *   immediate — сразу после регистрации (как было раньше, по умолчанию);
 *   delay     — через N минут после регистрации;
 *   time      — в заданное время суток (Europe/Minsk), ближайшее наступление.
 *
 * Время хранится отдельным файлом в каталоге данных: оно общее для всех
 * пользователей и должно переживать перезапуск контейнера.
 */

export const NOTIFY_SCHEDULE_TZ = 'Europe/Minsk';
export const NOTIFY_SCHEDULE_FILE = path.join(DATA_DIR, 'notify-schedule.json');
export const NOTIFY_SCHEDULE_MODES = ['immediate', 'delay', 'time'];

const DEFAULTS = Object.freeze({ mode: 'immediate', time: '10:00', delayMinutes: 60 });
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN_DELAY = 1;
const MAX_DELAY = 7 * 24 * 60;

/* Intl с h23: полночь приходит как «00», а не «24» — иначе 00:15 уезжало бы
   на сутки вперёд. */
const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: NOTIFY_SCHEDULE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function zonedParts(ms) {
  const out = {};
  for (const part of partsFormat.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

/* Обратный перевод «настенное время в Минске → UTC». Смещение узнаём у Intl,
   а не считаем вручную: при смене правил часового пояса расчёт останется
   верным. Двух итераций хватает, третья — страховка. */
function zonedToUtc(year, month, day, hour, minute) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let index = 0; index < 3; index += 1) {
    const parts = zonedParts(guess);
    const seen = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const diff = target - seen;
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

/** Настенное время Минска → UTC-миллисекунды. Нужно и отложенным рассылкам. */
export function minskWallToMs(year, month, day, hour, minute) {
  return zonedToUtc(year, month, day, hour, minute);
}

function dayShift(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function parseNotifyTime(value) {
  const match = TIME_RE.exec(String(value || '').trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function cleanDelay(value, fallback = DEFAULTS.delayMinutes) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_DELAY, Math.max(MIN_DELAY, number));
}

/** Настройки с безопасными значениями: испорченный файл не должен ломать регистрацию. */
export function readNotifySchedule() {
  const raw = readJson(NOTIFY_SCHEDULE_FILE, null);
  const value = raw && typeof raw === 'object' ? raw : {};
  const mode = NOTIFY_SCHEDULE_MODES.includes(value.mode) ? value.mode : DEFAULTS.mode;
  const time = parseNotifyTime(value.time) ? String(value.time).trim() : DEFAULTS.time;
  return {
    mode,
    time,
    delayMinutes: cleanDelay(value.delayMinutes),
    updatedAt: value.updatedAt || null,
    updatedBy: value.updatedBy || null,
  };
}

/** Первое окно после регистрации: учитывает и задержку, и время суток. */
export function firstNotifyMs(nowMs, schedule = readNotifySchedule()) {
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return Date.now();
  if (schedule.mode === 'delay') return now + cleanDelay(schedule.delayMinutes) * 60000;
  if (schedule.mode === 'time') {
    const clock = parseNotifyTime(schedule.time) || parseNotifyTime(DEFAULTS.time);
    const parts = zonedParts(now);
    let at = zonedToUtc(parts.year, parts.month, parts.day, clock.hour, clock.minute);
    if (at <= now) {
      const next = dayShift(parts, 1);
      at = zonedToUtc(next.year, next.month, next.day, clock.hour, clock.minute);
    }
    return at;
  }
  return now;
}

/* Повторное напоминание (через месяц или три) ставим на тот же календарный
   день, но в настроенное время суток. Задержку «через N минут» второй раз не
   прибавляем: она относится к регистрации, а не к каждому повтору. */
export function alignNotifyMs(baseMs, schedule = readNotifySchedule()) {
  const base = Number(baseMs);
  if (!Number.isFinite(base)) return Date.now();
  if (schedule.mode !== 'time') return base;
  const clock = parseNotifyTime(schedule.time) || parseNotifyTime(DEFAULTS.time);
  const parts = zonedParts(base);
  return zonedToUtc(parts.year, parts.month, parts.day, clock.hour, clock.minute);
}

export function notifySchedulePreview(ms) {
  return new Date(ms).toLocaleString('ru-RU', {
    timeZone: NOTIFY_SCHEDULE_TZ,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** То, что видит панель администратора. */
export function notifyScheduleView(nowMs = Date.now()) {
  const schedule = readNotifySchedule();
  const next = firstNotifyMs(nowMs, schedule);
  return {
    ...schedule,
    tz: NOTIFY_SCHEDULE_TZ,
    nextAt: new Date(next).toISOString(),
    preview: notifySchedulePreview(next),
  };
}

/** Строгая проверка ввода: ошибку надо показать администратору, а не молча затереть. */
export function saveNotifySchedule(input, { updatedBy = '', now = nowIso() } = {}) {
  const body = input && typeof input === 'object' ? input : {};
  const mode = String(body.mode || '');
  if (!NOTIFY_SCHEDULE_MODES.includes(mode)) {
    throw new Error('Выберите, когда отправлять напоминание');
  }
  const rawTime = String(body.time ?? DEFAULTS.time).trim();
  if (!parseNotifyTime(rawTime)) {
    throw new Error('Время укажите в формате ЧЧ:ММ');
  }
  const delayMinutes = cleanDelay(body.delayMinutes);
  if (mode === 'delay') {
    const requested = Number(body.delayMinutes);
    if (!Number.isFinite(requested) || requested < MIN_DELAY || requested > MAX_DELAY) {
      throw new Error('Задержка должна быть от 1 минуты до 7 дней');
    }
  }
  const schedule = {
    mode,
    time: rawTime,
    delayMinutes,
    updatedAt: now,
    updatedBy: String(updatedBy || '').slice(0, 80) || null,
  };
  writeJson(NOTIFY_SCHEDULE_FILE, schedule);
  return notifyScheduleView(Date.parse(now) || Date.now());
}

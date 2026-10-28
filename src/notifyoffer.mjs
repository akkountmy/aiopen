import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { nowIso, readJson, writeJson } from './util.mjs';

/* Напоминание о включении уведомлений после регистрации.
 *
 * Расписание живёт на сервере, а не в localStorage: человек может зайти с
 * другого устройства или почистить хранилище браузера, а месяцы ожидания
 * должны остаться. Одна запись на пользователя, потому что это не настройка
 * устройства, а решение человека: включить уведомления или отложить.
 *
 * Этапы:
 *   1 — сразу после регистрации;
 *   2 — через месяц после первого «Отложить»;
 *   3 — через три месяца после второго «Отложить».
 * Третье «Отложить» (или закрытие третьего окна) выключает напоминания.
 */

const OFFERS_FILE = path.join(DATA_DIR, 'notify-offers.json');

export const NOTIFY_OFFER_STAGES = 3;

/** Календарные месяцы, а не 30 дней: «через месяц» не должно съезжать. */
export function addMonths(iso, months) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.getUTCDate();
  /* Переводим на первое число, чтобы 31 января + месяц не стало 3 марта. */
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

function readOffers() {
  const value = readJson(OFFERS_FILE, []);
  return Array.isArray(value) ? value : [];
}

function writeOffers(offers) {
  writeJson(OFFERS_FILE, offers);
}

function findOffer(offers, userId) {
  return offers.find((item) => item && item.userId === userId) || null;
}

function due(item, nowMs) {
  if (!item) return false;
  if (item.status === 'due') return true;
  if (item.status !== 'scheduled') return false;
  const at = Date.parse(item.dueAt || '');
  return Number.isFinite(at) && at <= nowMs;
}

/** То, что можно отдать браузеру: без служебных полей и чужих данных. */
export function offerView(item, nowMs = Date.now()) {
  if (!item) return { eligible: false, show: false, status: 'none', stage: 0 };
  return {
    eligible: true,
    show: due(item, nowMs),
    status: item.status,
    stage: Number(item.stage) || 1,
    dueAt: item.dueAt || null,
    nextAt: item.status === 'scheduled' ? item.dueAt || null : null,
    postponed: Math.max(0, (Number(item.stage) || 1) - 1),
    enabledAt: item.enabledAt || null,
    createdAt: item.createdAt || null,
  };
}

export function notifyOfferState(userId, nowMs = Date.now()) {
  if (!userId) return offerView(null);
  return offerView(findOffer(readOffers(), userId), nowMs);
}

/** Вызывается только при самостоятельной регистрации. */
export function createNotifyOffer(userId, { now = nowIso() } = {}) {
  if (!userId) return offerView(null);
  const offers = readOffers();
  let item = findOffer(offers, userId);
  if (!item) {
    item = {
      userId,
      status: 'due',
      stage: 1,
      dueAt: now,
      createdAt: now,
      updatedAt: now,
      shownCount: 0,
      postponedCount: 0,
    };
    offers.push(item);
    writeOffers(offers);
  }
  return offerView(item);
}

/** Клиент отметил, что окно действительно показано. На расписание не влияет. */
export function markNotifyOfferShown(userId, { now = nowIso() } = {}) {
  const offers = readOffers();
  const item = findOffer(offers, userId);
  if (!item) return offerView(null);
  item.lastShownAt = now;
  item.shownCount = (Number(item.shownCount) || 0) + 1;
  item.updatedAt = now;
  writeOffers(offers);
  return offerView(item);
}

/**
 * «Отложить». Первый раз — через календарный месяц, второй — через три.
 * Третий раз останавливает напоминания совсем.
 */
export function postponeNotifyOffer(userId, { now = nowIso() } = {}) {
  const offers = readOffers();
  const item = findOffer(offers, userId);
  if (!item) return offerView(null);
  if (item.status === 'enabled' || item.status === 'stopped' || item.status === 'denied') {
    return offerView(item);
  }
  const stage = Number(item.stage) || 1;
  item.postponedCount = (Number(item.postponedCount) || 0) + 1;
  item.lastPostponedAt = now;
  if (stage >= NOTIFY_OFFER_STAGES) {
    item.status = 'stopped';
    item.stoppedAt = now;
    item.dueAt = null;
  } else {
    item.stage = stage + 1;
    item.status = 'scheduled';
    /* После первого напоминания — месяц, после второго — три месяца. */
    item.dueAt = addMonths(now, stage === 1 ? 1 : 3);
  }
  item.updatedAt = now;
  writeOffers(offers);
  return offerView(item, Date.parse(now));
}

/** «Включить»: разрешение уже получено (или включено в настройках браузера). */
export function enableNotifyOffer(userId, { now = nowIso(), deviceId = '' } = {}) {
  const offers = readOffers();
  const item = findOffer(offers, userId);
  if (!item) return offerView(null);
  item.status = 'enabled';
  item.enabledAt = now;
  item.enabledDeviceId = deviceId ? String(deviceId).slice(0, 120) : null;
  item.dueAt = null;
  item.updatedAt = now;
  writeOffers(offers);
  return offerView(item);
}

/** Браузер запретил уведомления — повторять запрос бессмысленно. */
export function denyNotifyOffer(userId, { now = nowIso(), reason = 'denied' } = {}) {
  const offers = readOffers();
  const item = findOffer(offers, userId);
  if (!item) return offerView(null);
  item.status = reason === 'unsupported' ? 'unsupported' : 'denied';
  item.stoppedAt = now;
  item.dueAt = null;
  item.updatedAt = now;
  writeOffers(offers);
  return offerView(item);
}

/** Только для проверок: убрать записи конкретного пользователя. */
export function resetNotifyOffer(userId) {
  const offers = readOffers().filter((item) => item && item.userId !== userId);
  writeOffers(offers);
}

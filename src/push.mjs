import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { DATA_DIR } from './config.mjs';
import { readJson, writeJson, uid, nowIso } from './util.mjs';

/**
 * Пуш-уведомления в ярлык-приложение (PWA).
 *
 * Работает через стандартный Web Push: сервер подписывает сообщение ключами
 * VAPID и отправляет его в push-службу браузера, а сервис-воркер показывает
 * уведомление. Ключи и подписки устройств лежат в /data — это смонтированный
 * том, поэтому они переживают перезапуск контейнера и обновления сервиса.
 *
 * Как только ключи VAPID поменяются, старые подписки перестают приниматься,
 * но устройства переподписываются сами при следующем открытии приложения.
 * Поэтому ключи создаются один раз и больше не пересоздаются.
 */

const VAPID_FILE = path.join(DATA_DIR, 'push-vapid.json');
const SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
/* Одно устройство — одна подписка. Больше десятка на аккаунт не держим:
   старые телефоны и ноутбуки иначе копят уведомления и занимают файл. */
const MAX_SUBS_PER_USER = 10;

let vapidCache = null;

function ensureVapid() {
  if (vapidCache) return vapidCache;
  let saved = readJson(VAPID_FILE, null);
  if (!saved?.publicKey || !saved?.privateKey) {
    saved = webpush.generateVAPIDKeys();
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(VAPID_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
    } catch (error) {
      console.warn('[push] не удалось сохранить ключи VAPID:', error?.message || error);
    }
  }
  /* Адрес отправителя нужен, чтобы push-служба могла связаться с владельцем
     приложения: почта или ссылка на сервис. Настраивается переменной окружения. */
  const subject = process.env.DSHOW_PUSH_SUBJECT || 'mailto:admin@dshopen.tech';
  webpush.setVapidDetails(subject, saved.publicKey, saved.privateKey);
  vapidCache = saved;
  return saved;
}

function loadSubs() {
  const list = readJson(SUBS_FILE, []);
  return Array.isArray(list) ? list.filter((item) => item && item.endpoint) : [];
}

function saveSubs(list) {
  writeJson(SUBS_FILE, list);
}

/* Подписка приходит из браузера: endpoint, p256dh и auth. Проверяем всё, что
   попадёт в файл, потому что дальше эти поля уходят в push-службу. */
function normalize(input) {
  const endpoint = String(input?.endpoint || '').trim();
  const p256dh = String(input?.keys?.p256dh || '').trim();
  const auth = String(input?.keys?.auth || '').trim();
  if (!/^https:\/\/[^\s]+$/i.test(endpoint)) return null;
  if (!/^[A-Za-z0-9_-]{16,}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,}$/.test(auth)) return null;
  return {
    endpoint,
    keys: { p256dh, auth },
    expirationTime: Number.isFinite(input?.expirationTime) ? input.expirationTime : null,
  };
}

function shortUa(value) {
  const text = String(value || '');
  if (!text) return '';
  const platform = /Android/i.test(text)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(text)
      ? 'iOS'
      : /Windows/i.test(text)
        ? 'Windows'
        : /Mac OS X|Macintosh/i.test(text)
          ? 'macOS'
          : /Linux/i.test(text)
            ? 'Linux'
            : '';
  const browser = /YaBrowser/i.test(text)
    ? 'Yandex'
    : /Edg\//i.test(text)
      ? 'Edge'
      : /OPR\//i.test(text)
        ? 'Opera'
        : /Firefox/i.test(text)
          ? 'Firefox'
          : /Chrome|CriOS/i.test(text)
            ? 'Chrome'
            : /Safari/i.test(text)
              ? 'Safari'
              : '';
  return [browser, platform].filter(Boolean).join('/') || text.slice(0, 40);
}

export function pushState(userId) {
  const vapid = ensureVapid();
  const mine = loadSubs().filter((item) => item.userId === userId);
  return {
    publicKey: vapid.publicKey,
    subscriptions: mine.length,
    devices: mine.map((item) => ({ id: item.id, device: item.device || '', addedAt: item.addedAt || null })),
  };
}

export function subscribe(user, input, ua = '') {
  const subscription = normalize(input);
  if (!subscription) return { ok: false, error: 'Подписка устройства не распознана — попробуйте ещё раз' };
  const list = loadSubs();
  const known = list.find((item) => item.endpoint === subscription.endpoint);
  if (known) {
    /* Это устройство уже было подписано: обновляем владельца и ключи, чтобы
       после смены пароля или повторного входа уведомления не терялись. */
    known.userId = user.id;
    known.keys = subscription.keys;
    known.device = shortUa(ua);
    known.expirationTime = subscription.expirationTime;
    known.updatedAt = nowIso();
  } else {
    list.push({
      id: uid('push_'),
      userId: user.id,
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      expirationTime: subscription.expirationTime,
      device: shortUa(ua),
      addedAt: nowIso(),
      updatedAt: nowIso(),
      fails: 0,
    });
  }
  const mine = list.filter((item) => item.userId === user.id);
  if (mine.length > MAX_SUBS_PER_USER) {
    const extra = new Set(mine.slice(0, mine.length - MAX_SUBS_PER_USER).map((item) => item.id));
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (extra.has(list[index].id)) list.splice(index, 1);
    }
  }
  saveSubs(list);
  return { ok: true, subscriptions: Math.min(mine.length, MAX_SUBS_PER_USER) };
}

export function unsubscribe(user, endpoint) {
  const wanted = String(endpoint || '').trim();
  if (!wanted) return { ok: false, error: 'Не указано устройство' };
  const list = loadSubs();
  const kept = list.filter((item) => !(item.endpoint === wanted && item.userId === user.id));
  if (kept.length !== list.length) saveSubs(kept);
  return { ok: true, subscriptions: kept.filter((item) => item.userId === user.id).length };
}

/* Устройство могло быть удалено пользователем или системой самого телефона:
   чистим такие записи, чтобы не копить мёртвые подписки. */
export function forgetUser(userId) {
  const list = loadSubs();
  const kept = list.filter((item) => item.userId !== userId);
  if (kept.length !== list.length) saveSubs(kept);
}

/**
 * Отправка на список подписок. Ошибка одного устройства не мешает остальным.
 * Ответ 404/410/403 означает, что подписка больше не существует
 * (переустановили приложение, отозвали разрешение) — её убираем сразу.
 */
async function deliver(subs, payload) {
  const mine = subs;
  if (!mine.length) return { sent: 0, failed: 0, total: 0 };
  ensureVapid();
  const body = JSON.stringify(payload || {});
  let sent = 0;
  let failed = 0;
  const dead = [];
  await Promise.all(
    mine.map(async (item) => {
      try {
        await webpush.sendNotification({ endpoint: item.endpoint, keys: item.keys }, body, {
          TTL: 3600,
          urgency: 'high',
        });
        sent += 1;
        item.lastOkAt = nowIso();
        item.fails = 0;
      } catch (error) {
        const status = Number(error?.statusCode) || 0;
        failed += 1;
        item.fails = (item.fails || 0) + 1;
        item.lastError = `${status} ${String(error?.body || error?.message || '')}`.slice(0, 180);
        if (status === 404 || status === 410 || status === 403) dead.push(item.endpoint);
        else console.warn(`[push] устройство не приняло уведомление: ${status} ${item.lastError}`);
      }
    }),
  );
  const fresh = loadSubs();
  for (const item of fresh) {
    const updated = mine.find((candidate) => candidate.id === item.id);
    if (updated) {
      item.lastOkAt = updated.lastOkAt;
      item.lastError = updated.lastError;
      item.fails = updated.fails;
    }
  }
  saveSubs(fresh.filter((item) => !dead.includes(item.endpoint)));
  return { sent, failed, total: mine.length };
}

/** Отправка всем устройствам одного пользователя. */
export async function pushToUser(userId, payload) {
  return deliver(
    loadSubs().filter((item) => item.userId === userId),
    payload,
  );
}

/**
 * Кому можно писать: пользователи, у которых есть хотя бы одно подключённое
 * устройство. Нужно администратору для рассылки — он видит, у кого
 * уведомления действительно включены, а у кого их просто некуда слать.
 */
export function pushTargets() {
  const counts = new Map();
  let total = 0;
  for (const item of loadSubs()) {
    total += 1;
    counts.set(item.userId, (counts.get(item.userId) || 0) + 1);
  }
  return {
    total,
    users: [...counts.entries()].map(([userId, devices]) => ({ userId, devices })),
  };
}

/**
 * Рассылка нескольким пользователям сразу (объявление о новой функции и
 * подобное). Устройства отправляются параллельно; ответ — сколько дошло,
 * сколько нет и скольким людям вообще было куда писать.
 */
export async function pushToUsers(userIds, payload) {
  const wanted = new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String));
  const subs = loadSubs().filter((item) => wanted.has(item.userId));
  const result = await deliver(subs, payload);
  const people = new Set(subs.map((item) => item.userId));
  return { ...result, users: people.size };
}

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
 * Кроме подписок сервер помнит состояние каждого устройства: выдал ли браузер
 * разрешение на уведомления и есть ли живая подписка. Без этого администратор
 * видел только тех, кому можно писать, и не понимал, у кого уведомления
 * выключены на самом устройстве.
 */

const VAPID_FILE = path.join(DATA_DIR, 'push-vapid.json');
const SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const DEVICES_FILE = path.join(DATA_DIR, 'push-devices.json');
/* Одно устройство — одна подписка. Больше десятка на аккаунт не держим:
   старые телефоны и ноутбуки иначе копят уведомления и занимают файл. */
const MAX_SUBS_PER_USER = 10;
/* Отчётов о состоянии может быть чуть больше, чем подписок: сюда попадают и
   устройства, где браузер запретил уведомления. */
const MAX_DEVICES_PER_USER = 20;

const PERMISSIONS = new Set(['granted', 'denied', 'default', 'unsupported']);
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

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

function loadDevices() {
  const list = readJson(DEVICES_FILE, []);
  return Array.isArray(list) ? list.filter((item) => item && item.userId && item.deviceId) : [];
}

function saveDevices(list) {
  writeJson(DEVICES_FILE, list);
}

/* Куда вообще может уходить push-запрос: только известные службы доставки.
   Подписку присылает браузер, но повторить её может любой клиент, а сервер
   потом сам делает на этот адрес POST — без списка доменов это готовый канал
   в локальную сеть и в служебные адреса. */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'wns.windows.com',
  'push.apple.com',
  'web.push.apple.com',
];

function allowedPushEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/* Подписка приходит из браузера: endpoint, p256dh и auth. Проверяем всё, что
   попадёт в файл, потому что дальше эти поля уходят в push-службу. */
function normalize(input) {
  const endpoint = String(input?.endpoint || '').trim();
  const p256dh = String(input?.keys?.p256dh || '').trim();
  const auth = String(input?.keys?.auth || '').trim();
  if (!/^https:\/\/[^\s]+$/i.test(endpoint)) return null;
  if (!allowedPushEndpoint(endpoint)) return null;
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

function validDeviceId(value) {
  const id = String(value || '').trim();
  return DEVICE_ID_RE.test(id) ? id : '';
}

/* Статус устройства:
   on             — разрешение выдано и подписка живая, уведомления придут;
   off            — браузер запретил уведомления;
   pending        — разрешение ещё не спрашивали (браузер ждёт действия человека);
   no-subscription— разрешение есть, но подписка на этом устройстве не оформилась;
   unsupported    — браузер вообще не умеет web push. */
function deviceStatus(permission, hasSubscription) {
  if (hasSubscription && permission === 'granted') return 'on';
  if (permission === 'denied') return 'off';
  if (permission === 'default') return 'pending';
  if (permission === 'granted') return 'no-subscription';
  if (permission === 'unsupported') return 'unsupported';
  if (hasSubscription) return 'on';
  return 'unknown';
}

function accountOf(user) {
  return {
    userId: String(user.id || user.userId || ''),
    username: user.username || '',
    displayName: user.displayName || user.username || '',
    role: user.role || 'user',
    lastLoginAt: user.lastLoginAt || null,
  };
}

/* Собирает по каждому человеку его устройства: живые подписки, отчёты браузера
   и понятный итог. Устройства без отчёта (старые подписки) считаем включёнными:
   подписка есть — значит, разрешение когда-то было выдано. */
function collect(users = []) {
  const subs = loadSubs();
  const reports = loadDevices();
  const accounts = new Map();

  const remember = (userId, source = {}) => {
    if (!userId) return null;
    let account = accounts.get(userId);
    if (!account) {
      const known = users.find((item) => String(item.id || item.userId || '') === String(userId));
      account = {
        ...(known ? accountOf(known) : { userId, username: '', displayName: '', role: 'user', lastLoginAt: null }),
        deviceList: [],
      };
      accounts.set(account.userId, account);
    }
    if (source.username && !account.username) account.username = source.username;
    if (source.displayName && !account.displayName) account.displayName = source.displayName;
    if (source.lastLoginAt && !account.lastLoginAt) account.lastLoginAt = source.lastLoginAt;
    return account;
  };

  for (const user of users) remember(String(user.id || user.userId || ''), user);

  const usedSubs = new Set();
  for (const report of reports) {
    const account = remember(report.userId);
    if (!account) continue;
    const sub = subs.find(
      (item) => item.userId === report.userId && item.deviceId && item.deviceId === report.deviceId,
    );
    if (sub) usedSubs.add(sub.id);
    const status = deviceStatus(report.permission, Boolean(sub));
    account.deviceList.push({
      id: report.id,
      device: report.device || 'Устройство',
      status,
      permission: PERMISSIONS.has(report.permission) ? report.permission : 'unknown',
      app: Boolean(report.app),
      addedAt: report.addedAt || report.updatedAt || null,
      lastSeenAt: report.lastSeenAt || report.updatedAt || null,
      /** Подписка живая и разрешение выдано — сюда действительно дойдёт. */
      enabled: status === 'on',
    });
  }

  for (const sub of subs) {
    if (usedSubs.has(sub.id)) continue;
    const account = remember(sub.userId);
    if (!account) continue;
    account.deviceList.push({
      id: sub.id,
      device: sub.device || 'Устройство',
      status: 'on',
      permission: 'granted',
      app: Boolean(sub.app),
      addedAt: sub.addedAt || null,
      lastSeenAt: sub.lastOkAt || sub.updatedAt || sub.addedAt || null,
      enabled: true,
    });
  }

  const list = [];
  let devicesEnabled = 0;
  let devicesDisabled = 0;
  let devicesPending = 0;
  for (const account of accounts.values()) {
    const enabled = account.deviceList.filter((device) => device.status === 'on').length;
    const disabled = account.deviceList.filter((device) => device.status === 'off').length;
    const noSub = account.deviceList.filter((device) => device.status === 'no-subscription').length;
    const pending = account.deviceList.filter((device) => device.status === 'pending').length;
    const unsupported = account.deviceList.filter((device) => device.status === 'unsupported').length;
    let status = 'unknown';
    if (enabled) status = 'on';
    else if (disabled) status = 'off';
    else if (noSub) status = 'no-subscription';
    else if (pending) status = 'pending';
    else if (unsupported) status = 'unsupported';
    /* Для сортировки и списка получателей важна именно доставляемость. */
    const devices = enabled;
    devicesEnabled += enabled;
    devicesDisabled += disabled;
    devicesPending += pending;
    account.deviceList.sort((a, b) => {
      const rank = { on: 0, 'no-subscription': 1, pending: 2, off: 3, unsupported: 4, unknown: 5 };
      return (rank[a.status] ?? 5) - (rank[b.status] ?? 5);
    });
    account.enabled = enabled;
    account.disabled = disabled;
    account.noSub = noSub;
    account.pending = pending;
    account.unsupported = unsupported;
    account.status = status;
    /* devices — число адресов, куда реально уйдёт сообщение. */
    account.devices = devices;
    list.push(account);
  }

  const priority = { on: 0, pending: 1, off: 2, unsupported: 3, unknown: 4 };
  list.sort(
    (a, b) =>
      (priority[a.status] ?? 4) - (priority[b.status] ?? 4) ||
      String(a.displayName || a.username).localeCompare(String(b.displayName || b.username), 'ru'),
  );

  const summary = {
    users: list.length,
    withEnabled: list.filter((item) => item.enabled > 0).length,
    offOnly: list.filter((item) => item.enabled === 0 && item.disabled > 0).length,
    noSubOnly: list.filter(
      (item) => item.enabled === 0 && item.disabled === 0 && item.noSub > 0,
    ).length,
    pendingOnly: list.filter(
      (item) => item.enabled === 0 && item.disabled === 0 && item.noSub === 0 && item.pending > 0,
    ).length,
    unsupportedOnly: list.filter(
      (item) => item.enabled === 0 && item.disabled === 0 && item.pending === 0 && item.unsupported > 0,
    ).length,
    noData: list.filter((item) => !item.deviceList.length).length,
    devicesEnabled,
    devicesDisabled,
    devicesPending,
  };

  return { users: list, summary, total: devicesEnabled };
}

export function pushState(userId) {
  const vapid = ensureVapid();
  const mine = loadSubs().filter((item) => item.userId === userId);
  const reports = loadDevices().filter((item) => item.userId === userId);
  const byDevice = new Map(reports.map((item) => [item.deviceId, item]));
  return {
    publicKey: vapid.publicKey,
    subscriptions: mine.length,
    devices: mine.map((item) => {
      const report = item.deviceId ? byDevice.get(item.deviceId) : null;
      return {
        id: item.id,
        device: item.device || '',
        addedAt: item.addedAt || null,
        permission: report?.permission || 'granted',
      };
    }),
  };
}

/* Браузер присылает состояние сам: даже если разрешение запрещено, сервер
   должен знать, что устройство существует и почему уведомления не придут. */
export function reportDevice(user, input = {}, ua = '') {
  const deviceId = validDeviceId(input.deviceId);
  if (!deviceId) return { ok: false, error: 'Не распознано устройство' };
  const permission = PERMISSIONS.has(String(input.permission)) ? String(input.permission) : 'unknown';
  const subscribed = Boolean(input.subscribed);
  const list = loadDevices();
  const now = nowIso();
  const known = list.find((item) => item.userId === user.id && item.deviceId === deviceId);
  if (known) {
    known.permission = permission;
    known.subscribed = subscribed;
    known.app = Boolean(input.app);
    known.device = shortUa(ua) || known.device || 'Устройство';
    known.lastSeenAt = now;
    known.updatedAt = now;
  } else {
    list.push({
      id: uid('pushdev_'),
      userId: user.id,
      deviceId,
      permission,
      subscribed,
      app: Boolean(input.app),
      device: shortUa(ua) || 'Устройство',
      addedAt: now,
      updatedAt: now,
      lastSeenAt: now,
    });
  }
  const mine = list.filter((item) => item.userId === user.id);
  if (mine.length > MAX_DEVICES_PER_USER) {
    const extra = new Set(mine.slice(0, mine.length - MAX_DEVICES_PER_USER).map((item) => item.id));
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (extra.has(list[index].id)) list.splice(index, 1);
    }
  }
  saveDevices(list);

  /* Если браузер запретил уведомления, старая подписка этого устройства уже
     не покажет сообщение. Убираем её сразу, чтобы рассылка не считала адрес
     живым и не ждала ошибку push-службы. */
  if (permission !== 'granted') {
    const subs = loadSubs();
    const kept = subs.filter((item) => !(item.userId === user.id && item.deviceId === deviceId));
    if (kept.length !== subs.length) saveSubs(kept);
  }
  return { ok: true, permission, subscribed };
}

export function subscribe(user, input, ua = '', options = {}) {
  const subscription = normalize(input);
  if (!subscription) return { ok: false, error: 'Подписка устройства не распознана — попробуйте ещё раз' };
  const deviceId = validDeviceId(options.deviceId);
  let list = loadSubs();
  /* Браузер может пересоздать подписку с новым адресом. Старый адрес этого же
     устройства убираем сразу: иначе в списке появится второе «устройство», а
     рассылка будет писать в мёртвую push-службу. */
  if (deviceId) {
    list = list.filter(
      (item) => !(item.userId === user.id && item.deviceId === deviceId && item.endpoint !== subscription.endpoint),
    );
  }
  const known = list.find((item) => item.endpoint === subscription.endpoint);
  if (known) {
    /* Это устройство уже было подписано: обновляем владельца и ключи, чтобы
       после смены пароля или повторного входа уведомления не терялись. */
    known.userId = user.id;
    known.keys = subscription.keys;
    known.device = shortUa(ua) || known.device;
    if (deviceId) known.deviceId = deviceId;
    known.app = Boolean(options.app);
    known.expirationTime = subscription.expirationTime;
    known.updatedAt = nowIso();
  } else {
    list.push({
      id: uid('push_'),
      userId: user.id,
      ...(deviceId ? { deviceId } : {}),
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      expirationTime: subscription.expirationTime,
      device: shortUa(ua),
      app: Boolean(options.app),
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
   чистим такие записи, чтобы не копить мёртвые подписки и отчёты. */
export function forgetUser(userId) {
  const subs = loadSubs();
  const keptSubs = subs.filter((item) => item.userId !== userId);
  if (keptSubs.length !== subs.length) saveSubs(keptSubs);
  const devices = loadDevices();
  const keptDevices = devices.filter((item) => item.userId !== userId);
  if (keptDevices.length !== devices.length) saveDevices(keptDevices);
}

/**
 * Отправка на список подписок. Ошибка одного устройства не мешает остальным.
 * Ответ 404/410/403 означает, что подписка больше не существует
 * (переустановили приложение, отозвали разрешение) — её убираем сразу.
 */
async function deliver(subs, payload) {
  /* Подписка могла остаться, а разрешение на устройстве уже отозвано. Такие
     адреса не считаем живыми: отчёт браузера главнее старой записи. */
  const blocked = new Set(
    loadDevices()
      .filter((item) => item.permission !== 'granted')
      .map((item) => `${item.userId}\u0000${item.deviceId}`),
  );
  const mine = subs.filter((item) => !item.deviceId || !blocked.has(`${item.userId}\u0000${item.deviceId}`));
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
 * Кому можно писать и у кого уведомления выключены. Администратору нужен не
 * просто список подписок, а картина по людям и устройствам: браузер запретил,
 * разрешение ещё не спрашивали, приложение ни разу не открывали.
 */
export function pushTargets(users = []) {
  const result = collect(users);
  return {
    total: result.total,
    people: result.users.filter((item) => item.enabled > 0).length,
    users: result.users,
    summary: result.summary,
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

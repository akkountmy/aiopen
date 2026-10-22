/* Рассылка уведомлений из админки: кто имеет право, что проверяется,
   скольким людям и устройствам уходит сообщение.
   Запуск: DSHOW_BASE=… node test/push-broadcast.mjs (сервер уже слушает). */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = process.env.PUSH_BASE || 'http://127.0.0.1:3141';
const ADMIN = process.env.PUSH_USER || 'DSH';
const ADMIN_PASS = process.env.PUSH_PASS || 'test-only-pass-123';
const DATA = path.resolve(process.env.PUSH_DATA || '.tmp/push-data');

let failures = 0;

function check(label, ok, extra = '') {
  if (ok) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.log(`FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

/* Каждый вход — своя печенька: админ и обычный пользователь проверяются врозь. */
function session() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async call(method, url, body, { auth = true } = {}) {
      const headers = { 'Content-Type': 'application/json' };
      if (auth && cookie) headers.Cookie = cookie;
      const res = await fetch(`${BASE}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      for (const line of res.headers.getSetCookie?.() || []) {
        const pair = line.split(';')[0];
        if (pair.includes('session')) cookie = pair;
      }
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    },
  };
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeSubscription(tag) {
  return {
    endpoint: `https://127.0.0.1:65530/push/${tag}`,
    keys: { p256dh: b64url(crypto.randomBytes(65)), auth: b64url(crypto.randomBytes(16)) },
    expirationTime: null,
  };
}

const admin = session();
const viewer = session();
const viewerName = `broadcast-${Date.now().toString(36)}`;
const viewerPass = 'viewer-pass-12345';

const adminLogin = await admin.call('POST', '/api/login', { username: ADMIN, password: ADMIN_PASS }, { auth: false });
check('вход администратора', adminLogin.status === 200, `HTTP ${adminLogin.status}`);

const created = await admin.call('POST', '/api/admin/users', { username: viewerName, password: viewerPass });
check('создан получатель', created.status === 200 && created.json?.user?.id, `HTTP ${created.status} ${created.text.slice(0, 160)}`);
const viewerId = created.json?.user?.id;

const viewerLogin = await viewer.call('POST', '/api/login', { username: viewerName, password: viewerPass }, { auth: false });
check('вход получателя', viewerLogin.status === 200, `HTTP ${viewerLogin.status}`);

/* 1. Права: обычный пользователь к рассылке не допускается. */
const viewerTargets = await viewer.call('GET', '/api/admin/push');
check('обычному пользователю список получателей закрыт', viewerTargets.status === 403, `HTTP ${viewerTargets.status}`);
const viewerSend = await viewer.call('POST', '/api/admin/push', { all: true, title: 'x', text: 'y' });
check('обычный пользователь не может разослать', viewerSend.status === 403, `HTTP ${viewerSend.status}`);

const anonSend = await session().call('POST', '/api/admin/push', { all: true, title: 'x', text: 'y' }, { auth: false });
check('без входа рассылка закрыта', anonSend.status === 401 || anonSend.status === 403, `HTTP ${anonSend.status}`);

/* 2. Состояние устройства: сервер должен видеть не только подписки, но и
   запрет браузера, и ещё не выданное разрешение. */
const DEVICE = 'viewer-device-key-123';
const anonReport = await session().call(
  'POST',
  '/api/push/report',
  { deviceId: DEVICE, permission: 'denied', subscribed: false },
  { auth: false },
);
check('без входа отчёт устройства закрыт', anonReport.status === 401 || anonReport.status === 403, `HTTP ${anonReport.status}`);
const badReport = await viewer.call('POST', '/api/push/report', { deviceId: '!', permission: 'denied' });
check('кривой ключ устройства → 400', badReport.status === 400, `HTTP ${badReport.status}`);

const denied = await viewer.call('POST', '/api/push/report', {
  deviceId: DEVICE,
  permission: 'denied',
  subscribed: false,
});
check('запрет уведомлений принят', denied.status === 200 && denied.json?.ok === true, `HTTP ${denied.status}`);
const deniedView = await admin.call('GET', '/api/admin/push');
const deniedUser = deniedView.json?.users?.find((item) => item.userId === viewerId);
check('выключенное устройство видно администратору', deniedUser?.status === 'off' && deniedUser?.devices === 0);
check('выключенное устройство не считается получателем', deniedView.json?.total === 0);
check('выключенные посчитаны в сводке', Number(deniedView.json?.summary?.offOnly) >= 1);

const pending = await viewer.call('POST', '/api/push/report', {
  deviceId: DEVICE,
  permission: 'default',
  subscribed: false,
});
check('ожидание разрешения принято', pending.status === 200);
const pendingView = await admin.call('GET', '/api/admin/push');
const pendingUser = pendingView.json?.users?.find((item) => item.userId === viewerId);
check('ожидание разрешения видно администратору', pendingUser?.status === 'pending' && pendingUser?.devices === 0);
check('ожидающие посчитаны в сводке', Number(pendingView.json?.summary?.pendingOnly) >= 1);

const noSubReport = await viewer.call('POST', '/api/push/report', {
  deviceId: DEVICE,
  permission: 'granted',
  subscribed: false,
});
check('разрешение без подписки принято', noSubReport.status === 200);
const noSubView = await admin.call('GET', '/api/admin/push');
const noSubUser = noSubView.json?.users?.find((item) => item.userId === viewerId);
check('разрешение без подписки видно отдельно', noSubUser?.status === 'no-subscription' && noSubUser?.devices === 0);
check('«нет подписки» посчитано в сводке', Number(noSubView.json?.summary?.noSubOnly) >= 1);

/* 3. Пока устройств нет — отправлять некому. */
const noneYet = await admin.call('POST', '/api/admin/push', { all: true, title: 'Новинка', text: 'Анонс функции' });
check('без подписок рассылка отклонена', noneYet.status === 409, `HTTP ${noneYet.status} ${noneYet.text.slice(0, 120)}`);

const sub = fakeSubscription('viewer-device');
const subscribed = await viewer.call('POST', '/api/push/subscribe', { subscription: sub, deviceId: DEVICE });
check('получатель подключил устройство', subscribed.status === 200 && subscribed.json?.subscriptions === 1);

/* Браузер пересоздал подписку: старый адрес того же устройства заменяется,
   а не превращается во второе устройство. */
const sub2 = fakeSubscription('viewer-device-2');
const resubscribed = await viewer.call('POST', '/api/push/subscribe', { subscription: sub2, deviceId: DEVICE });
check('пересозданная подписка заменила старую', resubscribed.status === 200 && resubscribed.json?.subscriptions === 1);

const granted = await viewer.call('POST', '/api/push/report', {
  deviceId: DEVICE,
  permission: 'granted',
  subscribed: true,
});
check('включённое устройство отмечено', granted.status === 200 && granted.json?.permission === 'granted');

const targets = await admin.call('GET', '/api/admin/push');
const everyone = await admin.call('GET', '/api/admin/users');
const userCount = everyone.json?.users?.length || 0;
check('список получателей отдан', targets.status === 200 && targets.json?.total === 1, `HTTP ${targets.status}`);
check('получатель виден с устройствами', targets.json?.users?.some((item) => item.userId === viewerId && item.devices === 1));
const detail = targets.json?.users?.find((item) => item.userId === viewerId)?.deviceList?.[0];
check('разрешение и статус устройства отданы', detail?.permission === 'granted' && detail?.status === 'on');
check('включённые посчитаны в сводке', Number(targets.json?.summary?.withEnabled) >= 1 && Number(targets.json?.summary?.devicesEnabled) === 1);

/* 4. Проверки текста. */
const noTitle = await admin.call('POST', '/api/admin/push', { all: true, title: '   ', text: 'текст' });
check('пустой заголовок → 400', noTitle.status === 400, `HTTP ${noTitle.status}`);
const longTitle = await admin.call('POST', '/api/admin/push', { all: true, title: 'я'.repeat(81), text: 'текст' });
check('длинный заголовок → 400', longTitle.status === 400, `HTTP ${longTitle.status}`);
const noText = await admin.call('POST', '/api/admin/push', { all: true, title: 'Заголовок', text: '  ' });
check('пустой текст → 400', noText.status === 400, `HTTP ${noText.status}`);
const longText = await admin.call('POST', '/api/admin/push', { all: true, title: 'Заголовок', text: 'я'.repeat(301) });
check('длинный текст → 400', longText.status === 400, `HTTP ${longText.status}`);

/* 5. Рассылка всем: адрес доставляется, но фальшивое устройство не примет. */const broadcast = await admin.call('POST', '/api/admin/push', {
  all: true,
  title: 'Новая функция: напоминания',
  text: 'Включите напоминания в настройках диалога.',
});
check('рассылка всем принята', broadcast.status === 200, `HTTP ${broadcast.status} ${broadcast.text.slice(0, 160)}`);
check('устройство получателя учтено', broadcast.json?.total === 1 && broadcast.json?.users === 1);
check('недоставка видна в отчёте', broadcast.json?.sent === 0 && broadcast.json?.failed === 1);
check('пользователи без устройств посчитаны', broadcast.json?.skipped === userCount - 1, `${broadcast.json?.skipped} / ${userCount}`);

/* 6. Выбранным: только адресат из списка. */
const selected = await admin.call('POST', '/api/admin/push', {
  all: false,
  userIds: [viewerId],
  title: 'Только вам',
  text: 'Персональный анонс.',
});
check('рассылка выбранному принята', selected.status === 200 && selected.json?.users === 1, `HTTP ${selected.status}`);

const nobody = await admin.call('POST', '/api/admin/push', { all: false, userIds: [], title: 'Никому', text: 'Текст' });
check('пустой выбор → 409', nobody.status === 409, `HTTP ${nobody.status}`);

const unknown = await admin.call('POST', '/api/admin/push', {
  all: false,
  userIds: ['нет-такого-id'],
  title: 'Мимо',
  text: 'Текст',
});
check('неизвестный получатель → 409', unknown.status === 409, `HTTP ${unknown.status}`);

/* 7. Подписка не испортилась: после попыток доставки устройство на месте. */
const targetsAfter = await admin.call('GET', '/api/admin/push');
check('устройство осталось в списке', targetsAfter.json?.total === 1);
const state = await viewer.call('GET', '/api/push/state');
check('получатель по-прежнему подключён', state.json?.subscriptions === 1);

/* 8. Разрешение отозвали на устройстве: подписка убирается, человек остаётся
   в списке с понятным статусом «выключены», а не пропадает из админки. */
const revoked = await viewer.call('POST', '/api/push/report', {
  deviceId: DEVICE,
  permission: 'denied',
  subscribed: false,
});
check('отзыв разрешения принят', revoked.status === 200);
const revokedView = await admin.call('GET', '/api/admin/push');
const revokedUser = revokedView.json?.users?.find((item) => item.userId === viewerId);
check('человек остался в списке со статусом «выключены»', revokedUser?.status === 'off' && revokedUser?.devices === 0);
check('мёртвая подписка больше не считается получателем', revokedView.json?.total === 0);
const revokedState = await viewer.call('GET', '/api/push/state');
check('подписка отозванного устройства удалена', revokedState.json?.subscriptions === 0);

/* За собой убираем: удалить тестового пользователя и его отчёты. */
const cleanup = await admin.call('DELETE', `/api/admin/users/${viewerId}`);
check('тестовый пользователь удалён', cleanup.status === 200, `HTTP ${cleanup.status}`);

const after = await admin.call('GET', '/api/admin/push');
check('после уборки устройств нет', after.json?.total === 0);
check('файл подписок не остался в данных', !fs.existsSync(path.join(DATA, 'push-subscriptions.json')) || JSON.parse(fs.readFileSync(path.join(DATA, 'push-subscriptions.json'), 'utf8')).length === 0);
const devicesLeft = fs.existsSync(path.join(DATA, 'push-devices.json'))
  ? JSON.parse(fs.readFileSync(path.join(DATA, 'push-devices.json'), 'utf8')).filter((item) => item.userId === viewerId)
  : [];
check('отчёты устройства удалены вместе с пользователем', devicesLeft.length === 0);

console.log(failures ? `\n${failures} проверок провалено` : '\nвсе проверки прошли');
process.exitCode = failures ? 1 : 0;

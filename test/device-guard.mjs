/* Проверка правила «один аккаунт — один компьютер и один телефон» и
   предупреждений о передаче пароля. Тест поднимает настоящий сервер на
   свободном порту во временной папке данных, поэтому рабочие данные и Telegram
   не затрагиваются.

   Что проверяем:
   - вход с ноутбука и вход с телефона живут одновременно;
   - ярлык-приложение на телефоне — отдельная полка: компьютер, вкладка
     телефона и ярлык работают одновременно, не выбивая друг друга;
   - второй вход с того же класса устройства закрывает прежний сеанс этого
     класса, но не трогает сеанс другого класса;
   - планшет с настольным User-Agent (iPadOS) попадает в телефонную полку
     благодаря Client Hint Sec-CH-UA-Mobile;
   - правило то же, что и раньше, для выбитых сеансов: пометка «displaced»,
     запись в историю входов и предупреждение администратору.

   Запуск: node test/device-guard.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3288);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-device-'));

const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DESKTOP_OTHER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
/* iPadOS 13+ присылает настольный User-Agent: класс виден только по Client Hint. */
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

const env = {
  ...process.env,
  DSHOW_HOST: '127.0.0.1',
  DSHOW_PORT: String(PORT),
  DSHOW_DATA_DIR: dataDir,
  DSHOW_ADMIN_USER: 'tester',
  DSHOW_ADMIN_PASSWORD: 'Test12345',
  /* Порог занижен специально: двух классов устройств достаточно для предупреждения. */
  DSHOW_ALERT_DEVICES: '2',
  DSHOW_ALERT_IPS: '2',
  DSHOW_ALERT_DISPLACED: '1',
  DSHOW_TG_TOKEN: '',
  DSHOW_TG_CHAT: '',
  DSHOW_DEEPSEEK_KEY: '',
  OPENROUTER_API_KEY: '',
};

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (chunk) => { log += chunk.toString(); });
server.stderr.on('data', (chunk) => { log += chunk.toString(); });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* сервер ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function cookieValue(response, name) {
  const headers = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  for (const header of headers) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return '';
}

async function call(pathname, { method = 'GET', body, cookie, ua = DESKTOP } = {}) {
  const init = { method, headers: { 'user-agent': ua } };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${pathname}`, init);
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return {
    status: response.status,
    data,
    session: cookieValue(response, 'dshow_session'),
    device: cookieValue(response, 'dshow_device'),
    raw: response,
  };
}

async function login(ua, deviceCookie = '', extraHeaders = {}) {
  const headers = { 'content-type': 'application/json', 'user-agent': ua, ...extraHeaders };
  if (deviceCookie) headers.cookie = `dshow_device=${deviceCookie}`;
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'tester', password: 'Test12345' }),
  });
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  return {
    status: response.status,
    data,
    session: cookieValue(response, 'dshow_session'),
    device: cookieValue(response, 'dshow_device') || deviceCookie,
  };
}

const asCookie = (session) => `dshow_session=${session}`;

function sessionsInState() {
  const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
  return Object.values(index.sessions || {});
}

function auditEvents() {
  const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
  return Object.values(index.loginAudit || {})[0]?.events || [];
}

try {
  if (!(await waitReady())) throw new Error('сервер не поднялся');
  check('сервер отвечает /api/health', true);

  const health = await call('/api/health');
  const slots = health.data.sessions || {};
  check(
    'разрешено по одному сеансу на компьютер, телефон и ярлык',
    slots.desktop === 1 && slots.mobile === 1 && slots.app === 1,
    `desktop=${slots.desktop}, mobile=${slots.mobile}, app=${slots.app}`,
  );

  /* --- компьютер и телефон одновременно --- */
  const desktop = await login(DESKTOP);
  check('вход с компьютера успешен', desktop.status === 200, `HTTP ${desktop.status}`);
  check('выдан сеанс', Boolean(desktop.session));
  check('выдана метка устройства', Boolean(desktop.device));

  const phone = await login(IPHONE);
  check('вход с телефона успешен', phone.status === 200, `HTTP ${phone.status}`);
  check('телефон получил свой сеанс', Boolean(phone.session) && phone.session !== desktop.session);

  const deskMe = await call('/api/me', { cookie: asCookie(desktop.session) });
  check('сеанс компьютера продолжает работать', deskMe.status === 200, `HTTP ${deskMe.status}`);
  const phoneMe = await call('/api/me', { cookie: asCookie(phone.session) });
  check('сеанс телефона работает', phoneMe.status === 200, `HTTP ${phoneMe.status}`);

  const both = sessionsInState();
  check('в памяти два активных сеанса', both.length === 2, `сеансов: ${both.length}`);
  const kinds = both.map((item) => item.kind).sort().join(',');
  check('классы устройств записаны', kinds === 'desktop,mobile', kinds);

  /* --- второй компьютер закрывает только компьютер --- */
  const desktop2 = await login(DESKTOP_OTHER);
  check('второй вход с компьютера успешен', desktop2.status === 200, `HTTP ${desktop2.status}`);
  const deskOld = await call('/api/me', { cookie: asCookie(desktop.session) });
  check('прежний сеанс компьютера закрыт', deskOld.status === 401, `HTTP ${deskOld.status}`);
  check('закрытый сеанс объясняет причину', deskOld.data.reason === 'displaced', String(deskOld.data.reason || ''));
  const phoneAlive = await call('/api/me', { cookie: asCookie(phone.session) });
  check('телефон не выбит вторым компьютером', phoneAlive.status === 200, `HTTP ${phoneAlive.status}`);

  /* --- второй телефон закрывает только телефон --- */
  const phone2 = await login(ANDROID);
  check('второй вход с телефона успешен', phone2.status === 200, `HTTP ${phone2.status}`);
  const phoneOld = await call('/api/me', { cookie: asCookie(phone.session) });
  check('прежний сеанс телефона закрыт', phoneOld.status === 401, `HTTP ${phoneOld.status}`);
  check('телефон тоже получает пометку displaced', phoneOld.data.reason === 'displaced', String(phoneOld.data.reason || ''));
  const deskAlive = await call('/api/me', { cookie: asCookie(desktop2.session) });
  check('компьютер не выбит вторым телефоном', deskAlive.status === 200, `HTTP ${deskAlive.status}`);

  const stillTwo = sessionsInState();
  check('сеансов по-прежнему два', stillTwo.length === 2, `сеансов: ${stillTwo.length}`);

  /* --- планшет с настольным User-Agent попадает в телефонную полку --- */
  const tablet = await login(IPAD_UA, '', { 'sec-ch-ua-mobile': '?1' });
  check('вход с планшета успешен', tablet.status === 200, `HTTP ${tablet.status}`);
  const androidKilled = await call('/api/me', { cookie: asCookie(phone2.session) });
  check('планшет выбил телефон, а не компьютер', androidKilled.status === 401, `HTTP ${androidKilled.status}`);
  const deskAfterTablet = await call('/api/me', { cookie: asCookie(desktop2.session) });
  check('компьютер пережил вход с планшета', deskAfterTablet.status === 200, `HTTP ${deskAfterTablet.status}`);

  /* --- ярлык-приложение на телефоне: третья полка --- */
  const shortcut = await login(IPHONE, '', { 'x-dshow-display': 'standalone' });
  check('вход из ярлыка-приложения успешен', shortcut.status === 200, `HTTP ${shortcut.status}`);
  check('ярлык получил отдельный сеанс', Boolean(shortcut.session) && shortcut.session !== tablet.session);
  const kindsNow = sessionsInState().map((item) => item.kind).sort().join(',');
  check('три полки: компьютер, телефон, ярлык', kindsNow === 'app,desktop,mobile', kindsNow);
  const tabletAfterApp = await call('/api/me', { cookie: asCookie(tablet.session) });
  check('вход из ярлыка не выбивает вкладку телефона', tabletAfterApp.status === 200, `HTTP ${tabletAfterApp.status}`);
  const deskAfterApp = await call('/api/me', { cookie: asCookie(desktop2.session) });
  check('вход из ярлыка не выбивает компьютер', deskAfterApp.status === 200, `HTTP ${deskAfterApp.status}`);
  const appMe = await call('/api/me', { cookie: asCookie(shortcut.session) });
  check('сеанс ярлыка работает', appMe.status === 200, `HTTP ${appMe.status}`);

  /* --- второй ярлык закрывает только ярлык --- */
  const shortcut2 = await login(IPHONE, '', { 'x-dshow-display': 'standalone' });
  check('второй вход из ярлыка успешен', shortcut2.status === 200, `HTTP ${shortcut2.status}`);
  const shortcutOld = await call('/api/me', { cookie: asCookie(shortcut.session) });
  check('прежний сеанс ярлыка закрыт вторым ярлыком', shortcutOld.status === 401, `HTTP ${shortcutOld.status}`);
  const tabletAlive = await call('/api/me', { cookie: asCookie(tablet.session) });
  check('второй ярлык не тронул вкладку телефона', tabletAlive.status === 200, `HTTP ${tabletAlive.status}`);
  const deskAlive2 = await call('/api/me', { cookie: asCookie(desktop2.session) });
  check('второй ярлык не тронул компьютер', deskAlive2.status === 200, `HTTP ${deskAlive2.status}`);
  const finalKinds = sessionsInState().map((item) => item.kind).sort().join(',');
  check('после второго ярлыка снова три сеанса', finalKinds === 'app,desktop,mobile', finalKinds);

  /* --- история входов и предупреждение администратору --- */
  const events = auditEvents();
  check('история входов записана', events.length >= 5, `событий: ${events.length}`);
  check('видны все три класса устройств', new Set(events.map((item) => item.kind)).size === 3);
  check('разные метки устройств сохранены', new Set(events.map((item) => item.device)).size >= 4);
  check('зафиксировано выбивание сеансов', events.some((item) => item.displaced >= 1));
  check('сработало предупреждение администратору', /\[guard\] подозрение/.test(log));
  check('сообщение ушло в канал уведомлений', /\[notify\]/.test(log));

  /* --- выход не считается выбиванием --- */
  const bye = await login(DESKTOP);
  await call('/api/logout', { method: 'POST', cookie: asCookie(bye.session) });
  const afterLogout = await call('/api/me', { cookie: asCookie(bye.session) });
  check('после выхода сеанс не считается выбитым', afterLogout.status === 401 && afterLogout.data.reason === undefined);

  /* --- знакомое устройство не добавляет новое --- */
  const devicesBefore = new Set(auditEvents().map((item) => item.device)).size;
  const known = await login(DESKTOP, desktop2.device);
  check('вход с прежней меткой устройства успешен', known.status === 200, `HTTP ${known.status}`);
  check('метка устройства сохраняется', known.device === desktop2.device);
  const devicesAfter = new Set(auditEvents().map((item) => item.device)).size;
  check(
    'знакомая машина не добавила новое устройство',
    devicesAfter === devicesBefore,
    `было ${devicesBefore}, стало ${devicesAfter}`,
  );
} catch (error) {
  check('тест выполнился без исключений', false, String(error?.message || error));
} finally {
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(dataDir, { recursive: true, force: true });
  const failed = results.filter((item) => !item.ok);
  console.log(`\nИтог: ${results.length - failed.length}/${results.length} проверок пройдено`);
  process.exitCode = failed.length ? 1 : 0;
}

/* Проверка правил входа под одним ником и предупреждений о передаче пароля.
   Тест поднимает настоящий сервер на свободном порту во временной папке данных,
   поэтому рабочие данные и Telegram не затрагиваются.

   Что проверяем:
   - число одновременных устройств не ограничено: ноутбук, браузер телефона,
     ярлык-приложение и планшет живут одновременно и никто никого не выбивает;
   - повторный вход с той же машины (та же метка dshow_device) закрывает свой
     прежний сеанс молча, без пометки «вас выбили» и без потери чужих сеансов;
   - выбитых сеансов нет, поэтому и повода для тревоги «выбили» не возникает,
     а история входов и предупреждение о частых устройствах продолжают работать;
   - классы устройств (компьютер, телефон, ярлык) по-прежнему записываются;
   - выход не считается выбиванием, а знакомая машина не добавляет устройство.

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
  /* Мест не считаем: фиксируем явно, что потолка нет (0 — без ограничений). */
  DSHOW_SESSIONS_MAX: '0',
  /* Порог занижен специально: одного выбивания достаточно для предупреждения. */
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* сервер ещё поднимается */
    }
    await sleep(100);
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

function state() {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
}

function sessionsInState() {
  return Object.values(state().sessions || {});
}

function auditEvents() {
  return Object.values(state().loginAudit || {})[0]?.events || [];
}

try {
  if (!(await waitReady())) throw new Error('сервер не поднялся');
  check('сервер отвечает /api/health', true);

  const health = await call('/api/health');
  check(
    'число одновременных устройств не ограничено',
    health.data.sessions?.max === 0 && health.data.sessions?.unlimited === true,
    JSON.stringify(health.data.sessions || {}),
  );

  /* --- ноутбук, телефон и ярлык: все сразу, никто никого не выбивает --- */
  const laptop = await login(DESKTOP);
  check('вход с ноутбука успешен', laptop.status === 200, `HTTP ${laptop.status}`);
  check('выдан сеанс', Boolean(laptop.session));
  check('выдана метка устройства', Boolean(laptop.device));

  const phone = await login(IPHONE);
  check('вход с телефона успешен', phone.status === 200, `HTTP ${phone.status}`);
  check('телефон получил свой сеанс', Boolean(phone.session) && phone.session !== laptop.session);

  const shortcut = await login(IPHONE, '', { 'x-dshow-display': 'standalone' });
  check('вход из ярлыка-приложения успешен', shortcut.status === 200, `HTTP ${shortcut.status}`);
  check('ярлык получил отдельный сеанс', Boolean(shortcut.session) && shortcut.session !== phone.session);

  const laptopMe = await call('/api/me', { cookie: asCookie(laptop.session) });
  const phoneMe = await call('/api/me', { cookie: asCookie(phone.session) });
  const appMe = await call('/api/me', { cookie: asCookie(shortcut.session) });
  check(
    'все три устройства работают одновременно',
    laptopMe.status === 200 && phoneMe.status === 200 && appMe.status === 200,
    `ноутбук ${laptopMe.status}, телефон ${phoneMe.status}, ярлык ${appMe.status}`,
  );

  const three = sessionsInState();
  check('в памяти ровно три сеанса', three.length === 3, `сеансов: ${three.length}`);
  const kinds = three.map((item) => item.kind).sort().join(',');
  check('классы устройств записаны', kinds === 'app,desktop,mobile', kinds);

  /* --- четвёртое устройство: мест не считаем, никто не уступает --- */
  await sleep(30);
  await call('/api/me', { cookie: asCookie(phone.session) });
  await call('/api/me', { cookie: asCookie(shortcut.session) });
  await sleep(30);
  const tablet = await login(IPAD_UA, '', { 'sec-ch-ua-mobile': '?1' });
  check('вход с четвёртого устройства успешен', tablet.status === 200, `HTTP ${tablet.status}`);

  const laptopStays = await call('/api/me', { cookie: asCookie(laptop.session) });
  check('давний сеанс не выбит четвёртым входом', laptopStays.status === 200, `HTTP ${laptopStays.status}`);
  check('пометки «вас выбили» нет', laptopStays.data.reason === undefined, String(laptopStays.data.reason || 'нет пометки'));
  const phoneAfter = await call('/api/me', { cookie: asCookie(phone.session) });
  const shortcutAfter = await call('/api/me', { cookie: asCookie(shortcut.session) });
  const tabletMe = await call('/api/me', { cookie: asCookie(tablet.session) });
  check(
    'все четыре устройства работают одновременно',
    phoneAfter.status === 200 && shortcutAfter.status === 200 && tabletMe.status === 200,
    `телефон ${phoneAfter.status}, ярлык ${shortcutAfter.status}, планшет ${tabletMe.status}`,
  );
  check('сеансов стало четыре — потолка нет', sessionsInState().length === 4, `сеансов: ${sessionsInState().length}`);

  /* --- повторный вход с той же машины: молча, без потери чужих мест --- */
  const phoneAgain = await login(ANDROID, phone.device);
  check('повторный вход с того же телефона успешен', phoneAgain.status === 200, `HTTP ${phoneAgain.status}`);
  const phoneOld = await call('/api/me', { cookie: asCookie(phone.session) });
  check('прежний сеанс этой же машины закрыт', phoneOld.status === 401, `HTTP ${phoneOld.status}`);
  check(
    'своя же машина не пугает пометкой «вас выбили»',
    phoneOld.data.reason === undefined,
    String(phoneOld.data.reason || 'нет пометки'),
  );
  const othersAlive = await Promise.all([
    call('/api/me', { cookie: asCookie(shortcut.session) }),
    call('/api/me', { cookie: asCookie(tablet.session) }),
    call('/api/me', { cookie: asCookie(phoneAgain.session) }),
  ]);
  check(
    'повторный вход не занял чужое место',
    othersAlive.every((item) => item.status === 200),
    othersAlive.map((item) => item.status).join(','),
  );

  /* --- история входов и предупреждение администратору --- */
  const events = auditEvents();
  check('история входов записана', events.length >= 4, `событий: ${events.length}`);
  check('видны все три класса устройств', new Set(events.map((item) => item.kind)).size === 3);
  check('разные метки устройств сохранены', new Set(events.map((item) => item.device)).size >= 3);
  check('выбитых сеансов нет', !events.some((item) => item.displaced >= 1));
  check('сработало предупреждение администратору', /\[guard\] подозрение/.test(log));
  check('сообщение ушло в канал уведомлений', /\[notify\]/.test(log));

  /* --- выход не считается выбиванием --- */
  const bye = await login(DESKTOP);
  await call('/api/logout', { method: 'POST', cookie: asCookie(bye.session) });
  const afterLogout = await call('/api/me', { cookie: asCookie(bye.session) });
  check('после выхода сеанс не считается выбитым', afterLogout.status === 401 && afterLogout.data.reason === undefined);

  /* --- знакомое устройство не добавляет новое --- */
  const devicesBefore = new Set(auditEvents().map((item) => item.device)).size;
  const known = await login(DESKTOP, phoneAgain.device);
  check('вход с прежней меткой устройства успешен', known.status === 200, `HTTP ${known.status}`);
  check('метка устройства сохраняется', known.device === phoneAgain.device);
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
  await sleep(200);
  fs.rmSync(dataDir, { recursive: true, force: true });
  const failed = results.filter((item) => !item.ok);
  console.log(`\nИтог: ${results.length - failed.length}/${results.length} проверок пройдено`);
  process.exitCode = failed.length ? 1 : 0;
}

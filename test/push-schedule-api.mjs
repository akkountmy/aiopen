/* API отложенных рассылок: администратор ставит объявление на дату и время,
   видит его в списке и может отменить до отправки. Поднимаем настоящий сервер
   во временной папке; фоновый тик выключаем, чтобы он не мешал проверкам.

   Запуск: node test/push-schedule-api.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3294);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-push-schedule-api-'));

const env = {
  ...process.env,
  DSHOW_HOST: '127.0.0.1',
  DSHOW_PORT: String(PORT),
  DSHOW_DATA_DIR: dataDir,
  DSHOW_ADMIN_USER: 'tester',
  DSHOW_ADMIN_PASSWORD: 'Test12345',
  DSHOW_OPEN_SIGNUP: '0',
  DSHOW_PUSH_SCHEDULE: '0',
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
  results.push({ name, ok });
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

function cookieFrom(response, name) {
  const headers = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  for (const header of headers) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (match) return `${name}=${decodeURIComponent(match[1])}`;
  }
  return '';
}

async function call(pathname, { method = 'GET', body, cookie } = {}) {
  const init = { method, headers: {} };
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
    data = { raw: text };
  }
  return { status: response.status, data, response };
}

/* Дата в Минске через N дней; время фиксированное — оно всё равно в будущем. */
function minskDayAfter(days) {
  const at = new Date(Date.now() + days * 86400000);
  const parts = {};
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  for (const part of formatter.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function main() {
  if (!(await waitReady())) {
    console.error('Сервер не поднялся');
    console.error(log);
    process.exitCode = 1;
    return;
  }

  const guest = await call('/api/admin/push/schedule');
  check('список закрыт от гостя', guest.status === 401, `HTTP ${guest.status}`);
  const guestCreate = await call('/api/admin/push/schedule', {
    method: 'POST',
    body: { title: 'x', text: 'y', all: true, date: minskDayAfter(2), time: '12:00' },
  });
  check('постановка в расписание закрыта от гостя', guestCreate.status === 401, `HTTP ${guestCreate.status}`);

  const login = await call('/api/login', {
    method: 'POST',
    body: { username: 'tester', password: 'Test12345' },
  });
  const cookie = cookieFrom(login.response, 'dshow_session');
  check('вход администратора', login.status === 200 && cookie, `HTTP ${login.status}`);

  const initial = await call('/api/admin/push/schedule', { cookie });
  check(
    'пустой список и минский пояс',
    initial.status === 200 && Array.isArray(initial.data.items) && initial.data.items.length === 0 &&
      initial.data.tz === 'Europe/Minsk',
    `HTTP ${initial.status}`,
  );

  const noTitle = await call('/api/admin/push/schedule', {
    method: 'POST',
    cookie,
    body: { text: 'y', all: true, date: minskDayAfter(2), time: '12:00' },
  });
  check('без заголовка → 400', noTitle.status === 400, `HTTP ${noTitle.status}`);

  const past = await call('/api/admin/push/schedule', {
    method: 'POST',
    cookie,
    body: { title: 'x', text: 'y', all: true, date: '2020-01-01', time: '12:00' },
  });
  check('прошедшая дата → 400', past.status === 400, `HTTP ${past.status} ${past.data?.error}`);

  const noAudience = await call('/api/admin/push/schedule', {
    method: 'POST',
    cookie,
    body: { title: 'x', text: 'y', all: false, userIds: ['нет-такого'], date: minskDayAfter(2), time: '12:00' },
  });
  check('неизвестный получатель → 400', noAudience.status === 400, `HTTP ${noAudience.status}`);

  const day = minskDayAfter(2);
  const created = await call('/api/admin/push/schedule', {
    method: 'POST',
    cookie,
    body: { title: 'Новая функция', text: 'Скоро расскажем', all: true, date: day, time: '18:30' },
  });
  check(
    'рассылка запланирована',
    created.status === 200 && created.data?.item?.status === 'scheduled',
    `HTTP ${created.status} ${created.data?.error || ''}`,
  );
  check(
    'время переведено из Минска в UTC',
    String(created.data?.item?.sendAt || '').endsWith('T15:30:00.000Z'),
    String(created.data?.item?.sendAt),
  );
  check(
    'подпись аудитории понятная',
    created.data?.item?.audience === 'Все, у кого включены уведомления',
    String(created.data?.item?.audience),
  );
  const id = created.data?.item?.id;

  const listed = await call('/api/admin/push/schedule', { cookie });
  const listedItem = listed.data?.items?.find((item) => item.id === id);
  check('запланированная видна в списке', Boolean(listedItem) && listedItem.status === 'scheduled');

  const canceled = await call('/api/admin/push/schedule/cancel', {
    method: 'POST',
    cookie,
    body: { id },
  });
  check(
    'отмена переводит в canceled',
    canceled.status === 200 && canceled.data?.item?.status === 'canceled',
    `HTTP ${canceled.status}`,
  );

  const again = await call('/api/admin/push/schedule/cancel', {
    method: 'POST',
    cookie,
    body: { id },
  });
  check('повторная отмена → 400', again.status === 400, `HTTP ${again.status}`);

  const after = await call('/api/admin/push/schedule', { cookie });
  const canceledItem = after.data?.items?.find((item) => item.id === id);
  check('отменённая остаётся в истории', canceledItem?.status === 'canceled');

  const users = await call('/api/admin/users', { cookie });
  const admin = users.data?.users?.find((user) => user.role === 'admin');
  const selected = await call('/api/admin/push/schedule', {
    method: 'POST',
    cookie,
    body: {
      title: 'Только себе',
      text: 'Проверка выбранного получателя',
      all: false,
      userIds: [admin?.id].filter(Boolean),
      date: day,
      time: '19:00',
    },
  });
  check(
    'выбранный получатель сохраняется',
    selected.status === 200 && selected.data?.item?.userIds?.length === 1,
    `HTTP ${selected.status} ${selected.data?.error || ''}`,
  );

  const stored = path.join(dataDir, 'push-schedule.json');
  check('расписание легло на диск', fs.existsSync(stored));
}

try {
  await main();
} finally {
  server.kill();
  await sleep(150);
  fs.rmSync(dataDir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${failed ? `ПРОВАЛОВ: ${failed}` : 'Все проверки пройдены'}`);
  if (failed) process.exitCode = 1;
}

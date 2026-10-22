/* Проверка «Дашборда» — шести постоянных заданий.
   Тест поднимает настоящий сервер на свободном порту во временной папке
   данных, поэтому рабочие данные и расписание не затрагиваются.

   Что проверяем:
   — у каждого аккаунта ровно шесть заданий и по умолчанию они выключены;
   — настройки (частота, день, час, текст) сохраняются и переживают перезапрос;
   — ближайший запуск считается по времени Минска, а не контейнера;
   — «Запустить сейчас» открывает диалог в проекте задания;
   — планировщик сам запускает задание, когда время подошло, и переносит дату;
   — сброс возвращает заводской текст задания;
   — чужие и несуществующие задания отвечают 404, без входа — 401.

   Запуск: node test/dashboard.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3293);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-dash-'));

const env = {
  ...process.env,
  DSHOW_HOST: '127.0.0.1',
  DSHOW_PORT: String(PORT),
  DSHOW_DATA_DIR: dataDir,
  DSHOW_ADMIN_USER: 'tester',
  DSHOW_ADMIN_PASSWORD: 'Test12345',
  DSHOW_TG_TOKEN: '',
  DSHOW_TG_CHAT: '',
  /* Ключ-пустышка и заведомо мёртвый адрес модели: запуск падает сразу, без
     похода в интернет. Задача при этом создаётся и завершается как обычная. */
  DSHOW_DEEPSEEK_KEY: 'test-key',
  DSHOW_MODEL_BASE: 'http://127.0.0.1:1/v1',
  OPENROUTER_API_KEY: '',
  /* Расписание срабатывает раз в месяц — для проверки сокращаем ожидание. */
  DSHOW_DASHBOARD: '1',
  DSHOW_DASHBOARD_TEST: '1',
  DSHOW_DASHBOARD_TICK_MS: '2000',
  DSHOW_DASHBOARD_START_MS: '300',
};

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (chunk) => {
  log += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  log += chunk.toString();
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitReady() {
  for (let i = 0; i < 120; i += 1) {
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

async function call(pathname, { method = 'GET', body, cookie } = {}) {
  const init = { method, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131' } };
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
    data = { raw: text.slice(0, 300) };
  }
  return { status: response.status, data };
}

/* Документ задания: тело — сами байты, имя в заголовке x-filename, как у
   обычного вложения в чат. */
async function uploadDoc(taskId, cookie, name, text, mime = 'text/plain') {
  const response = await fetch(`${BASE}/api/dashboard/tasks/${taskId}/files`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': mime,
      'x-filename': encodeURIComponent(name),
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131',
    },
    body: Buffer.from(text, 'utf8'),
  });
  const raw = await response.text();
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw: raw.slice(0, 300) };
  }
  return { status: response.status, data };
}

async function login(username, password) {
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131' },
    body: JSON.stringify({ username, password }),
  });
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  return { status: response.status, data, session: cookieValue(response, 'dshow_session') };
}

const MINSK = 'Europe/Minsk';
function minskParts(iso) {
  const date = new Date(iso);
  const format = new Intl.DateTimeFormat('ru-RU', {
    timeZone: MINSK,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = {};
  for (const part of format.formatToParts(date)) parts[part.type] = part.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour === '24' ? '00' : parts.hour),
    minute: Number(parts.minute),
    /* 1 = понедельник, как в dashboard.mjs */
    weekday: new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`).getUTCDay() || 7,
  };
}

async function waitFor(predicate, timeoutMs = 12000, stepMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return null;
}

try {
  if (!(await waitReady())) throw new Error('сервер не поднялся');

  const unauth = await call('/api/dashboard');
  check('без входа дашборд закрыт', unauth.status === 401, `HTTP ${unauth.status}`);

  const admin = await login('tester', 'Test12345');
  check('вход администратора', admin.status === 200, `HTTP ${admin.status}`);
  const cookie = `dshow_session=${admin.session}`;

  /* ---- шесть заданий ---- */
  const dash = await call('/api/dashboard', { cookie });
  check('дашборд отвечает', dash.status === 200, `HTTP ${dash.status}`);
  const tasks = dash.data.tasks || [];
  check('ровно шесть заданий', tasks.length === 6, `заданий: ${tasks.length}`);
  const blocks = tasks.map((task) => task.blockId);
  check('все блоки разные', new Set(blocks).size === 6, blocks.join(', '));
  check('по умолчанию всё выключено', tasks.every((task) => task.enabled === false), tasks.map((t) => t.enabled).join(','));
  check('у заданий есть расписание и текст', tasks.every((task) => task.schedule && task.prompt && task.title), '');
  check('время задано минское', dash.data.tz === MINSK, String(dash.data.tz));
  check('у администратора нет предупреждения о балансе', dash.data.canAutoRun === true, String(dash.data.canAutoRun));
  check(
    'в текстах заданий нет численности компании',
    tasks.every((task) => !/около\s*60\s*(работников|сотрудников)/.test(task.prompt)),
    tasks.map((task) => (/около\s*60/.test(task.prompt) ? task.blockId : '')).filter(Boolean).join(', '),
  );
  check(
    'страна осталась словами',
    tasks.every((task) => task.prompt.includes('Беларус')),
    tasks.filter((task) => !task.prompt.includes('Беларус')).map((task) => task.blockId).join(', '),
  );

  const target = tasks.find((task) => task.blockId === 'tenders') || tasks[0];

  /* ---- настройки ---- */
  const patched = await call(`/api/dashboard/tasks/${target.id}`, {
    method: 'PATCH',
    cookie,
    body: { enabled: true, cadence: 'weekly', dayOfWeek: 3, hour: 15 },
  });
  check('настройки принимаются', patched.status === 200, `HTTP ${patched.status}`);
  const task = patched.data.task || {};
  check('включение сохранилось', task.enabled === true, String(task.enabled));
  check('расписание пересчитано', /сред/i.test(task.schedule || ''), String(task.schedule));
  check('дата следующего запуска есть', Boolean(task.nextRunAt), String(task.nextRunAt));
  if (task.nextRunAt) {
    const parts = minskParts(task.nextRunAt);
    check('следующий запуск — среда, 15:00 по Минску', parts.weekday === 3 && parts.hour === 15 && parts.minute === 0, JSON.stringify(parts));
    check('следующий запуск в будущем', Date.parse(task.nextRunAt) > Date.now(), task.nextRunAt);
  }

  const reread = await call('/api/dashboard', { cookie });
  const persisted = (reread.data.tasks || []).find((item) => item.id === target.id);
  check('настройки пережили перезапрос', persisted?.enabled === true && persisted?.cadence === 'weekly', JSON.stringify(persisted?.schedule));

  /* ---- сброс текста задания: проверяем в конце, потому что он возвращает и
     расписание к заводскому ---- */

  /* ---- документы задания: любой формат, попадают в запуск ---- */
  const docText = 'Прайс-лист поставщика: молоко 2,10 BYN, хлеб 1,35 BYN.';
  const uploaded = await uploadDoc(target.id, cookie, 'прайс-лист поставщика.txt', docText);
  check(
    'документ загружается',
    uploaded.status === 200 && (uploaded.data.task?.files || []).length === 1,
    `HTTP ${uploaded.status} ${JSON.stringify(uploaded.data).slice(0, 120)}`,
  );
  const doc = uploaded.data.task?.files?.[0] || {};
  check(
    'имя и размер документа сохранены',
    doc.name === 'прайс-лист поставщика.txt' && doc.size === Buffer.byteLength(docText),
    JSON.stringify(doc),
  );
  const withDoc = (await call('/api/dashboard', { cookie })).data.tasks.find((item) => item.id === target.id);
  check('документ виден в дашборде', (withDoc?.files || []).length === 1, JSON.stringify(withDoc?.files || []));
  const downloaded = await fetch(`${BASE}/api/dashboard/tasks/${target.id}/files/${doc.id}`, { headers: { cookie } });
  const downloadedText = await downloaded.text();
  check('документ скачивается', downloaded.status === 200 && downloadedText.includes('молоко'), `HTTP ${downloaded.status}`);

  /* ---- «Запустить сейчас» ---- */
  const manual = await call(`/api/dashboard/tasks/${target.id}/run`, { method: 'POST', cookie, body: {} });
  check('ручной запуск открывает диалог', manual.status === 200 && Boolean(manual.data.chatId), `HTTP ${manual.status} ${JSON.stringify(manual.data).slice(0, 120)}`);
  if (manual.data.chatId) {
    const chat = await call(`/api/chats/${manual.data.chatId}`, { cookie });
    check('диалог задания доступен', chat.status === 200 && chat.data.chat?.id === manual.data.chatId, `HTTP ${chat.status}`);
    check('диалог назван по блоку', String(chat.data.chat?.title || '').length > 3, String(chat.data.chat?.title));
    /* Документ должен дойти до модели: имя — в списке материалов, текст — в
       приложении к заданию. Ждём: сообщение пишется в момент старта задачи. */
    const withDocs = await waitFor(async () => {
      const fresh = await call(`/api/chats/${manual.data.chatId}`, { cookie });
      const text = String((fresh.data.chat?.messages || [])[0]?.content || '');
      return text.includes('прайс-лист поставщика.txt') && text.includes('молоко') ? text : null;
    }, 8000);
    check('документы переданы в задание', Boolean(withDocs), String(withDocs || '').slice(0, 160));
  }
  const afterManual = (await call('/api/dashboard', { cookie })).data.tasks || [];
  const manualTask = afterManual.find((item) => item.id === target.id);
  check('ручной запуск не сдвигает расписание', manualTask?.nextRunAt === task.nextRunAt, `${manualTask?.nextRunAt} vs ${task.nextRunAt}`);

  /* Дожидаемся, пока задача закончится: модель недоступна, поэтому она упадёт
     быстро, но запись о последнем запуске должна остаться. */
  const finished = await waitFor(async () => {
    const list = (await call('/api/dashboard', { cookie })).data.tasks || [];
    const item = list.find((entry) => entry.id === target.id);
    return item && item.lastStatus && item.lastStatus !== 'running' ? item : null;
  });
  check('результат запуска записан в задание', Boolean(finished?.lastChatId), String(finished?.lastStatus));

  /* ---- документ убирается из задания ---- */
  const deleted = await call(`/api/dashboard/tasks/${target.id}/files/${doc.id}`, { method: 'DELETE', cookie });
  check(
    'документ удаляется',
    deleted.status === 200 && (deleted.data.task?.files || []).length === 0,
    `HTTP ${deleted.status}`,
  );

  /* ---- планировщик ---- */
  const scheduled = await call(`/api/dashboard/tasks/${target.id}`, {
    method: 'PATCH',
    cookie,
    body: { enabled: true, forceDue: true },
  });
  check('задание переведено в «пора»', scheduled.status === 200, `HTTP ${scheduled.status}`);
  const dueAt = scheduled.data.task?.nextRunAt;
  const fired = await waitFor(async () => {
    const list = (await call('/api/dashboard', { cookie })).data.tasks || [];
    const item = list.find((entry) => entry.id === target.id);
    if (!item) return null;
    /* Планировщик сдвинул дату вперёд и записал новый диалог. */
    return item.nextRunAt && item.nextRunAt !== dueAt ? item : null;
  }, 16000);
  check('планировщик запускает задание сам', Boolean(fired), fired ? `следующий: ${fired.nextRunAt}` : 'не сработал');
  if (fired?.nextRunAt) {
    const parts = minskParts(fired.nextRunAt);
    check('после запуска дата снова в будущем', Date.parse(fired.nextRunAt) > Date.now(), fired.nextRunAt);
    check('расписание осталось средой 15:00', parts.weekday === 3 && parts.hour === 15, JSON.stringify(parts));
  }

  /* ---- сброс: возвращает и текст, и заводское расписание ---- */
  const custom = await call(`/api/dashboard/tasks/${target.id}`, {
    method: 'PATCH',
    cookie,
    body: { prompt: 'Проверочный текст задания' },
  });
  check('свой текст задания сохраняется', custom.data.task?.prompt === 'Проверочный текст задания', String(custom.data.task?.prompt).slice(0, 40));
  const reset = await call(`/api/dashboard/tasks/${target.id}/reset`, { method: 'POST', cookie });
  check('сброс возвращает заводской текст', reset.status === 200 && reset.data.task?.prompt === target.prompt, `HTTP ${reset.status}`);
  check('сброс возвращает заводское расписание', reset.data.task?.cadence === target.cadence && reset.data.task?.hour === target.hour, String(reset.data.task?.schedule));

  /* ---- старые формулировки в уже сохранённых заданиях ----
     У живой компании текст задания сохранялся раньше с численностью в скобках;
     при чтении он приводится к новому виду, а свой текст пользователя цел. */
  const legacyId = tasks.find((item) => item.blockId === 'finance').id;
  const legacy = await call(`/api/dashboard/tasks/${legacyId}`, {
    method: 'PATCH',
    cookie,
    body: { prompt: 'Ты готовишь сводку для компании из Республики Беларусь (около 60 работников). Остальное сам.' },
  });
  check('старый текст задания принимается', legacy.status === 200, `HTTP ${legacy.status}`);
  const migrated = (await call('/api/dashboard', { cookie })).data.tasks.find((item) => item.id === legacyId);
  check(
    'численность уходит из старого текста',
    !/около\s*60\s*работников/.test(migrated?.prompt || ''),
    String(migrated?.prompt || '').slice(0, 90),
  );
  check(
    'страна остаётся без скобок, остальной текст цел',
    (migrated?.prompt || '').includes('из Республики Беларусь.') && (migrated?.prompt || '').includes('Остальное сам'),
    String(migrated?.prompt || '').slice(0, 90),
  );

  /* ---- чужие ручки ---- */
  const missing = await call('/api/dashboard/tasks/d_nope_000000', { method: 'PATCH', cookie, body: { enabled: true } });
  check('несуществующее задание — 404', missing.status === 404, `HTTP ${missing.status}`);

  /* ---- второй аккаунт не видит чужие задания ---- */
  const other = await call('/api/admin/users', {
    method: 'POST',
    cookie,
    body: { username: 'dashuser', password: 'Test12345', role: 'user' },
  });
  if (other.status === 200 || other.status === 201) {
    const second = await login('dashuser', 'Test12345');
    const secondDash = await call('/api/dashboard', { cookie: `dshow_session=${second.session}` });
    const secondTasks = secondDash.data.tasks || [];
    check('у второго аккаунта свои шесть заданий', secondTasks.length === 6, `заданий: ${secondTasks.length}`);
    check('чужое включение не видно', secondTasks.every((item) => item.enabled === false), secondTasks.map((t) => t.enabled).join(','));
    check('id заданий свои', secondTasks.every((item) => !tasks.some((own) => own.id === item.id)), '');
  } else {
    check('второй аккаунт создан', false, `HTTP ${other.status}`);
  }
} catch (error) {
  check('проверка завершилась без исключения', false, error?.message || String(error));
} finally {
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(dataDir, { recursive: true, force: true });
  const failed = results.filter((item) => !item.ok);
  console.log('');
  console.log(`Итог: ${results.length - failed.length} из ${results.length} проверок пройдено.`);
  if (failed.length) {
    console.log('Сервер сказал:');
    console.log(log.split('\n').slice(-25).join('\n'));
    process.exitCode = 1;
  }
}

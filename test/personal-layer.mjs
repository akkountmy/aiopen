/* Проверка личного слоя: человек добавляет своё поверх неизменной основы.
   Тест поднимает настоящий сервер во временной папке данных, поэтому рабочие
   аккаунты, дашборд и выпуск новостей не затрагиваются.

   Что проверяем:
   — основа после всех действий остаётся прежней: те же шесть блоков, те же
     названия и тексты, ни одного изменённого поля;
   — свой блок создаётся, живёт в конце списка и не подменяет блоки основы;
   — лимиты честные: шестой свой блок принимается, седьмой — отказ 409;
   — удаление своего блока насовсем, удаление блока основы — мягкое;
   — журнал отмены возвращает ровно предыдущее состояние: час запуска,
     удалённый блок, удалённые блоки основы, свою тему;
   — «вернуть всё как было» снимает только своё;
   — свои темы выпуска ограничены тремя и не подменяют шесть базовых;
   — чужой аккаунт не видит и не трогает личный слой соседа.

   Запуск: node test/personal-layer.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3294);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-personal-'));

const env = {
  ...process.env,
  DSHOW_HOST: '127.0.0.1',
  DSHOW_PORT: String(PORT),
  DSHOW_DATA_DIR: dataDir,
  DSHOW_ADMIN_USER: 'tester',
  DSHOW_ADMIN_PASSWORD: 'Test12345',
  DSHOW_TG_TOKEN: '',
  DSHOW_TG_CHAT: '',
  /* Ключ-пустышка и заведомо мёртвый адрес модели: ни один запуск не должен
     уйти в интернет, даже если задание случайно стартует. */
  DSHOW_DEEPSEEK_KEY: 'test-key',
  DSHOW_MODEL_BASE: 'http://127.0.0.1:1/v1',
  OPENROUTER_API_KEY: '',
  /* Планировщик дашборда не мешает: задания выключены, но тик всё равно
     отодвигаем, чтобы тест не зависел от времени суток. */
  DSHOW_DASHBOARD_START_MS: '3600000',
};

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitReady() {
  for (let i = 0; i < 150; i += 1) {
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

async function login(username, password) {
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131' },
    body: JSON.stringify({ username, password }),
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  return { status: response.status, data, session: cookieValue(response, 'dshow_session') };
}

const block = (title, prompt, extra = {}) => ({
  title,
  prompt,
  short: '',
  description: '',
  icon: 'chart',
  cadence: 'monthly',
  dayOfMonth: 5,
  hour: 10,
  ...extra,
});

const topic = (title, query, extra = {}) => ({ title, query, ...extra });

function baseOf(payload) {
  return (payload.tasks || []).filter((task) => !task.custom);
}
function ownOf(payload) {
  return (payload.tasks || []).filter((task) => task.custom);
}

try {
  if (!(await waitReady())) throw new Error('сервер не поднялся');

  const unauth = await call('/api/dashboard');
  check('без входа личный слой закрыт', unauth.status === 401, `HTTP ${unauth.status}`);

  const admin = await login('tester', 'Test12345');
  check('вход администратора', admin.status === 200, `HTTP ${admin.status}`);
  const cookie = `dshow_session=${admin.session}`;

  /* ---- пустое начало: основа на месте, своего ещё нет ---- */
  const first = await call('/api/dashboard', { cookie });
  check('дашборд отвечает', first.status === 200, `HTTP ${first.status}`);
  const baseTitles = baseOf(first.data).map((task) => task.title);
  const basePrompts = baseOf(first.data).map((task) => task.prompt);
  check('основа — ровно шесть блоков', baseOf(first.data).length === 6, `блоков: ${baseOf(first.data).length}`);
  check('своего пока нет', ownOf(first.data).length === 0, `своих: ${ownOf(first.data).length}`);
  check(
    'личный слой в ответе с нулём и лимитом',
    first.data.personal?.customCount === 0 && first.data.personal?.customLimit === 6 && first.data.personal?.canAddCustom === true,
    JSON.stringify(first.data.personal?.customCount ?? null),
  );
  check(
    'набор значков для своего блока пришёл',
    Array.isArray(first.data.personal?.icons) && first.data.personal.icons.includes('chart'),
    String((first.data.personal?.icons || []).join(',')),
  );
  check('отменять пока нечего', first.data.undo?.canUndo === false && first.data.undo?.count === 0, JSON.stringify(first.data.undo));

  /* ---- свой блок ---- */
  const created = await call('/api/dashboard/tasks', { method: 'POST', cookie, body: block('Отчёт по складу', 'Собери отчёт по остаткам склада за месяц.') });
  check('свой блок создаётся', created.status === 201, `HTTP ${created.status}`);
  const own = created.data.task || {};
  check('у своего блока свой идентификатор', /^own_[0-9a-f]{8}$/.test(String(own.blockId)), String(own.blockId));
  check('название взято из ввода', own.title === 'Отчёт по складу', String(own.title));
  check('свой блок отмечен флагом', own.custom === true, String(own.custom));
  check('заводских настроек у своего нет', own.canReset === false, String(own.canReset));
  check('текст задания сохранён', String(own.prompt).includes('остаткам склада'), String(own.prompt).slice(0, 40));
  check('свой блок включён по умолчанию', own.enabled === true, String(own.enabled));
  check('свой блок встал в конец списка', created.data.tasks?.[created.data.tasks.length - 1]?.id === own.id, String(created.data.tasks?.length));
  check('счётчик своего стал один', created.data.personal?.customCount === 1, String(created.data.personal?.customCount));
  check('основа не изменилась', baseOf(created.data).length === 6, `основы: ${baseOf(created.data).length}`);
  check('появилась запись отмены создания', created.data.undo?.canUndo === true && String(created.data.undo?.label).includes('Отчёт по складу'), String(created.data.undo?.label));

  const broken = await call('/api/dashboard/tasks', { method: 'POST', cookie, body: {} });
  check('пустой блок не создаётся', broken.status === 400, `HTTP ${broken.status}`);
  check('ошибки приходят списком, а не одной', Array.isArray(broken.data.errors) && broken.data.errors.length >= 2, JSON.stringify(broken.data.errors));

  const longTitle = await call('/api/dashboard/tasks', {
    method: 'POST',
    cookie,
    body: block('я'.repeat(61), 'Проверить длинное название блока.'),
  });
  check('название длиннее 60 знаков отклоняется', longTitle.status === 400 && /60/.test(String(longTitle.data.error)), String(longTitle.data.error));

  /* ---- лимит своих блоков ---- */
  const extras = [];
  for (let i = 2; i <= 6; i += 1) {
    const extra = await call('/api/dashboard/tasks', { method: 'POST', cookie, body: block(`Свой блок ${i}`, `Задание своего блока номер ${i}.`) });
    extras.push(extra.status);
  }
  check('шесть своих блоков принимаются', extras.every((status) => status === 201), extras.join(','));
  const over = await call('/api/dashboard/tasks', { method: 'POST', cookie, body: block('Седьмой', 'Уже лишний блок.') });
  check('седьмой свой блок — отказ 409', over.status === 409, `HTTP ${over.status}`);
  check('в отказе назван лимит', /6/.test(String(over.data.error)), String(over.data.error));

  /* ---- правка своего блока и её отмена ---- */
  const patched = await call(`/api/dashboard/tasks/${own.id}`, { method: 'PATCH', cookie, body: { hour: 15 } });
  check('правка своего блока принимается', patched.status === 200 && patched.data.task?.hour === 15, `HTTP ${patched.status}`);
  const journal = await call('/api/personal/journal', { cookie });
  check('журнал отвечает', journal.status === 200, `HTTP ${journal.status}`);
  check('в журнале видна правка с названием', String(journal.data.entries?.[0]?.label).includes('Отчёт по складу'), String(journal.data.entries?.[0]?.label));
  check('вид записи — правка задания', journal.data.entries?.[0]?.kind === 'task-patch', String(journal.data.entries?.[0]?.kind));

  const undone = await call('/api/personal/undo', { method: 'POST', cookie, body: {} });
  check('отмена отвечает', undone.status === 200, `HTTP ${undone.status}`);
  const afterUndo = (undone.data.tasks || []).find((task) => task.id === own.id) || {};
  check('отмена вернула прежний час', afterUndo.hour === 10, String(afterUndo.hour));
  check('в ответе сказано, что отменили', String(undone.data.undone?.label).includes('Отчёт по складу'), String(undone.data.undone?.label));

  /* ---- удаление своего блока: насовсем, но с отменой ---- */
  const removed = await call(`/api/dashboard/tasks/${own.id}`, { method: 'DELETE', cookie });
  check('свой блок удаляется', removed.status === 200, `HTTP ${removed.status}`);
  check('свой блок исчез из списка', !(removed.data.tasks || []).some((task) => task.id === own.id), String((removed.data.tasks || []).length));
  check('удаление своего не считается удалением основы', Number(removed.data.deleted || 0) === 0, String(removed.data.deleted));
  const back = await call('/api/personal/undo', { method: 'POST', cookie, body: {} });
  const backOwn = (back.data.tasks || []).find((task) => task.id === own.id) || {};
  check('удалённый свой блок возвращается', Boolean(backOwn.id), `HTTP ${back.status}`);
  check(
    'возвращённый свой блок снова по расписанию',
    backOwn.enabled === true && Boolean(backOwn.nextRunAt),
    `${backOwn.enabled} / ${backOwn.nextRunAt}`,
  );

  /* ---- удаление блока основы: мягкое, с возвратом ---- */
  const baseTask = baseOf(back.data)[0];
  await call(`/api/dashboard/tasks/${baseTask.id}`, { method: 'PATCH', cookie, body: { enabled: true } });
  const softDeleted = await call(`/api/dashboard/tasks/${baseTask.id}`, { method: 'DELETE', cookie });
  check('блок основы удаляется', softDeleted.status === 200, `HTTP ${softDeleted.status}`);
  check('удалённый блок основы посчитан', Number(softDeleted.data.deleted || 0) === 1, String(softDeleted.data.deleted));
  check('удалённый блок основы скрыт из списка', !(softDeleted.data.tasks || []).some((task) => task.id === baseTask.id), '');
  const restored = await call('/api/personal/undo', { method: 'POST', cookie, body: {} });
  check('отмена возвращает блок основы', (restored.data.tasks || []).some((task) => task.id === baseTask.id), `HTTP ${restored.status}`);
  const restoredBase = (restored.data.tasks || []).find((task) => task.id === baseTask.id) || {};
  check(
    'возвращённый блок основы включён, как был',
    restoredBase.enabled === true && Boolean(restoredBase.nextRunAt),
    `${restoredBase.enabled} / ${restoredBase.nextRunAt}`,
  );
  check('счётчик удалённых обнулился', Number(restored.data.deleted || 0) === 0, String(restored.data.deleted));

  /* ---- основа не тронута ни одним действием ---- */
  const snapshot = await call('/api/dashboard', { cookie });
  check(
    'названия основы прежние',
    JSON.stringify(baseOf(snapshot.data).map((task) => task.title)) === JSON.stringify(baseTitles),
    baseOf(snapshot.data).map((task) => task.title).join(' | '),
  );
  check(
    'тексты основы прежние',
    JSON.stringify(baseOf(snapshot.data).map((task) => task.prompt)) === JSON.stringify(basePrompts),
    '',
  );
  check('блоки основы не помечены своими', baseOf(snapshot.data).every((task) => task.custom === false), '');

  /* ---- свои темы выпуска ---- */
  const newsOff = await call('/api/topnews', { cookie });
  const baseThemeCount = (payload) => (payload.preview || payload.issue?.categories || []).length;
  check('выпуск отвечает', newsOff.status === 200, `HTTP ${newsOff.status}`);
  check('шесть базовых тем на месте', baseThemeCount(newsOff.data) === 6, `тем: ${baseThemeCount(newsOff.data)}`);
  check('своих тем пока нет', (newsOff.data.personal?.topics || []).length === 0, '');

  const topic1 = await call('/api/topnews/topics', { method: 'POST', cookie, body: topic('Логистика', 'логистика и склады Беларусь 2026') });
  check('своя тема создаётся', topic1.status === 201, `HTTP ${topic1.status}`);
  check('у темы есть идентификатор', Boolean(topic1.data.topic?.id), String(topic1.data.topic?.id));
  const afterTopic = await call('/api/topnews', { cookie });
  check('своя тема не подменяет базовые', baseThemeCount(afterTopic.data) === 6 && (afterTopic.data.personal?.topics || []).length === 1, `HTTP ${afterTopic.status}`);
  check('лимит тем назван', topic1.data.personal?.limit === 3, String(topic1.data.personal?.limit));
  check('блок своей темы ждёт выпуска', ['off', 'building'].includes(String(topic1.data.personal?.blocks?.[0]?.status)), String(topic1.data.personal?.blocks?.[0]?.status));

  const badTopic = await call('/api/topnews/topics', { method: 'POST', cookie, body: { title: 'Без запроса' } });
  check('тема без запроса отклоняется', badTopic.status === 400, `HTTP ${badTopic.status}`);

  await call('/api/topnews/topics', { method: 'POST', cookie, body: topic('Кадры', 'рынок труда Беларусь 2026') });
  const third = await call('/api/topnews/topics', { method: 'POST', cookie, body: topic('Закупки', 'госзакупки Беларусь 2026') });
  check('три свои темы принимаются', third.status === 201, `HTTP ${third.status}`);
  const fourth = await call('/api/topnews/topics', { method: 'POST', cookie, body: topic('Четвёртая', 'ещё один запрос') });
  check('четвёртая тема — отказ 409', fourth.status === 409, `HTTP ${fourth.status}`);

  const topicGone = await call(`/api/topnews/topics/${topic1.data.topic.id}`, { method: 'DELETE', cookie });
  check('своя тема удаляется', topicGone.status === 200, `HTTP ${topicGone.status}`);
  check('тем стало две', (topicGone.data.personal?.topics || []).length === 2, String((topicGone.data.personal?.topics || []).length));
  const topicUndo = await call('/api/personal/undo', { method: 'POST', cookie, body: {} });
  check('отмена возвращает тему', (topicUndo.data.topics || []).some((item) => item.id === topic1.data.topic.id), `HTTP ${topicUndo.status}`);

  /* ---- стык с модулем своих тем: готовый кеш отдаётся без сети ----
     Кеш кладём вручную, чтобы проверка была оффлайн и повторяемой: сервер при
     включённом разделе обязан поднять модуль, прочитать файл и отдать готовые
     блоки. Если модуль не загрузится, придёт `building` — проверка это поймает. */
  const usersList = await call('/api/admin/users', { cookie });
  const adminId = (usersList.data.users || []).find((item) => item.username === 'tester')?.id || '';
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Minsk' }).format(new Date());
  const cacheDir = path.join(dataDir, 'topnews', 'personal', adminId);
  fs.mkdirSync(cacheDir, { recursive: true });
  const topicIds = (topicUndo.data.topics || []).map((item) => item.id);
  const cachedBlocks = topicIds.map((id, index) => ({
    topicId: id,
    title: `Своя тема ${index + 1}`,
    kicker: 'Проверка',
    tone: 'gold',
    status: 'ready',
    items: [
      { rank: 1, headline: 'Первая новость', summary: 'Коротко о главном.', source: 'Пример', url: 'https://example.com/a', publishedAt: '2026-11-09T06:00:00.000Z' },
      { rank: 2, headline: 'Вторая новость', summary: 'Ещё короче.', source: 'Пример', url: 'https://example.com/b', publishedAt: '2026-11-09T05:00:00.000Z' },
    ],
  }));
  fs.writeFileSync(
    path.join(cacheDir, `${dayKey}.json`),
    JSON.stringify({ dateKey: dayKey, builtAt: new Date().toISOString(), blocks: cachedBlocks }),
    'utf8',
  );
  const toggled = await call('/api/topnews/toggle', { method: 'POST', cookie, body: { enabled: true } });
  check('выпуск включается', toggled.status === 200, `HTTP ${toggled.status}`);
  const newsOn = await call('/api/topnews', { cookie });
  const ownBlocks = newsOn.data.personal?.blocks || [];
  check(
    'свои темы приходят готовыми блоками',
    ownBlocks.length === topicIds.length && ownBlocks.every((item) => item.status === 'ready'),
    ownBlocks.map((item) => item.status).join(','),
  );
  check('новости своей темы отдаются целиком', (ownBlocks[0]?.items || []).length === 2, String((ownBlocks[0]?.items || []).length));
  await call('/api/topnews/toggle', { method: 'POST', cookie, body: { enabled: false } });
  /* Свои темы — добавка, а не замена: превью шести базовых тем на месте, а свои
     блоки при выключенном разделе честно помечены «выключено». */
  const newsOffAgain = await call('/api/topnews', { cookie });
  check('шесть базовых тем не подменяются своими', baseThemeCount(newsOffAgain.data) === 6, `базовых: ${baseThemeCount(newsOffAgain.data)}`);
  check('свои темы остаются в списке', (newsOffAgain.data.personal?.topics || []).length === 3, String((newsOffAgain.data.personal?.topics || []).length));
  check(
    'свои блоки при выключенном разделе честно выключены',
    (newsOffAgain.data.personal?.blocks || []).every((item) => item.status === 'off'),
    (newsOffAgain.data.personal?.blocks || []).map((item) => item.status).join(','),
  );

  /* ---- чужой аккаунт ---- */
  const guestCreated = await call('/api/admin/users', {
    method: 'POST',
    cookie,
    body: { username: 'guest', password: 'Guest12345', role: 'user', creditUsd: 0 },
  });
  check('второй аккаунт создан', guestCreated.status === 200, `HTTP ${guestCreated.status}`);
  const guest = await login('guest', 'Guest12345');
  const guestCookie = `dshow_session=${guest.session}`;
  const guestDash = await call('/api/dashboard', { cookie: guestCookie });
  check('чужой аккаунт видит только основу', baseOf(guestDash.data).length === 6 && ownOf(guestDash.data).length === 0, `HTTP ${guestDash.status}`);
  check('чужой аккаунт не видит своего у соседа', guestDash.data.personal?.customCount === 0, String(guestDash.data.personal?.customCount));
  const guestNews = await call('/api/topnews', { cookie: guestCookie });
  check('чужие темы не протекают', (guestNews.data.personal?.topics || []).length === 0, '');
  const guestTouch = await call(`/api/dashboard/tasks/${own.id}`, { method: 'PATCH', cookie: guestCookie, body: { hour: 11 } });
  check('чужой блок не правится', guestTouch.status === 404, `HTTP ${guestTouch.status}`);
  const guestDelete = await call(`/api/dashboard/tasks/${own.id}`, { method: 'DELETE', cookie: guestCookie });
  check('чужой блок не удаляется', guestDelete.status === 404, `HTTP ${guestDelete.status}`);

  /* ---- «вернуть всё как было» ---- */
  /* Документы своего блока лежат на диске отдельно от index.json: сброс обязан
     убрать их вместе с блоком, иначе на сервере остались бы сироты. */
  const ownDocsDir = path.join(dataDir, 'dashboard-files', own.id);
  fs.mkdirSync(ownDocsDir, { recursive: true });
  fs.writeFileSync(path.join(ownDocsDir, 'report.txt'), 'временный документ', 'utf8');
  const reset = await call('/api/personal/reset', { method: 'POST', cookie });
  check('сброс личного слоя отвечает', reset.status === 200, `HTTP ${reset.status}`);
  const afterResetBase = baseOf(reset.data);
  check('после сброса осталась только основа', ownOf(reset.data).length === 0 && afterResetBase.length === 6, `своих: ${ownOf(reset.data).length}`);
  check('после сброса тем нет', (reset.data.topics || []).length === 0, String((reset.data.topics || []).length));
  check('после сброса отменять нечего', reset.data.undo?.canUndo === false, JSON.stringify(reset.data.undo));
  check('документы снятого блока убраны с диска', !fs.existsSync(ownDocsDir), ownDocsDir);
  check(
    'названия основы и после сброса прежние',
    JSON.stringify(afterResetBase.map((task) => task.title)) === JSON.stringify(baseTitles),
    afterResetBase.map((task) => task.title).join(' | '),
  );

  /* ---- счётчики в отчёте сброса ---- */
  check('сброс сказал, сколько снял', Number(reset.data.reset?.removedBlocks) >= 1 && Number(reset.data.reset?.removedTopics) >= 1, JSON.stringify(reset.data.reset));
} catch (error) {
  check('проверка дошла до конца', false, error?.message || String(error));
} finally {
  server.kill();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* временная папка могла не создаться */
  }
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} проверок личного слоя прошло`);
if (failed.length) {
  console.log('провалились:');
  for (const item of failed) console.log(`  - ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  if (serverLog.length) console.log(`\nлог сервера (хвост):\n${serverLog.join('').slice(-1500)}`);
  process.exitCode = 1;
}

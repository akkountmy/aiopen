/**
 * Дымовой тест закрытого сервиса.
 * Требует запущенный сервер и учётные данные администратора:
 *   $env:DSHOW_USER='...'; $env:DSHOW_PASS='...'; node test/smoke.mjs
 * Опционально: $env:DSHOW_BASE='http://127.0.0.1:3123'
 */
const BASE = (process.env.DSHOW_BASE || 'http://127.0.0.1:3123').replace(/\/$/, '');
const USERNAME = process.env.DSHOW_USER || '';
const PASSWORD = process.env.DSHOW_PASS || '';

let cookie = '';
let passed = 0;
const failures = [];

function ok(name, details = '') {
  passed += 1;
  console.log(`  ok  ${name}${details ? ` — ${details}` : ''}`);
}

function fail(name, error) {
  failures.push(`${name}: ${error}`);
  console.log(`  FAIL ${name} — ${error}`);
}

async function call(path, { method = 'GET', body, headers = {}, expect = 200, auth = true } = {}) {
  const init = { method, headers: { ...headers } };
  if (auth && cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${path}`, init);
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (setCookies.length) cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
  let data = null;
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) data = await response.json();
  else data = await response.text();
  if (expect !== null && response.status !== expect) {
    throw new Error(`${method} ${path} → ${response.status} (ожидался ${expect}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { status: response.status, data, headers: response.headers };
}

async function test(name, fn) {
  try {
    await fn();
  } catch (error) {
    fail(name, error.message);
  }
}

async function main() {
  console.log(`Дымовой тест: ${BASE}\n`);
  if (!USERNAME || !PASSWORD) {
    console.error('Задайте DSHOW_USER и DSHOW_PASS в окружении.');
    process.exit(2);
  }

  let projectId = null;
  let chatId = null;

  await test('health', async () => {
    const { data } = await call('/api/health', { auth: false });
    if (!data?.ok) throw new Error('нет поля ok');
    ok('health');
  });

  await test('доступ без входа', async () => {
    const saved = cookie;
    cookie = '';
    try {
      await call('/api/me', { expect: 401 });
    } finally {
      cookie = saved;
    }
    ok('GET /api/me без cookie → 401');
  });

  await test('неверный пароль', async () => {
    const saved = cookie;
    cookie = '';
    try {
      await call('/api/login', { method: 'POST', body: { username: USERNAME, password: 'definitely-wrong' }, expect: 401, auth: false });
    } finally {
      cookie = saved;
    }
    ok('неверный пароль → 401');
  });

  await test('вход', async () => {
    const { data } = await call('/api/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD }, auth: false });
    if (!data?.user?.username) throw new Error('нет пользователя в ответе');
    if (!cookie) throw new Error('не получена сессионная cookie');
    ok('вход', data.user.role);
  });

  await test('bootstrap', async () => {
    const { data } = await call('/api/me');
    if (!Array.isArray(data.projects)) throw new Error('нет списка проектов');
    ok('bootstrap', `${data.projects.length} проектов`);
  });

  await test('проект', async () => {
    const { data } = await call('/api/projects', { method: 'POST', body: { name: `Smoke ${new Date().toISOString().slice(11, 19)}` } });
    projectId = data.project.id;
    if (!projectId) throw new Error('нет id проекта');
    ok('создание проекта');
  });

  await test('диалог', async () => {
    const { data } = await call(`/api/projects/${projectId}/chats`, { method: 'POST', body: {} });
    chatId = data.chat.id;
    if (!chatId) throw new Error('нет id диалога');
    ok('создание диалога');
  });

  await test('переименование диалога', async () => {
    await call(`/api/chats/${chatId}`, { method: 'PATCH', body: { title: 'Smoke диалог' } });
    const { data } = await call(`/api/chats/${chatId}`);
    if (data.chat.title !== 'Smoke диалог') throw new Error(`title=${data.chat.title}`);
    ok('переименование диалога');
  });

  await test('файлы проекта', async () => {
    const { data } = await call(`/api/projects/${projectId}/files?path=.&depth=4`);
    if (!Array.isArray(data.items)) throw new Error('нет items');
    ok('список файлов', `${data.items.length} записей`);
  });

  await test('запись и чтение файла', async () => {
    const upload = await fetch(`${BASE}/api/projects/${projectId}/upload?path=${encodeURIComponent('smoke/demo.txt')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Filename': encodeURIComponent('demo.txt'), cookie },
      body: 'привет, harness',
    });
    if (!upload.ok) throw new Error(`upload → ${upload.status}`);
    const read = await fetch(`${BASE}/api/projects/${projectId}/file?path=${encodeURIComponent('smoke/demo.txt')}`, {
      headers: { cookie },
    });
    const text = await read.text();
    if (!text.includes('привет')) throw new Error('содержимое не совпало');
    ok('запись/чтение файла');
  });

  await test('архив проекта', async () => {
    const response = await fetch(`${BASE}/api/projects/${projectId}/download`, { headers: { cookie } });
    if (!response.ok) throw new Error(`download → ${response.status}`);
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length < 60 || buf.subarray(0, 2).toString() !== 'PK') throw new Error('не похоже на zip');
    ok('архив проекта', `${Math.round(buf.length / 1024)} КБ`);
  });

  await test('удаление', async () => {
    await call(`/api/chats/${chatId}`, { method: 'DELETE' });
    await call(`/api/projects/${projectId}`, { method: 'DELETE' });
    ok('удаление проекта и диалога');
  });

  await test('выход', async () => {
    await call('/api/logout', { method: 'POST', body: {} });
    await call('/api/me', { expect: 401 });
    ok('выход и отзыв сессии');
  });

  console.log(`\nИтого: ${passed} ok, ${failures.length} fail`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Сбой теста:', error);
  process.exit(1);
});

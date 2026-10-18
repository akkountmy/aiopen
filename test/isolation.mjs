/* Проверка того, что проекты, история и файлы у каждого пользователя свои.
   Тест поднимает настоящий сервер на свободном порту во временной папке данных,
   поэтому рабочие данные не затрагиваются.

   Что проверяем:
   — каждому аккаунту при первом входе достаётся свой «Мой проект» и диалог;
   — чужой проект, его диалоги, файлы и переписка отвечают 404;
   — административные ручки закрыты для обычного пользователя;
   — контекст (история и память) живёт в своём диалоге и не перетекает;
   — удаление аккаунта уносит его проекты с диска.

   Запуск: node test/isolation.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3289);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-iso-'));

const env = {
  ...process.env,
  DSHOW_HOST: '127.0.0.1',
  DSHOW_PORT: String(PORT),
  DSHOW_DATA_DIR: dataDir,
  DSHOW_ADMIN_USER: 'tester',
  DSHOW_ADMIN_PASSWORD: 'Test12345',
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

async function call(pathname, { method = 'GET', body, cookie, raw = false, headers = {} } = {}) {
  const init = {
    method,
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131',
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
  };
  if (body !== undefined) {
    if (body instanceof Uint8Array) {
      init.body = body;
    } else {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const response = await fetch(`${BASE}${pathname}`, init);
  const text = await response.text();
  if (raw) return { status: response.status, text };
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: response.status, data, session: cookieValue(response, 'dshow_session') };
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

try {
  if (!(await waitReady())) throw new Error('сервер не поднялся');

  /* ---- администратор: своё рабочее место с первого входа ---- */
  const admin = await login('tester', 'Test12345');
  check('вход администратора', admin.status === 200, `HTTP ${admin.status}`);
  const adminCookie = `dshow_session=${admin.session}`;
  const adminProjectsAtStart = admin.data.projects || [];
  check('у администратора появился свой проект', adminProjectsAtStart.length === 1, JSON.stringify(adminProjectsAtStart.map((p) => p.name)));
  const adminProject = adminProjectsAtStart[0];
  check('у проекта есть свой диалог', Boolean(adminProject?.chats?.length), `диалогов: ${adminProject?.chats?.length || 0}`);
  const adminChatId = adminProject?.chats?.[0]?.id || '';

  const extraProject = await call('/api/projects', { method: 'POST', body: { name: 'Проект админа' }, cookie: adminCookie });
  const extraProjectId = extraProject.data?.project?.id || '';
  check('администратор создаёт второй проект', Boolean(extraProjectId), `HTTP ${extraProject.status}`);

  const upload = await call('/api/attachments', {
    method: 'POST',
    cookie: adminCookie,
    raw: true,
    headers: { 'content-type': 'text/plain', 'x-filename': encodeURIComponent('secret.txt'), 'x-project-id': extraProjectId, 'x-chat-id': adminChatId },
    body: new Uint8Array(Buffer.from('данные администратора')),
  });
  check('администратор загружает файл', upload.status === 200, `HTTP ${upload.status}`);
  const adminAttachmentId = (() => {
    try {
      return JSON.parse(upload.text).attachment?.id || '';
    } catch {
      return '';
    }
  })();

  /* ---- администратор заводит обычного пользователя ---- */
  const created = await call('/api/admin/users', { method: 'POST', cookie: adminCookie, body: { username: 'boris', password: 'Boris-pass-2026' } });
  const borisId = created.data?.user?.id || '';
  check('администратор создаёт пользователя', created.status === 200 && Boolean(borisId), `HTTP ${created.status}`);

  const bob = await login('boris', 'Boris-pass-2026');
  const bobCookie = `dshow_session=${bob.session}`;
  check('вход второго пользователя', bob.status === 200, `HTTP ${bob.status}`);
  const bobProjects = bob.data.projects || [];
  check('у второго пользователя только свои проекты', bobProjects.every((project) => project.id !== extraProjectId), `проектов: ${bobProjects.length}`);
  check('второй пользователь сразу получает личный проект', bobProjects.length === 1 && bobProjects[0].name === 'Мой проект', JSON.stringify(bobProjects.map((p) => p.name)));
  const bobProjectId = bobProjects[0]?.id || '';
  const bobChatId = bobProjects[0]?.chats?.[0]?.id || '';
  check('личный диалог второго пользователя создан', Boolean(bobChatId));

  /* ---- чужое не открывается ---- */
  const probes = [
    ['чужой проект', `/api/projects/${extraProjectId}`],
    ['диалоги чужого проекта', `/api/projects/${extraProjectId}/chats`],
    ['файлы чужого проекта', `/api/projects/${extraProjectId}/files`],
    ['чужой диалог', `/api/chats/${adminChatId}`],
    ['чужое вложение', `/api/attachments/${adminAttachmentId}`],
    ['админский список пользователей', '/api/admin/users'],
    ['админская статистика', '/api/admin/stats'],
  ];
  for (const [label, pathname] of probes) {
    const result = await call(pathname, { cookie: bobCookie });
    const expected = pathname.includes('/admin/') ? 403 : 404;
    check(`закрыто: ${label}`, result.status === expected, `HTTP ${result.status} (ждали ${expected})`);
  }

  const push = await call(`/api/chats/${adminChatId}/messages`, { method: 'POST', cookie: bobCookie, body: { text: 'чужое сообщение' } });
  check('закрыто: запись в чужой диалог', push.status === 404, `HTTP ${push.status}`);

  const deleteFile = await call(`/api/projects/${extraProjectId}/file?path=${encodeURIComponent('uploads/secret.txt')}`, { method: 'DELETE', cookie: bobCookie });
  check('закрыто: удаление чужого файла', deleteFile.status === 404, `HTTP ${deleteFile.status}`);

  /* ---- свой файл виден только своему владельцу ---- */
  const bobUpload = await call(`/api/projects/${bobProjectId}/upload?path=${encodeURIComponent('uploads/note.txt')}`, {
    method: 'POST',
    cookie: bobCookie,
    raw: true,
    headers: { 'content-type': 'text/plain', 'x-filename': encodeURIComponent('note.txt') },
    body: new Uint8Array(Buffer.from('заметка бориса')),
  });
  check('второй пользователь загружает свой файл', bobUpload.status === 200, `HTTP ${bobUpload.status}`);

  const bobFiles = await call(`/api/projects/${bobProjectId}/files`, { cookie: bobCookie });
  const bobFileNames = (bobFiles.data?.items || []).filter((entry) => entry.type !== 'dir').map((entry) => entry.name);
  check('свой файл виден владельцу', bobFileNames.includes('note.txt'), JSON.stringify(bobFileNames.slice(0, 5)));

  const adminSeesBobProject = await call(`/api/projects/${bobProjectId}/files`, { cookie: adminCookie });
  check('файлы второго пользователя не видны администратору', adminSeesBobProject.status === 404, `HTTP ${adminSeesBobProject.status}`);

  /* ---- контекст живёт в своём диалоге ---- */
  const bobChat = await call(`/api/chats/${bobChatId}`, { cookie: bobCookie });
  check('второй пользователь читает свой диалог', bobChat.status === 200, `HTTP ${bobChat.status}`);
  check('история личного диалога пустая', (bobChat.data?.chat?.messages || []).length === 0);
  check('память личного диалога пустая', !bobChat.data?.chat?.memory);

  const newChat = await call(`/api/projects/${bobProjectId}/chats`, { method: 'POST', cookie: bobCookie, body: { title: 'Второй диалог' } });
  const newChatId = newChat.data?.chat?.id || '';
  check('второй диалог создаётся', newChat.status === 200 && Boolean(newChatId), `HTTP ${newChat.status}`);

  const firstChatAfter = await call(`/api/chats/${bobChatId}`, { cookie: bobCookie });
  check('новый диалог не тронул историю первого', (firstChatAfter.data?.chat?.messages || []).length === 0);

  /* ---- удаление аккаунта убирает его данные с диска ---- */
  const bobDir = path.join(dataDir, 'workspaces', bobProjectId);
  check('рабочая папка второго пользователя существует', fs.existsSync(bobDir));

  const removed = await call(`/api/admin/users/${borisId}`, { method: 'DELETE', cookie: adminCookie });
  check('администратор удаляет пользователя', removed.status === 200, `HTTP ${removed.status}`);
  const afterDelete = await call('/api/me', { cookie: bobCookie });
  check('сеанс удалённого пользователя закрыт', afterDelete.status === 401, `HTTP ${afterDelete.status}`);
  check('файлы удалённого пользователя стёрты', !fs.existsSync(bobDir));
  const adminProjects = await call('/api/bootstrap', { cookie: adminCookie });
  check('проекты администратора на месте', (adminProjects.data?.projects || []).length === 2, JSON.stringify((adminProjects.data?.projects || []).map((p) => p.name)));

  const failed = results.filter((item) => !item.ok);
  console.log(`\nИтого: ${results.length - failed.length} ok, ${failed.length} fail`);
  if (failed.length) {
    console.log('Сервер сказал:\n' + log.slice(-2000));
    process.exitCode = 1;
  }
} catch (error) {
  console.error('ОШИБКА', error?.message || error);
  console.error(log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

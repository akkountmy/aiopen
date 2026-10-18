// Наследство прежних версий: проекты, папки и диалоги, созданные до появления
// владельцев, не должны пропасть после перехода на раздельные истории.
// Проверка поднимает настоящий сервер на временных данных.
//
// Запуск: node test/orphans.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.DSHOW_TEST_PORT || 3291);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-orphans-'));
const ADMIN = { username: 'tester', password: 'Test12345' };

const results = [];
function ok(name, extra = '') {
  results.push(true);
  console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`);
}
function fail(name, detail) {
  results.push(false);
  console.log(`  FAIL ${name}: ${detail}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Слепок старого хранилища: ни у проекта, ни у папки, ни у диалога нет владельца. */
fs.mkdirSync(path.join(DATA, 'chats'), { recursive: true });
const stamp = new Date('2026-01-10T09:00:00.000Z').toISOString();
const legacyProject = { id: 'p_legacy000001', name: 'Старый проект', createdAt: stamp, updatedAt: stamp, spentUsd: 0 };
const legacyWorkflow = { id: 'w_legacy000001', name: 'Старая папка', createdAt: stamp, updatedAt: stamp };
const legacyChat = { id: 'c_legacy000001', projectId: legacyProject.id, title: 'Старый диалог', createdAt: stamp, updatedAt: stamp };

fs.writeFileSync(
  path.join(DATA, 'index.json'),
  JSON.stringify({
    version: 2,
    createdAt: stamp,
    users: [],
    sessions: {},
    kicked: {},
    loginAudit: {},
    loginAuditVersion: 2,
    projects: [legacyProject],
    workflows: [legacyWorkflow],
    chats: [legacyChat],
    attachments: { a_legacy000001: { id: 'a_legacy000001', chatId: legacyChat.id, name: 'старый.txt', size: 10 } },
    usage: {},
    approvals: [],
    settings: { registrationOpen: false, visionEnabled: true },
  }),
  'utf8',
);
fs.writeFileSync(path.join(DATA, 'chats', `${legacyChat.id}.json`), JSON.stringify({ messages: [], history: [], memory: '' }), 'utf8');

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    DSHOW_PORT: String(PORT),
    DSHOW_HOST: '127.0.0.1',
    DSHOW_DATA_DIR: DATA,
    DSHOW_ADMIN_USER: ADMIN.username,
    DSHOW_ADMIN_PASSWORD: ADMIN.password,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => {
  serverLog += String(chunk);
});
server.stderr.on('data', (chunk) => {
  serverLog += String(chunk);
});

try {
  let up = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const health = await fetch(`${BASE}/api/health`);
      if (health.ok) {
        up = true;
        break;
      }
    } catch {
      /* ещё поднимается */
    }
    await sleep(250);
  }
  if (!up) throw new Error('сервер не поднялся:\n' + serverLog);
  ok('сервер запущен на временных данных');

  const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  if (loginRes.status !== 200) throw new Error(`вход ${loginRes.status}: ${await loginRes.text()}`);
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  ok('вход администратора');

  const call = async (url, init = {}) => {
    const res = await fetch(BASE + url, { ...init, headers: { ...(init.headers || {}), cookie } });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

  const bootstrap = await call('/api/bootstrap');
  const projects = (bootstrap.body && bootstrap.body.projects) || [];
  const found = projects.find((project) => project.id === legacyProject.id);
  found
    ? ok('старый проект виден администратору', found.name)
    : fail('старый проект виден администратору', `в списке: ${projects.map((p) => p.name).join(', ') || 'пусто'}`);

  if (found) {
    /* ownerId в ответе допустим, только если это идентификатор самого пользователя:
       чужие отметки не должны утекать в браузер. */
    const mine = bootstrap.body.user.id;
    !found.ownerId || found.ownerId === mine
      ? ok('в проекте нет чужих владельцев', found.ownerId ? 'свой id' : 'поля нет')
      : fail('в проекте нет чужих владельцев', found.ownerId);
  }

  const chats = await call(`/api/projects/${legacyProject.id}/chats`);
  const legacyChats = (chats.body && chats.body.chats) || [];
  legacyChats.some((chat) => chat.id === legacyChat.id)
    ? ok('старый диалог на месте', legacyChat.title)
    : fail('старый диалог на месте', `в списке: ${legacyChats.map((c) => c.title).join(', ') || 'пусто'}`);

  const workflows = (bootstrap.body && bootstrap.body.workflows) || [];
  workflows.some((workflow) => workflow.id === legacyWorkflow.id)
    ? ok('старая папка на месте', legacyWorkflow.name)
    : fail('старая папка на месте', `в списке: ${workflows.map((w) => w.name).join(', ') || 'пусто'}`);

  const chatFile = await call(`/api/chats/${legacyChat.id}`);
  chatFile.status === 200 ? ok('старый диалог открывается', `HTTP ${chatFile.status}`) : fail('старый диалог открывается', `HTTP ${chatFile.status}`);

  /* Второй пользователь не должен увидеть чужое наследство. */
  const createUser = await call('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boris', password: 'Boris-pass-2026', role: 'user' }),
  });
  createUser.status === 200 ? ok('второй пользователь создан') : fail('второй пользователь создан', JSON.stringify(createUser.body));

  const borisLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boris', password: 'Boris-pass-2026' }),
  });
  const borisCookie = (borisLogin.headers.get('set-cookie') || '').split(';')[0];
  const borisBootstrap = await fetch(`${BASE}/api/bootstrap`, { headers: { cookie: borisCookie } }).then((res) => res.json());
  const borisProjects = borisBootstrap.projects || [];
  borisProjects.some((project) => project.id === legacyProject.id)
    ? fail('наследство не видно второму пользователю', 'старый проект в списке')
    : ok('наследство не видно второму пользователю', `своих проектов: ${borisProjects.length}`);
  borisProjects.some((project) => project.name === 'Мой проект')
    ? ok('второму пользователю выдан личный проект')
    : fail('второму пользователю выдан личный проект', borisProjects.map((p) => p.name).join(', ') || 'пусто');

  /* Владельцы должны быть проставлены на диске, а не только в памяти. */
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
  const ownerless = [
    ...saved.projects.filter((item) => !item.ownerId),
    ...saved.chats.filter((item) => !item.ownerId),
    ...saved.workflows.filter((item) => !item.ownerId),
  ];
  ownerless.length === 0
    ? ok('все записи получили владельца', `проектов ${saved.projects.length}, диалогов ${saved.chats.length}`)
    : fail('все записи получили владельца', `без владельца: ${ownerless.length}`);
} finally {
  server.kill();
}

/* Второй сценарий: пока аккаунтов несколько, при старте никто ничего не забирает,
   а наследство достаётся тому, кто первым открыл рабочее место. */
const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-orphans2-'));
fs.writeFileSync(
  path.join(DATA2, 'index.json'),
  JSON.stringify({
    version: 2,
    createdAt: stamp,
    users: [
      { id: 'u_first', username: 'first', usernameLower: 'first', displayName: 'first', role: 'admin', password: 'x:y', disabled: false, creditUsd: 0, spentUsd: 0 },
      { id: 'u_second', username: 'second', usernameLower: 'second', displayName: 'second', role: 'user', password: 'x:y', disabled: false, creditUsd: 0, spentUsd: 0 },
    ],
    sessions: {},
    kicked: {},
    loginAudit: {},
    loginAuditVersion: 2,
    projects: [{ ...legacyProject }],
    workflows: [],
    chats: [{ ...legacyChat }],
    attachments: {},
    usage: {},
    approvals: [],
    settings: { registrationOpen: false, visionEnabled: true },
  }),
  'utf8',
);

process.env.DSHOW_DATA_DIR = DATA2;
const { store } = await import('../src/store.mjs');
store.init({ adminUsername: 'first', adminPassword: '' });
const untouched = store.state.projects.every((project) => !project.ownerId);
untouched ? ok('при двух аккаунтах старт ничего не забирает') : fail('при двух аккаунтах старт ничего не забирает', 'владелец проставлен');
const claimed = store.claimOrphans('u_second');
claimed >= 2 ? ok('наследство достаётся вошедшему', `записей: ${claimed}`) : fail('наследство достаётся вошедшему', `записей: ${claimed}`);
store.projectsFor('u_second').some((project) => project.id === legacyProject.id)
  ? ok('вошедший видит старый проект')
  : fail('вошедший видит старый проект', 'список пуст');
store.projectsFor('u_first').length === 0
  ? ok('второй аккаунт ничего не получил')
  : fail('второй аккаунт ничего не получил', `проектов: ${store.projectsFor('u_first').length}`);
store.claimOrphans('u_first') === 0
  ? ok('повторная передача ничего не меняет')
  : fail('повторная передача ничего не меняет', 'записи переехали');
try {
  fs.rmSync(DATA2, { recursive: true, force: true });
} catch {
  /* каталог мог остаться заблокированным */
}

console.log(`\nИтого: ${results.filter(Boolean).length} ok, ${results.filter((item) => !item).length} fail`);
try {
  fs.rmSync(DATA, { recursive: true, force: true });
} catch {
  /* каталог мог остаться заблокированным */
}
process.exit(results.every(Boolean) ? 0 : 1);

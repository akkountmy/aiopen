// Папки проектов (workflows) на уровне API: создание, проект внутри папки,
// переименование, перемещение и удаление папки, когда проекты остаются.
// Из интерфейса папку создать нельзя, но старые папки должны работать —
// поэтому проверка идёт по HTTP, а сервер поднимается на временных данных.
//
// Запуск: node test/workflows.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.DSHOW_TEST_PORT || 3293);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-workflows-'));
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
    const options = { ...init, headers: { ...(init.headers || {}), cookie } };
    if (init.body && typeof init.body !== 'string') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(init.body);
    }
    const res = await fetch(BASE + url, options);
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };

  const me = await call('/api/me');
  Array.isArray(me.body && me.body.workflows)
    ? ok('список папок в /api/me', `${me.body.workflows.length}`)
    : fail('список папок в /api/me', JSON.stringify(me.body).slice(0, 120));

  const created = await call('/api/workflows', { method: 'POST', body: { name: 'Тестовая папка' } });
  const flowId = created.body && created.body.workflow && created.body.workflow.id;
  created.status === 200 && flowId
    ? ok('папка создаётся', created.body.workflow.name)
    : fail('создание папки', `${created.status} ${JSON.stringify(created.body).slice(0, 120)}`);

  const empty = await call('/api/workflows', { method: 'POST', body: { name: '   ' } });
  empty.status === 400 ? ok('пустое имя папки отклонено') : fail('пустое имя папки', String(empty.status));

  const project = await call('/api/projects', { method: 'POST', body: { name: 'Проект в папке', workflowId: flowId } });
  const projectId = project.body && project.body.project && project.body.project.id;
  project.body && project.body.project && project.body.project.workflowId === flowId
    ? ok('проект ложится в папку')
    : fail('проект в папке', JSON.stringify(project.body).slice(0, 120));

  const bad = await call('/api/projects', { method: 'POST', body: { name: 'Без папки', workflowId: 'w_missing' } });
  bad.status === 404 ? ok('несуществующая папка отклонена') : fail('чужая папка', String(bad.status));

  const renamed = await call(`/api/workflows/${flowId}`, { method: 'PATCH', body: { name: 'Папка 2026' } });
  renamed.body && renamed.body.workflow && renamed.body.workflow.name === 'Папка 2026'
    ? ok('папка переименовывается', renamed.body.workflow.name)
    : fail('переименование папки', JSON.stringify(renamed.body).slice(0, 120));

  const out = await call(`/api/projects/${projectId}`, { method: 'PATCH', body: { workflowId: null } });
  out.body && out.body.project && out.body.project.workflowId === null
    ? ok('проект выносится в корень')
    : fail('проект в корень', JSON.stringify(out.body).slice(0, 120));

  const back = await call(`/api/projects/${projectId}`, { method: 'PATCH', body: { workflowId: flowId } });
  back.body && back.body.project && back.body.project.workflowId === flowId
    ? ok('проект возвращается в папку')
    : fail('проект обратно в папку', JSON.stringify(back.body).slice(0, 120));

  const me2 = await call('/api/me');
  (me2.body && me2.body.workflows || []).some((item) => item.id === flowId)
    ? ok('папка видна в списке')
    : fail('папка в списке', JSON.stringify(me2.body && me2.body.workflows).slice(0, 120));

  const removed = await call(`/api/workflows/${flowId}`, { method: 'DELETE' });
  removed.status === 200 && (removed.body.movedProjects || []).includes(projectId)
    ? ok('папка удаляется, проекты переезжают в корень')
    : fail('удаление папки', `${removed.status} ${JSON.stringify(removed.body).slice(0, 120)}`);

  const me3 = await call('/api/me');
  const survivor = ((me3.body && me3.body.projects) || []).find((item) => item.id === projectId);
  survivor && survivor.workflowId === null ? ok('проект остался без папки') : fail('проект после удаления папки', JSON.stringify(survivor));
  !((me3.body && me3.body.workflows) || []).some((item) => item.id === flowId)
    ? ok('папки больше нет в списке')
    : fail('папка осталась в списке', String(flowId));

  if (projectId) {
    const cleaned = await call(`/api/projects/${projectId}`, { method: 'DELETE' });
    cleaned.status === 200 ? ok('уборка: проект удалён') : fail('уборка', String(cleaned.status));
  }
} catch (error) {
  fail('проверка', error.message);
} finally {
  server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\nИтого: ${passed} ok, ${results.length - passed} fail`);
process.exit(results.length - passed ? 1 : 0);

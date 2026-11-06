/* Потолок памяти на HTTP-пути: при памяти выше потолка сервис обязан ответить
   «занято» (503 + Retry-After), а не упасть по OOM вместе с чужими диалогами.

   Проверяем на настоящем сервере, но с заведомо низким потолком
   (DSHOW_MAX_RSS_MB=40 при реальных ~120 MB): память «на пределе» с первой
   секунды, поэтому OOM-сценарий воспроизводится без риска для живого сервиса.
   Второй прогон с потолком 0 — контроль: тот же запрос проходит, значит отказ
   дал именно потолок, а не что-то ещё.

   Запуск: node test/memory-pressure-http.mjs */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = Number(process.env.DSHOW_MOCK_PORT || 3391);

/* Заглушка модели: короткий поток, чтобы запрос доходил до конца, если его пустили. */
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk.toString();
  });
  req.on('end', () => {
    if (!String(req.url || '').includes('/v1/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'только /v1' }));
      return;
    }
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Готово.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Готово.' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

let portSeq = 0;

/** Поднимает сервер с заданным потолком памяти; возвращает ручки управления. */
async function startServer(limitMb) {
  portSeq += 1;
  const port = Number(process.env.DSHOW_TEST_PORT || 3400) + portSeq;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-mem-'));
  const env = {
    ...process.env,
    DSHOW_HOST: '127.0.0.1',
    DSHOW_PORT: String(port),
    DSHOW_DATA_DIR: dataDir,
    DSHOW_ADMIN_USER: 'tester',
    DSHOW_ADMIN_PASSWORD: 'Test12345',
    DSHOW_TG_TOKEN: '',
    DSHOW_TG_CHAT: '',
    DSHOW_DEEPSEEK_KEY: 'test-key',
    DSHOW_MODEL_BASE: `http://127.0.0.1:${MOCK_PORT}/v1`,
    DSHOW_DASHBOARD: '0',
    DSHOW_MAX_RSS_MB: String(limitMb),
    DSHOW_AUTO_RESUME: '0',
    OPENROUTER_API_KEY: '',
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    log += chunk.toString();
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) break;
    } catch {
      /* сервер ещё поднимается */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { child, base, dataDir, log: () => log };
}

function cookieHeader(response) {
  const headers = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  return headers.map((header) => header.split(';')[0]).filter(Boolean).join('; ');
}

async function login(base) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131' },
    body: JSON.stringify({ username: 'tester', password: 'Test12345' }),
  });
  const cookie = cookieHeader(response);
  if (response.status !== 200 || !cookie) {
    const text = await response.text();
    throw new Error(`вход не удался: код ${response.status}, cookie «${cookie}», ответ ${text.slice(0, 120)}`);
  }
  return cookie;
}

async function call(base, pathname, { method = 'GET', body, cookie } = {}) {
  const init = { method, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131' } };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${pathname}`, init);
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: response.status, data, headers: response.headers };
}

/** Готовит проект и диалог, возвращает id диалога. */
async function prepareChat(base) {
  const cookie = await login(base);
  const project = await call(base, '/api/projects', { method: 'POST', cookie, body: { name: 'Память' } });
  const projectId = project.data?.project?.id || project.data?.id;
  const created = await call(base, `/api/projects/${projectId}/chats`, { method: 'POST', cookie, body: {} });
  const chatId = created.data?.chat?.id || created.data?.id;
  return { cookie, chatId, projectId };
}

/* --- прогон 1: потолок ниже реальной памяти → честный отказ --- */
const tight = await startServer(40);
try {
  const { cookie, chatId } = await prepareChat(tight.base);
  const health = await call(tight.base, '/api/health');
  const rss = Number(health.data?.load?.memory?.rssMb || 0);
  check('память процесса выше потолка', rss >= 40, `rss ${rss} MB при потолке 40 MB`);

  const response = await fetch(`${tight.base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131' },
    body: JSON.stringify({ text: 'сколько будет 2+2' }),
  });
  const text = await response.text();
  check('запрос отклонён кодом 503', response.status === 503, `код ${response.status}`);
  check('есть Retry-After: 60', response.headers.get('retry-after') === '60', `Retry-After ${response.headers.get('retry-after')}`);
  check('в ответе сказано про предел памяти', /на пределе памяти/.test(text), text.slice(0, 120).replace(/\s+/g, ' '));
  check('в журнале есть строка отказа', /\[capacity\] память [\d.]+ MB выше потолка/.test(tight.log()), (tight.log().match(/\[capacity\][^\n]*/) || ['нет строки'])[0]);

  const alive = await call(tight.base, '/api/health');
  check('процесс жив после отказа', alive.status === 200 && alive.data?.ok === true, `код ${alive.status}`);
} finally {
  tight.child.kill();
  fs.rmSync(tight.dataDir, { recursive: true, force: true });
}

/* --- прогон 2: контроль, потолок 0 (без предела) → тот же запрос проходит --- */
const loose = await startServer(0);
try {
  const { cookie, chatId } = await prepareChat(loose.base);
  const response = await fetch(`${loose.base}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/131' },
    body: JSON.stringify({ text: 'сколько будет 2+2' }),
  });
  const text = await response.text();
  check('без потолка запрос не отклоняется по памяти', response.status !== 503, `код ${response.status}, начало: ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
} finally {
  loose.child.kill();
  fs.rmSync(loose.dataDir, { recursive: true, force: true });
}

mock.close();
const failed = results.filter((item) => !item.ok).length;
console.log(failed ? `\n${failed} из ${results.length} не прошли` : `\nвсе ${results.length} прошли`);
process.exit(failed ? 1 : 0);

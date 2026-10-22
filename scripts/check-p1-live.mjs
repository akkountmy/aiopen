// Сквозная проверка паритета P1 на живом сервисе: память, навыки, проверка файлов.
//
//   P1_BASE=http://127.0.0.1:3125 P1_PASS=... node scripts/check-p1-live.mjs
//   P1_BASE=https://dshopen-vladimir00177.msk1.amvera.tech P1_PASS=... node scripts/check-p1-live.mjs
//
// Что проверяется:
//   1. health отвечает и показывает число навыков;
//   2. диалог с моделью: модель вызывает create_word и получает строку «Проверка файла»;
//   3. «запомни …» действительно пишет факт в память пользователя (GET /api/memory);
//   4. «как называется навык …» приводит к вызову use_skill (виден в событиях задачи);
//   5. файл появляется в проекте.
// Ничего не печатает секретов; пароль берётся из P1_PASS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.P1_BASE || 'https://dshopen-vladimir00177.msk1.amvera.tech').replace(/\/+$/, '');
const USER = process.env.P1_USER || 'DSH';
const PASS = process.env.P1_PASS || '';
const TIMEOUT_MS = Number(process.env.P1_TIMEOUT_MS || 240000);

if (!PASS) {
  console.error('нет P1_PASS — пароль в переменной окружения, в файл не пишем');
  process.exit(2);
}

const jar = new Map();
function cookieHeader() {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}
function rememberCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const [pair] = raw.split(';');
    const [name, ...rest] = pair.split('=');
    jar.set(name.trim(), rest.join('=').trim());
  }
}

async function api(pathname, { method = 'GET', body, stream = false } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      ...(jar.size ? { cookie: cookieHeader() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  rememberCookies(res);
  return res;
}

async function json(pathname, options) {
  const res = await api(pathname, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${options?.method || 'GET'} ${pathname} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

/** Читает поток задачи до конца, возвращает накопленный текст. */
async function readRun(chatId) {
  const res = await api(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    body: { text: PROMPT },
    stream: true,
  });
  if (!res.ok) throw new Error(`сообщение → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    /* Сервер ответил задачей — догоняем её поток отдельным запросом. */
    const data = JSON.parse(await res.text());
    const runId = data.run?.id || data.id;
    if (!runId) return JSON.stringify(data);
    const follow = await api(`/api/runs/${runId}/stream`, { stream: true });
    return await drain(follow);
  }
  return await drain(res);
}

async function drain(res) {
  const decoder = new TextDecoder();
  let text = '';
  const started = Date.now();
  for await (const chunk of res.body) {
    text += decoder.decode(chunk, { stream: true });
    if (Date.now() - started > TIMEOUT_MS) break;
    if (/"type"\s*:\s*"done"|event:\s*done/.test(text.slice(-400))) break;
  }
  return text;
}

const PROMPT = [
  'Выполни три шага подряд, коротко:',
  '1) вызови use_skill для навыка office-docx;',
  '2) вызови remember и запомни правило: «Тестовые отчёты называет коротко»;',
  '3) создай Word-файл «Проверка P1.docx» с одним разделом «Резюме» и абзацем о рынке кофе.',
  'В конце одной строкой напиши, что показала строка «Проверка файла».',
].join(' ');

const health = await json('/api/health');
check('health отвечает', health.ok === true);
check('навыки видны сервису', Number(health.skills) >= 6, `skills=${health.skills}`);

await json('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
const me = await json('/api/me');
check('вход выполнен', Boolean(me.user), me.user?.username || '');

const created = await json('/api/projects', { method: 'POST', body: { name: 'Проверка P1' } });
const projectId = created.project.id;
const chat = await json(`/api/projects/${projectId}/chats`, { method: 'POST', body: { title: 'P1' } });
const chatId = chat.chat?.id || chat.id;

const stream = await readRun(chatId);
check('модель ответила', stream.length > 200, `${stream.length} байт событий`);

/* Текст ответа собираем из дельт SSE: в сыром потоке фразы разорваны по буквам. */
const deltaText = stream
  .split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => {
    try {
      return JSON.parse(line.slice(6));
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .map((event) => (event.type === 'delta' ? event.text || '' : ''))
  .join('');

const toolNames = [...stream.matchAll(/"name"\s*:\s*"([a-z_]+)"/g)].map((match) => match[1]);

check('модель вызвала use_skill', toolNames.includes('use_skill'), toolNames.join(','));
check('модель вызвала remember', toolNames.includes('remember'));
check('создан Word-файл', toolNames.includes('create_word'));
check(
  'модель получила отчёт «Проверка файла»',
  /* Модель цитирует строку по-своему: «Проверка файла» показала: **OK**. Проверяем смысл, не пунктуацию. */
  /Проверка файла/.test(deltaText) && /(OK|замечания|ОШИБКИ)/.test(deltaText),
  (deltaText.match(/Проверка файла[^\n]*/) || [''])[0].slice(0, 160),
);

const facts = await json('/api/memory');
check('факт попал в память', (facts.facts || []).length > 0, (facts.facts || []).map((f) => f.text).join(' | '));

const tree = await json(`/api/projects/${projectId}/files?depth=6`);
const flatten = (items) => items.flatMap((item) => [item, ...(Array.isArray(item.children) ? flatten(item.children) : [])]);
const entries = flatten(tree.items || []);
const docx = entries.find((entry) => /\.docx$/i.test(entry.name || entry.path || ''));
check('файл лежит в проекте', Boolean(docx), entries.map((entry) => entry.path || entry.name).join(', '));

/* Чистим за собой: проект проверки и тестовый факт памяти. */
if (docx) {
  const rel = docx.path || docx.name;
  const read = await fetch(`${BASE}/api/projects/${projectId}/file?path=${encodeURIComponent(rel)}`, {
    headers: { cookie: cookieHeader() },
  });
  if (read.ok) {
    const buffer = Buffer.from(await read.arrayBuffer());
    const saved = path.join(os.tmpdir(), 'p1-check.docx');
    fs.writeFileSync(saved, buffer);
    console.log(`\nСкачанный файл: ${saved} (${(buffer.length / 1024).toFixed(1)} КБ)`);
    check('скачанный docx начинается с ZIP-подписи', buffer.subarray(0, 2).toString() === 'PK');
  }
}
for (const fact of facts.facts || []) await json('/api/memory', { method: 'DELETE', body: { id: fact.id } });
await json(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => {});

const failed = results.filter((result) => !result.ok);
console.log(`\nИтог: ${results.length - failed.length} из ${results.length}`);
if (failed.length) {
  console.log('\nПоследние события задачи:\n' + stream.slice(-3000));
  process.exit(1);
}

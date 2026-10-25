// Замер производительности живого сервиса: сколько идёт ход, когда приходит
// первый знак ответа, сколько заняли инструменты.
//
//   MEASURE_BASE=https://dshopen-vladimir00177.msk1.amvera.tech MEASURE_PASS=... node scripts/measure-live.mjs
//   MEASURE_BASE=http://127.0.0.1:3141 MEASURE_PASS=... node scripts/measure-live.mjs
//
// Замер ничего не оставляет после себя: созданный проект удаляется в конце.
// Пароль читается только из переменной окружения и никуда не печатается.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.MEASURE_BASE || 'https://dshopen-vladimir00177.msk1.amvera.tech').replace(/\/+$/, '');
const USER = process.env.MEASURE_USER || 'DSH';
const PASS = process.env.MEASURE_PASS || '';
const ROUNDS = Math.max(1, Number(process.env.MEASURE_ROUNDS || 1));

if (!PASS) {
  console.error('нет MEASURE_PASS — пароль в переменной окружения, в файл не пишем');
  process.exit(2);
}

const jar = new Map();
const cookieHeader = () => [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
function rememberCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const [pair] = raw.split(';');
    const [name, ...rest] = pair.split('=');
    jar.set(name.trim(), rest.join('=').trim());
  }
}

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
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

/* Один ход: POST /api/chats/<id>/messages, ответ приходит потоком SSE.
   Считаем три числа: до первого знака ответа, до первого шага модели и всё
   время хода. Ещё собираем, какие события пришли, — по ним видно, был ли
   инструмент, ревью и сколько шагов сделал агент. */
async function turn(chatId, text) {
  const startedAt = Date.now();
  let firstDeltaMs = null;
  let firstStepMs = null;
  let answer = '';
  const events = [];
  const tools = [];
  const toolIds = new Set();
  const res = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(jar.size ? { cookie: cookieHeader() } : {}),
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`ход → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const line = frame.split('\n').find((item) => item.startsWith('data: '));
      if (!line) continue;
      let data;
      try {
        data = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      const kind = String(data.type || '');
      events.push(kind);
      if (kind === 'delta' && firstDeltaMs === null) firstDeltaMs = Date.now() - startedAt;
      if (kind === 'progress' && firstStepMs === null) firstStepMs = Date.now() - startedAt;
      if (kind === 'delta' && data.text) answer += data.text;
      /* Один вызов инструмента приходит двумя событиями (запуск и итог) —
         считаем вызовы по id, иначе «calculate, calculate» врёт о двух шагах. */
      if (kind === 'tool') {
        const key = String(data.id || data.name || '');
        if (!toolIds.has(key)) {
          toolIds.add(key);
          tools.push(String(data.name || data.tool || ''));
        }
      }
      if (kind === 'done' && data.usage) usage = data.usage;
    }
  }
  return { text, ms: Date.now() - startedAt, firstDeltaMs, firstStepMs, events, tools, usage, answer };
}

/* Качество документа проверяем не на слово: скачиваем созданный файл и
   прогоняем его тем же чекером, что и сервис (src/doccheck.mjs). */
async function checkCreatedDocs(projectId) {
  const { checkDocument, formatCheckReport, documentExcerpt } = await import('../src/doccheck.mjs');
  const res = await api(`/api/projects/${projectId}/files`);
  if (!res.ok) return { error: `файлы → ${res.status}` };
  const listing = await res.json();
  const items = Array.isArray(listing.items) ? listing.items.flatMap((item) => item.children || [item]) : [];
  const docs = items.filter((item) => /\.(docx|xlsx|pptx)$/i.test(String(item.name || '')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-docs-'));
  const out = [];
  for (const doc of docs) {
    const fileRes = await fetch(`${BASE}/api/projects/${projectId}/file?path=${encodeURIComponent(doc.path || doc.name)}`, {
      headers: jar.size ? { cookie: cookieHeader() } : {},
    });
    if (!fileRes.ok) {
      out.push({ name: doc.name, error: `скачивание → ${fileRes.status}` });
      continue;
    }
    const local = path.join(dir, String(doc.name));
    fs.writeFileSync(local, Buffer.from(await fileRes.arrayBuffer()));
    const check = await checkDocument(local);
    const excerpt = await documentExcerpt(local, { chars: 300 }).catch(() => '');
    out.push({
      name: doc.name,
      bytes: fs.statSync(local).size,
      ok: check?.ok ?? null,
      report: formatCheckReport(check).slice(0, 600),
      excerpt: String(excerpt || '').slice(0, 200),
    });
  }
  return { files: docs.map((doc) => doc.name), docs: out };
}

function report(row) {  const short = row.answer.replace(/\s+/g, ' ').slice(0, 90);
  return [
    `«${row.text.slice(0, 48)}…»`,
    `всего ${row.ms} мс`,
    `первый знак ${row.firstDeltaMs ?? '—'} мс`,
    `первый шаг ${row.firstStepMs ?? '—'} мс`,
    `инструменты: ${row.tools.length ? row.tools.join(', ') : 'нет'}`,
    `события: ${[...new Set(row.events)].join(', ')}`,
    `ответ: ${short || '(пусто)'}`,
  ].join(' | ');
}

async function main() {
  const login = await api('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
  if (!login.ok) throw new Error(`вход → ${login.status}`);
  await login.text();

  const healthPing = Date.now();
  const health = await json('/api/health');
  const healthMs = Date.now() - healthPing;

  const project = await json('/api/projects', { method: 'POST', body: { name: `Замер скорости ${new Date().toISOString().slice(0, 16)}` } });
  const projectId = project.project?.id || project.id;
  const chat = await json(`/api/projects/${projectId}/chats`, { method: 'POST', body: { title: 'Замер' } });
  const chatId = chat.chat?.id || chat.id;

  const probes = [
    'Сколько будет 17*23? Ответь одной строкой, без инструментов.',
    'Посчитай 123456*789 через calculate и назови только результат.',
  ];
  if (process.env.MEASURE_DOC === '1') {
    probes.push('Создай Word-документ «Замер качества» про смету ремонта офиса: обложка, два раздела и таблица из трёх строк. Файл положи в проект.');
  }
  const rows = [];
  let docCheck = null;
  try {
    for (let round = 0; round < ROUNDS; round++) {
      for (const text of probes) rows.push(await turn(chatId, text));
    }
    if (process.env.MEASURE_DOC === '1') docCheck = await checkCreatedDocs(projectId);
  } finally {
    await api(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => {});
  }

  const out = {
    base: BASE,
    healthMs,
    skills: health.skills ?? null,
    docs: health.docs ?? null,
    probes: rows.map((row) => ({
      text: row.text,
      ms: row.ms,
      firstDeltaMs: row.firstDeltaMs,
      firstStepMs: row.firstStepMs,
      tools: row.tools,
      events: [...new Set(row.events)],
      answer: row.answer.slice(0, 200),
      usage: row.usage,
    })),
    docCheck,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
  const file = path.join(dir, 'measure.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`сервис: ${BASE}  (health ${healthMs} мс, навыков ${out.skills ?? '—'}, движки ${JSON.stringify(out.docs)})`);
  for (const row of rows) console.log(report(row));
  if (docCheck) {
    if (docCheck.error) console.log(`\nдокументы: ${docCheck.error}`);
    else if (!docCheck.docs?.length) console.log('\nдокументы: файл не создан');
    else {
      for (const doc of docCheck.docs) {
        console.log(`\nдокумент ${doc.name}: ${doc.bytes ?? '—'} байт, проверка ${doc.ok === null ? '—' : doc.ok ? 'пройдена' : 'ПРОВАЛЕНА'}`);
        console.log(String(doc.report || doc.error || '').replace(/\n/g, ' ').slice(0, 400));
      }
    }
  }
  console.log(`\nполные данные: ${file}`);
}

await main();

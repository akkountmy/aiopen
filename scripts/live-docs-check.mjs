/**
 * Живая проверка документов на развёрнутом сервисе: входим как администратор,
 * создаём проект, просим модель собрать Word / Excel / PowerPoint / PDF и
 * складываем скачанные файлы в .live-docs для локальной проверки.
 *
 *   $env:DSHOW_USER='...'; $env:DSHOW_PASS='...'; node scripts/live-docs-check.mjs
 *   $env:DSHOW_BASE='https://dshopen-vladimir00177.msk1.amvera.tech'
 *   $env:DSHOW_LIVE_KEEP='1' — не удалять проект после проверки
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.DSHOW_BASE || 'http://127.0.0.1:3123').replace(/\/$/, '');
const USERNAME = process.env.DSHOW_USER || '';
const PASSWORD = process.env.DSHOW_PASS || '';
const OUT = path.join(import.meta.dirname, '..', '.live-docs');
const TIMEOUT_MS = Number(process.env.DSHOW_LIVE_TIMEOUT || 240000);

let cookie = '';

async function call(p, { method = 'GET', body, expect = 200, auth = true } = {}) {
  const init = { method, headers: {} };
  if (auth && cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${p}`, init);
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (setCookies.length) cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (expect !== null && response.status !== expect) {
    throw new Error(`${method} ${p} → ${response.status} (ждали ${expect}): ${String(JSON.stringify(data)).slice(0, 300)}`);
  }
  return data;
}

/** Отправляет сообщение и ждёт финальное событие SSE. */
async function ask(chatId, text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  let answer = '';
  let tools = 0;
  try {
    const response = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`POST messages → ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 2);
        if (!raw.startsWith('data:')) continue;
        let event;
        try {
          event = JSON.parse(raw.slice(5).trim());
        } catch {
          continue;
        }
        if (event.type === 'delta') answer += event.text || '';
        if (event.type === 'tool') tools += 1;
        if (event.type === 'error') throw new Error(`ошибка модели: ${event.message}`);
        if (event.type === 'done') {
          done = true;
          break;
        }
      }
      if (done) break;
    }
    if (!done) throw new Error('поток закрылся без события done');
  } finally {
    clearTimeout(timer);
  }
  return { answer, tools, seconds: Math.round((Date.now() - started) / 1000) };
}

async function files(projectId) {
  const data = await call(`/api/projects/${projectId}/files?path=.&depth=4`);
  return (data.items || []).filter((item) => item.type !== 'dir' && !item.path.includes('/'));
}

async function download(projectId, rel, targetName) {
  const response = await fetch(`${BASE}/api/projects/${projectId}/file?path=${encodeURIComponent(rel)}&download=1`, {
    headers: { cookie },
  });
  if (!response.ok) throw new Error(`скачивание ${rel} → ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(OUT, { recursive: true });
  const target = path.join(OUT, targetName);
  fs.writeFileSync(target, buffer);
  return { target, size: buffer.length };
}

const CASES = [
  {
    key: 'docx',
    file: 'КП-студия.docx',
    prompt:
      'Сделай Word-документ: коммерческое предложение для студии веб-разработки на разработку корпоративного сайта. ' +
      'Нужны обложка, оглавление, 3 раздела, KPI-строка с ключевыми цифрами, таблица с этапами и итоговой строкой. ' +
      'Файл назови «КП-студия.docx».',
  },
  {
    key: 'xlsx',
    file: 'Финмодель.xlsx',
    prompt:
      'Построй в Excel финансовую модель на 12 месяцев для небольшой онлайн-школы: лист с допущениями, лист с расчётом ' +
      'формулами и сценариями, юнит-экономика и диаграмма выручки по месяцам. Файл назови «Финмодель.xlsx».',
  },
  {
    key: 'pptx',
    file: 'Итоги-года.pptx',
    prompt:
      'Сделай презентацию на 8 слайдов: итоги года компании, выручка и маржа по кварталам с диаграммой, ' +
      'три вывода и план на следующий год. Файл назови «Итоги-года.pptx».',
  },
  {
    key: 'pdf',
    file: 'Отчёт.pdf',
    prompt:
      'Сделай PDF-отчёт формата A4 с обложкой: 3 раздела, KPI-строка, таблица с итоговой строкой, колонтитулы со ' +
      'страницами. Файл назови «Отчёт.pdf».',
  },
];

async function main() {
  if (!USERNAME || !PASSWORD) {
    console.error('Задайте DSHOW_USER и DSHOW_PASS в окружении.');
    process.exit(2);
  }
  console.log(`Живая проверка документов: ${BASE}\n`);

  const health = await call('/api/health', { auth: false });
  console.log('движки:', JSON.stringify(health.docs));

  const login = await call('/api/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD }, auth: false });
  console.log('вход:', login.user.username, `(${login.user.role})`);

  const reuseProject = (process.env.DSHOW_PROJECT || '').trim();
  let projectId;
  if (reuseProject) {
    projectId = reuseProject;
    console.log('проект: переиспользуем', projectId);
  } else {
    const project = await call('/api/projects', {
      method: 'POST',
      body: { name: `Документы — проверка ${new Date().toISOString().slice(0, 16).replace('T', ' ')}` },
    });
    projectId = project.project.id;
    console.log('проект:', project.project.name);
  }

  const chat = await call(`/api/projects/${projectId}/chats`, { method: 'POST', body: {} });
  const chatId = chat.chat.id;

  const results = [];
  const only = String(process.env.DSHOW_LIVE_ONLY || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of only.length ? CASES.filter((row) => only.includes(row.key)) : CASES) {
    process.stdout.write(`\n[${item.key}] прошу «${item.file}» … `);
    try {
      const turn = await ask(chatId, item.prompt);
      const list = await files(projectId);
      const found = list.find((entry) => entry.name.toLowerCase() === item.file.toLowerCase());
      if (!found) {
        results.push({ ...item, ok: false, reason: 'файл не появился', tools: turn.tools, seconds: turn.seconds, answer: turn.answer.slice(-300) });
        console.log(`файл не появился (${turn.seconds} с, инструментов: ${turn.tools})`);
        console.log('ответ модели: ' + turn.answer.replace(/\s+/g, ' ').slice(0, 600));
        continue;
      }
      const saved = await download(projectId, found.path, item.file);
      results.push({
        ...item,
        ok: true,
        size: saved.size,
        tools: turn.tools,
        seconds: turn.seconds,
        answer: turn.answer.slice(-300),
        local: saved.target,
      });
      console.log(`готово: ${Math.round(saved.size / 1024)} КБ, ${turn.seconds} с, инструментов: ${turn.tools}`);
    } catch (error) {
      results.push({ ...item, ok: false, reason: error.message });
      console.log('сбой: ' + error.message);
    }
  }

  console.log('\n==== Итог ====');
  for (const row of results) {
    console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.key.padEnd(5)} ${row.ok ? `${Math.round(row.size / 1024)} КБ` : row.reason}`);
  }
  console.log(`\nСсылка для просмотра: ${BASE}/?project=${projectId}`);
  console.log(`Проект: ${projectId.slice(0, 12)}…  Локальные копии: ${OUT}`);

  if (process.env.DSHOW_LIVE_KEEP !== '1') {
    console.log('Проект оставлен в сервисе для просмотра (удалить вручную, если не нужен).');
  }
  const failed = results.filter((row) => !row.ok);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Проверка не прошла:', error.message);
  process.exit(1);
});

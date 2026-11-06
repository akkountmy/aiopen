/* Индикатор «работаю…» в шапке ответа: кольцо должно ВРАЩАТЬСЯ, а не мигать.
   Проверка живая — в настоящем Chrome, на настоящем сервисе, с медленной
   заглушкой модели, чтобы ответ шёл достаточно долго для замера.

   Два случая:
     1. обычные настройки Windows — кольцо крутится (spin 0,85 с);
     2. «эффекты анимации выключены» (prefers-reduced-motion: reduce) — там
        раньше кольцо подменялось миганием прозрачности, и человек видел точку,
        которая «моргает». Теперь и здесь вращение, только медленнее (1,6 с).

   Для обоих случаев проверяем не только имя анимации, но и сам поворот:
   берём computed transform несколько раз подряд — у вращающегося кольца он
   меняется, у мигающего остаётся единичной матрицей.

   Запуск: node test/ui-spinner.mjs */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHOW_TEST_PORT || 3451);
const MOCK_PORT = Number(process.env.DSHOW_MOCK_PORT || 3452);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-ui-spinner-'));
const ADMIN = { username: 'tester', password: 'Test12345' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const ok = (label, detail = '') => console.log(`  ok  ${label}${detail ? ' — ' + detail : ''}`);
const fail = (label, detail) => {
  failures += 1;
  console.log(`  ПРОВАЛ ${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};
const check = (good, label, detail) => (good ? ok(label, detail) : fail(label, detail));

/* ------------------------------ заглушка модели ------------------------------ */

/* Ответ идёт около 9 секунд: за это время успеваем снять несколько кадров
   вращения. Служебные запросы (заголовок диалога) получают обычный JSON. */
const CHUNKS = ['Считаю ', 'неспешно ', 'и ', 'проверяю ', 'каждую ', 'мелочь, ', 'потому ', 'что ', 'это ', 'проверка ', 'индикатора.'];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk.toString();
  });
  req.on('end', () => {
    if (!req.url || !req.url.includes('/v1/')) {
      res.writeHead(404).end();
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
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Короткий ответ' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      );
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    let index = 0;
    const timer = setInterval(() => {
      if (index < CHUNKS.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: CHUNKS[index] } }] })}\n\n`);
        index += 1;
        return;
      }
      clearInterval(timer);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    }, 750);
    res.on('close', () => clearInterval(timer));
  });
});

/* ---------------------------------- сервис ---------------------------------- */

const env = {
  ...process.env,
  DSHOW_HOST: '127.0.0.1',
  DSHOW_PORT: String(PORT),
  DSHOW_DATA_DIR: dataDir,
  DSHOW_ADMIN_USER: ADMIN.username,
  DSHOW_ADMIN_PASSWORD: ADMIN.password,
  DSHOW_TG_TOKEN: '',
  DSHOW_TG_CHAT: '',
  DSHOW_DEEPSEEK_KEY: 'test-key',
  DSHOW_MODEL_BASE: `http://127.0.0.1:${MOCK_PORT}/v1`,
  DSHOW_DASHBOARD: '0',
  DSHOW_TRUST_PROXY: '0',
  OPENROUTER_API_KEY: '',
};

await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
const app = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
app.stderr.on('data', (chunk) => {
  const line = String(chunk);
  if (!/ExperimentalWarning|localstorage/.test(line)) process.stderr.write(`[сервис] ${line}`);
});

async function waitServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      /* ещё поднимается */
    }
    await sleep(250);
  }
  throw new Error('сервис не поднялся');
}
await waitServer();

const browser = await chromium.launch();

/* Вход, проект и диалог — через API того же контекста: cookie входа живёт в
   общем хранилище контекста, поэтому страница открывается уже авторизованной. */
async function prepare(context, label) {
  const login = await context.request.post(`${BASE}/api/login`, { data: ADMIN });
  if (!login.ok()) throw new Error(`вход не удался: ${login.status()} ${await login.text()}`);
  const project = await context.request.post(`${BASE}/api/projects`, { data: { name: `Индикатор ${label}` } });
  if (!project.ok()) throw new Error(`проект не создался: ${project.status()} ${await project.text()}`);
  const projectId = (await project.json()).project.id;
  const chat = await context.request.post(`${BASE}/api/projects/${projectId}/chats`, { data: {} });
  if (!chat.ok()) throw new Error(`диалог не создался: ${chat.status()} ${await chat.text()}`);
  return (await chat.json()).chat.id;
}

/* Снимок индикатора: чем он рисуется, как быстро и куда повёрнут. */
async function snapshotDot(page) {
  return page.evaluate(() => {
    const dot = document.querySelector('.msg-assistant.streaming .msg-head .dot');
    if (!dot) return null;
    const style = getComputedStyle(dot);
    return {
      name: style.animationName,
      duration: style.animationDuration,
      iteration: style.animationIterationCount,
      transform: style.transform,
      width: style.width,
      height: style.height,
      label: document.querySelector('.msg-assistant.streaming .work-label')?.textContent || '',
    };
  });
}

async function scenario({ reducedMotion, expectDuration, title }) {
  console.log(`\n== ${title} ==`);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const chatId = await prepare(context, reducedMotion);
  await page.goto(`${BASE}/?chat=${chatId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#input', { timeout: 15000 });

  const mediaMatches = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  check(
    mediaMatches === (reducedMotion === 'reduce'),
    'браузер действительно в заданном режиме движения',
    `media=${mediaMatches}`,
  );

  await page.fill('#input', 'Расскажи, что происходит, не торопясь.');
  await page.press('#input', 'Enter');

  await page.waitForSelector('.msg-assistant.streaming .msg-head .dot', { timeout: 20000 });

  /* Вращение видно только по меняющемуся transform: у мигающей точки он
     всегда равен единичной матрице, у вращающейся — углу поворота. */
  const frames = [];
  for (let i = 0; i < 6; i += 1) {
    const shot = await snapshotDot(page);
    if (shot) frames.push(shot);
    await sleep(140);
  }
  check(frames.length === 6, 'индикатор виден всё время ответа (6 кадров)', `кадров ${frames.length}`);
  const last = frames[frames.length - 1] || {};
  check(last.name === 'spin', 'анимация — вращение, а не мигание', `animation-name=${last.name || '—'}`);
  check(last.duration === expectDuration, `длительность вращения ${expectDuration}`, `animation-duration=${last.duration || '—'}`);
  check(last.label.length > 0, 'рядом с кольцом есть подпись (не глухая точка)', JSON.stringify(last.label));

  const distinct = new Set(frames.map((frame) => frame.transform));
  check(distinct.size >= 3, 'кольцо действительно крутится (transform меняется)', `${distinct.size} разных положений из ${frames.length}`);

  const ring = frames[0] || {};
  check(
    ring.width === '13px' && ring.height === '13px',
    'индикатор — кольцо 13×13, а не прежняя точка 6×6',
    `${ring.width}×${ring.height}`,
  );

  /* Останавливаем поток, чтобы задача не висела после теста. */
  const live = await context.request.get(`${BASE}/api/runs`);
  for (const run of (await live.json()).runs || []) {
    await context.request.post(`${BASE}/api/runs/${run.id}/stop`, { data: {} }).catch(() => {});
  }

  check(pageErrors.length === 0, 'на странице нет ошибок JavaScript', pageErrors.join(' | '));
  await context.close();
}

try {
  await scenario({
    reducedMotion: 'reduce',
    expectDuration: '1.6s',
    title: 'эффекты анимации выключены (prefers-reduced-motion: reduce)',
  });
  await scenario({
    reducedMotion: 'no-preference',
    expectDuration: '0.85s',
    title: 'обычные настройки (prefers-reduced-motion: no-preference)',
  });
} finally {
  await browser.close();
  app.kill();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(failures ? `\nПРОВАЛОВ: ${failures}` : '\nВсе проверки пройдены');
process.exit(failures ? 1 : 0);

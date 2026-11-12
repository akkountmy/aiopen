/* Дата и время в ленте: под пузырём просьбы, в шапке ответа и справа в строке
   диалога. Второй диалог откатывается на прошлую неделю — так проверяется вид
   «не сегодня» и то, что подпись не ломает ширину строки.

   Поднимает фальшивую модель (поток SSE) и отдельный экземпляр сервиса во
   временной папке, ходит живым Chrome/Edge. Настоящие данные не трогаются.
   Без браузера проверка пропускается — так же, как остальные ui-*.mjs.

   Запуск: node test/ui-when.mjs */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const MODEL_PORT = 3471;
const APP_PORT = 3472;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-ui-when-'));
const ADMIN = { username: 'DSH', password: 'TestPass-12345' };
/* Час и минуты откатанного сообщения: проверяем, что именно они попали в ленту. */
const PAST = { hour: 9, minute: 14 };

const CHROME = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, живая проверка пропущена');
  process.exit(0);
}

const answer = 'Готово: цифры сверил, выводы в конце.';
const model = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

let app = null;
function startApp() {
  app = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSHOW_PORT: String(APP_PORT),
      DSHOW_HOST: '127.0.0.1',
      DSHOW_DATA_DIR: DIR,
      DSHOW_ADMIN_USER: ADMIN.username,
      DSHOW_ADMIN_PASSWORD: ADMIN.password,
      DSHOW_MODEL_BASE: `http://127.0.0.1:${MODEL_PORT}`,
      DSHOW_DEEPSEEK_KEY: 'test-key',
      DSHOW_DASHBOARD: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', () => {});
  app.stderr.on('data', () => {});
}
async function stopApp() {
  if (!app) return;
  const dying = app;
  app = null;
  dying.kill();
  await new Promise((resolve) => dying.on('exit', resolve));
}
async function waitReady() {
  for (let i = 0; i < 120; i += 1) {
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

let failures = 0;
function check(good, label, detail = '') {
  if (!good) failures += 1;
  console.log(`${good ? '  ok  ' : '  ПРОВАЛ '}${label}${detail ? ` — ${detail}` : ''}`);
}

async function login(browser, viewport) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (error) => check(false, 'ошибка страницы', error.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#loginUser', ADMIN.username);
  await page.fill('#loginPass', ADMIN.password);
  await page.click('#loginSubmit');
  await page.waitForSelector('#auth.hidden', { state: 'attached', timeout: 15000 });
  return page;
}

const TIME = /^\d{2}:\d{2}$/;
const CHAT_STAMP = /^\d{2}\.\d{2} \d{2}:\d{2}$/;
const MESSAGE_STAMP = /^\d{1,2} [а-яё]+( \d{4})?, \d{2}:\d{2}$/i;

async function main() {
  await new Promise((resolve) => model.listen(MODEL_PORT, '127.0.0.1', resolve));
  startApp();
  if (!(await waitReady())) throw new Error('сервер не поднялся');

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await login(browser, { width: 1280, height: 900 });

  const ids = await page.evaluate(async () => {
    const post = async (url, body) => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
      return response.json();
    };
    const project = await post('/api/projects', { name: 'Дата и время' });
    const fresh = await post(`/api/projects/${project.project.id}/chats`, {});
    const old = await post(`/api/projects/${project.project.id}/chats`, {});
    /* При создании проекта появляется пустой диалог — оставляем только два
       рабочих, иначе первый же клик открывает пустышку. */
    const me = await (await fetch('/api/me')).json();
    const chats = me.projects.find((item) => item.id === project.project.id)?.chats || [];
    for (const chat of chats) {
      if (chat.id !== fresh.chat.id && chat.id !== old.chat.id) await fetch(`/api/chats/${chat.id}`, { method: 'DELETE' });
    }
    const rename = (id, title) =>
      fetch(`/api/chats/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
    await rename(fresh.chat.id, 'Свежий диалог');
    await rename(old.chat.id, 'Диалог с прошлой недели');
    return { fresh: fresh.chat.id, old: old.chat.id };
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.project-row .row-main', { hasText: 'Дата и время' }).first().click();

  const chats = [
    { id: ids.fresh, title: 'Свежий диалог', text: 'Сведи цифры за квартал' },
    { id: ids.old, title: 'Диалог с прошлой недели', text: 'Проверь договор от подрядчика' },
  ];
  for (const chat of chats) {
    await page.locator('.chat-row', { hasText: chat.title }).locator('.row-main').click();
    await page.waitForSelector('#composer', { state: 'visible' });
    await page.fill('#input', chat.text);
    await page.press('#input', 'Enter');
    await page.waitForFunction(
      async (id) => {
        const fresh = await (await fetch(`/api/chats/${id}`)).json();
        const last = fresh.chat?.messages?.[fresh.chat.messages.length - 1];
        return Boolean(last) && !last.streaming && (fresh.chat.messages.length >= 2);
      },
      chat.id,
      { timeout: 25000 },
    );
    await page.waitForTimeout(600);
  }

  /* Сегодняшний вид: у просьбы и у ответа — только часы, и они совпадают с
     часами в строке диалога (задача и ответ сделаны в одну минуту). */
  await page.locator('.chat-row', { hasText: 'Свежий диалог' }).locator('.row-main').click();
  await page.waitForSelector('.msg-user .msg-when', { timeout: 10000 });
  const today = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.chat-row')].find((item) => item.querySelector('.c-title')?.textContent?.includes('Свежий диалог'));
    const user = document.querySelector('.msg-user .msg-when');
    const head = document.querySelector('.msg-head .msg-when');
    const bubble = document.querySelector('.msg-user .bubble');
    return {
      row: row?.querySelector('.c-when')?.textContent?.trim() || '',
      rowTitle: row?.querySelector('.c-when')?.title || '',
      user: user?.textContent?.trim() || '',
      userTitle: user?.title || '',
      head: head?.textContent?.trim() || '',
      headTitle: head?.title || '',
      bubbleRight: Math.round(bubble?.getBoundingClientRect().right || 0),
      whenRight: Math.round(user?.getBoundingClientRect().right || 0),
      body: document.body.innerText,
    };
  });
  check(TIME.test(today.row), 'в строке диалога сегодня только часы', today.row);
  check(today.rowTitle.includes(':'), 'подсказка строки диалога знает время', today.rowTitle);
  check(TIME.test(today.user), 'у просьбы стоит время', today.user);
  check(TIME.test(today.head), 'в шапке ответа стоит время', today.head);
  check(today.user === today.head, 'просьба и ответ показывают одно время', `${today.user} / ${today.head}`);
  check(today.userTitle.includes(':') && /\d{4}/.test(today.userTitle), 'в подсказке просьбы есть дата с годом', today.userTitle);
  check(today.headTitle.includes(':') && /\d{4}/.test(today.headTitle), 'в подсказке ответа есть дата с годом', today.headTitle);
  /* Время стоит под пузырём по его правому краю, а не у края колонки. */
  check(Math.abs(today.bubbleRight - today.whenRight) <= 4, 'время под пузырём выровнено по его краю', `${today.bubbleRight} / ${today.whenRight}`);
  check(!/Invalid Date|InvalidDate/.test(today.body), 'в ленте нет «Invalid Date»');

  /* Прошлая неделя: правим файл диалога и метку в индексе, затем поднимаем
     сервис заново — иначе он отдаст диалог из своего кеша. */
  await stopApp();
  const chatFile = path.join(DIR, 'chats', `${ids.old}.json`);
  const data = JSON.parse(fs.readFileSync(chatFile, 'utf8'));
  const past = new Date(Date.now() - 6 * 24 * 3600 * 1000);
  past.setHours(PAST.hour, PAST.minute, 0, 0);
  data.messages = (data.messages || []).map((message, index) => ({
    ...message,
    at: new Date(past.getTime() + index * 30 * 60 * 1000).toISOString(),
  }));
  fs.writeFileSync(chatFile, JSON.stringify(data));
  const indexFile = path.join(DIR, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  for (const chat of index.chats || []) {
    if (chat.id === ids.old) chat.updatedAt = past.toISOString();
  }
  fs.writeFileSync(indexFile, JSON.stringify(index));

  startApp();
  if (!(await waitReady())) throw new Error('сервер не поднялся во второй раз');
  const page2 = await login(browser, { width: 1280, height: 900 });
  await page2.locator('.project-row .row-main', { hasText: 'Дата и время' }).first().click();
  await page2.locator('.chat-row', { hasText: 'Диалог с прошлой недели' }).locator('.row-main').click();
  await page2.waitForSelector('.msg-user .msg-when', { timeout: 10000 });
  const older = await page2.evaluate(() => {
    const row = [...document.querySelectorAll('.chat-row')].find((item) => item.querySelector('.c-title')?.textContent?.includes('Диалог с прошлой недели'));
    return {
      row: row?.querySelector('.c-when')?.textContent?.trim() || '',
      user: document.querySelector('.msg-user .msg-when')?.textContent?.trim() || '',
      head: document.querySelector('.msg-head .msg-when')?.textContent?.trim() || '',
      titleWidth: Math.round(row?.querySelector('.c-title')?.getBoundingClientRect().width || 0),
      titleText: row?.querySelector('.c-title')?.textContent?.trim() || '',
      body: document.body.innerText,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  const pastTime = `${String(PAST.hour).padStart(2, '0')}:${String(PAST.minute).padStart(2, '0')}`;
  check(CHAT_STAMP.test(older.row), 'в строке диалога за прошлую неделю есть дата и время', older.row);
  check(older.row.endsWith(pastTime), 'в строке диалога время последней работы', older.row);
  check(MESSAGE_STAMP.test(older.user), 'у старой просьбы есть день и время', older.user);
  check(older.user.endsWith(pastTime), 'время старой просьбы — то, что записано в диалоге', older.user);
  check(MESSAGE_STAMP.test(older.head), 'у старого ответа есть день и время', older.head);
  check(older.titleWidth > 60, 'подпись времени не съела название диалога', `${older.titleWidth} px, «${older.titleText}»`);
  check(older.overflow <= 0, 'от подписи времени нет горизонтальной прокрутки', `${older.overflow} px`);
  check(!/Invalid Date|InvalidDate/.test(older.body), 'в старом диалоге нет «Invalid Date»');

  /* Телефон: та же лента на 390 px — время не выдавливает текст из пузыря. */
  const mobile = await login(browser, { width: 390, height: 844 });
  await mobile.goto(`${BASE}/?chat=${ids.old}`, { waitUntil: 'domcontentloaded' });
  await mobile.waitForSelector('.msg-user .msg-when', { timeout: 15000 });
  const narrow = await mobile.evaluate(() => {
    const when = document.querySelector('.msg-user .msg-when');
    return {
      user: when?.textContent?.trim() || '',
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      visible: Boolean(when && when.getBoundingClientRect().width > 0),
    };
  });
  check(narrow.visible && MESSAGE_STAMP.test(narrow.user), 'на телефоне время видно', narrow.user);
  check(narrow.overflow <= 0, 'на телефоне нет горизонтальной прокрутки', `${narrow.overflow} px`);

  await browser.close();
  await stopApp();
  await new Promise((resolve) => model.close(resolve));
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(failures ? `\nпровалов: ${failures}` : '\nвсе проверки прошли');
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error('ПРОВАЛ:', error.message);
  await stopApp();
  process.exit(1);
});

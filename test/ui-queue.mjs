/* Живая проверка очереди в браузере: вторая задача видна над полем ввода, её
   текст можно поправить, задачу можно убрать, а после «Стоп» она не стартует
   сама и запускается кнопкой ▶.

   Поднимает поддельную модель (медленный поток), отдельный экземпляр сервиса
   во временной папке и headless Chrome/Edge. Настоящие данные не трогаются.

   Запуск: node test/ui-queue.mjs */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const MODEL_PORT = 3411;
const APP_PORT = 3412;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-ui-queue-'));
const ADMIN = { username: 'DSH', password: 'TestPass-12345' };

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, живая проверка пропущена');
  process.exit(0);
}

const WORDS = ['Первая ', 'задача ', 'ещё ', 'выполняется, ', 'а ', 'эти ', 'строки ', 'показывают, ', 'что ', 'очередь ', 'живая. ', 'Конец.'];
const model = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = {};
    }
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Короткий ответ' }, finish_reason: 'stop' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let index = 0;
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(timer);
        return;
      }
      if (index < WORDS.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: WORDS[index] } }] })}\n\n`);
        index += 1;
        return;
      }
      clearInterval(timer);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }, 600);
  });
});

const app = spawn(process.execPath, ['server.mjs'], {
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
let log = '';
app.stdout.on('data', (chunk) => {
  log += chunk.toString();
});
app.stderr.on('data', (chunk) => {
  log += chunk.toString();
});

let failures = 0;
function check(good, label, detail = '') {
  if (!good) failures += 1;
  console.log(`${good ? '  ok  ' : '  ПРОВАЛ '}${label}${detail ? ` — ${detail}` : ''}`);
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

async function main() {
  await new Promise((resolve) => model.listen(MODEL_PORT, '127.0.0.1', resolve));
  if (!(await waitReady())) throw new Error(`сервер не поднялся\n${log.slice(-1500)}`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => check(false, 'ошибка страницы', error.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await page.fill('#loginUser', ADMIN.username);
  await page.fill('#loginPass', ADMIN.password);
  await page.click('#loginSubmit');
  await page.waitForSelector('#auth.hidden', { state: 'attached', timeout: 10000 });

  const ids = await page.evaluate(async () => {
    const post = async (url, body) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return response.json();
    };
    const project = await post('/api/projects', { name: 'Очередь UI' });
    const created = await post(`/api/projects/${project.project.id}/chats`, {});
    const title = `Очередь UI ${Date.now().toString().slice(-6)}`;
    await fetch(`/api/chats/${created.chat.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    /* При создании проекта появляется пустой диалог — оставляем только тот,
       в который будем писать, иначе первый же клик откроет пустышку. */
    const me = await (await fetch('/api/me')).json();
    const chats = me.projects.find((item) => item.id === project.project.id)?.chats || [];
    for (const chat of chats) {
      if (chat.id !== created.chat.id) await fetch(`/api/chats/${chat.id}`, { method: 'DELETE' });
    }
    return { projectId: project.project.id, chatId: created.chat.id, title };
  });
  check(Boolean(ids.chatId), 'проект и диалог созданы', ids.chatId);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.project-row .row-main', { hasText: 'Очередь UI' }).first().click();
  await page.locator('.chat-row', { hasText: ids.title }).locator('.row-main').click();
  await page.waitForSelector('#composer', { state: 'visible' });

  async function send(text) {
    /* Пока идёт ответ, кнопка отправки уступает место «Стоп», поэтому вторая
       задача отправляется Enter — так же, как это делает человек. */
    await page.fill('#input', text);
    await page.press('#input', 'Enter');
  }

  await send('Первая задача');
  /* Ждём именно живой запуск на сервере, а не только вкладку: иначе вторая
     просьба успеет уйти до регистрации первой и начнёт второй ответ. */
  await page.waitForFunction(
    async (chatId) => {
      const fresh = await (await fetch(`/api/chats/${chatId}`)).json();
      return Boolean(fresh.chat?.run);
    },
    ids.chatId,
    { timeout: 10000 },
  );
  await send('Вторая задача');

  await page.waitForSelector('#queuePanel:not(.hidden)', { timeout: 10000 });
  check((await page.locator('.queue-item').count()) === 1, 'очередь видна над полем ввода');
  check((await page.locator('.queue-text').first().textContent())?.includes('Вторая задача'), 'текст задачи в очереди', await page.locator('.queue-text').first().textContent());

  await page.click('.queue-edit');
  await page.waitForSelector('.queue-edit-textarea', { timeout: 5000 });
  await page.fill('.queue-edit-textarea', 'Вторая задача — уточнённая');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.waitForFunction(() => document.querySelector('.queue-text')?.textContent?.includes('уточнённая'), null, { timeout: 8000 });
  check(true, 'текст задачи редактируется в окне');

  const saved = await page.evaluate(async (chatId) => {
    const response = await fetch(`/api/chats/${chatId}`);
    return response.json();
  }, ids.chatId);
  check(
    saved.chat?.queue?.[0]?.text === 'Вторая задача — уточнённая',
    'правка сохранилась на сервере',
    JSON.stringify(saved.chat?.queue || []),
  );

  await page.click('.queue-del');
  await page.getByRole('button', { name: 'Убрать', exact: true }).click();
  await page.waitForSelector('#queuePanel.hidden', { state: 'attached', timeout: 8000 });
  check((await page.locator('.queue-item').count()) === 0, 'задача убирается из очереди');

  await send('Вторая задача');
  await page.waitForSelector('.queue-item', { timeout: 8000 });
  await send('Третья задача');
  await page.waitForFunction(() => document.querySelectorAll('.queue-item').length === 2, null, { timeout: 8000 });
  check((await page.locator('.queue-item').count()) === 2, 'две задачи стоят в очереди', String(await page.locator('.queue-item').count()));
  if (process.env.DSHOW_UI_SHOT) {
    if (process.env.DSHOW_UI_SHOT_MOBILE) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(250);
    }
    await page.screenshot({ path: process.env.DSHOW_UI_SHOT });
    if (process.env.DSHOW_UI_SHOT_MOBILE) await page.setViewportSize({ width: 1280, height: 900 });
  }

  await page.click('#stopBtn');
  await page.waitForSelector('#stopBtn.hidden', { state: 'attached', timeout: 10000 });
  await page.waitForSelector('.queue-run', { timeout: 10000 });
  const paused = await page.locator('.queue-item').count();
  check(paused === 2 && (await page.locator('.queue-run').count()) === 2, 'после «Стоп» очередь ждёт кнопки ▶', `задач: ${paused}`);

  await page.waitForTimeout(1200);
  check((await page.locator('.queue-item').count()) === 2, 'после «Стоп» очередь не запускается сама');

  await page.locator('.queue-run').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.queue-item').length === 1, null, { timeout: 10000 });
  check(true, 'кнопка ▶ запускает задачу из очереди');
  await page.waitForFunction(() => document.querySelectorAll('.queue-item').length === 0 && !document.querySelector('#stopBtn:not(.hidden)'), null, { timeout: 40000 });
  check(true, 'следующая задача стартует автоматически', '');

  const messages = await page.evaluate(async (chatId) => {
    const response = await fetch(`/api/chats/${chatId}`);
    return response.json();
  }, ids.chatId);
  const userTexts = (messages.chat?.messages || []).filter((message) => message.role === 'user').map((message) => message.content);
  check(userTexts.includes('Вторая задача') && userTexts.includes('Третья задача'), 'обе задачи дошли до ленты', JSON.stringify(userTexts));
  check((messages.chat?.queue || []).length === 0, 'очередь опустела', JSON.stringify(messages.chat?.queue || []));

  await browser.close();
}

main()
  .catch((error) => {
    failures += 1;
    console.error('Сбой проверки:', error.message);
    console.error(log.slice(-2000));
  })
  .finally(() => {
    app.kill();
    model.close();
    console.log(failures ? `\nПровалов: ${failures}` : '\nВсе проверки пройдены.');
    process.exit(failures ? 1 : 0);
  });

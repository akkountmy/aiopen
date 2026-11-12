/* Живая проверка места ответа в ленте: текст идущего ответа обязан появляться
   ПОД вопросом, на который он отвечает, и никогда — в прошлом ответе, который
   стоит выше нового вопроса.

   Повод: вторая задача, отправленная во время работы, начинается с сервера
   (очередь), и клиент добавляет пузырь ответа уже после перерисовки ленты. Если
   живой текст писать в «последний блок ассистента» на экране, он попадает в
   предыдущий ответ, а новый вопрос остаётся внизу без ответа под ним.

   Поднимает поддельную модель (медленный поток), отдельный экземпляр сервиса во
   временной папке и headless Chrome/Edge. Настоящие данные не трогаются.

   Запуск: node test/ui-answer-position.mjs */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const MODEL_PORT = 3421;
const APP_PORT = 3422;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-ui-answer-'));
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

/* Разные слова у первого и второго ответа: по ним видно, чей текст оказался в
   каком блоке. Первый ответ короткий — чтобы очередь стартовала быстро. */
const ANSWERS = [
  ['ПЕРВЫЙ ', 'ответ ', 'первой ', 'задачи. ', 'Конец.'],
  ['ВТОРОЙ ', 'ответ ', 'второй ', 'задачи ', 'идёт ', 'сейчас ', 'в ленту. ', 'Конец.'],
];
let streams = 0;
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
    const words = ANSWERS[Math.min(streams, ANSWERS.length - 1)];
    streams += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let index = 0;
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(timer);
        return;
      }
      if (index < words.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[index] } }] })}\n\n`);
        index += 1;
        return;
      }
      clearInterval(timer);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }, 350);
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

/* Порядок в ленте: есть ли ответ после пузыря второй задачи и не попал ли текст
   второго ответа в блок выше неё. */
async function readOrder(page) {
  return page.evaluate(() => {
    const thread = document.querySelector('#thread');
    const nodes = [...thread.children];
    const userIndex = nodes.findIndex(
      (node) => node.classList.contains('msg-user') && node.textContent.includes('Вторая задача'),
    );
    const slice = (list) => list.map((node) => node.textContent || '').join(' | ');
    const after = userIndex < 0 ? [] : nodes.slice(userIndex + 1);
    const before = userIndex < 0 ? [] : nodes.slice(0, userIndex);
    return {
      userIndex,
      afterAssistant: slice(after.filter((node) => node.classList.contains('msg-assistant'))),
      beforeHasSecond: before.some(
        (node) => node.classList.contains('msg-assistant') && (node.textContent || '').includes('ВТОРОЙ'),
      ),
      streamingCount: document.querySelectorAll('#thread .msg-assistant.streaming').length,
      answerCount: after.filter((node) => node.classList.contains('msg-assistant')).length,
      lastNodeClass: nodes[nodes.length - 1]?.className || '',
      nodes: nodes.map((node) => `${node.className} :: ${(node.textContent || '').replace(/\s+/g, ' ').slice(0, 60)}`),
    };
  });
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
    const project = await post('/api/projects', { name: 'Место ответа' });
    const created = await post(`/api/projects/${project.project.id}/chats`, {});
    const title = `Место ответа ${Date.now().toString().slice(-6)}`;
    await fetch(`/api/chats/${created.chat.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const me = await (await fetch('/api/me')).json();
    const chats = me.projects.find((item) => item.id === project.project.id)?.chats || [];
    for (const chat of chats) {
      if (chat.id !== created.chat.id) await fetch(`/api/chats/${chat.id}`, { method: 'DELETE' });
    }
    return { projectId: project.project.id, chatId: created.chat.id, title };
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.project-row .row-main', { hasText: 'Место ответа' }).first().click();
  await page.locator('.chat-row', { hasText: ids.title }).locator('.row-main').click();
  await page.waitForSelector('#composer', { state: 'visible' });

  async function send(text) {
    await page.fill('#input', text);
    await page.press('#input', 'Enter');
  }

  /* Состояние диалога берём с сервера явным опросом: предикат waitForFunction с
     async-функцией возвращает промис, и проверка срабатывает раньше времени. */
  async function serverChat() {
    return page.evaluate(async (chatId) => (await (await fetch(`/api/chats/${chatId}`)).json()).chat, ids.chatId);
  }

  async function waitChat(predicate, label, timeout = 40000) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeout) {
      last = await serverChat();
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`не дождались: ${label} (очередь ${last?.queue?.length || 0}, запуск ${last?.run?.id || 'нет'})`);
  }

  await send('Первая задача');
  const first = await waitChat((chat) => Boolean(chat?.run?.id), 'первая задача пошла', 15000);
  check(Boolean(first?.run?.id), 'первая задача пошла');

  /* Вторая просьба уходит в очередь: ответ идёт, кнопка отправки заменена «Стоп». */
  await send('Вторая задача');
  await page.waitForSelector('#queuePanel:not(.hidden)', { timeout: 10000 });

  /* Ждём, когда сервер поднимет вторую задачу из очереди: в переписке появится её
     текст, очередь опустеет, а запуск сменится. */
  const second = await waitChat(
    (chat) =>
      (chat?.messages || []).some((message) => message.role === 'user' && message.content === 'Вторая задача') &&
      Boolean(chat?.run?.id) &&
      chat.run.id !== first.run.id,
    'вторая задача стартовала',
    40000,
  );
  check(Boolean(second?.run?.id), 'вторая задача стартовала');
  /* Ответ уходит в ленту одним куском в конце работы (см. runTurn), поэтому ждём
     появления самой реплики, а не «несколько кадров потока». */
  let live = await readOrder(page);
  const answerUntil = Date.now() + 30000;
  while (Date.now() < answerUntil && !live.afterAssistant.includes('ВТОРОЙ')) {
    await page.waitForTimeout(150);
    live = await readOrder(page);
  }

  check(live.userIndex >= 0, 'вторая задача есть в ленте', `индекс ${live.userIndex}`);
  check(
    live.afterAssistant.includes('ВТОРОЙ'),
    'ответ идёт под текстом второй задачи',
    live.afterAssistant.slice(0, 90) || 'ниже вопроса блоков ассистента нет',
  );
  check(
    !live.beforeHasSecond,
    'текст второго ответа не попал в прошлый ответ',
    live.beforeHasSecond ? live.nodes.join(' ; ') : '',
  );
  /* Ответ приходит готовым: к моменту показа блок может быть уже не «идущим»,
     но он должен быть ровно один и стоять после своего вопроса. */
  check(
    live.answerCount === 1 && live.streamingCount <= 1,
    'идёт ровно один ответ',
    `блоков ${live.answerCount}, идущих ${live.streamingCount}`,
  );

  if (process.env.DSHOW_UI_SHOT) await page.screenshot({ path: process.env.DSHOW_UI_SHOT });

  await waitChat((chat) => !chat?.run, 'ответы закончились', 60000);
  await page.waitForTimeout(400);

  const done = await readOrder(page);
  check(done.afterAssistant.includes('ВТОРОЙ'), 'после завершения ответ остаётся под вопросом', done.afterAssistant.slice(-90));
  check(!done.beforeHasSecond, 'после завершения прошлый ответ чист');

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

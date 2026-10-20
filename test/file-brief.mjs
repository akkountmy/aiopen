/**
 * Проверка того, что принесённые файлы сразу попадают в контекст.
 *
 * Сценарий жизни: человек загружает или перетаскивает файл в проект, чтобы
 * показать его ассистенту, и пишет короткое «вот». Сервис обязан:
 *  - пересказать свежие файлы в системном сообщении (тип, размер, когда
 *    появился, фрагмент содержимого, листы таблицы, размеры картинки),
 *  - не пересказывать старые файлы (они в списке, но без фрагмента),
 *  - не дублировать вложения текущего сообщения — они уже в тексте,
 *  - держать правило «нет задачи — предложи ровно три варианта»,
 *  - не добавлять блок файлов в проект, где файлов нет.
 *
 * Модель поддельная: она записывает системное сообщение и отвечает текстом.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import ExcelJS from 'exceljs';

const MODEL_PORT = 3451;
const APP_PORT = 3452;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-files-'));
const ADMIN = { username: 'DSHOPENWEB', password: 'TestPass-12345' };
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(ok, label, extra = '') {
  console.log(`${ok ? '  ok ' : '  ПРОВАЛ '}${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
}

/* 1×1 PNG: картинка, у которой сервис обязан назвать размер. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/* ------------------------- поддельная модель ------------------------- */

const seenSystems = [];
let lastUserText = '';

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
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'Файлы проекта' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 4 },
        }),
      );
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages.find((m) => m.role === 'system');
    seenSystems.push(String(system?.content || ''));
    const user = [...messages].reverse().find((m) => m.role === 'user');
    lastUserText = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content || '');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const word of ['Готово: ', 'файлы ', 'разобраны.']) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: word } }] })}\n\n`);
    }
    res.write(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 10 },
      })}\n\n`,
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

/* --------------------------- экземпляр сервиса --------------------------- */

function startApp() {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSHOW_PORT: String(APP_PORT),
      DSHOW_HOST: '127.0.0.1',
      DSHOW_DATA_DIR: DIR,
      DSHOW_ADMIN_USER: ADMIN.username,
      DSHOW_ADMIN_PASSWORD: ADMIN.password,
      DSHOW_TRUST_PROXY: '0',
      DSHOW_MODEL_BASE: `http://127.0.0.1:${MODEL_PORT}`,
      DSHOW_DEEPSEEK_KEY: 'test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    const line = String(chunk);
    if (!/ExperimentalWarning|localstorage/.test(line)) process.stderr.write(`[сервис] ${line}`);
  });
  return child;
}

let app = null;

async function waitReady() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* сервис ещё поднимается */
    }
    await sleep(250);
  }
  throw new Error('сервис не поднялся');
}

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(ADMIN),
  });
  const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]);
  return cookies.join('; ');
}

async function api(route, { cookie, method = 'GET', body } = {}) {
  const r = await fetch(`${BASE}${route}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

/** Загрузка файла в проект — тем же путём, что панель «Файлы проекта». */
async function uploadToProject(cookie, projectId, rel, buffer) {
  const r = await fetch(`${BASE}/api/projects/${projectId}/upload?path=${encodeURIComponent(rel)}`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(path.basename(rel)),
    },
    body: buffer,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

/** Загрузка вложения из поля сообщения (как «прикрепить файл» в композере). */
async function uploadAttachment(cookie, projectId, chatId, name, buffer) {
  const r = await fetch(`${BASE}/api/attachments`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(name),
      'x-project-id': projectId,
      'x-chat-id': chatId,
    },
    body: buffer,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

async function readRunStream(response) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const chunk = await Promise.race([reader.read(), sleep(20000).then(() => 'timeout')]);
    if (chunk === 'timeout' || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          events.push(JSON.parse(payload));
        } catch {
          /* неполный кадр */
        }
      }
    }
  }
  return events;
}

async function ask(cookie, chatId, text, attachmentIds = []) {
  const response = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ text, attachmentIds }),
  });
  if (!response.ok) throw new Error(`сообщение не принято: ${response.status} ${await response.text()}`);
  return readRunStream(response);
}

/* ------------------------------ сценарий ------------------------------ */

model.listen(MODEL_PORT, '127.0.0.1');
const contractPhrase = 'ДОГОВОР ПОСТАВКИ № 12 от 3 марта, ООО «Ромашка»';
const stalePhrase = 'СТАРЫЙ АРХИВ, который трогать не надо';
const attachedPhrase = 'ПРИКАЗ № 7 по учебному центру';

try {
  app = startApp();
  await waitReady();
  const cookie = await login();

  const project = (await api('/api/projects', { cookie, method: 'POST', body: { name: 'Файлы под рукой' } })).data.project;
  check(Boolean(project?.id), 'проект создан');
  const chat = (await api(`/api/projects/${project.id}/chats`, { cookie, method: 'POST', body: {} })).data.chat;
  check(Boolean(chat?.id), 'диалог создан');

  /* Смета: настоящая таблица Excel, чтобы проверить разбор листов. */
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Март');
  sheet.addRow(['№', 'Наименование', 'Кол-во', 'Сумма']);
  sheet.addRow([1, 'Цемент М500', 40, 19200]);
  sheet.addRow([2, 'Песок', 12, 8400]);
  const xlsxBuffer = Buffer.from(await book.xlsx.writeBuffer());

  const fresh = await uploadToProject(cookie, project.id, 'договор.txt', Buffer.from(`${contractPhrase}\n\nПоставка до 30 марта.`, 'utf8'));
  check(fresh.status === 200 && fresh.data.path === 'договор.txt', 'свежий текстовый файл загружен', JSON.stringify(fresh.data));
  const table = await uploadToProject(cookie, project.id, 'смета.xlsx', xlsxBuffer);
  check(table.status === 200, 'таблица загружена');
  const picture = await uploadToProject(cookie, project.id, 'снимок.png', PNG_1X1);
  check(picture.status === 200, 'картинка загружена');
  const stale = await uploadToProject(cookie, project.id, 'архив.txt', Buffer.from(stalePhrase, 'utf8'));
  check(stale.status === 200, 'старый файл загружен');
  /* Состариваем его: сводка не должна пересказывать содержание старых файлов. */
  const stalePath = path.join(DIR, 'workspaces', project.id, 'архив.txt');
  const aged = new Date(Date.now() - 72 * 60 * 60 * 1000);
  fs.utimesSync(stalePath, aged, aged);

  seenSystems.length = 0;
  const events = await ask(cookie, chat.id, 'вот файлы, посмотри');
  check(events.some((e) => e.type === 'end'), 'ответ доехал до конца', events.map((e) => e.type).join(','));
  check(!events.some((e) => e.type === 'error'), 'ошибок в потоке нет');

  const system = seenSystems.join('\n\n');
  check(system.includes('Файлы проекта:'), 'в системном сообщении есть блок файлов проекта');
  check(system.includes('договор.txt'), 'свежий текстовый файл попал в сводку');
  check(system.includes(contractPhrase.slice(0, 30)), 'фрагмент свежего файла прочитан заранее');
  check(/договор\.txt[^\n]*·[^\n]*свежий/.test(system), 'свежий файл помечен как свежий');
  check(system.includes('смета.xlsx'), 'таблица попала в сводку');
  check(/лист «Март»/.test(system), 'сводка называет лист таблицы');
  check(/заголовки:/i.test(system), 'сводка называет заголовки таблицы');
  check(system.includes('снимок.png'), 'картинка попала в сводку');
  check(/1×1/.test(system), 'у картинки назван размер в пикселях');
  check(system.includes('архив.txt'), 'старый файл в списке есть');
  check(!system.includes(stalePhrase.slice(0, 20)), 'содержание старого файла не пересказывается');
  check(system.includes('ровно три пронумерованных варианта'), 'правило трёх вариантов передано модели');
  check(/«1\) …», «2\) …», «3\) …»/.test(system), 'правило задаёт форму ответа с нумерацией');
  check(
    system.indexOf('Файлы проекта:') > system.indexOf('Ты — AI-ассистент'),
    'сводка стоит в конце системного сообщения',
  );

  /* Вложение из поля сообщения уже целиком в тексте — в сводке только путь. */
  const att = await uploadAttachment(cookie, project.id, chat.id, 'приказ.txt', Buffer.from(`${attachedPhrase}\nУтвердить состав.`, 'utf8'));
  check(att.status === 200 && Boolean(att.data.attachment?.id), 'вложение принято');
  const attId = att.data.attachment.id;

  seenSystems.length = 0;
  await ask(cookie, chat.id, 'Исправь по приказу', [attId]);
  const system2 = seenSystems.join('\n\n');
  check(system2.includes('содержимое уже передано в сообщении выше'), 'вложение не пересказывается повторно');
  check(lastUserText.includes(attachedPhrase), 'текст вложения доехал до модели в сообщении');
  check(
    (system2.match(new RegExp(attachedPhrase, 'g')) || []).length === 0,
    'в системном сообщении текст вложения не дублируется',
  );

  /* Пустой проект: блока файлов быть не должно, ответ всё равно приходит. */
  const emptyProject = (await api('/api/projects', { cookie, method: 'POST', body: { name: 'Пустой' } })).data.project;
  const emptyChat = (await api(`/api/projects/${emptyProject.id}/chats`, { cookie, method: 'POST', body: {} })).data.chat;
  seenSystems.length = 0;
  await ask(cookie, emptyChat.id, 'Привет, что умеешь?');
  const system3 = seenSystems.join('\n\n');
  check(!system3.includes('Файлы проекта:'), 'в пустом проекте блока файлов нет');
  check(system3.includes('ровно три пронумерованных варианта'), 'правило трёх вариантов действует всегда');
} catch (error) {
  console.error('ошибка проверки:', error.stack || error.message);
  failures += 1;
} finally {
  if (app) app.kill();
  model.close();
  await sleep(300);
  try {
    fs.rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(failures ? `\nПровалов: ${failures}` : '\nВсё прошло');
process.exit(failures ? 1 : 0);

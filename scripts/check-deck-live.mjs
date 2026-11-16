#!/usr/bin/env node
/* Сквозная живая проверка презентации — единственная команда, которой проверяем деку
   на боевом сервисе. Работает по HTTP, без браузера: заводит свой проект «Проба деки …»,
   просит деку в чате, ждёт файл, скачивает его, печатает строки отчёта инструмента
   (подгонка/раскладка/что не вошло) и убирает проект за собой.

   Зачем так: раньше каждая проверка была отдельной CDP-пробой на 300 строк, с логином
   через браузер, ожиданием ответа модели и ручным разбором скриншотов. Один круг стоил
   8–12 минут и много токенов, а падал на мелочах (canvas: null, не тот ключ JSON).

   Использование:
     node scripts/check-deck-live.mjs "Сделай презентацию кофейни на 3 слайда"
     node scripts/check-deck-live.mjs "…" --render        сразу отрендерить PNG для просмотра
     node scripts/check-deck-live.mjs "…" --keep          оставить проект на сервисе
     node scripts/check-deck-live.mjs "…" --timeout 480   предельное ожидание ответа, секунды
*/
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const prompt = args.find((item) => !item.startsWith('--')) || 'Сделай дизайнерскую презентацию на 3 слайда про кофейню';
const keep = args.includes('--keep');
const render = args.includes('--render');
const timeoutIndex = args.indexOf('--timeout');
const TIMEOUT_MS = Math.max(60, Number(timeoutIndex >= 0 ? args[timeoutIndex + 1] : 600) || 600) * 1000;

const BASE = process.env.DSHOW_BASE || 'https://dshopen-vladimir00177.msk1.amvera.tech';
const UA = 'DSH-OPEN-WEB-deck-check/2.0';
const VAULT = path.join(os.homedir(), '.dsh', 'secrets', '_vault.ps1');

function vault(field) {
  if (field === 'login' && process.env.DSHOW_LOGIN) return process.env.DSHOW_LOGIN;
  if (field === 'password' && process.env.DSHOW_PASSWORD) return process.env.DSHOW_PASSWORD;
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `& '${VAULT}' get dshow-admin -Field ${field}`],
    { encoding: 'utf8' },
  ).trim();
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(process.cwd(), 'tmp', 'live', stamp);

async function login() {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, 'x-dshow-service': '1' },
    body: JSON.stringify({ username: vault('login'), password: vault('password') }),
  });
  if (!res.ok) throw new Error(`вход не удался: HTTP ${res.status}`);
  const cookie = (res.headers.getSetCookie?.() || []).map((item) => item.split(';')[0]).join('; ');
  if (!cookie) throw new Error('вход прошёл, но cookie не пришла');
  return { cookie, 'user-agent': UA, 'x-dshow-service': '1' };
}

/* Поток ответа: сервер пишет SSE `data: {json}`, конец — событие type "end".
   Отчёт инструмента ловим из событий type "tool" (summary/note/detail): в тексте
   ответа модели этих строк нет, поэтому раньше проверка показывала «деку не звали». */
async function ask(headers, chatId, text) {
  const res = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 202) return { queued: true };
  if (!res.ok || !res.body) throw new Error(`запрос не принят: HTTP ${res.status}`);

  const decoder = new TextDecoder();
  let buffer = '';
  const tools = [];
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (!frame.startsWith('data: ')) continue;
      let event;
      try {
        event = JSON.parse(frame.slice(6));
      } catch {
        continue;
      }
      if (event.type === 'tool' && event.status !== 'run') tools.push(event);
      if (event.type === 'end') return { done: true, tools };
    }
  }
  return { done: false, tools };
}

const REPORT = /(Подгонка:|Раскладка:|Не вошло:|Проверка файла|Дека создана|Презентация создана)/;

function reportLines(tools, chatText) {
  const lines = new Set();
  for (const tool of tools) {
    for (const field of [tool.summary, tool.note, tool.detail, tool.label]) {
      String(field || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && REPORT.test(line))
        .forEach((line) => lines.add(`${tool.name}: ${line}`));
    }
  }
  String(chatText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && REPORT.test(line))
    .forEach((line) => lines.add(line));
  return [...lines];
}

async function main() {
  const headers = await login();
  console.log(`сервис: ${BASE}`);
  console.log(`просьба: ${prompt}`);

  const created = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Проба деки ${stamp.slice(11, 19)}` }),
  });
  const createdBody = await created.json().catch(() => ({}));
  const projectId = createdBody.project?.id || createdBody.id;
  if (!projectId) throw new Error(`проект не создан: HTTP ${created.status}`);
  console.log(`проект: ${projectId}`);

  let decks = [];
  try {
    const chatRes = await fetch(`${BASE}/api/projects/${projectId}/chats`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Проба деки' }),
    });
    const chatBody = await chatRes.json().catch(() => ({}));
    const chatId = chatBody.chat?.id;
    if (!chatId) throw new Error(`диалог не создан: HTTP ${chatRes.status}`);

    const started = Date.now();
    const turn = await ask(headers, chatId, prompt);
    console.log(`ответ: ${turn.done ? 'завершён' : 'поток закрылся раньше'} за ${Math.round((Date.now() - started) / 1000)} с${turn.queued ? ' (поставлено в очередь)' : ''}`);

    const chat = await (await fetch(`${BASE}/api/chats/${chatId}`, { headers })).json();
    const full = (chat.chat?.messages || []).map((message) => message.text || message.content || '').join('\n\n');
    const called = turn.tools.filter((tool) => tool.status === 'ok').map((tool) => tool.name);
    console.log(`инструменты: ${called.length ? [...new Set(called)].join(', ') : 'никаких'}`);

    /* Полный текст ответа инструмента (строки «Подгонка/Раскладка») сервер держит
       в chat.history и по HTTP не отдаёт. Раскладку стерегут локальные тесты
       (test/deck.mjs), а живой прогон отвечает на вопрос «файл получился и открывается?». */
    const lines = reportLines(turn.tools, full);
    if (lines.length) {
      console.log('--- отчёт инструмента (из ответа модели) ---');
      lines.forEach((line) => console.log(line));
    }

    const files = await (await fetch(`${BASE}/api/projects/${projectId}/files?path=.&depth=6`, { headers })).json();
    decks = (files.items || []).filter((item) => String(item.path).toLowerCase().endsWith('.pdf'));
    console.log('--- файлы ---');
    console.log(decks.length ? decks.map((item) => `${item.path} (${Math.round(item.size / 1024)} КБ)`).join(', ') : 'PDF не появился');

    let pages = 0;
    if (decks.length) {
      const rel = String(decks[0].path).replace(/^\.\//, '');
      const dl = await fetch(`${BASE}/api/projects/${projectId}/file?path=${encodeURIComponent(rel)}&download=1`, { headers });
      const buf = Buffer.from(await dl.arrayBuffer());
      fs.mkdirSync(outDir, { recursive: true });
      const saved = path.join(outDir, path.basename(rel));
      fs.writeFileSync(saved, buf);
      pages = (buf.toString('latin1').match(/\/Type \/Page(?!s)/g) || []).length;
      console.log(`скачано: HTTP ${dl.status}, ${Math.round(buf.length / 1024)} КБ, страниц ${pages}`);
      console.log(`файл: ${saved}`);
      if (render) {
        const shot = execFileSync('python', [path.join(import.meta.dirname, 'pdf2png.py'), saved, outDir, '1.2'], {
          encoding: 'utf8',
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        }).trim();
        console.log(`снимки: ${shot}`);
      } else {
        console.log(`посмотреть: python scripts/pdf2png.py "${saved}" "${outDir}" 1.2`);
      }
    }

    const failed = !decks.length
      || pages < 1
      || !called.length
      || lines.some((line) => /Не вошло:/.test(line))
      || lines.some((line) => /Раскладка:(?!\s*чисто)/.test(line));
    console.log(`итог: ${failed ? 'ЕСТЬ ЗАМЕЧАНИЯ' : 'чисто'}`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (!keep) {
      const del = await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers });
      console.log(`проект убран: HTTP ${del.status}`);
    } else {
      console.log(`проект оставлен: ${projectId}`);
    }
  }
}

await main();

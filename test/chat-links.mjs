// Ссылки и файлы проекта в ответах ассистента должны быть кликабельными.
// Часть 1 (без браузера) проверяет разбор markdown: адреса с протоколом и без,
// «www.», имена файлов проекта, ссылки вида [текст](page.html), и то, что код
// и обычные слова ссылками не становятся.
// Часть 2 (браузер) проверяет, что клик по файлу в сообщении открывает окно
// просмотра сервиса, а внешняя ссылка идёт в новую вкладку.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('.');
const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3123';
const USER = process.env.DSHOW_USER || 'DSHOPENWEB';
const PASS = process.env.DSHOW_PASS || '';
const STAMP = Date.now().toString().slice(-6);
const PROJECT = `Проверка ссылок в ответах ${STAMP}`;
const HTML_NAME = `page-${STAMP}.html`;
const MARK = `страница-${STAMP}`;

const results = [];
const ok = (name, extra = '') => {
  results.push(true);
  console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`);
};
const fail = (name, detail) => {
  results.push(false);
  console.log(`  FAIL ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};
const check = (name, condition, detail) => (condition ? ok(name, typeof detail === 'string' ? detail : '') : fail(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- разбор markdown ------------------------- */

const appSource = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const mdStart = appSource.indexOf('/* ------------------------------ markdown');
const mdEnd = appSource.indexOf('/* ------------------------------ api');
if (mdStart < 0 || mdEnd < mdStart) {
  console.error('Не нашёл раздел markdown в public/app.js');
  process.exit(1);
}
const mdSection = appSource.slice(mdStart, mdEnd);

/* Та же функция, что в public/app.js: раздел markdown на неё опирается. */
const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function markdown(projectId = 'proj-1') {
  const factory = new Function('escapeHtml', 'filesProjectId', `${mdSection}\nreturn { renderMarkdown };`);
  return factory(escapeHtml, () => projectId).renderMarkdown;
}

const render = markdown();
const anchors = (html) => [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
const filePaths = (html) => [...html.matchAll(/data-file-path="([^"]*)"/g)].map((m) => m[1]);

/* Внешние адреса: и с протоколом, и «example.ru», и «www.». */
const externalHtml = render('Смотрите https://example.com/karta, сайт example.ru/put и www.site.ru.');
const external = anchors(externalHtml);
check(
  'адреса в ответе стали ссылками — с протоколом и без',
  external.length === 3 &&
    external.every((a) => /target="_blank"/.test(a) && /rel="noopener noreferrer"/.test(a)) &&
    external.some((a) => a.includes('href="https://example.ru/put"')) &&
    external.some((a) => a.includes('href="https://www.site.ru"')) &&
    external.some((a) => a.includes('href="https://example.com/karta"')),
  external.join(' | '),
);

/* Файлы проекта: имя в тексте, во фразе с точкой, в папке и в обратных кавычках. */
const fileHtml = render('Готово: index.html, файл docs/смета.xlsx, страница «вход.html», а ещё `page.html`.');
const files = filePaths(fileHtml);
check(
  'имена файлов проекта стали ссылками с data-file-path',
  files.length === 4 &&
    files.includes('index.html') &&
    files.includes('docs/смета.xlsx') &&
    files.includes('вход.html') &&
    files.includes('page.html'),
  files.join(', '),
);

const trailing = filePaths(render('Открой page.html.'));
check('точка в конце фразы не попала в имя файла', trailing.length === 1 && trailing[0] === 'page.html', trailing.join(', '));

const hrefHtml = render('Открой index.html');
check(
  'у ссылки на файл правильный адрес проекта',
  /href="\/api\/projects\/proj-1\/file\?path=index\.html"/.test(hrefHtml),
  hrefHtml,
);

/* [текст](адрес): и на файл проекта, и на внешний сайт. */
const mdLinks = render('Смотри [страницу проекта](page.html) и [сайт](https://example.ru).');
check(
  'markdown-ссылка на файл открывает просмотр, на сайт — внешняя ссылка',
  filePaths(mdLinks)[0] === 'page.html' && /href="page\.html"|data-file-path="page\.html"/.test(mdLinks) && /href="https:\/\/example\.ru\/?"/.test(mdLinks) && mdLinks.includes('страницу проекта'),
  mdLinks,
);

/* Код и обычные имена трогать нельзя. */
const codeHtml = render('```\nindex.html\n```');
check('имя файла внутри блока кода ссылкой не стало', anchors(codeHtml).length === 0, codeHtml);

const plainHtml = render('Правим app.js и styles.css, это не файлы проекта.');
check('файлы кода и стилей ссылками не стали', anchors(plainHtml).length === 0, plainHtml);

const escaped = render('<script>alert(1)</script> и index.html');
check(
  'разметка экранирована, а имя файла рядом осталось ссылкой',
  !/<script/i.test(escaped) && filePaths(escaped).length === 1,
  escaped,
);

/* ------------------------- браузер ------------------------- */

const CHROME = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].find((c) => fs.existsSync(c));

if (!CHROME) {
  console.log('  --  Chrome не найден, браузерная часть пропущена');
  finish(0);
}

const PORT = 9339;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-links-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const pageWs = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
      if (pages.length) return pages[0].webSocketDebuggerUrl;
    } catch {
      /* стартует */
    }
    await sleep(250);
  }
  throw new Error('DevTools не поднялся');
};

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    for (const l of listeners) l(m);
  });
  const ready = new Promise((res, rej) => {
    socket.addEventListener('open', res);
    socket.addEventListener('error', rej);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(l) {
      listeners.add(l);
    },
  };
}

let projectId = '';

try {
  const cdp = connect(await pageWs());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    platform: 'Windows',
  });
  let loaded = false;
  cdp.on((m) => {
    if (m.method === 'Page.loadEventFired') loaded = true;
  });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const goto = async (url) => {
    loaded = false;
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 100 && !loaded; i++) await sleep(100);
    await sleep(400);
  };
  const waitFor = async (expression, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        /* страница ещё грузится */
      }
      await sleep(200);
    }
    return false;
  };

  await goto(BASE + '/');
  const status = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  check('вход в сервис', status === 200, String(status));

  /* Проект с одной страницей — на нём проверяем клик по ссылке из ответа. */
  projectId = await evaluate(`(async () => {
    const boot = await (await fetch('/api/bootstrap')).json();
    const stale = (boot.projects || []).filter((p) => /^Проверка ссылок в ответах \\d+$/.test(String(p.name || '')));
    for (const p of stale) await fetch('/api/projects/' + p.id, { method: 'DELETE' });
    const res = await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:${JSON.stringify(PROJECT)}})});
    const created = await res.json();
    return created.project.id;
  })()`);

  const uploaded = await evaluate(`(async () => {
    const body = new TextEncoder().encode(${JSON.stringify(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Страница</title></head><body><h1>Страница проекта</h1><p>${MARK}</p></body></html>`)});
    const res = await fetch('/api/projects/' + ${JSON.stringify(projectId)} + '/upload?path=' + encodeURIComponent(${JSON.stringify(HTML_NAME)}), {
      method: 'POST', headers: { 'x-filename': encodeURIComponent(${JSON.stringify(HTML_NAME)}) }, body,
    });
    return res.status;
  })()`);
  check('страница загружена в проект', uploaded === 200, String(uploaded));

  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`, 20000);
  const picked = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.project-row')].find(r => r.textContent.includes(${JSON.stringify(STAMP)}));
    if (!row) return false;
    row.click();
    return true;
  })()`);
  check('проект выбран слева', picked);

  /* Ответ ассистента собираем настоящим разбором markdown и вставляем в ленту:
     дальше проверяем именно то, что увидит человек. */
  const message = render(
    `Готово — страница сохранена: ${HTML_NAME}. Открыть можно и ссылкой: [страница](${HTML_NAME}).\n\nСайт-пример: https://example.ru`,
  );
  await evaluate(`(() => {
    const probe = document.createElement('div');
    probe.className = 'md';
    probe.id = 'chatLinkProbe';
    probe.innerHTML = ${JSON.stringify(message)};
    document.getElementById('thread').appendChild(probe);
    return true;
  })()`);

  const renderedInPage = await evaluate(`(() => {
    const probe = document.getElementById('chatLinkProbe');
    const file = probe.querySelector('a[data-file-path]');
    if (!file) return null;
    const style = getComputedStyle(file);
    return {
      count: probe.querySelectorAll('a[data-file-path]').length,
      path: file.dataset.filePath,
      href: file.getAttribute('href'),
      color: style.color,
      external: probe.querySelectorAll('a[target="_blank"]').length,
    };
  })()`);
  check(
    'в ленте обе ссылки на страницу кликабельны, внешняя — в новой вкладке',
    renderedInPage && renderedInPage.count === 2 && renderedInPage.path === HTML_NAME && /\/api\/projects\//.test(renderedInPage.href) && renderedInPage.external === 1,
    renderedInPage,
  );

  await evaluate(`document.querySelector('#chatLinkProbe a[data-file-path]').click()`);
  const opened = await waitFor(`!!document.querySelector('.file-preview-modal')`, 15000);
  check('клик по имени файла открыл окно просмотра', opened);
  const frameSrc = await evaluate(`(document.querySelector('.file-preview iframe.preview-frame') || {}).src || ''`);
  const page = frameSrc
    ? await evaluate(`(async () => {
        const res = await fetch(${JSON.stringify(frameSrc)});
        const body = await res.text();
        return { ok: res.ok, status: res.status, marker: body.includes(${JSON.stringify(MARK)}) };
      })()`)
    : null;
  check('в окне просмотра та самая страница проекта', page && page.ok && page.marker, { frameSrc, page });

  await evaluate(`document.querySelector('.file-preview-modal .modal-close')?.click()`);
  await waitFor(`!document.querySelector('.file-preview-modal')`, 8000);

  /* Ссылка [текст](page.html) открывает то же окно. Небольшая пауза: окно
     просмотра защищено от двойного тапа (одно и то же окно не открывается
     дважды за 600 мс). */
  await sleep(900);
  await evaluate(`(() => {
    const probe = document.getElementById('chatLinkProbe');
    const link = [...probe.querySelectorAll('a[data-file-path]')].pop();
    link.click();
    return true;
  })()`);
  const openedSecond = await waitFor(`!!document.querySelector('.file-preview-modal')`, 15000);
  check('markdown-ссылка [страница](файл) открывает просмотр', openedSecond);

  await evaluate(`document.querySelector('#chatLinkProbe')?.remove()`);
} catch (error) {
  fail('браузерная часть', error.message);
} finally {
  /* Временный проект за собой убираем, чтобы проверка не оставляла следов. */
  if (projectId) {
    try {
      const rest = connect(await pageWs());
      await rest.ready;
      await rest.send('Runtime.enable');
      const removed = await rest.send('Runtime.evaluate', {
        expression: `fetch('/api/projects/' + ${JSON.stringify(projectId)}, {method:'DELETE'}).then(r => r.status)`,
        awaitPromise: true,
        returnByValue: true,
      });
      const code = removed.result?.value;
      code === 200 || code === 204 ? ok('временный проект удалён') : fail('уборка проекта', code);
    } catch (error) {
      fail('уборка проекта', error.message);
    }
  }
  chrome.kill();
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* профиль ещё занят */
  }
}

finish(0);

function finish() {
  const passed = results.filter(Boolean).length;
  console.log(`\nИтого: ${passed} ok, ${results.length - passed} fail`);
  process.exit(results.length - passed ? 1 : 0);
}

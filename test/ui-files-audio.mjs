/* Полоса прослушивания внизу панели файлов: живая проверка в настоящем Chrome.
   Нажатие по записи в панели поднимает полосу, полоса повторяет ширину панели,
   не уезжает при прокрутке списка, на телефоне приходит со шторкой и
   возвращается после её закрытия, крестик убирает её до следующего нажатия.
   Звук — сгенерированная тишина в WAV, поэтому проверке не нужен файл на диске.
   
   Запуск (нужен уже работающий сервис):
     $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
     node test/ui-files-audio.mjs
   Без сервера и Chrome проверка пропускается: npm test её не запускает. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'DSH';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';
const STAMP = Date.now().toString().slice(-6);
const TRACK_NAME = `проба-${STAMP}.wav`;
/* В шапке полосы расширение не показывается — оно лишнее, подпись ниже и так
   говорит «WAV». */
const TRACK_TITLE = TRACK_NAME.replace(/\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i, '');
/* Карточка прослушивания не идёт от края до края панели: в стилях у неё
   margin 6px 10px и рамка 1px, то есть по 11 px с боков и 6 px снизу. */
const BAR_INSET = 11;
const BAR_GAP = 6;
/* Тишина вместо записи: проверяются полоса, ширина и память места, а не звук,
   поэтому файл собирается здесь же и проверке не нужен mp3 на диске. */
function buildWav(seconds = 3, rate = 8000) {
  const dataSize = Math.round(seconds * rate) * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const SHOT_DIR = process.env.DSHOW_SHOTS || path.join(os.tmpdir(), 'dshow-audio-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let passed = 0;
let failed = 0;
const ok = (name, extra = '') => {
  passed++;
  console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`);
};
const fail = (name, detail) => {
  failed++;
  console.log(`  FAIL ${name}: ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка пропущена');
  process.exit(0);
}

const PORT = Number(process.env.DSHOW_CDP_PORT || 9347);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-cdp-audio-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function browserWs() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* ещё стартует */
    }
    await sleep(250);
  }
  throw new Error('Chrome не поднял DevTools-порт');
}

const pageWs = async () => {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const pages = (await res.json()).filter((t) => t.type === 'page');
      if (pages.length) return pages[0].webSocketDebuggerUrl;
    } catch {
      /* ещё стартует */
    }
    await sleep(250);
  }
  throw new Error('нет страницы для подключения');
};

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    for (const listener of listeners) listener(msg);
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(listener) {
      listeners.add(listener);
    },
    close() {
      socket.close();
    },
  };
}

try {
  await browserWs();
  const cdp = connect(await pageWs());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  let loaded = false;
  const consoleErrors = [];
  cdp.on((msg) => {
    if (msg.method === 'Page.loadEventFired') loaded = true;
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'исключение');
    }
  });

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async function goto(url) {
    loaded = false;
    await cdp.send('Page.navigate', { url });
    for (let attempt = 0; attempt < 100 && !loaded; attempt++) await sleep(100);
    await sleep(400);
  }

  async function waitFor(expression, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        /* страница ещё перезагружается */
      }
      await sleep(150);
    }
    return false;
  }

  async function shot(name) {
    try {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(data, 'base64'));
    } catch {
      /* снимок не обязателен */
    }
  }

  /* ------------------------------- вход ------------------------------- */
  await goto(BASE + '/');
  const loginStatus = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  loginStatus === 200 ? ok('вход в сервис') : fail('вход', loginStatus);
  if (loginStatus !== 200) throw new Error('нет входа');

  /* -------------------- диалог и запись в его файлах -------------------- */
  const b64 = buildWav(3).toString('base64');
  const made = await evaluate(`(async () => {
     const boot = await (await fetch('/api/bootstrap')).json();
     let project = (boot.projects || [])[0];
     if (!project) project = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проба звука'})})).json()).project;
     let chats = project.chats || [];
     if (!chats.length) {
       await fetch('/api/projects/' + project.id + '/chats', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Проба звука'})});
       const again = await (await fetch('/api/bootstrap')).json();
       project = (again.projects || []).find((item) => item.id === project.id) || project;
       chats = project.chats || [];
     }
     const chatId = chats[0] ? chats[0].id : '';
     const raw = atob(${JSON.stringify(b64)});
     const bytes = new Uint8Array(raw.length);
     for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
     const up = await fetch('/api/projects/' + project.id + '/upload?path=' + encodeURIComponent(${JSON.stringify(TRACK_NAME)}), {
       method: 'POST',
       headers: { 'x-filename': encodeURIComponent(${JSON.stringify(TRACK_NAME)}), 'x-chat-id': chatId },
       body: bytes,
     });
     return { id: project.id, name: project.name, chatId, upload: up.status, csrf: 'ok' };
  })()`);
  made.upload === 200 ? ok('запись загружена в диалог', `${Math.round(b64.length / 1024)} КБ, ${TRACK_NAME}`) : fail('загрузка записи', made.upload);

  /* ------------------------- открыть диалог ------------------------- */
  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  const openChat = `(() => {
    const block = [...document.querySelectorAll('.project')].find(
      (p) => (p.querySelector('.p-name') || {}).textContent.trim() === ${JSON.stringify(made.name)},
    );
    if (!block) return false;
    const chat = block.querySelector('.chat-row .row-main');
    if (chat) { chat.click(); return true; }
    block.querySelector('.project-row .row-main')?.click();
    return false;
  })()`;
  const opened = await evaluate(openChat);
  if (!opened) {
    await sleep(400);
    await evaluate(openChat);
  }
  await waitFor(`(document.querySelector('#crumbChat')?.textContent || '').trim().length > 0`);
  const filesReady = await waitFor(
    `[...document.querySelectorAll('#filesList .file-row')].some((row) => (row.textContent || '').includes(${JSON.stringify(TRACK_NAME)}))`,
    12000,
  );
  filesReady ? ok('запись видна в панели файлов') : fail('панель файлов', 'строки записи нет');

  /* ------------------- нажатие по строке включает полосу ------------------- */
  const clicked = await evaluate(`(() => {
    const row = [...document.querySelectorAll('#filesList .file-row')].find((r) => (r.textContent || '').includes(${JSON.stringify(TRACK_NAME)}));
    if (!row) return false;
    const main = row.querySelector('.row-main') || row;
    main.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    return !!row.dataset.audio;
  })()`);
  const barShown = await waitFor(`(() => {
    const bar = document.getElementById('filesAudio');
    return !!bar && !bar.classList.contains('hidden') && !!bar.querySelector('.audio-bar');
  })()`, 6000);
  clicked && barShown ? ok('нажатие по записи подняло полосу прослушивания') : fail('полоса прослушивания', JSON.stringify({ clicked, barShown }));

  const MEASURE = `(() => {
    const panel = document.getElementById('filesPanel');
    const bar = document.getElementById('filesAudio');
    const list = document.getElementById('filesList');
    const pr = panel.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    return {
      inside: panel.contains(bar),
      panel: { l: Math.round(pr.left), r: Math.round(pr.right), w: Math.round(pr.width), b: Math.round(pr.bottom) },
      bar: { l: Math.round(br.left), r: Math.round(br.right), w: Math.round(br.width), b: Math.round(br.bottom), h: Math.round(br.height) },
      listOverflow: getComputedStyle(list).overflowY,
      title: (document.getElementById('filesAudioTitle').textContent || '').trim(),
      barClass: bar.className,
      lastChild: panel.lastElementChild === bar,
      playing: (() => { const a = document.querySelector('body > audio'); return a ? { paused: a.paused, src: a.currentSrc || a.src } : null; })(),
      listeningRows: document.querySelectorAll('#filesList .file-row.is-listening').length,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  })()`;
  const first = await evaluate(MEASURE);
  first.inside && Math.abs(first.bar.w - (first.panel.w - BAR_INSET * 2)) <= 1
    ? ok('полоса вписана в панель с теми же полями', `${first.bar.w} px`)
    : fail('ширина полосы', JSON.stringify({ panel: first.panel, bar: first.bar }));
  first.title === TRACK_TITLE ? ok('в шапке полосы имя записи', first.title) : fail('имя записи', first.title);
  first.listeningRows === 1 ? ok('строка включённой записи подсвечена') : fail('подсветка строки', first.listeningRows);
  Math.abs(first.panel.b - first.bar.b - BAR_GAP) <= 1
    ? ok('полоса прижата к низу панели', `${first.panel.b} − ${first.bar.b} = ${BAR_GAP}`)
    : fail('полоса не внизу', JSON.stringify({ panel: first.panel, bar: first.bar }));
  first.listOverflow === 'auto' ? ok('список файлов прокручивается отдельно') : fail('прокрутка списка', first.listOverflow);

  /* список прокручивается, полоса остаётся на месте */
  const pinned = await evaluate(`(() => {
    const list = document.getElementById('filesList');
    const bar = document.getElementById('filesAudio');
    const before = Math.round(bar.getBoundingClientRect().top);
    list.scrollTop = list.scrollHeight;
    const after = Math.round(bar.getBoundingClientRect().top);
    return { before, after, scrolled: Math.round(list.scrollTop) };
  })()`);
  pinned.before === pinned.after
    ? ok('прокрутка списка не сдвигает полосу', `top ${pinned.after} px`)
    : fail('полоса уехала при прокрутке', JSON.stringify(pinned));

  await shot('01-desktop-bar.png');

  /* --------------------- разделитель меняет ширину --------------------- */
  const press = (key) =>
    evaluate(`(() => {
      const handle = document.getElementById('filesResizer');
      handle.focus();
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
      const panel = document.getElementById('filesPanel').getBoundingClientRect();
      const bar = document.getElementById('filesAudio').getBoundingClientRect();
      return { panel: Math.round(panel.width), bar: Math.round(bar.width) };
    })()`);
  const wide1 = await press('ArrowLeft');
  const wide2 = await press('ArrowLeft');
  const wide3 = await press('ArrowLeft');
  wide3.panel > first.panel.w && Math.abs(wide3.bar - (wide3.panel - BAR_INSET * 2)) <= 1
    ? ok('после раздвигания разделителя полоса выросла вместе с панелью', `${first.panel.w} → ${wide3.panel} px`)
    : fail('полоса не следует за разделителем', JSON.stringify({ start: first.panel, wide1, wide2, wide3 }));
  const narrow1 = await press('ArrowRight');
  const narrow2 = await press('ArrowRight');
  const narrow3 = await press('ArrowRight');
  narrow3.panel < wide3.panel && Math.abs(narrow3.bar - (narrow3.panel - BAR_INSET * 2)) <= 1
    ? ok('при сужении полоса снова следует за панелью', `${wide3.panel} → ${narrow3.panel} px`)
    : fail('полоса при сужении', JSON.stringify({ wide3, narrow1, narrow2, narrow3 }));
  await shot('02-desktop-narrow.png');

  /* ------------------------ состояние звука ------------------------ */
  const barWidthMin = await evaluate(`(() => {
    const bar = document.getElementById('filesAudio');
    const row = bar.querySelector('.audio-bar');
    return { fits: row.scrollWidth <= row.clientWidth + 1, w: Math.round(bar.getBoundingClientRect().width), rowW: row.scrollWidth, rowClient: row.clientWidth };
  })()`);
  barWidthMin.fits
    ? ok('кнопки полосы помещаются на узкой панели', `${barWidthMin.w} px`)
    : fail('полоса не влезает', JSON.stringify(barWidthMin));

  /* ------------------- мобильная версия: шторка ------------------- */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(500);
  const closeDrawer = `(() => {
    const app = document.getElementById('app');
    if (app.classList.contains('files-open')) document.getElementById('filesBtn').click();
    return !app.classList.contains('files-open');
  })()`;
  await evaluate(closeDrawer);
  await sleep(200);
  const openedMobile = await evaluate(`(() => {
    document.getElementById('filesBtn').click();
    const app = document.getElementById('app');
    const bar = document.getElementById('filesAudio');
    const r = bar ? bar.getBoundingClientRect() : null;
    return {
      drawer: app.classList.contains('files-open'),
      barVisible: !!bar && !bar.classList.contains('hidden') && (!r || (r.width > 0 && r.height > 0)),
      title: (document.getElementById('filesAudioTitle')?.textContent || '').trim(),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  })()`);
  openedMobile.drawer && openedMobile.barVisible && openedMobile.title === TRACK_TITLE
    ? ok('в мобильной шторке полоса на месте', `${openedMobile.title}`)
    : fail('мобильная шторка', JSON.stringify(openedMobile));
  await shot('03-mobile-drawer.png');

  /* Ссылка на запись в ответе ассистента на телефоне: панель закрыта шторкой, и
     полоса включилась бы невидимой — шторка открывается сама, а окно просмотра
     не появляется: человек слушает и продолжает читать ответ. */
  await evaluate(closeDrawer);
  await sleep(300);
  const chatLinkMobile = await evaluate(`(() => {
    const probe = document.createElement('div');
    probe.className = 'md';
    probe.id = 'chatSoundProbe';
    probe.innerHTML = ${JSON.stringify(
      `<a class="msg-link msg-file" href="#" data-file-path="${TRACK_NAME}" title="Слушать в полосе «Файлы проекта»">${TRACK_NAME}</a>`,
    )};
    document.getElementById('thread').appendChild(probe);
    const drawerBefore = document.getElementById('app').classList.contains('files-open');
    probe.querySelector('a[data-file-path]').click();
    const bar = document.getElementById('filesAudio');
    const rect = bar.getBoundingClientRect();
    return {
      drawerBefore,
      drawer: document.getElementById('app').classList.contains('files-open'),
      barVisible: !bar.classList.contains('hidden') && rect.width > 0 && rect.height > 0,
      title: (document.getElementById('filesAudioTitle')?.textContent || '').trim(),
      modal: !!document.querySelector('.file-preview-modal'),
    };
  })()`);
  chatLinkMobile.drawer && chatLinkMobile.barVisible && chatLinkMobile.title === TRACK_TITLE && !chatLinkMobile.modal
    ? ok('ссылка на запись в ответе на телефоне открывает шторку с полосой')
    : fail('ссылка на запись на телефоне', JSON.stringify(chatLinkMobile));
  await shot('06-mobile-chat-link.png');
  await evaluate(`document.querySelector('#chatSoundProbe')?.remove()`);

  /* закрыть и снова открыть шторку — полоса обязана вернуться */
  await evaluate(closeDrawer);
  await sleep(300);
  const reopened = await evaluate(`(() => {
    document.getElementById('filesBtn').click();
    const bar = document.getElementById('filesAudio');
    const r = bar.getBoundingClientRect();
    const panel = document.getElementById('filesPanel').getBoundingClientRect();
    return {
      barVisible: !bar.classList.contains('hidden') && r.width > 0 && r.height > 0,
      sameTitle: (document.getElementById('filesAudioTitle')?.textContent || '').trim() === ${JSON.stringify(TRACK_TITLE)},
      widthMatch: Math.abs(r.width - (panel.width - ${BAR_INSET * 2})) <= 1,
      atBottom: Math.abs(panel.bottom - r.bottom - ${BAR_GAP}) <= 1,
      players: document.querySelectorAll('#filesPanel .audio-player').length,
      audios: document.querySelectorAll('audio').length,
    };
  })()`);
  reopened.barVisible && reopened.sameTitle && reopened.widthMatch && reopened.atBottom
    ? ok('после закрытия и открытия шторки полоса возвращается')
    : fail('полоса не вернулась', JSON.stringify(reopened));
  reopened.players === 1 && reopened.audios === 1
    ? ok('в документе один плеер и один <audio>')
    : fail('дубли плеера', JSON.stringify(reopened));

  /* крестик убирает полосу, панель остаётся рабочей */
  const dismissed = await evaluate(`(() => {
    document.getElementById('filesAudioClose').click();
    const bar = document.getElementById('filesAudio');
    return {
      hidden: bar.classList.contains('hidden'),
      mounted: !!bar.querySelector('.audio-player'),
      rows: document.querySelectorAll('#filesList .file-row.is-listening').length,
      filesShown: document.querySelectorAll('#filesList .file-row').length,
      listHtml: (document.getElementById('filesList').innerHTML || '').slice(0, 160),
    };
  })()`);
  const filesBack = await waitFor(`document.querySelectorAll('#filesList .file-row').length > 0`, 3000);
  dismissed.hidden && !dismissed.mounted && dismissed.rows === 0 && (dismissed.filesShown > 0 || filesBack)
    ? ok('крестик убирает полосу, список файлов остаётся', filesBack && !dismissed.filesShown ? `список вернулся сам` : '')
    : fail('крестик', JSON.stringify(dismissed));
  await sleep(400);
  const afterDismiss = await evaluate(`!document.getElementById('filesAudio').classList.contains('hidden')`);
  afterDismiss ? fail('полоса вернулась сама', 'крестик не держится') : ok('после крестика полоса не всплывает сама');

  /* возврат на широкий экран: строки снова открывают полосу */
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);
  await evaluate(`(() => {
    const app = document.getElementById('app');
    if (app.classList.contains('files-open')) document.getElementById('filesBtn').click();
    const row = [...document.querySelectorAll('#filesList .file-row')].find((r) => (r.textContent || '').includes(${JSON.stringify(TRACK_NAME)}));
    (row.querySelector('.row-main') || row).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  })()`);
  const backAgain = await waitFor(`!document.getElementById('filesAudio').classList.contains('hidden')`, 4000);
  backAgain ? ok('нажатие по записи снова поднимает полосу') : fail('повторный запуск', 'полоса не появилась');
  await shot('04-desktop-again.png');

  /* ------------------ перезагрузка страницы ------------------ */
  /* Слушали запись, закрыли вкладку, вернулись: на компьютере полоса снова внизу
     панели (без нажатия по строке), на телефоне приходит со шторкой. */
  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  await evaluate(openChat);
  await waitFor(`(document.querySelector('#crumbChat')?.textContent || '').trim().length > 0`);
  await evaluate(`(() => {
    const app = document.getElementById('app');
    if (!app.classList.contains('with-files') && !app.classList.contains('files-open')) {
      const toggle = document.getElementById('filesBtn');
      if (toggle) toggle.click();
    }
  })()`);
  const restored = await waitFor(`(() => {
    const bar = document.getElementById('filesAudio');
    if (!bar || bar.classList.contains('hidden')) return false;
    const title = (document.getElementById('filesAudioTitle')?.textContent || '').trim();
    const panel = document.getElementById('filesPanel');
    return title === ${JSON.stringify(TRACK_TITLE)} && !!bar.querySelector('.audio-bar')
      && Math.abs(bar.getBoundingClientRect().width - (panel.getBoundingClientRect().width - ${BAR_INSET * 2})) <= 1;
  })()`, 12000);
  restored
    ? ok('после перезагрузки полоса снова внизу панели', TRACK_NAME)
    : fail('полоса после перезагрузки', await evaluate(`(document.getElementById('filesList')?.textContent || '').slice(0, 120)`));
  await shot('05-after-reload.png');

  const noise = consoleErrors.filter((text) => !/favicon|ResizeObserver|net::ERR_ABORTED/i.test(String(text)));
  noise.length === 0 ? ok('в консоли страницы чисто') : fail('ошибки в консоли', noise.slice(0, 3).join(' | '));

  console.log(`\nснимки: ${SHOT_DIR}`);
  console.log(failed === 0 ? `\nвсе ${passed} проверок прошли` : `\n${passed} прошло, ${failed} упало`);
} catch (error) {
  failed++;
  console.log(`  FAIL общий ход проверки: ${error && error.message ? error.message : error}`);
} finally {
  try {
    chrome.kill();
  } catch {
    /* уже остановлен */
  }
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* профиль занят — не беда */
  }
  process.exit(failed === 0 ? 0 : 1);
}

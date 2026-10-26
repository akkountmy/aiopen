// Проверка подсказок в мобильной версии в настоящем Chrome через DevTools-протокол (без зависимостей):
//   - шесть коротких карточек «Чем помочь?» стоят по две в ряд на телефоне (390 px и 320 px),
//     последняя занимает всю ширину;
//   - ничего не вылезает по горизонтали, текст карточек не обрезан;
//   - «Файлы проекта» выезжают таким же ящиком, как «Проекты», и закрываются крестиком.
//
// Запуск (нужен уже работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/ui-mobile.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка мобильной версии пропущена');
  process.exit(0);
}

const results = [];
function ok(name, extra = '') {
  results.push(true);
  console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`);
}
function fail(name, detail) {
  results.push(false);
  console.log(`  FAIL ${name}: ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------- Chrome + CDP ---------------------------- */

const PORT = Number(process.env.DSHOW_CDP_PORT || 9334);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-cdp-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function pageWs() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const pages = (await res.json()).filter((t) => t.type === 'page');
      if (pages.length) return pages[0].webSocketDebuggerUrl;
    } catch {
      /* ещё стартует */
    }
    await sleep(250);
  }
  throw new Error('Chrome не поднял DevTools-порт');
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
    close() {
      socket.close();
    },
  };
}

try {
  const cdp = connect(await pageWs());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async function goto(url) {
    await cdp.send('Page.navigate', { url });
    await sleep(600);
  }

  async function waitFor(expression, timeoutMs = 8000) {
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

  // 1. вход через API внутри страницы (cookie ставится как при обычном входе)
  await goto(BASE + '/');
  const loginStatus = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  loginStatus === 200 ? ok('вход в сервис') : fail('вход', loginStatus);

  // 2. пустой диалог — именно там видны подсказки «Чем помочь?»
  //    Заводим отдельный проект: приложение запоминает последний проект, а
  //    свежий после перезагрузки оказывается первым. Так тест не зависит от
  //    того, что уже лежит у пользователя.
  const target = await evaluate(
    `(async () => {
       const project = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проверка мобильной версии'})})).json()).project;
       await fetch('/api/projects/' + project.id + '/chats', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Мобильная проверка'})});
       return { id: project.id };
     })()`,
  );

  async function checkWidth(width, height) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await goto(BASE + '/');
    const shown = await waitFor(`!!document.querySelector('.suggestions .suggestion')`);
    if (!shown) {
      fail(`подсказки при ${width}px`, 'карточек нет на экране');
      return;
    }
    const layout = await evaluate(`(() => {
       const box = document.querySelector('.suggestions');
       const cards = [...box.querySelectorAll('.suggestion')].map((node) => {
         const rect = node.getBoundingClientRect();
         return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), text: node.innerText.trim() };
       });
       return {
         cards,
         columns: getComputedStyle(box).gridTemplateColumns.split(' ').filter(Boolean).length,
         rows: new Set(cards.map((card) => card.y)).size,
         overflow: document.documentElement.scrollWidth - window.innerWidth,
         clipped: [...box.querySelectorAll('.suggestion')].some((node) => node.scrollHeight > node.clientHeight + 1),
         viewport: window.innerWidth,
       };
     })()`);
    layout.cards.length === 6 ? ok(`подсказки при ${width}px: шесть карточек`) : fail(`карточки при ${width}px`, String(layout.cards.length));
    layout.columns === 2 ? ok(`две карточки в ряд при ${width}px`, `ширина ${layout.cards[0].w}px`) : fail(`колонки при ${width}px`, `колонок ${layout.columns}`);
    layout.rows === 3 ? ok(`три ряда при ${width}px`) : fail(`ряды при ${width}px`, `рядов ${layout.rows}`);
    layout.cards[0].x < layout.cards[1].x && layout.cards[0].y === layout.cards[1].y
      ? ok(`первая пара стоит рядом при ${width}px`)
      : fail(`раскладка при ${width}px`, JSON.stringify(layout.cards));
    layout.overflow <= 0 ? ok(`нет горизонтальной прокрутки при ${width}px`) : fail(`переполнение при ${width}px`, `${layout.overflow}px`);
    layout.clipped ? fail(`обрезка текста при ${width}px`, 'текст карточек не влез') : ok(`текст карточек влезает при ${width}px`);
    if (process.env.DSHOW_MOBILE_SHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.DSHOW_MOBILE_SHOT.replace('.png', `-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
  }

  for (const [width, height] of [[390, 844], [360, 780], [320, 640]]) await checkWidth(width, height);

  // 2а. композер как в приложении DeepSeek: поле сверху, «Рассуждения» внизу
  //     слева, справа — прикрепление, орфография, микрофон и отправка.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('micBtn') && document.documentElement.classList.contains('compact-input')`);
  const composer = await evaluate(`(() => {
    const q = (selector) => document.querySelector(selector);
    const box = (selector) => q(selector).getBoundingClientRect();
    const css = (selector) => getComputedStyle(q(selector));
    return {
      grid: css('#composer').display,
      placeholder: q('#input').placeholder,
      greeting: q('.empty-title') ? q('.empty-title').textContent.trim() : '',
      inputTop: Math.round(box('#input').top),
      thinkTop: Math.round(box('#thinkToggle').top),
      photoTop: Math.round(box('#photoBtn').top),
      sameRow: Math.abs(box('#micBtn').top - box('#sendBtn').top) < 2,
      thinkLabel: css('#thinkToggle span').display,
      thinkShape: css('#thinkToggle').borderRadius,
      round: css('#photoBtn').borderRadius,
      plus: !!q('#attachBtn'),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  composer.grid === 'grid' ? ok('композер собран сеткой, как в приложении') : fail('раскладка композера', composer.grid);
  composer.inputTop < composer.thinkTop && Math.abs(composer.thinkTop - composer.photoTop) < 2
    ? ok('поле сверху, ряд кнопок внизу: «Рассуждения» стоит с остальными кнопками')
    : fail('порядок блоков композера', JSON.stringify(composer));
  composer.sameRow ? ok('микрофон и отправка в одном ряду') : fail('ряд кнопок правой стороны', JSON.stringify(composer));
  composer.thinkLabel === 'none' ? ok('«Рассуждения» на телефоне — кнопка без подписи') : fail('подпись кнопки режима', composer.thinkLabel);
  composer.thinkShape === '50%' && composer.round === '50%' ? ok('круглые кнопки, как в приложении') : fail('форма кнопок', `${composer.thinkShape}/${composer.round}`);
  composer.plus ? fail('кнопка «＋»', 'осталась в разметке') : ok('кнопки «＋» больше нет');
  composer.placeholder.includes('удерживайте') ? ok('подсказка в поле говорит про удержание') : fail('подсказка в поле', composer.placeholder);
  composer.greeting.startsWith('Привет!') ? ok('приветствие как в приложении') : fail('приветствие', composer.greeting);
  composer.overflow <= 0 ? ok('композер не даёт горизонтальной прокрутки') : fail('переполнение композера', `${composer.overflow}px`);

  await evaluate(`(() => {
    window.__picked = [];
    const proto = HTMLInputElement.prototype;
    const original = proto.click;
    proto.click = function () {
      if (this.id === 'fileInput') {
        window.__picked.push({ accept: this.accept, capture: this.getAttribute('capture') });
        return;
      }
      return original.call(this);
    };
    return true;
  })()`);
  await evaluate(`document.getElementById('photoBtn').click(); true`);
  await evaluate(`document.getElementById('galleryBtn').click(); true`);
  await evaluate(`document.getElementById('fileBtn').click(); true`);
  const picked = await evaluate(`JSON.stringify(window.__picked)`).then((text) => JSON.parse(text));
  if (process.env.DSHOW_MOBILE_SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.DSHOW_MOBILE_SHOT.replace('.png', '-attach.png'), Buffer.from(shot.data, 'base64'));
  }
  picked.length === 3 ? ok('три кнопки — три отдельных выбора файла') : fail('кнопки прикрепления', JSON.stringify(picked));
  picked[0] && picked[0].accept === 'image/*' && picked[0].capture === 'environment'
    ? ok('«Сфотографировать» зовёт камеру на фото')
    : fail('камера', JSON.stringify(picked[0]));
  picked[1] && picked[1].accept === 'image/*' && !picked[1].capture
    ? ok('«Фото из галереи» берёт снимки без камеры')
    : fail('галерея', JSON.stringify(picked[1]));
  picked[2] && picked[2].accept === '' && !picked[2].capture
    ? ok('«Файл» берёт любые файлы')
    : fail('файл', JSON.stringify(picked[2]));

  // 2б. на компьютере всё прежнее: ряд кнопок, три кнопки прикрепления, своя подсказка.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('micBtn') && !document.documentElement.classList.contains('compact-input')`);
  const desktop = await evaluate(`(() => {
    const css = (selector) => getComputedStyle(document.querySelector(selector));
    return {
      grid: css('#composer').display,
      think: css('#thinkToggle').display,
      photo: css('#photoBtn').display,
      gallery: css('#galleryBtn').display,
      file: css('#fileBtn').display,
      placeholder: document.querySelector('#input').placeholder,
    };
  })()`);
  desktop.grid !== 'grid' ? ok('на компьютере композер остался прежним') : fail('раскладка на компьютере', desktop.grid);
  desktop.think === 'none' ? ok('на компьютере кнопки режима нет') : fail('кнопка режима на компьютере', desktop.think);
  desktop.photo !== 'none' && desktop.gallery !== 'none' && desktop.file !== 'none'
    ? ok('на компьютере три кнопки прикрепления на месте')
    : fail('кнопки прикрепления на компьютере', JSON.stringify(desktop));
  desktop.placeholder === 'Спросите или поставьте задачу…' ? ok('подсказка на компьютере прежняя') : fail('подсказка на компьютере', desktop.placeholder);

  // 2б. голос с удержанием: слой подсказки есть, спрятан и не перехватывает
  //     касания, микрофон слушается удержания, режим ответа — один.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('micBtn')`);
  const voice = await evaluate(`(() => {
    const overlay = document.getElementById('voiceOverlay');
    const hint = document.getElementById('voiceOverlayHint');
    const mic = document.getElementById('micBtn');
    const chips = [...document.querySelectorAll('.mode-chip')].map((b) => b.textContent.trim());
    return {
      exists: !!overlay,
      hidden: overlay ? overlay.classList.contains('hidden') : null,
      ariaHidden: overlay ? overlay.getAttribute('aria-hidden') : null,
      hint: hint ? hint.textContent.trim() : '',
      pointerEvents: overlay ? getComputedStyle(overlay).pointerEvents : '',
      touchAction: getComputedStyle(mic).touchAction,
      chips,
    };
  })()`);
  voice.exists && voice.hidden === true && voice.ariaHidden === 'true'
    ? ok('подсказка удержания спрятана, пока микрофон не нажат')
    : fail('слой подсказки удержания', JSON.stringify(voice));
  voice.hint === 'Отпустите, чтобы отправить, сдвиньте вверх для отмены'
    ? ok('подсказка удержания объясняет отправку и отмену')
    : fail('текст подсказки удержания', voice.hint);
  voice.pointerEvents === 'none'
    ? ok('слой подсказки не перехватывает палец')
    : fail('pointer-events слоя подсказки', voice.pointerEvents);
  voice.touchAction === 'none'
    ? ok('микрофон слушается удержания, а не прокрутки')
    : fail('touch-action микрофона', voice.touchAction);
  voice.chips.length === 1 && voice.chips[0] === 'Рассуждения'
    ? ok('в композере один режим — «Рассуждения»')
    : fail('режимы композера', JSON.stringify(voice.chips));

  // 3. выезжающие ящики: «Файлы проекта» выезжает так же, как «Проекты»,
  //    того же размера, и закрывается крестиком в своём заголовке.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  const DRAWERS = `(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width),
        corners: style.borderRadius.split(' ').filter(Boolean), visibility: style.visibility, display: style.display,
      };
    };
    const app = document.getElementById('app').classList;
    return {
      viewport: window.innerWidth,
      sidebar: box('#sidebar'),
      files: box('#filesPanel'),
      close: box('#filesClose'),
      backdrop: getComputedStyle(document.getElementById('backdrop')).display,
      sidebarOpen: app.contains('sidebar-open'),
      filesOpen: app.contains('files-open'),
    };
  })()`;
  await evaluate(`document.getElementById('sidebarToggle').click()`);
  await waitFor(`document.getElementById('app').classList.contains('sidebar-open')`);
  const sidebarDrawer = await evaluate(DRAWERS);
  await evaluate(`document.getElementById('backdrop').click()`);
  await waitFor(`!document.getElementById('app').classList.contains('sidebar-open')`);
  await evaluate(`document.getElementById('filesBtn').click()`);
  await waitFor(`document.getElementById('app').classList.contains('files-open')`);
  const filesDrawer = await evaluate(DRAWERS);
  const sameWidth = sidebarDrawer.sidebar.width === filesDrawer.files.width;
  sameWidth
    ? ok('ящик файлов той же ширины, что ящик проектов', `${filesDrawer.files.width} px`)
    : fail('ширина ящиков', JSON.stringify({ sidebar: sidebarDrawer.sidebar.width, files: filesDrawer.files.width }));
  filesDrawer.files.right === filesDrawer.viewport && sidebarDrawer.sidebar.left === 0
    ? ok('файлы выезжают справа, проекты — слева')
    : fail('края ящиков', JSON.stringify({ filesRight: filesDrawer.files.right, viewport: filesDrawer.viewport, sidebarLeft: sidebarDrawer.sidebar.left }));
  const mirrored =
    filesDrawer.files.corners[0] === sidebarDrawer.sidebar.corners[1] &&
    filesDrawer.files.corners[3] === sidebarDrawer.sidebar.corners[2];
  mirrored
    ? ok('скругления у ящиков зеркальные', `${filesDrawer.files.corners.join(' ')} / ${sidebarDrawer.sidebar.corners.join(' ')}`)
    : fail('скругления ящиков', JSON.stringify({ files: filesDrawer.files.corners, sidebar: sidebarDrawer.sidebar.corners }));
  filesDrawer.filesOpen && !filesDrawer.sidebarOpen && filesDrawer.backdrop !== 'none'
    ? ok('открыт один ящик, остальное затемнено')
    : fail('состояние ящиков', JSON.stringify(filesDrawer));
  /* Крестика в шапке панели больше нет: в ящике её закрывают затемнение,
     кнопка-папка в шапке и Escape. */
  filesDrawer.close === null
    ? ok('в шапке панели файлов нет крестика закрытия')
    : fail('крестик ящика файлов', JSON.stringify(filesDrawer.close));
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  );
  // visibility переключается по завершении выезда (0,28 s), поэтому ждём её, а не класс.
  const filesClosed = await waitFor(`(() => {
    const panel = document.getElementById('filesPanel');
    if (document.getElementById('app').classList.contains('files-open')) return false;
    return getComputedStyle(panel).visibility === 'hidden';
  })()`);
  const closedState = await evaluate(DRAWERS);
  filesClosed && closedState.files.visibility === 'hidden'
    ? ok('Escape закрывает ящик файлов')
    : fail('закрытие ящика файлов', JSON.stringify(closedState.files));

  // 3.1. В дашборде правый блок тоже должен выезжать: панель файлов раньше
  //      пряталась правилом !important без учёта ширины экрана, и кнопка-папка
  //      в шапке на телефоне не открывала ничего.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  await evaluate(`document.getElementById('dashboardBtn').click()`);
  const dashShown = await waitFor(`document.getElementById('app').classList.contains('dash-open')`);
  dashShown ? ok('дашборд открывается на телефоне') : fail('дашборд на телефоне не открылся');
  if (process.env.DSHOW_MOBILE_SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.DSHOW_MOBILE_SHOT.replace('.png', '-dashboard.png'), Buffer.from(shot.data, 'base64'));
  }
  await evaluate(`document.getElementById('filesBtn').click()`);
  await waitFor(`document.getElementById('app').classList.contains('files-open')`);
  const dashDrawer = await evaluate(DRAWERS);
  dashDrawer.filesOpen ? ok('в дашборде ящик файлов открывается') : fail('ящик файлов в дашборде', JSON.stringify(dashDrawer));
  const dashPanelOnScreen =
    dashDrawer.files &&
    dashDrawer.files.display !== 'none' &&
    dashDrawer.files.visibility === 'visible' &&
    dashDrawer.files.right === dashDrawer.viewport;
  dashPanelOnScreen
    ? ok('в дашборде панель файлов видна на экране', `${dashDrawer.files.width} px`)
    : fail('панель файлов в дашборде скрыта', JSON.stringify(dashDrawer.files));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(`!document.getElementById('app').classList.contains('files-open')`);
  await evaluate(`document.getElementById('dashboardBtn').click()`);
  await waitFor(`!document.getElementById('app').classList.contains('dash-open')`);
  (await evaluate(`!document.getElementById('app').classList.contains('dash-open')`))
    ? ok('дашборд закрывается, ящик убран')
    : fail('дашборд не закрылся');

  // 3.2. Значки в шапке нарисованы одинаково: «Дашборд», профиль, тема и папка
  //      одного размера. Контурные — одной толщины 2 px. Штрих считается в
  //      экранных пикселях (vector-effect: non-scaling-stroke), поэтому 2 px
  //      одинаковы и на 22 px, и на 24 px. Папка — исключение по заливке: это
  //      та же раскрытая папка, что в заголовке панели «Файлы проекта».
  const headerIcons = await evaluate(`(() => [...document.querySelectorAll('.topbar-right svg')]
    .filter((svg) => svg.getBoundingClientRect().width > 0 && !svg.classList.contains('chev'))
    .map((svg) => ({
      id: svg.closest('button') ? svg.closest('button').id : '',
      size: Math.round(svg.getBoundingClientRect().width * 10) / 10,
      stroke: getComputedStyle(svg).strokeWidth,
      scaling: getComputedStyle(svg.querySelector('*')).vectorEffect,
      fill: getComputedStyle(svg).fill,
    })))()`);
  const iconSizes = [...new Set(headerIcons.map((icon) => icon.size))];
  const lineIcons = headerIcons.filter((icon) => icon.id !== 'filesBtn');
  const lineStrokes = [...new Set(lineIcons.map((icon) => icon.stroke))];
  const lineScaling = [...new Set(lineIcons.map((icon) => icon.scaling))];
  headerIcons.length === 4 && iconSizes.length === 1 && lineIcons.length === 3 && lineStrokes.length === 1 &&
  lineStrokes[0] === '2px' && lineScaling.length === 1 && lineScaling[0] === 'non-scaling-stroke'
    ? ok('значки шапки одного размера, контурные — одной толщины', `${headerIcons.map((icon) => `${icon.id}:${icon.size}`).join(' / ')}, штрих ${lineStrokes[0]} без масштабирования`)
    : fail('значки шапки разной толщины', JSON.stringify(headerIcons));
  const filled = headerIcons.filter((icon) => icon.fill !== 'none');
  const folderMatchesPanel = await evaluate(`(() => {
    const inBar = document.querySelector('#filesBtn svg path');
    const inPanel = document.querySelector('#filesProjectTitle svg path');
    if (!inBar || !inPanel) return false;
    const a = inBar.getAttribute('d');
    const b = inPanel.getAttribute('d');
    return !!a && a === b;
  })()`);
  filled.length === 1 && filled[0].id === 'filesBtn' && folderMatchesPanel
    ? ok('папка в шапке залита той же иконкой, что заголовок «Файлы проекта»')
    : fail('иконка папки в шапке не совпала с панелью', JSON.stringify({ filled, folderMatchesPanel }));

  // 3.2б. Верх плашек «Новый проект» и «Файлы проекта» не подрезан: полоска под
  //       системную строку состояния не лежит поверх содержимого. Цвет верхней
  //       полосы iOS 26 берёт из фона .app — он должен быть непрозрачным и
  //       совпадать с фоном страницы в обеих темах.
  const plateTops = await evaluate(`(() => {
    const tint = document.querySelector('.status-tint');
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden';
    document.body.appendChild(probe);
    const safe = Math.round(probe.getBoundingClientRect().height);
    probe.remove();
    const top = (el) => (el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null);
    return {
      tint: tint ? Math.round(tint.getBoundingClientRect().height) : null,
      safe,
      newProject: top(document.getElementById('newProjectBtn')),
      filesTitle: top(document.getElementById('filesProjectTitle')),
      appBg: getComputedStyle(document.getElementById('app')).backgroundColor,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  })()`);
  plateTops.tint === plateTops.safe &&
  Math.min(plateTops.newProject, plateTops.filesTitle) >= plateTops.tint &&
  plateTops.appBg === plateTops.bodyBg && plateTops.appBg !== 'rgba(0, 0, 0, 0)'
    ? ok('полоска статус-бара не накрывает верх плашек, у .app цвет темы', `полоска ${plateTops.tint} px, плашки с ${plateTops.newProject}/${plateTops.filesTitle} px`)
    : fail('полоска статус-бара подрезает верх плашек', JSON.stringify(plateTops));
  const dashLabel = await evaluate(`(() => {
    const btn = document.getElementById('dashboardBtn');
    const label = btn.querySelector('.dash-btn-label');
    return { text: btn.innerText.trim(), label: label ? getComputedStyle(label).display : 'нет в разметке' };
  })()`);
  dashLabel.text === '' && dashLabel.label !== 'inline'
    ? ok('у «Дашборда» на телефоне только значок')
    : fail('подпись у «Дашборда» на телефоне', JSON.stringify(dashLabel));

  // 3.5. Ряд значков справа ровный: кнопка профиля — такой же квадрат, как
  //      соседи, поэтому промежутки между всеми иконками одинаковые. Раньше в
  //      ней стоял ник, кнопка была шире, и шаг выглядел разным.
  const rightRow = await evaluate(`(() => {
    const row = document.querySelector('.topbar-right');
    const nodes = Array.from(row.children).filter((node) => getComputedStyle(node).display !== 'none');
    const boxes = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { id: node.id, width: Math.round(rect.width), height: Math.round(rect.height), left: rect.left, right: rect.right };
    });
    return {
      gap: getComputedStyle(row).columnGap,
      gaps: boxes.slice(1).map((box, index) => Math.round(box.left - boxes[index].right)),
      boxes: boxes.map((box) => box.width + '×' + box.height),
      nameShown: document.getElementById('userName').getBoundingClientRect().width > 0,
    };
  })()`);
  const evenGap = rightRow.gaps.length >= 2 && new Set(rightRow.gaps).size === 1;
  evenGap && rightRow.gaps[0] > 0 && new Set(rightRow.boxes).size === 1 && !rightRow.nameShown
    ? ok('значки справа стоят с одинаковым шагом', `шаг ${rightRow.gaps[0]} px, кнопки ${rightRow.boxes[0]}`)
    : fail('шаг значков справа', JSON.stringify(rightRow));

  // 3.6. Ник на телефоне не потерян: он переехал в начало раскрывающегося
  //      списка профиля — туда, куда и так ведёт нажатие на значок.
  await evaluate(`document.getElementById('userChip').click()`);
  const profileHead = await waitFor(`(() => {
    const head = document.querySelector('.menu .menu-account');
    return !!head && getComputedStyle(head).display !== 'none';
  })()`);
  const profileMenu = profileHead
    ? await evaluate(`(() => {
        const account = document.querySelector('.menu .menu-account');
        const headerName = document.getElementById('userName').textContent.trim();
        return {
          name: (account.querySelector('.menu-account-name') || {}).textContent.trim(),
          role: (account.querySelector('.menu-account-role') || {}).textContent.trim(),
          buttons: Array.from(document.querySelectorAll('.menu > button')).map((btn) => btn.textContent.trim()),
        };
      })()`)
    : null;
  profileMenu && profileMenu.name && profileMenu.name === await evaluate(`document.getElementById('userName').textContent.trim()`) && !profileMenu.buttons.includes(profileMenu.name)
    ? ok('ник показан в списке профиля', `${profileMenu.name}${profileMenu.role ? ', ' + profileMenu.role : ''}`)
    : fail('ник в списке профиля', JSON.stringify(profileMenu));
  if (process.env.DSHOW_MOBILE_SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.DSHOW_MOBILE_SHOT.replace('.png', '-profile.png'), Buffer.from(shot.data, 'base64'));
  }
  if (profileHead) await evaluate(`document.getElementById('userChip').click()`);
  await waitFor(`!document.querySelector('.menu')`);

  // 3.4. Кнопка-меню отмечена, когда проект открыт: по ней видно, что список
  //      проектов не пустой и открытый проект лежит именно там. Постоянной
  //      плашки у неё нет — фон остаётся только коротким откликом на нажатие,
  //      поэтому кнопка не выглядит «залипшей».
  const burger = await evaluate(`(() => {
    const node = document.getElementById('sidebarToggle');
    const style = getComputedStyle(node);
    return {
      active: node.classList.contains('active'),
      pressed: node.getAttribute('aria-pressed'),
      bg: style.backgroundColor,
      project: (document.querySelector('.project.active .p-name') || {}).textContent || null,
    };
  })()`);
  burger.active && burger.pressed === 'true' && burger.project && burger.bg === 'rgba(0, 0, 0, 0)'
    ? ok('кнопка-меню отмечена при открытом проекте и не держит плашку', `проект «${burger.project}»`)
    : fail('подсветка кнопки-меню', JSON.stringify(burger));
  await evaluate(`document.getElementById('dashboardBtn').click()`);
  const dashPainted = await waitFor(`document.getElementById('dashboardBtn').classList.contains('active')`);
  const dashBg = dashPainted ? await evaluate(`getComputedStyle(document.getElementById('dashboardBtn')).backgroundColor`) : '';
  await evaluate(`document.getElementById('dashboardBtn').click()`);
  await waitFor(`!document.getElementById('app').classList.contains('dash-open')`);
  dashBg === 'rgba(0, 0, 0, 0)' && dashBg === burger.bg
    ? ok('открытый «Дашборд» не залит, как и кнопка-меню', dashBg)
    : fail('фон открытого «Дашборда»', JSON.stringify({ menu: burger.bg, dash: dashBg }));

  // 3.3. Меню профиля сворачивается от нажатия в любом другом месте сервиса:
  //      раньше слушали только mousedown, а на телефоне касание в ленту или
  //      прокрутка оставляли список висеть открытым.
  await evaluate(`document.getElementById('userChip').click()`);
  const menuShown = await waitFor(`!!document.querySelector('.menu')`);
  menuShown ? ok('меню профиля открывается') : fail('меню профиля не открылось');
  if (menuShown) {
    const chipBox = await evaluate(`(() => { const r = document.getElementById('userChip').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 40, y: 400 }] });
    await sleep(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const menuClosed = await waitFor(`!document.querySelector('.menu')`, 4000);
    menuClosed ? ok('касание в стороне сворачивает меню профиля') : fail('меню профиля осталось открытым после касания в стороне');
    // Прокрутка ленты тоже убирает список, а не оставляет его висеть над ней.
    await evaluate(`document.getElementById('userChip').click()`);
    await waitFor(`!!document.querySelector('.menu')`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 620 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y: 500 }] });
    await sleep(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const closedByScroll = await waitFor(`!document.querySelector('.menu')`, 4000);
    closedByScroll ? ok('прокрутка ленты сворачивает меню профиля') : fail('меню профиля осталось после прокрутки');
    // Повторное нажатие на профиль закрывает список.
    await evaluate(`document.getElementById('userChip').click()`);
    await waitFor(`!!document.querySelector('.menu')`);
    await evaluate(`document.getElementById('userChip').click()`);
    const toggled = await waitFor(`!document.querySelector('.menu')`, 4000);
    toggled ? ok('повторное нажатие на профиль сворачивает меню') : fail('меню не свернулось повторным нажатием');
    if (!menuClosed) console.log('    профиль был в', JSON.stringify(chipBox));
  }

  // 4. файл в приложении-ярлыке: тап открывает своё окно просмотра, а
  //    «Скачать» оттуда не уводит из приложения. Раньше ссылка отдавала файл
  //    системе: открывалось чужое окно «чем открыть файл», из которого не было
  //    ни «назад», ни «закрыть» — оставалось перезапускать ярлык.
  const PHONE_FILE = 'мобильный-файл.txt';
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  /* Без этого Chrome не считает указатель грубым, и тап по строке файла не
     доходит до мобильного поведения (двойной щелчок — это компьютер). */
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  const fileUploaded = await evaluate(
    `(async () => {
       const res = await fetch('/api/projects/' + ${JSON.stringify(target.id)} + '/upload?path=' + encodeURIComponent(${JSON.stringify(PHONE_FILE)}), {
         method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'файл для проверки мобильной версии',
       });
       return res.status;
     })()`,
  );
  fileUploaded === 200 ? ok('файл для мобильной проверки загружен') : fail('загрузка файла на телефоне', fileUploaded);
  // Встаём в свой проект и открываем ящик «Файлы проекта».
  await evaluate(`(() => {
     const row = [...document.querySelectorAll('.project-row')].find(r => r.textContent.includes('Проверка мобильной версии'));
     if (row) row.click();
     return !!row;
   })()`);
  await sleep(600);
  await evaluate(`document.getElementById('filesBtn').click()`);
  await waitFor(`document.getElementById('app').classList.contains('files-open')`);
  const fileSeen = await waitFor(`[...document.querySelectorAll('.file-row .f-name')].some(n => n.textContent === ${JSON.stringify(PHONE_FILE)})`, 8000);
  fileSeen ? ok('файл виден в ящике на телефоне') : fail('файл не появился в ящике', await evaluate(`document.getElementById('filesList').innerText`));

  if (fileSeen) {
    // Тап по строке на телефоне: своё окно просмотра, без перехода на файл.
    await evaluate(`(() => {
       window.__downloads = [];
       if (!window.__linkProbe) {
         const native = HTMLAnchorElement.prototype.click;
         HTMLAnchorElement.prototype.click = function () {
           if (this.hasAttribute('download')) { window.__downloads.push({ href: this.href, name: this.download }); return; }
           return native.call(this);
         };
         window.__linkProbe = true;
       }
       const row = [...document.querySelectorAll('.file-row')].find(r => (r.querySelector('.f-name') || {}).textContent === ${JSON.stringify(PHONE_FILE)});
       row.querySelector('.f-name').click();
       return true;
     })()`);
    const previewOpen = await waitFor(`!!document.querySelector('.file-preview-modal')`, 8000);
    previewOpen ? ok('тап по файлу открывает своё окно просмотра') : fail('окно просмотра не открылось');
    const stillApp = await evaluate(`({ path: location.pathname, app: !!document.getElementById('composer') })`);
    stillApp && stillApp.app && !stillApp.path.startsWith('/api/')
      ? ok('после тапа по файлу приложение на месте')
      : fail('тап по файлу увёл из приложения', stillApp);

    // «Скачать» из окна просмотра: сохраняется из памяти приложения.
    const saved = await evaluate(`(async () => {
       const button = [...document.querySelectorAll('.file-preview-modal button')].find(b => b.textContent.trim() === 'Скачать');
       if (!button) return { missing: true };
       button.click();
       for (let i = 0; i < 100 && !window.__downloads.length; i += 1) await new Promise((r) => setTimeout(r, 100));
       return { downloads: window.__downloads, path: location.pathname, app: !!document.getElementById('composer') };
     })()`);
    saved && saved.downloads && saved.downloads.length === 1 && /^blob:/.test(saved.downloads[0].href) && saved.downloads[0].name === PHONE_FILE
      ? ok('«Скачать» сохраняет файл, не открывая чужие окна')
      : fail('«Скачать» на телефоне', saved);
    saved && saved.app && !saved.path.startsWith('/api/')
      ? ok('после скачивания приложение остаётся открытым')
      : fail('скачивание увело из приложения', saved);

    // Окно закрывается крестиком/кнопкой, разговор на месте — перезапуск не нужен.
    await evaluate(`(() => {
       const button = [...document.querySelectorAll('.file-preview-modal button')].find(b => b.textContent.trim() === 'Закрыть');
       if (button) button.click();
       return !!button;
     })()`);
    const closed = await waitFor(`!document.querySelector('.file-preview-modal')`, 5000);
    const usable = await evaluate(`!!document.getElementById('composer') && !document.getElementById('app').classList.contains('hidden')`);
    closed && usable
      ? ok('окно просмотра закрывается, приложение работает дальше')
      : fail('закрытие окна просмотра', { closed, usable });
  }

  // 5. уборка: свой проект удаляем, чужие не трогаем
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  const cleaned = await evaluate(
    `(async () => {
       const res = await fetch('/api/projects/' + ${JSON.stringify(target.id)}, {method:'DELETE'});
       const boot = await (await fetch('/api/bootstrap')).json();
       return { status: res.status, left: (boot.projects || []).length };
     })()`,
  );
  cleaned.status === 200 ? ok('тестовый проект удалён') : fail('уборка проекта', JSON.stringify(cleaned));
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);

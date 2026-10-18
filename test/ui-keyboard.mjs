// Проверка мобильной вёрстки при открытой клавиатуре (настоящий Chrome + DevTools-протокол).
//
// Клавиатуру в headless-браузере не нажать, поэтому visualViewport подменяется
// до загрузки скриптов: тест «открывает» её так же, как это делает iOS —
// уменьшается visible height, страница пытается подкрутиться вверх.
//
// Что проверяем:
//   - окно приложения сжимается по видимой области, композер целиком внутри экрана;
//   - страница не растягивается вбок: ни диалог, ни сообщения, ни длинные адреса;
//   - в поле ввода 16 px (иначе Safari увеличивает страницу и края уезжают);
//   - после закрытия клавиатуры высота возвращается к полной.
//
// Запуск (нужен уже работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/ui-keyboard.mjs
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
  console.log('  --  Chrome/Edge не найден, проверка клавиатуры пропущена');
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

/* Подмена visualViewport до загрузки приложения: window.__kb(высота, сдвиг)
   «открывает» клавиатуру, window.__kb(null) — закрывает. */
const FAKE_VV = `(() => {
  const target = new EventTarget();
  const fake = {
    height: window.innerHeight,
    width: window.innerWidth,
    offsetTop: 0,
    offsetLeft: 0,
    pageTop: 0,
    pageLeft: 0,
    scale: 1,
    addEventListener: (type, fn, opts) => target.addEventListener(type, fn, opts),
    removeEventListener: (type, fn, opts) => target.removeEventListener(type, fn, opts),
    dispatchEvent: (event) => target.dispatchEvent(event),
  };
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
  window.__kb = (height, offsetTop = 0) => {
    fake.height = height === null ? window.innerHeight : height;
    fake.offsetTop = offsetTop;
    target.dispatchEvent(new Event('resize'));
    target.dispatchEvent(new Event('scroll'));
  };
})();`;

const PORT = Number(process.env.DSHOW_CDP_PORT || 9336);
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
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_VV });

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async function goto(url) {
    await cdp.send('Page.navigate', { url });
    await sleep(700);
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

  // Вход и пустой диалог: композер виден сразу, посторонние сообщения не мешают.
  await goto(BASE + '/');
  const loginStatus = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  loginStatus === 200 ? ok('вход в сервис') : fail('вход', loginStatus);

  const project = await evaluate(
    `(async () => {
       const created = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проверка клавиатуры'})})).json()).project;
       await fetch('/api/projects/' + created.id + '/chats', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Клавиатура'})});
       return created.id;
     })()`,
  );

  /* Мерки: страница не шире экрана, композер внутри окна приложения,
     шрифт в поле ввода не меньше 16 px. */
  const MEASURE = `(() => {
     const app = document.querySelector('.app');
     const composer = document.querySelector('.composer');
     const wrap = document.querySelector('.composer-wrap');
     const input = document.querySelector('#input');
     const box = app.getBoundingClientRect();
     const cbox = composer.getBoundingClientRect();
     const wbox = wrap.getBoundingClientRect();
     return {
       vw: window.innerWidth,
       appH: Math.round(box.height),
       appBottom: Math.round(box.bottom),
       composerRight: Math.round(cbox.right),
       composerBottom: Math.round(cbox.bottom),
       composerHeight: Math.round(cbox.height),
       wrapRight: Math.round(wbox.right),
       wrapBottom: Math.round(wbox.bottom),
       inputFont: parseFloat(getComputedStyle(input).fontSize),
       inputRight: Math.round(input.getBoundingClientRect().right),
       overflow: document.documentElement.scrollWidth - window.innerWidth,
       kbOpen: document.documentElement.classList.contains('kb-open'),
       appVar: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim(),
       kbVar: getComputedStyle(document.documentElement).getPropertyValue('--kb-offset').trim(),
     };
   })()`;

  async function checkWidth(width, height) {
    const keyboard = 320;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await goto(BASE + '/');
    const ready = await waitFor(`!!document.querySelector('.composer')`);
    if (!ready) {
      fail(`композер при ${width}px`, 'не отрисовался');
      return;
    }
    await evaluate(`document.querySelector('#input').focus()`);
    await sleep(200);

    const before = await evaluate(MEASURE);
    before.inputFont >= 16
      ? ok(`поле ввода ${width}px: шрифт ${before.inputFont}px (iOS не увеличит страницу)`)
      : fail(`шрифт поля при ${width}px`, `${before.inputFont}px — Safari увеличит страницу`);
    before.composerRight <= width + 0.5 && before.wrapRight <= width + 0.5
      ? ok(`композер внутри экрана при ${width}px`)
      : fail(`композер при ${width}px`, `правый край ${before.composerRight}, ширина окна ${width}`);
    before.overflow <= 0 ? ok(`нет горизонтального переполнения при ${width}px`) : fail(`переполнение при ${width}px`, `${before.overflow}px`);

    // «Открываем» клавиатуру и подкручиваем страницу так, как это делает iOS.
    await evaluate(`window.__kb(${height - keyboard}, 0)`);
    await sleep(300);
    const after = await evaluate(MEASURE);
    if (!after.kbOpen) {
      fail(`клавиатура при ${width}px`, 'страница не заметила клавиатуру (нет класса kb-open)');
    } else {
      ok(`клавиатура при ${width}px замечена`);
    }
    Math.abs(after.appH - (height - keyboard)) <= 1
      ? ok(`высота окна по видимой области при ${width}px`, `${after.appH}px`)
      : fail(`высота окна при ${width}px`, `${after.appH}px вместо ${height - keyboard}px`);
    after.composerBottom <= after.appBottom + 1
      ? ok(`композер не уходит под клавиатуру при ${width}px`, `низ ${after.composerBottom}, окно ${after.appBottom}`)
      : fail(`композер под клавиатурой при ${width}px`, `${after.composerBottom} > ${after.appBottom}`);
    after.composerRight <= width + 0.5 && after.wrapRight <= width + 0.5 && after.inputRight <= width + 0.5
      ? ok(`при клавиатуре ничего не вылезло вправо при ${width}px`)
      : fail(`правый край при клавиатуре ${width}px`, JSON.stringify({ c: after.composerRight, w: after.wrapRight, i: after.inputRight, vw: width }));
    after.overflow <= 0
      ? ok(`при клавиатуре нет горизонтальной прокрутки при ${width}px`)
      : fail(`переполнение при клавиатуре ${width}px`, `${after.overflow}px`);
    after.inputFont >= 16
      ? ok(`при клавиатуре поле ввода остаётся 16 px (${width}px)`)
      : fail(`шрифт поля при клавиатуре ${width}px`, `${after.inputFont}px`);

    // Длинная ссылка без пробелов не должна растягивать колонку.
    const longText = await evaluate(`(() => {
       const thread = document.querySelector('.thread');
       const md = document.createElement('div');
       md.className = 'md';
       md.innerHTML = '<p>' + 'https://dshopen-vladimir00177.msk1.amvera.tech/api/projects/p_mvctimqnc8b9b6e5a8/file?path=uploads%2F1226d2_IMG_9179.png' + '</p><pre>' + 'x'.repeat(180) + '</pre>';
       thread.appendChild(md);
       const bubble = document.createElement('div');
       bubble.className = 'msg msg-user';
       bubble.innerHTML = '<div class="bubble">' + 'a'.repeat(200) + '</div>';
       thread.appendChild(bubble);
       const page = document.documentElement.scrollWidth - window.innerWidth;
       const mdWide = md.scrollWidth - md.clientWidth;
       const bubbleWide = bubble.querySelector('.bubble').scrollWidth - bubble.querySelector('.bubble').clientWidth;
       md.remove();
       bubble.remove();
       return { page, mdWide, bubbleWide };
     })()`);
    longText.page <= 0 && longText.mdWide <= 1 && longText.bubbleWide <= 1
      ? ok(`длинный адрес и слово переносятся внутри пузыря (${width}px)`)
      : fail(`длинный текст при ${width}px`, JSON.stringify(longText));

    if (process.env.DSHOW_KB_SHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.DSHOW_KB_SHOT.replace('.png', `-${width}.png`), Buffer.from(shot.data, 'base64'));
    }

    // Клавиатура закрылась — высота вернулась.
    await evaluate(`window.__kb(null)`);
    await sleep(250);
    const closed = await evaluate(MEASURE);
    !closed.kbOpen && Math.abs(closed.appH - height) <= 1
      ? ok(`после закрытия клавиатуры окно снова ${height}px (${width}px)`)
      : fail(`закрытие клавиатуры ${width}px`, JSON.stringify({ kb: closed.kbOpen, appH: closed.appH }));
    closed.appVar === '' && closed.kbVar === ''
      ? ok(`переменные клавиатуры убраны (${width}px)`)
      : fail(`переменные после закрытия ${width}px`, JSON.stringify({ app: closed.appVar, kb: closed.kbVar }));
  }

  for (const [width, height] of [[390, 844], [360, 780], [320, 640]]) await checkWidth(width, height);

  // --- десктоп: клавиатуры нет, композер по центру и не шире 780 px ---
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await goto(BASE + '/');
  await waitFor(`!!document.querySelector('.composer')`);
  const desk = await evaluate(`(() => {
     const composer = document.querySelector('.composer').getBoundingClientRect();
     const main = document.querySelector('.main').getBoundingClientRect();
     const app = document.querySelector('.app');
     return {
       width: Math.round(composer.width),
       left: Math.round(composer.left),
       right: Math.round(composer.right),
       mainLeft: Math.round(main.left),
       mainRight: Math.round(main.right),
       vw: window.innerWidth,
       appH: Math.round(app.getBoundingClientRect().height),
       overflow: document.documentElement.scrollWidth - window.innerWidth,
       inputFont: parseFloat(getComputedStyle(document.querySelector('#input')).fontSize),
     };
   })()`);
  desk.width <= 782 ? ok('десктоп: композер не шире 780 px', `${desk.width}px`) : fail('десктоп: ширина композера', `${desk.width}px`);
  // Композер центрируется в колонке диалога, а не в окне: слева сайдбар,
  // справа открытая панель файлов.
  Math.abs(desk.left - desk.mainLeft - (desk.mainRight - desk.right)) <= 2
    ? ok('десктоп: композер по центру колонки диалога')
    : fail('десктоп: центрирование', JSON.stringify({ left: desk.left, right: desk.right, main: [desk.mainLeft, desk.mainRight] }));
  Math.abs(desk.appH - 900) <= 1 ? ok('десктоп: окно занимает всю высоту', `${desk.appH}px`) : fail('десктоп: высота', `${desk.appH}px`);
  desk.overflow <= 0 ? ok('десктоп: нет горизонтального переполнения') : fail('десктоп: переполнение', `${desk.overflow}px`);
  desk.inputFont === 14 ? ok('десктоп: поле ввода осталось компактным (14 px)') : fail('десктоп: шрифт поля', `${desk.inputFont}px`);

  // --- уборка ---
  const cleaned = await evaluate(`fetch('/api/projects/' + ${JSON.stringify(project)}, {method:'DELETE'}).then(r => r.status)`);
  cleaned === 200 ? ok('тестовый проект удалён') : fail('уборка проекта', String(cleaned));
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);

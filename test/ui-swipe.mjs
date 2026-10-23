// Проверка свайпов боковых ящиков в мобильной версии (настоящий Chrome через
// DevTools-протокол, без зависимостей):
//   - свайп вправо открывает «Проекты», свайп влево — «Файлы проекта»;
//   - обратный свайп закрывает открытый ящик;
//   - вертикальная прокрутка и горизонтальные блоки (код, таблицы) ящик не открывают;
//   - на планшете (1000 px) проекты постоянно видны, а файлы всё ещё выезжают.
//
// Запуск (нужен уже работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/ui-swipe.mjs
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
  console.log('  --  Chrome/Edge не найден, проверка свайпов пропущена');
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

const PORT = Number(process.env.DSHOW_CDP_PORT || 9335);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-swipe-cdp-'));
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
    await cdp.send('Page.navigate', { url });
    await sleep(700);
  }

  async function waitFor(expression, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        /* страница ещё перезагружается */
      }
      await sleep(120);
    }
    return false;
  }

  /* Плавный палец: несколько touchMove, как у настоящего свайпа. */
  async function swipe(x1, y1, x2, y2, { steps = 5 } = {}) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] });
    for (let step = 1; step <= steps; step++) {
      const ratio = step / steps;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x1 + (x2 - x1) * ratio, y: y1 + (y2 - y1) * ratio }],
      });
      await sleep(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(420);
  }

  const state = () =>
    evaluate(`(() => {
      const root = document.getElementById('app');
      if (!root) return { projects: false, files: false, missing: true };
      const app = root.classList;
      const shown = (selector) => {
        const style = getComputedStyle(document.querySelector(selector));
        return style.visibility === 'visible' && style.display !== 'none';
      };
      return {
        projects: app.contains('sidebar-open') && shown('#sidebar'),
        files: app.contains('files-open') && shown('#filesPanel'),
      };
    })()`);

  /* Пока страница переезжает на новую версию (приложение само перезагружается
     после выкладки), разметки может не быть вовсе — это не провал жеста.
     Дожидаемся #app и читаем состояние снова, иначе проверка врёт. */
  const stateSettled = async () => {
    for (let i = 0; i < 20; i += 1) {
      const current = await state();
      if (!current.missing) return current;
      await sleep(150);
    }
    return { projects: false, files: false, missing: true };
  };

  /* Страница может перезагрузиться сама: приложение забирает свежие файлы после
     выкладки, а сервис-воркер в новом профиле перезапускает вкладку. Кратковременный
     провал разметки — не провал жеста, поэтому перед жестом ждём, пока документ
     перестанет меняться, и повторяем жест, если он совпал с перезагрузкой. */
  const pageStable = async () => {
    for (let i = 0; i < 16; i += 1) {
      const first = await evaluate('performance.timeOrigin').catch(() => 0);
      await sleep(320);
      const second = await evaluate('performance.timeOrigin').catch(() => 0);
      if (first && first === second) {
        const alive = await evaluate(`!!document.getElementById('app')`).catch(() => false);
        if (alive) return true;
      }
    }
    return false;
  };

  await goto(BASE + '/');
  const loginStatus = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  loginStatus === 200 ? ok('вход в сервис') : fail('вход', loginStatus);

  const target = await evaluate(
    `(async () => {
       const project = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проверка свайпов'})})).json()).project;
       await fetch('/api/projects/' + project.id + '/chats', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Свайпы панелей'})});
       return { id: project.id };
     })()`,
  );
  target?.id ? ok('проект для проверки создан') : fail('проект для проверки', JSON.stringify(target));

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await goto(BASE + '/');
  const appReady = await waitFor(
    `!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`,
  );
  appReady ? ok('мобильная версия загрузилась') : fail('загрузка мобильной версии', 'приложение скрыто');

  // Полоска под системную строку состояния: iOS 26 берёт цвет полосы из
  // fixed-элемента у верхнего края, а не из theme-color (WebKit 301756).
  // Высота — ровно вырез (env(safe-area-inset-top)): она не должна накрывать
  // содержимое. Без выреза цвет системе отдаёт непрозрачный фон .app.
  const tint = await evaluate(`(() => {
    const el = document.querySelector('.status-tint');
    if (!el) return null;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden';
    document.body.appendChild(probe);
    const safe = Math.round(probe.getBoundingClientRect().height);
    probe.remove();
    return {
      top: box.top,
      width: box.width,
      height: Math.round(box.height),
      safe,
      bg: style.backgroundColor,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      appBg: getComputedStyle(document.getElementById('app')).backgroundColor,
      z: style.zIndex,
      position: style.position,
      visibility: style.visibility,
      display: style.display,
    };
  })()`);
  tint && tint.position === 'fixed' && tint.top === 0 && tint.width >= 320 &&
  tint.height === tint.safe &&
  tint.visibility === 'visible' && tint.display === 'block' && tint.bg === tint.bodyBg &&
  tint.appBg === tint.bodyBg && Number(tint.z) > 58
    ? ok('полоска статус-бара — ровно вырез, у .app цвет темы', `высота ${tint.height} px при вырезе ${tint.safe} px`)
    : fail('полоска статус-бара', JSON.stringify(tint));

  let current = await state();
  !current.projects && !current.files ? ok('оба ящика закрыты на старте') : fail('стартовое состояние', JSON.stringify(current));

  // 1. Свайп вправо — «Проекты» слева.
  await swipe(120, 420, 300, 420);
  current = await state();
  current.projects && !current.files
    ? ok('свайп вправо открыл «Проекты»')
    : fail('свайп вправо → «Проекты»', JSON.stringify(current));

  // 2. Обратный свайп по открытому ящику закрывает его, а не открывает файлы.
  await swipe(290, 420, 110, 420);
  current = await state();
  !current.projects && !current.files
    ? ok('свайп влево закрыл «Проекты»')
    : fail('закрытие «Проектов» свайпом', JSON.stringify(current));

  // 3. Свайп влево — «Файлы проекта» справа.
  await swipe(280, 420, 90, 420);
  current = await state();
  current.files && !current.projects
    ? ok('свайп влево открыл «Файлы проекта»')
    : fail('свайп влево → «Файлы проекта»', JSON.stringify(current));

  // 4. Обратный свайп по открытой панели файлов закрывает её.
  await swipe(100, 420, 300, 420);
  current = await state();
  !current.projects && !current.files
    ? ok('свайп вправо закрыл «Файлы проекта»')
    : fail('закрытие «Файлов проекта» свайпом', JSON.stringify(current));

  // 5. Вертикальная прокрутка не должна открывать ящики.
  await swipe(190, 640, 190, 300);
  current = await state();
  !current.projects && !current.files
    ? ok('вертикальная прокрутка не открывает ящики')
    : fail('вертикальная прокрутка и ящики', JSON.stringify(current));

  // 6. Горизонтальная прокрутка внутри широкого блока остаётся прокруткой.
  const scrollBox = await evaluate(`(() => {
     document.getElementById('swipe-scroll-test')?.remove();
     const box = document.createElement('div');
     box.id = 'swipe-scroll-test';
     box.style.cssText = 'width:300px;max-width:100%;overflow-x:auto;white-space:nowrap;padding:16px;margin:8px 0;border:1px solid #888';
     box.textContent = 'горизонтальный блок '.repeat(30);
     document.getElementById('thread').appendChild(box);
     const rect = box.getBoundingClientRect();
     return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
   })()`);
  await swipe(scrollBox.x + 90, scrollBox.y, scrollBox.x - 90, scrollBox.y);
  current = await state();
  const scrolled = await evaluate(`document.getElementById('swipe-scroll-test').scrollLeft`);
  !current.projects && !current.files && scrolled > 0
    ? ok('свайп в горизонтальном блоке прокручивает блок, а не открывает ящик', `${Math.round(scrolled)} px`)
    : fail('горизонтальный блок и свайп', JSON.stringify({ ...current, scrolled }));

  // 7. Кнопки работают как раньше, а свайп закрывает открытое кнопкой.
  await evaluate(`document.getElementById('sidebarToggle').click()`);
  await waitFor(`document.getElementById('app').classList.contains('sidebar-open')`);
  await swipe(290, 420, 110, 420);
  current = await state();
  !current.projects && !current.files
    ? ok('свайп закрывает «Проекты», открытые кнопкой')
    : fail('закрытие «Проектов» после кнопки', JSON.stringify(current));
  await evaluate(`document.getElementById('filesBtn').click()`);
  await waitFor(`document.getElementById('app').classList.contains('files-open')`);
  await swipe(100, 420, 300, 420);
  current = await state();
  !current.projects && !current.files
    ? ok('свайп закрывает «Файлы проекта», открытые кнопкой')
    : fail('закрытие «Файлов» после кнопки', JSON.stringify(current));

  // 8. Планшет 1000 px: проекты уже стоят на экране, файлы всё ещё ящик.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 2, mobile: true });
  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  /* После выкладки приложение один раз перезагружается на новой версии.
     Даём этому произойти до свайпа, иначе проверяем уже исчезнувшую страницу. */
  await sleep(1200);
  await waitFor(`!!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden')`);
  await pageStable();
  await swipe(300, 420, 500, 420);
  current = await stateSettled();
  !current.projects && !current.files
    ? ok('на планшете свайп вправо не открывает постоянные «Проекты»')
    : fail('свайп вправо на планшете', JSON.stringify(current));
  /* Жест влево повторяем, если он пришёлся на перезагрузку страницы: сама
     перезагрузка — не провал, а вот три подряд означают, что ящик не выезжает. */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await pageStable();
    await swipe(700, 420, 500, 420);
    current = await stateSettled();
    if (current.files && !current.projects) break;
  }
  current.files && !current.projects
    ? ok('на планшете свайп влево открыл «Файлы проекта»')
    : fail('свайп влево на планшете', JSON.stringify(current));

  chrome.kill();
  const failed = results.filter((value) => !value).length;
  console.log(`\n  ${results.length - failed} ok, ${failed} fail`);
  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error('  FAIL проверка свайпов:', error.message);
  chrome.kill();
  process.exitCode = 1;
} finally {
  setTimeout(() => {
    try {
      chrome.kill();
    } catch {
      /* уже остановлен */
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
  }, 500);
}

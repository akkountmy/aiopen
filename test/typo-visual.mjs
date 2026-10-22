// Сверка шрифтов и размеров с эталоном харнеса на четырёх ширинах.
// Запуск (нужен работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/typo-visual.mjs
//
// Эталон — типографика DSH (dsh-client-ui-theme): 14/22 основной текст, 13/20
// второй уровень, 12/18 подписи, 11/14 метки, шкала заголовков 16/24 – 21/30,
// markdown 14/24 с h1 700 21/30, h2 700 19/28, h3 700 18/26, h4 600 14/24,
// код 11/19, таблица 13/22. Кегли подняты на полпикселя по просьбе владельца,
// высоты строк оставлены прежними. Ни один размер не меняется по ширине экрана —
// единственное исключение поле ввода на телефоне: 16 px вместо 14, иначе
// iOS Safari сам увеличивает страницу при фокусе (см. test/ui-keyboard.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';
const OUT = process.env.DSHOW_SHOTS || path.join(os.tmpdir(), 'typo-shots');

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка типографики пропущена');
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PORT = Number(process.env.DSHOW_CDP_PORT || 9337);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-typo-'));
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

// Ожидаемые значения: селектор -> [font-size, line-height, font-weight|null]
const EXPECTED = {
  body: ['14.5px', '22px', null],
  '.brand-name': ['18.5px', '24px', '600'],
  '.project-row': ['14.5px', '20px', null],
  '.chat-row': ['14.5px', '20px', null],
  '.crumbs': ['14.5px', '20px', null],
  '.crumb-chat': ['14.5px', '20px', '500'],
  '#input': ['14.5px', '24px', null],
  '.empty-title': ['26.5px', '32px', '500'],
  '.empty-sub': ['14.5px', '22px', null],
  '.suggestion': ['13.5px', '20px', null],
  '.btn-primary': ['14.5px', '22px', '500'],
  '.files-title': ['14.5px', '22px', '500'],
  '.file-row': ['13.5px', '20px', null],
  '.modal-title': ['16.5px', '24px', '600'],
};

// Осознанное отклонение от «шкала не зависит от ширины»: на телефоне и узком
// планшете поле ввода набирается кеглем 16 px, иначе iOS приближает страницу
// при фокусе и правый край уезжает за экран.
const IOS_INPUT_FIX = { selector: '#input', upTo: 860, value: ['16px', '24px', null] };

// Значения внутри markdown проверяем на искусственном блоке: он получает те же
// классы, что и ответ ассистента, поэтому CSS применяется ровно тот же.
const MARKDOWN = `(() => {
  const host = document.querySelector('.messages') || document.querySelector('#chatScroll') || document.body;
  let probe = document.getElementById('typo-probe');
  if (!probe) {
    probe = document.createElement('div');
    probe.id = 'typo-probe';
    probe.style.position = 'absolute';
    probe.style.left = '-10000px';
    probe.style.top = '0';
    probe.style.width = '720px';
    probe.innerHTML =
      '<div class="md">' +
      '<h1>Заголовок</h1><h2>Второй</h2><h3>Третий</h3><h4>Четвёртый</h4><h5>Пятый</h5>' +
      '<p>Основной текст <strong>жирный</strong> <code>inline</code></p>' +
      '<pre><code>const x = 1;</code></pre>' +
      '<table><thead><tr><th>Колонка</th></tr></thead><tbody><tr><td>Ячейка</td></tr></tbody></table>' +
      '</div>';
    host.appendChild(probe);
  }
  const read = (selector) => {
    const element = probe.querySelector(selector);
    if (!element) return null;
    const style = getComputedStyle(element);
    return [style.fontSize, style.lineHeight, style.fontWeight];
  };
  const value = {
    '.md': read('.md'),
    'md h1': read('h1'),
    'md h2': read('h2'),
    'md h3': read('h3'),
    'md h4': read('h4'),
    'md h5': read('h5'),
    'md p': read('p'),
    'md strong': read('strong'),
    'md code': read('code'),
    'md pre code': read('pre code'),
    'md th': read('th'),
    'md td': read('td'),
  };
  probe.remove();
  return value;
})()`;

const MARKDOWN_EXPECTED = {
  '.md': ['14.5px', '24px', null],
  'md h1': ['21.5px', '30px', '700'],
  'md h2': ['19.5px', '28px', '700'],
  'md h3': ['18.5px', '26px', '700'],
  'md h4': ['14.5px', '24px', '600'],
  'md h5': ['14.5px', '24px', '600'],
  'md p': ['14.5px', '24px', null],
  'md strong': ['14.5px', '24px', '600'],
  'md code': ['12.6875px', '19px', null],
  'md pre code': ['11.5px', '19px', null],
  'md th': ['13.5px', '22px', '500'],
  'md td': ['13.5px', '22px', null],
};

let baseline = null;

try {
  const cdp = connect(await pageWs());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  fs.mkdirSync(OUT, { recursive: true });

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
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

  await goto(BASE + '/');
  const loginStatus = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  loginStatus === 200 ? ok('вход в сервис') : fail('вход', loginStatus);

  await evaluate(
    `(async () => {
       const project = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проверка типографики'})})).json()).project;
       await fetch('/api/projects/' + project.id + '/chats', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Типографика'})});
       return project.id;
     })()`,
  );

  const WIDTHS = [
    { name: 'настольный', width: 1440, height: 900 },
    { name: 'планшет', width: 1024, height: 768 },
    { name: 'узкий планшет', width: 860, height: 800 },
    { name: 'телефон', width: 390, height: 844 },
  ];

  for (const breakpoint of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: breakpoint.width,
      height: breakpoint.height,
      deviceScaleFactor: 1,
      mobile: breakpoint.width < 900,
    });
    await goto(BASE + '/');
    const ready = await waitFor(`!!document.querySelector('.auto-projects') || !!document.querySelector('.empty-title')`);
    if (!ready) {
      fail(`${breakpoint.name}: рабочий стол загрузился`, 'нет ни проектов, ни пустого экрана');
      continue;
    }
    await sleep(400);

    const measured = await evaluate(`(() => {
      const read = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const style = getComputedStyle(element);
        return [style.fontSize, style.lineHeight, style.fontWeight];
      };
      const out = {};
      for (const selector of ${JSON.stringify(Object.keys(EXPECTED))}) out[selector] = read(selector);
      return out;
    })()`);

    const expectedFor = { ...EXPECTED };
    if (breakpoint.width <= IOS_INPUT_FIX.upTo) expectedFor[IOS_INPUT_FIX.selector] = IOS_INPUT_FIX.value;

    const problems = [];
    for (const [selector, expected] of Object.entries(expectedFor)) {
      const actual = measured[selector];
      if (!actual) continue; // элемента нет в этой раскладке — не ошибка
      for (let index = 0; index < 3; index += 1) {
        if (expected[index] && actual[index] !== expected[index]) {
          problems.push(`${selector}: ожидалось ${expected.join('/')}, получено ${actual.join('/')}`);
          break;
        }
      }
    }

    const markdown = await evaluate(MARKDOWN);
    for (const [selector, expected] of Object.entries(MARKDOWN_EXPECTED)) {
      const actual = markdown[selector];
      if (!actual) {
        problems.push(`${selector}: элемента нет`);
        continue;
      }
      if (actual[0] !== expected[0] || actual[1] !== expected[1] || (expected[2] && actual[2] !== expected[2])) {
        problems.push(`${selector}: ожидалось ${expected.join('/')}, получено ${actual.join('/')}`);
      }
    }

    problems.length
      ? fail(`${breakpoint.name} ${breakpoint.width}×${breakpoint.height}`, problems.slice(0, 6).join(' | '))
      : ok(`${breakpoint.name} ${breakpoint.width}×${breakpoint.height}`, 'размеры совпадают с харнесом');

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${breakpoint.width}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`       снимок: ${file}`);

    // Размер шрифта не должен зависеть от ширины: сравниваем с настольным.
    if (breakpoint.width < 1440) {
      const desktop = baseline;
      if (desktop) {
        const scale = [];
        for (const [selector, actual] of Object.entries(measured)) {
          const base = desktop[selector];
          if (!actual || !base) continue;
          if (selector === IOS_INPUT_FIX.selector && breakpoint.width <= IOS_INPUT_FIX.upTo) continue;
          if (actual[0] !== base[0] || actual[1] !== base[1]) {
            scale.push(`${selector}: ${base.slice(0, 2).join('/')} -> ${actual.slice(0, 2).join('/')}`);
          }
        }
        scale.length
          ? fail(`${breakpoint.name}: кегль не меняется по ширине`, scale.slice(0, 5).join(' | '))
          : ok(`${breakpoint.name}: кегль не меняется по ширине`);
      }
    } else {
      baseline = measured;
    }
  }
} finally {
  chrome.kill();
  await sleep(300);
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* профиль мог остаться заблокированным */
  }
}

const passed = results.filter(Boolean).length;
console.log(`\nИтого: ${passed} ok, ${results.length - passed} fail`);
process.exit(results.every(Boolean) ? 0 : 1);

// Регрессия мобильной клавиатуры: набор текста в новом диалоге.
//
// Проверяем то, что не ловил статический тест ui-keyboard.mjs:
//   - открытие диалога на телефоне не поднимает клавиатуру само;
//   - пока клавиатура выезжает, подвал следует за видимой областью с первого
//     пикселя, а не после порога в 140 px (раньше поле оказывалось под ней и
//     экран прыгал);
//   - при наборе поле растёт до разумного предела, низ подвала остаётся у
//     клавиатуры, последняя строка текста видна;
//   - панель предсказаний и сдвиг visualViewport не отрывают подвал;
//   - после закрытия клавиатуры окно возвращается к полной высоте.
//
// Запуск (нужен работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='DSH'; $env:DSHOW_PASS='...'
//   node test/ui-keyboard-typing.mjs
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

/* visualViewport подменяем до скриптов приложения. Высота без клавиатуры берётся
   лениво из window.innerHeight: на about:blank она ещё не равна вьюпорту
   страницы, и зафиксированное число ломало бы проверку закрытия. */
const FAKE_VV = `(() => {
  const target = new EventTarget();
  let forcedHeight = null;
  const fake = {
    get height() { return forcedHeight === null ? window.innerHeight : forcedHeight; },
    get width() { return window.innerWidth; },
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
    forcedHeight = height === null ? null : height;
    fake.offsetTop = offsetTop;
    target.dispatchEvent(new Event('resize'));
    target.dispatchEvent(new Event('scroll'));
  };
})();`;

const PORT = Number(process.env.DSHOW_CDP_PORT || 9337);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-kb-typing-'));
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
  const events = [];
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id) {
      events.push(msg);
      return;
    }
    if (!pending.has(msg.id)) return;
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
    events,
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

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const app = q('.app');
  const composer = q('.composer');
  const input = q('#input');
  const scroll = q('#scroll');
  const vv = window.visualViewport;
  const ab = app.getBoundingClientRect();
  const cb = composer.getBoundingClientRect();
  return {
    innerH: Math.round(window.innerHeight),
    vvH: Math.round(vv.height),
    vvTop: Math.round(vv.offsetTop || 0),
    vvBottom: Math.round(vv.height + (vv.offsetTop || 0)),
    kb: document.documentElement.classList.contains('kb-open'),
    appTop: Math.round(ab.top),
    appBottom: Math.round(ab.bottom),
    appH: Math.round(ab.height),
    compTop: Math.round(cb.top),
    compBottom: Math.round(cb.bottom),
    compH: Math.round(cb.height),
    inputH: Math.round(input.getBoundingClientRect().height),
    inputLh: parseFloat(getComputedStyle(input).lineHeight) || 0,
    inputPad:
      (parseFloat(getComputedStyle(input).paddingTop) || 0) +
      (parseFloat(getComputedStyle(input).paddingBottom) || 0),
    inputScrollTop: input.scrollTop,
    inputScrollH: input.scrollHeight,
    inputClientH: input.clientHeight,
    selection: input.selectionStart,
    valueLength: input.value.length,
    scrollTop: scroll.scrollTop,
    scrollH: scroll.scrollHeight,
    scrollClientH: scroll.clientHeight,
    active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
    appVar: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim(),
    panVar: getComputedStyle(document.documentElement).getPropertyValue('--kb-pan').trim(),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
})()`;

try {
  const cdp = connect(await pageWs());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_VV });

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
    await sleep(900);
  }
  async function waitFor(expression, timeoutMs = 10000) {
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

  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto(BASE + '/');
  const login = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  login === 200 ? ok('вход в сервис') : fail('вход', login);

  const ids = await evaluate(
    `(async () => {
       const project = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проверка набора'})})).json()).project;
       const chat = (await (await fetch('/api/projects/' + project.id + '/chats', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Новый диалог'})})).json()).chat;
       localStorage.setItem('dshow.lastChat', chat.id);
       return { project: project.id, chat: chat.id };
     })()`,
  );

  await goto(BASE + '/');
  const ready = await waitFor(`!!document.querySelector('.app:not(.hidden)') && !!document.querySelector('#input')`);
  if (!ready) throw new Error('приложение не отрисовалось');
  await sleep(700);

  const boot = await evaluate(MEASURE);
  boot.active !== 'input'
    ? ok('открытие диалога на телефоне не поднимает клавиатуру', `фокус: ${boot.active}`)
    : fail('автофокус при открытии диалога', 'поле ввода получило фокус само');
  !boot.kb && boot.appH === 844
    ? ok('до клавиатуры окно занимает всю высоту', `${boot.appH}px`)
    : fail('окно до клавиатуры', JSON.stringify({ kb: boot.kb, appH: boot.appH }));

  // Касание поля — единственный способ поднять клавиатуру.
  await evaluate(`document.querySelector('#input').focus()`);
  await sleep(150);
  (await evaluate(MEASURE)).active === 'input'
    ? ok('поле получает фокус по тапу')
    : fail('фокус поля', 'фокус не встал');

  // Клавиатура выезжает на 320 px. На каждом шаге подвал должен быть над ней.
  let covered = 0;
  let missingState = 0;
  let wrongHeight = 0;
  let worstGap = 0;
  const animation = [];
  for (let i = 1; i <= 16; i++) {
    const h = Math.round(844 - (320 * i) / 16);
    await evaluate(`window.__kb(${h}, 0)`);
    await sleep(24);
    const m = await evaluate(MEASURE);
    animation.push({
      i,
      h,
      vv: m.vvBottom,
      app: m.appH,
      appVar: m.appVar,
      comp: m.compBottom,
      kb: m.kb,
      top: m.appTop,
    });
    if (i > 0 && !m.kb) missingState++;
    if (Math.abs(m.appBottom - m.vvBottom) > 1) wrongHeight++;
    covered = Math.max(covered, m.compBottom - m.vvBottom);
    worstGap = Math.max(worstGap, m.compBottom - m.vvBottom);
  }
  if (covered > 1 || wrongHeight > 0) {
    console.table(animation);
    const errors = cdp.events
      .filter((event) => event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled')
      .map((event) => JSON.stringify(event.params).slice(0, 900));
    console.log('errors:', errors);
  }
  covered <= 1
    ? ok('пока клавиатура выезжает, подвал не оказывается под ней', `макс. накрытие ${covered}px`)
    : fail('подвал под клавиатурой при выезде', `${covered}px`);
  missingState === 0
    ? ok('клавиатура замечена с первого шага анимации')
    : fail('задержка распознавания клавиатуры', `${missingState} шагов без kb-open`);
  wrongHeight === 0
    ? ok('высота окна совпадает с видимой областью на всей анимации')
    : fail('высота окна при анимации', `${wrongHeight} расхождений`);

  // Посимвольный набор: поле не должно «ползти» вверх на несколько пикселей
  // за каждую букву, пока текст ещё помещается в одну строку.
  const typingBase = await evaluate(MEASURE);
  const twoLineHeight = Math.round(typingBase.inputLh * 2 + typingBase.inputPad);
  typingBase.valueLength === 0 && typingBase.inputH >= twoLineHeight - 1
    ? ok('пустое поле вмещает две строки', `${typingBase.inputH}px при строке ${typingBase.inputLh}px`)
    : fail(
        'высота пустого поля',
        JSON.stringify({ h: typingBase.inputH, need: twoLineHeight, lh: typingBase.inputLh, pad: typingBase.inputPad }),
      );
  const typedHeights = [];
  for (const char of 'Проверка') {
    await cdp.send('Input.insertText', { text: char });
    await sleep(40);
    typedHeights.push((await evaluate(MEASURE)).inputH);
  }
  const typedSpread = Math.max(...typedHeights) - Math.min(...typedHeights);
  typedSpread <= 1 && Math.abs(typedHeights[0] - typingBase.inputH) <= 1
    ? ok('посимвольный набор не дёргает поле ввода', `${typedHeights[0]}px`)
    : fail('посимвольный набор', JSON.stringify({ base: typingBase.inputH, heights: typedHeights }));
  await evaluate(
    `(() => { const i = document.querySelector('#input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); return true; })()`,
  );
  await sleep(80);

  // Набор: поле растёт, но не съедает экран; курсор и последняя строка видны.
  let maxComposer = 0;
  let badBottom = 0;
  let badCaret = 0;
  let scrollDropped = 0;
  let previousScroll = -1;
  for (let line = 1; line <= 8; line++) {
    await cdp.send('Input.insertText', {
      text: `Строка ${line}: проверка набора и видимости последней строки. `,
    });
    await sleep(70);
    const m = await evaluate(MEASURE);
    maxComposer = Math.max(maxComposer, m.compH);
    if (m.compBottom > m.vvBottom + 1) badBottom++;
    const atEnd = m.selection >= m.valueLength;
    if (atEnd && m.inputScrollH > m.inputClientH + 1 && m.inputScrollTop + m.inputClientH < m.inputScrollH - 3) {
      badCaret++;
    }
    if (previousScroll >= 0 && m.scrollTop < previousScroll - 1) scrollDropped++;
    previousScroll = m.scrollTop;
  }
  maxComposer <= 200
    ? ok('поле ввода растёт не больше 200 px', `${maxComposer}px`)
    : fail('предел роста поля', `${maxComposer}px`);
  badBottom === 0
    ? ok('при наборе подвал остаётся у клавиатуры')
    : fail('подвал при наборе', `${badBottom} строк вышли за экран`);
  badCaret === 0
    ? ok('последняя строка набранного текста видна в поле')
    : fail('видимость текста', `${badCaret} строк с курсором вне поля`);
  scrollDropped === 0
    ? ok('лента не прыгает вниз при росте поля')
    : fail('прокрутка ленты при наборе', `${scrollDropped} скачков`);

  // Длинный черновик листается внутри поля, а правка в середине не отбрасывает
  // прокрутку к первой строке.
  const middlePos = await evaluate(
    `(() => { const i = document.querySelector('#input'); const p = Math.floor(i.value.length * 0.6); i.setSelectionRange(p, p); i.scrollTop = 0; return p; })()`,
  );
  await cdp.send('Input.insertText', { text: 'X' });
  await sleep(180);
  const afterMiddleInsert = await evaluate(MEASURE);
  const caretFound =
    afterMiddleInsert.selection >= middlePos &&
    afterMiddleInsert.selection <= middlePos + 4 &&
    afterMiddleInsert.inputScrollTop > 0;
  caretFound
    ? ok('правка в середине длинного текста показывает курсор', `прокрутка ${Math.round(afterMiddleInsert.inputScrollTop)}px`)
    : fail(
        'правка в середине',
        JSON.stringify({
          pos: middlePos,
          sel: afterMiddleInsert.selection,
          scroll: afterMiddleInsert.inputScrollTop,
        }),
      );

  await evaluate(
    `(() => { const i = document.querySelector('#input'); const p = Math.floor(i.value.length * 0.6); i.setSelectionRange(p, p); i.scrollTop = i.scrollHeight; return p; })()`,
  );
  await sleep(120);
  const beforeMiddleDelete = await evaluate(MEASURE);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
    key: 'Backspace',
    code: 'Backspace',
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
    key: 'Backspace',
    code: 'Backspace',
  });
  await sleep(180);
  const afterMiddleDelete = await evaluate(MEASURE);
  afterMiddleDelete.inputScrollTop > 0 && afterMiddleDelete.inputScrollH > afterMiddleDelete.inputClientH
    ? ok('удаление в середине не сбрасывает прокрутку поля')
    : fail(
        'прокрутка после удаления',
        JSON.stringify({
          before: beforeMiddleDelete.inputScrollTop,
          after: afterMiddleDelete.inputScrollTop,
          sh: afterMiddleDelete.inputScrollH,
          ch: afterMiddleDelete.inputClientH,
        }),
      );

  // Панель предсказаний меняет высоту клавиатуры на 44 px — подвал следует.
  for (const h of [480, 524, 480, 524]) {
    await evaluate(`window.__kb(${h}, 0)`);
    await sleep(220);
    const m = await evaluate(MEASURE);
    Math.abs(m.compBottom - m.vvBottom) <= 6 && Math.abs(m.appH - m.vvH) <= 1
      ? ok(`подвал следует за клавиатурой при высоте ${h}px`, `низ ${m.compBottom}`)
      : fail(
          `панель предсказаний ${h}px`,
          JSON.stringify({
            comp: m.compBottom,
            vv: m.vvBottom,
            app: m.appH,
            appVar: m.appVar,
            pan: m.panVar,
            vvTop: m.vvTop,
            kb: m.kb,
          }),
        );
  }

  // Телефон подтянул страницу: окно сдвигается, подвал остаётся у клавиатуры.
  await evaluate(`window.__kb(524, 96)`);
  await sleep(160);
  const panned = await evaluate(MEASURE);
  panned.appTop >= 95 && Math.abs(panned.compBottom - panned.vvBottom) <= 6
    ? ok('сдвиг видимой области не отрывает подвал от клавиатуры', `верх ${panned.appTop}, низ ${panned.compBottom}`)
    : fail('сдвиг видимой области', JSON.stringify({ top: panned.appTop, comp: panned.compBottom, vv: panned.vvBottom }));
  await evaluate(`window.__kb(524, 0)`);
  await sleep(160);

  // Закрытие: полная высота и никаких клавиатурных переменных.
  await evaluate(`window.__kb(null, 0)`);
  await sleep(300);
  const closed = await evaluate(MEASURE);
  !closed.kb && Math.abs(closed.appH - 844) <= 1 && closed.appVar === '' && closed.panVar === ''
    ? ok('после закрытия клавиатуры окно снова 844px, переменные убраны')
    : fail('закрытие клавиатуры', JSON.stringify({ kb: closed.kb, appH: closed.appH, appVar: closed.appVar, panVar: closed.panVar }));
  closed.compBottom <= 844 && closed.overflow <= 0
    ? ok('после закрытия композер внутри экрана, горизонтальной прокрутки нет')
    : fail('композер после закрытия', JSON.stringify({ comp: closed.compBottom, overflow: closed.overflow }));

  // Android с interactive-widget=resizes-content: уменьшается сам innerHeight.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 524, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  const resized = await evaluate(MEASURE);
  resized.appH <= 524 + 1 && resized.compBottom <= 525
    ? ok('при resizes-content окно и подвал укладываются в 524px', `${resized.compBottom}px`)
    : fail('resizes-content', JSON.stringify({ appH: resized.appH, comp: resized.compBottom }));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);

  // Десктоп: автофокус остаётся, клавиатурные переменные не появляются.
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await goto(BASE + '/');
  await waitFor(`!!document.querySelector('.app:not(.hidden)') && !!document.querySelector('#input')`);
  await sleep(600);
  const desk = await evaluate(MEASURE);
  desk.active === 'input'
    ? ok('на компьютере поле ввода по-прежнему получает фокус')
    : fail('автофокус на компьютере', `фокус: ${desk.active}`);
  !desk.kb && desk.appH === 900
    ? ok('на компьютере окно занимает всю высоту', `${desk.appH}px`)
    : fail('окно на компьютере', JSON.stringify({ kb: desk.kb, appH: desk.appH }));

  // Та же проверка на широком экране: одна строка не должна расти от буквы к букве.
  await evaluate(
    `(() => { const i = document.querySelector('#input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); return true; })()`,
  );
  await sleep(80);
  const deskTypingBase = await evaluate(MEASURE);
  const deskTypedHeights = [];
  for (const char of 'Проверка ввода') {
    await cdp.send('Input.insertText', { text: char });
    await sleep(40);
    deskTypedHeights.push((await evaluate(MEASURE)).inputH);
  }
  const deskSpread = Math.max(...deskTypedHeights) - Math.min(...deskTypedHeights);
  deskSpread <= 1 && Math.abs(deskTypedHeights[0] - deskTypingBase.inputH) <= 1
    ? ok('на компьютере посимвольный набор не дёргает поле', `${deskTypedHeights[0]}px`)
    : fail('посимвольный набор на компьютере', JSON.stringify({ base: deskTypingBase.inputH, heights: deskTypedHeights }));

  const cleaned = await evaluate(
    `fetch('/api/projects/' + ${JSON.stringify(ids.project)}, {method:'DELETE'}).then(r => r.status)`,
  );
  cleaned === 200 ? ok('тестовый проект удалён') : fail('уборка проекта', String(cleaned));
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);

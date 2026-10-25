// Проверка диалогов на телефоне через DevTools-протокол (без зависимостей):
//   - окно настроек блока дашборда выезжает снизу листом, как в мобильном
//     приложении DeepSeek: во всю ширину, со скруглёнными верхними углами,
//     «ручкой» сверху, заголовком и крестиком в шапке;
//   - лист целиком входит в экран: шапка и кнопки видны без прокрутки;
//   - действия стоят столбиком во всю ширину, главная кнопка — от 44 px;
//   - поля внутри получают кегль от 16 px и фокус не достаётся полю, иначе
//     iOS увеличивает страницу и окно выглядит «увеличенным»;
//   - жест вниз по шапке закрывает лист;
//   - окно просмотра файла (file-preview-modal) остаётся целым листом, а не
//     шторкой, и на компьютере диалог по-прежнему стоит по центру.
//
// Запуск (нужен уже работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/ui-modal-sheet.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';
const OUT = process.env.DSHOW_SHOT_DIR || '';

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка диалогов пропущена');
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

const PORT = Number(process.env.DSHOW_CDP_PORT || 9339);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-sheet-'));
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

/* Как читать окно: всё нужное для проверок одним запросом. */
const MEASURE = `(() => {
  const modal = document.querySelector('#modalRoot > .modal');
  if (!modal) return null;
  const root = document.getElementById('modalRoot');
  const style = getComputedStyle(modal);
  const before = getComputedStyle(modal, '::before');
  const rect = modal.getBoundingClientRect();
  const head = modal.querySelector('.modal-head');
  const body = modal.querySelector('.modal-body');
  const foot = modal.querySelector('.modal-foot');
  const buttons = [...modal.querySelectorAll('.modal-foot .btn')].map((b) => {
    const br = b.getBoundingClientRect();
    return { label: b.textContent.trim(), x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) };
  });
  const fields = [...modal.querySelectorAll('input, textarea, select')].map((n) => ({
    tag: n.tagName.toLowerCase(),
    fs: parseFloat(getComputedStyle(n).fontSize),
  }));
  const active = document.activeElement;
  return {
    inner: { w: window.innerWidth, h: window.innerHeight },
    modal: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) },
    align: getComputedStyle(root).alignItems,
    rootPadding: getComputedStyle(root).padding,
    radius: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
    grabber: { content: before.content, width: before.width, height: before.height },
    headBottom: head ? Math.round(head.getBoundingClientRect().bottom) : null,
    body: body ? { client: body.clientHeight, scroll: body.scrollHeight } : null,
    foot: foot ? Math.round(foot.getBoundingClientRect().height) : null,
    buttons,
    fields,
    focus: active ? { tag: active.tagName.toLowerCase(), cls: String(active.className || '') } : null,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
})()`;

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
    await sleep(700);
  }
  async function waitFor(expression, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        /* страница ещё грузится */
      }
      await sleep(150);
    }
    return false;
  }
  async function shot(name) {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    const data = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data.data, 'base64'));
  }

  await goto(BASE + '/');
  const login = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  console.log(`  --  вход: ${login}\n`);

  /* Открываем дашборд и окно первого блока — то самое, на которое жаловались. */
  async function openDashModal() {
    const openedDash = await waitFor(`!!document.getElementById('dashboardBtn')`);
    if (!openedDash) return false;
    await evaluate(`document.getElementById('dashboardBtn').click()`);
    const hasCard = await waitFor(`document.querySelectorAll('.dash-card .dash-setup').length > 0`);
    if (!hasCard) return false;
    await evaluate(`document.querySelector('.dash-card .dash-setup').click()`);
    return waitFor(`!!document.querySelector('#modalRoot .modal.dash-modal')`);
  }

  for (const [width, height] of [[390, 844], [360, 780], [320, 640]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await goto(BASE + '/');
    const opened = await openDashModal();
    if (!opened) {
      fail(`окно настроек при ${width}px`, 'окно не открылось (нет блока дашборда?)');
      continue;
    }
    await sleep(420);
    const m = await evaluate(MEASURE);
    await shot(`sheet-${width}.png`);

    /* 1. Лист внизу экрана и целиком в нём. Это и есть исходная жалоба:
          раньше окно вылезало за экран и человек уменьшал масштаб. */
    Math.abs(m.modal.bottom - height) <= 1 && m.modal.top >= 0 && m.modal.height <= height
      ? ok(`лист целиком в экране при ${width}px`, `${m.modal.top}…${m.modal.bottom}`)
      : fail(`лист при ${width}px`, `окно ${JSON.stringify(m.modal)}, экран ${width}×${height}`);
    m.align === 'flex-end' && m.rootPadding === '0px'
      ? ok(`лист прижат к нижнему краю при ${width}px`)
      : fail(`положение листа ${width}px`, JSON.stringify({ align: m.align, padding: m.rootPadding }));

    /* 2. Внешний вид шторки: скруглены только верхние углы, сверху ручка. */
    m.radius[0] === m.radius[1] && m.radius[2] === '0px' && m.radius[3] === '0px' && parseFloat(m.radius[0]) >= 10
      ? ok(`верхние углы скруглены, нижние срезаны при ${width}px`, m.radius.join(' '))
      : fail(`углы листа ${width}px`, m.radius.join(' '));
    m.grabber.content !== 'none' && m.grabber.height === '4px' && m.grabber.width === '38px'
      ? ok(`«ручка» листа на месте при ${width}px`, `${m.grabber.width}×${m.grabber.height}`)
      : fail(`ручка листа ${width}px`, JSON.stringify(m.grabber));

    /* 3. Шапка с заголовком и кнопки видны сразу, без прокрутки. */
    m.headBottom !== null && m.headBottom <= height
      ? ok(`шапка листа видна при ${width}px`, `низ ${m.headBottom}`)
      : fail(`шапка за экраном при ${width}px`, String(m.headBottom));
    m.foot > 0 && m.modal.bottom - m.foot >= 0
      ? ok(`кнопки внизу листа видны при ${width}px`, `полоса ${m.foot}px`)
      : fail(`кнопки за экраном при ${width}px`, JSON.stringify({ foot: m.foot, bottom: m.modal.bottom }));

    /* 4. Действия — столбиком во всю ширину, главная кнопка от 44 px. */
    const primary = m.buttons.find((b) => b.label === 'Сохранить');
    const cancel = m.buttons.find((b) => b.label === 'Отмена');
    primary && cancel && primary.y !== cancel.y && Math.abs(primary.x - cancel.x) <= 1
      ? ok(`действия стоят столбиком при ${width}px`)
      : fail(`действия при ${width}px`, JSON.stringify(m.buttons));
    primary && primary.h >= 44 && primary.w >= m.modal.width - 36
      ? ok(`главная кнопка во всю ширину при ${width}px`, `${primary.w}×${primary.h}`)
      : fail(`главная кнопка при ${width}px`, JSON.stringify(primary));

    /* 5. Поля от 16 px: меньше — iOS увеличивает страницу при фокусе, и окно
          кажется «увеличенным», пока не отожмёшь масштаб. */
    const small = m.fields.filter((field) => field.fs < 16);
    small.length === 0
      ? ok(`поля не мельче 16 px при ${width}px`, `${m.fields.length} шт.`)
      : fail(`мелкий кегль полей ${width}px`, JSON.stringify(small));
    m.focus && !/^(input|textarea|select)$/.test(m.focus.tag)
      ? ok(`фокус не в поле при ${width}px`, `${m.focus.tag}.${m.focus.cls}`)
      : fail(`фокус в поле при ${width}px`, JSON.stringify(m.focus));
    m.overflow <= 0 ? ok(`нет горизонтальной прокрутки при ${width}px`) : fail(`переполнение ${width}px`, `${m.overflow}px`);

    /* 6. Жест вниз по шапке закрывает лист — как в приложении. */
    const headBox = await evaluate(`(() => {
      const head = document.querySelector('#modalRoot .modal .modal-head');
      const rect = head.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + 10) };
    })()`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: headBox.x, y: headBox.y }] });
    for (const dy of [20, 60, 110, 150]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: headBox.x, y: headBox.y + dy }] });
      await sleep(30);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const closed = await waitFor(`!document.querySelector('#modalRoot .modal')`, 4000);
    closed ? ok(`жест вниз закрывает лист при ${width}px`) : fail(`жест вниз ${width}px`, 'лист остался открытым');
  }

  /* 7. Окно просмотра файла шторкой быть не должно: это полный лист. Правила
        шторки исключают .file-preview-modal и .modal-root.preview-open. */
  const preview = await evaluate(`(() => {
    const host = document.createElement('div');
    host.className = 'modal-root preview-open';
    host.style.visibility = 'hidden';
    const box = document.createElement('div');
    box.className = 'modal file-preview-modal';
    box.innerHTML = '<div class="modal-head"><div class="modal-title">Просмотр</div></div><div class="modal-body"></div>';
    host.appendChild(box);
    document.body.appendChild(host);
    const style = getComputedStyle(box);
    const before = getComputedStyle(box, '::before');
    const rect = box.getBoundingClientRect();
    const out = {
      radius: [style.borderTopLeftRadius, style.borderBottomLeftRadius],
      grabber: before.content,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      inner: window.innerWidth,
    };
    host.remove();
    return out;
  })()`);
  preview.grabber === 'none' && preview.radius[0] === '0px' && preview.width === preview.inner
    ? ok('окно просмотра файла осталось полным листом', `${preview.width}×${preview.height}`)
    : fail('окно просмотра переделалось в шторку', JSON.stringify(preview));

  /* 8. Компьютер: диалог по-прежнему по центру, без ручки и столбика кнопок. */
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await goto(BASE + '/');
  const desktopOpen = await openDashModal();
  if (!desktopOpen) {
    fail('окно настроек на компьютере', 'окно не открылось');
  } else {
    const d = await evaluate(MEASURE);
    await shot('sheet-desktop.png');
    d.align === 'center' && d.modal.top > 0 && d.modal.bottom < 900 && d.modal.width === 400
      ? ok('на компьютере диалог по центру', `${d.modal.width}px`)
      : fail('диалог на компьютере', JSON.stringify({ align: d.align, modal: d.modal }));
    d.grabber.content === 'none' && d.radius.every((value) => value === d.radius[0])
      ? ok('на компьютере нет «ручки» и срезанных углов', d.radius.join(' '))
      : fail('оформление компьютера', JSON.stringify({ grabber: d.grabber, radius: d.radius }));
    const primary = d.buttons.find((b) => b.label === 'Сохранить');
    const cancel = d.buttons.find((b) => b.label === 'Отмена');
    primary && cancel && Math.abs(primary.y - cancel.y) <= 1 && primary.h === 30
      ? ok('на компьютере кнопки в один ряд', `${primary.w}×${primary.h}`)
      : fail('кнопки на компьютере', JSON.stringify(d.buttons));
    d.focus && d.focus.tag === 'textarea'
      ? ok('на компьютере фокус по-прежнему в поле задания')
      : fail('автофокус на компьютере', JSON.stringify(d.focus));
  }
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);

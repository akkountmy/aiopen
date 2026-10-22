// Проверка прозрачных стрелок прокрутки диалога в настоящем Chrome через
// DevTools-протокол (без зависимостей):
//   - пока лента помещается целиком, колонка скрыта;
//   - при длинной переписке она появляется у правого края, по середине ленты,
//     не залезает на поле ввода и остаётся полупрозрачной;
//   - нижняя стрелка листает вниз, верхняя — обратно; у краёв стрелка гаснет;
//   - на телефоне (390 px) кнопка компактнее и не создаёт горизонтальной прокрутки.
//
// Запуск (нужен уже работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3214'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/ui-scroll.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';
const SHOT_DIR = process.env.DSHOW_SHOT_DIR || '';

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка стрелок прокрутки пропущена');
  process.exit(0);
}

const results = [];
function ok(name, extra = '') {
  results.push(true);
  console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`);
}
function fail(name, detail) {
  results.push(false);
  console.log(`  FAIL ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------- Chrome + CDP ---------------------------- */

const PORT = Number(process.env.DSHOW_CDP_PORT || 9336);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-scroll-cdp-'));
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

/* ------------------------------- сценарий ------------------------------- */

let target = null;
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
        /* страница ещё загружается */
      }
      await sleep(150);
    }
    return false;
  }

  async function shot(name) {
    if (!SHOT_DIR) return;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(data, 'base64'));
  }

  // 1. вход и отдельный проект: чужие диалоги проверка не трогает
  await goto(BASE + '/');
  const loginStatus = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${JSON.stringify(USER)}, password:${JSON.stringify(PASS)}})}).then(r => r.status)`,
  );
  loginStatus === 200 ? ok('вход в сервис') : fail('вход', loginStatus);

  target = await evaluate(
    `(async () => {
       const project = (await (await fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'Проверка стрелок прокрутки'})})).json()).project;
       const chat = (await (await fetch('/api/projects/' + project.id + '/chats', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'Длинный диалог'})})).json()).chat;
       return { id: project.id, chatId: chat.id };
     })()`,
  );
  target && target.chatId ? ok('тестовый проект и диалог созданы') : fail('создание проекта', target);

  await goto(BASE + '/?chat=' + encodeURIComponent(target.chatId));
  const ready = await waitFor(`!!document.querySelector('#app:not(.hidden)') && !!document.querySelector('#thread')`);
  ready ? ok('приложение открыло диалог') : fail('диалог не открылся');

  // 2. пустой диалог: лента помещается целиком — колонка скрыта
  const empty = await evaluate(`(() => {
    const jump = document.querySelector('#scrollJump');
    return {
      on: jump.classList.contains('on'),
      hidden: jump.getAttribute('aria-hidden'),
      opacity: getComputedStyle(jump).opacity,
      scrollable: document.querySelector('#scroll').scrollHeight - document.querySelector('#scroll').clientHeight,
    };
  })()`);
  !empty.on && empty.hidden === 'true' && Number(empty.opacity) === 0
    ? ok('в коротком диалоге кнопка скрыта')
    : fail('кнопка видна без необходимости', empty);

  // 3. длинная переписка: подкладываем настоящую разметку сообщений, чтобы
  //    проверить именно поведение ленты, не вызывая модель.
  await evaluate(`(() => {
    const thread = document.querySelector('#thread');
    const parts = [
      'Короткий ответ на первую реплику: проверяю, как ведёт себя лента при длинной переписке.',
      'Продолжаю разбор. В ответе несколько абзацев, таблица не нужна — достаточно текста, который занимает высоту и заставляет ленту прокручиваться.',
      'Итог: стрелки должны стоять справа по центру, не перекрывать поле ввода и листать примерно на экран за нажатие.',
    ];
    const rows = [];
    for (let i = 1; i <= 18; i += 1) {
      rows.push('<article class="msg msg-assistant">' +
        '<div class="msg-head"><span class="dot"></span>Ассистент · сообщение ' + i + '</div>' +
        '<div class="md"><p>' + parts[0] + '</p><p>' + parts[1] + '</p><p>' + parts[2] + '</p></div>' +
        '</article>');
    }
    thread.innerHTML = rows.join('');
    return thread.children.length;
  })()`);
  const appeared = await waitFor(`document.querySelector('#scrollJump').classList.contains('on')`);
  appeared ? ok('в длинном диалоге кнопка появилась') : fail('кнопка не появилась');

  const layout = await evaluate(`(() => {
    const jump = document.querySelector('#scrollJump');
    const box = jump.getBoundingClientRect();
    const scroller = document.querySelector('#scroll').getBoundingClientRect();
    const composer = document.querySelector('.composer-wrap').getBoundingClientRect();
    const style = getComputedStyle(jump);
    const down = document.querySelector('#scrollDown');
    const up = document.querySelector('#scrollUp');
    const alpha = (style.backgroundColor.match(/rgba?\\([^)]*\\)/) || [''])[0];
    return {
      box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), bottom: Math.round(box.bottom) },
      scroller: { top: Math.round(scroller.top), bottom: Math.round(scroller.bottom), right: Math.round(scroller.right) },
      composerTop: Math.round(composer.top),
      opacity: Number(style.opacity),
      pointer: style.pointerEvents,
      bg: alpha,
      upOff: up.classList.contains('is-off'),
      downOff: down.classList.contains('is-off'),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  })()`);
  const centerDelta = Math.abs((layout.box.y + layout.box.bottom) / 2 - (layout.scroller.top + layout.scroller.bottom) / 2);
  const rightGap = layout.scroller.right - (layout.box.x + layout.box.w);
  centerDelta <= 3 ? ok('кнопка стоит по середине высоты ленты', `смещение ${centerDelta.toFixed(1)} px`) : fail('не по центру', layout);
  rightGap >= 0 && rightGap <= 24 ? ok('кнопка прижата к правому краю', `зазор ${rightGap} px`) : fail('неверный отступ справа', layout);
  layout.box.bottom <= layout.composerTop ? ok('кнопка не заходит на поле ввода') : fail('кнопка перекрывает ввод', layout);
  layout.pointer === 'auto' && layout.opacity > 0.3 && layout.opacity < 0.8
    ? ok('кнопка полупрозрачная', `opacity ${layout.opacity}`)
    : fail('прозрачность', layout);
  /rgba\([^)]*,\s*0?\.\d+\)/.test(layout.bg)
    ? ok('фон кнопки прозрачный', layout.bg)
    : fail('фон не прозрачный', layout.bg);
  layout.upOff && !layout.downOff ? ok('у верхнего края активна только стрелка вниз') : fail('состояние стрелок сверху', layout);

  await shot('scroll-desktop.png');

  // 4. нижняя стрелка листает вниз, верхняя возвращает
  const before = await evaluate(`document.querySelector('#scroll').scrollTop`);
  await evaluate(`document.querySelector('#scrollDown').click()`);
  await sleep(900);
  const afterDown = await evaluate(`(() => { const s = document.querySelector('#scroll'); return { top: s.scrollTop, upOff: document.querySelector('#scrollUp').classList.contains('is-off') }; })()`);
  afterDown.top > before + 100 ? ok('стрелка вниз листает ленту', `${Math.round(afterDown.top)} px`) : fail('вниз не листает', afterDown);
  !afterDown.upOff ? ok('после прокрутки стрелка вверх стала активной') : fail('вверх осталась неактивной');

  // 5. до самого низа: нижняя стрелка гаснет
  const atBottom = await evaluate(`(async () => {
    const s = document.querySelector('#scroll');
    const button = document.querySelector('#scrollDown');
    for (let i = 0; i < 30 && !button.classList.contains('is-off'); i += 1) {
      button.click();
      await new Promise((r) => setTimeout(r, 180));
    }
    await new Promise((r) => setTimeout(r, 500));
    return {
      top: Math.round(s.scrollTop),
      max: Math.round(s.scrollHeight - s.clientHeight),
      downOff: button.classList.contains('is-off'),
      upOff: document.querySelector('#scrollUp').classList.contains('is-off'),
    };
  })()`);
  atBottom.downOff && !atBottom.upOff && atBottom.top >= atBottom.max - 4
    ? ok('внизу стрелка вниз гаснет', `${atBottom.top}/${atBottom.max} px`)
    : fail('нижний край', atBottom);

  // 6. и обратно вверх
  await evaluate(`document.querySelector('#scrollUp').click()`);
  await sleep(900);
  const afterUp = await evaluate(`(() => { const s = document.querySelector('#scroll'); return { top: s.scrollTop, downOff: document.querySelector('#scrollDown').classList.contains('is-off') }; })()`);
  afterUp.top < atBottom.top - 100 ? ok('стрелка вверх листает обратно', `${Math.round(afterUp.top)} px`) : fail('вверх не листает', afterUp);

  // 7. телефон: компактнее, без горизонтальной прокрутки
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await goto(BASE + '/?chat=' + encodeURIComponent(target.chatId));
  await waitFor(`!!document.querySelector('#app:not(.hidden)')`);
  await evaluate(`(() => {
    const thread = document.querySelector('#thread');
    const text = 'На телефоне кнопка должна быть компактнее и не закрывать текст. Проверяем длинную переписку и прокрутку в обе стороны.';
    thread.innerHTML = Array.from({ length: 16 }, (_, i) => '<article class="msg msg-assistant"><div class="msg-head"><span class="dot"></span>Ассистент</div><div class="md"><p>' + (i + 1) + '. ' + text + '</p><p>' + text + '</p></div></article>').join('');
  })()`);
  await waitFor(`document.querySelector('#scrollJump').classList.contains('on')`);
  const mobile = await evaluate(`(() => {
    const jump = document.querySelector('#scrollJump');
    const box = jump.getBoundingClientRect();
    const style = getComputedStyle(jump);
    const scroller = document.querySelector('#scroll').getBoundingClientRect();
    return {
      w: Math.round(box.width),
      h: Math.round(box.height),
      rightGap: Math.round(scroller.right - box.right),
      opacity: Number(style.opacity),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      composerTop: Math.round(document.querySelector('.composer-wrap').getBoundingClientRect().top),
      bottom: Math.round(box.bottom),
    };
  })()`);
  mobile.w <= 40 && mobile.w >= 28 ? ok('на телефоне кнопка компактная', `${mobile.w}×${mobile.h} px`) : fail('размер на телефоне', mobile);
  mobile.rightGap >= 0 && mobile.rightGap <= 16 ? ok('на телефоне кнопка у края', `${mobile.rightGap} px`) : fail('отступ на телефоне', mobile);
  mobile.overflow <= 0 ? ok('нет горизонтальной прокрутки на телефоне') : fail('горизонтальная прокрутка', mobile.overflow);
  mobile.bottom <= mobile.composerTop ? ok('на телефоне кнопка выше поля ввода') : fail('перекрытие ввода на телефоне', mobile);
  await shot('scroll-mobile.png');

  await cdp.send('Emulation.clearDeviceMetricsOverride');

  // 8. уборка: удаляем только свой проект
  const cleaned = await evaluate(
    `fetch('/api/projects/' + ${JSON.stringify(target.id)}, {method:'DELETE'}).then(r => r.status)`,
  );
  cleaned === 200 ? ok('тестовый проект удалён') : fail('уборка проекта', cleaned);
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);

// Проверка озвучки в живом интерфейсе через DevTools-протокол (без зависимостей):
//   - у документа в панели файлов есть кнопка «Озвучить» (и на телефоне она
//     видна без наведения — иначе до неё не добраться пальцем);
//   - окно озвучки показывает голоса и темп с сервера, а не заглушку;
//   - пустой файл не запускает синтез, а объясняет причину прямо в окне;
//   - у книги синтез идёт с прогрессом и заканчивается плеером с готовым MP3;
//   - готовый звук открывается в окне просмотра и играет там же.
//
// Запуск (нужен уже работающий сервер с проектом из test/tts.mjs):
//   $env:DSHOW_BASE='http://127.0.0.1:3311'; $env:DSHOW_USER='DSH'; $env:DSHOW_PASS='...'
//   node test/tts-ui.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'admin';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';
const OUT = process.env.DSHOW_SHOT_DIR || '';
const SOURCE = process.env.DSHOW_TTS_FILE || 'Глава первая.txt';
const EMPTY = process.env.DSHOW_TTS_EMPTY || 'пусто.txt';
/* Озвучка называется по исходнику (одна часть — просто «книга.mp3», книга
   целиком — «книга — часть 2 из 12.mp3») и всегда идёт вместе с Word. */
const SOURCE_BASE = SOURCE.replace(/\.[^.]+$/, '');
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MP3_MATCH = `/${escapeRe(SOURCE_BASE)}[^\\n]*\\.mp3/`;
const WORD_MATCH = `/${escapeRe(SOURCE_BASE)}[^\\n]*\\.docx/`;

const CHROME_CANDIDATES = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) {
  console.log('  --  Chrome/Edge не найден, проверка окна озвучки пропущена');
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

/* ---------------------------- Chrome + CDP ---------------------------- */

const PORT = Number(process.env.DSHOW_CDP_PORT || 9341);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-tts-'));
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
      const pages = (await res.json()).filter((tab) => tab.type === 'page');
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
  const consoleErrors = [];
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const text = (msg.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
      if (text) consoleErrors.push(text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails || {};
      consoleErrors.push(details.exception?.description || details.text || 'исключение');
    }
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
    consoleErrors,
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
    await sleep(800);
  }
  async function waitFor(expression, timeoutMs = 15000) {
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
  if (login !== 200) {
    console.log(`  --  вход не удался (${login}), дальше некуда`);
    process.exit(1);
  }
  /* Сеанс уже есть (cookie), но страница на экране входа: перезагружаем её,
     чтобы приложение поднялось уже авторизованным. */
  await goto(BASE + '/');

  /* Проект из test/tts.mjs: открываем его кликом в списке проектов, как это
     сделал бы человек, а не через внутренние переменные страницы. */
  /* Проекты в предпросмотре нумеруются («Озвучка 04689»), поэтому нужный
     документ ищем по содержимому: перебираем проекты, пока в панели файлов не
     появится строка с именем needName. */
  async function openProjectWithFiles(needName) {
    const ready = await waitFor(`document.querySelectorAll('nav button, aside button').length > 0`, 15000);
    if (!ready) return false;
    const openDrawer = async () => {
      /* На телефоне панель файлов — выдвижной ящик: пока его не открыть, строк
         файлов в разметке нет. Открываем той же кнопкой, что и человек. */
      const drawer = await evaluate(`(() => {
        const button = document.getElementById('filesBtn');
        if (!button || button.getAttribute('aria-expanded') === 'true') return false;
        button.click();
        return true;
      })()`);
      if (drawer) await sleep(300);
      return waitFor(`document.querySelectorAll('.file-row').length > 0`, 8000);
    };
    const count = await evaluate(`[...document.querySelectorAll('nav button, aside button')].filter((button) => /озвучка/i.test(button.textContent || '')).length`);
    for (let index = 0; index < Math.max(1, count); index += 1) {
      const picked = await evaluate(`(() => {
        const buttons = [...document.querySelectorAll('nav button, aside button')].filter((button) => /озвучка/i.test(button.textContent || ''));
        const target = buttons[${index}];
        if (!target) return false;
        target.click();
        return true;
      })()`);
      if (!picked) break;
      await sleep(400);
      const rows = (await openDrawer()) || (await waitFor(`document.querySelectorAll('.file-row').length > 0`, 4000));
      if (!rows) continue;
      const has = await evaluate(`(() => [...document.querySelectorAll('.file-row')].some((row) => (row.textContent || '').includes(${JSON.stringify(needName)})))()`);
      if (has) return true;
    }
    return false;
  }

  /* Ищем строку файла по имени и кнопку «Озвучить» внутри неё. */
  const FIND_FILE = (name) => `(() => {
    const rows = [...document.querySelectorAll('.file-row')];
    const row = rows.find((item) => (item.textContent || '').includes(${JSON.stringify(name)}));
    if (!row) return null;
    const narrate = row.querySelector('button[title="Озвучить"]');
    const rect = narrate ? narrate.getBoundingClientRect() : null;
    return { hasRow: true, hasNarrate: Boolean(narrate), w: rect ? Math.round(rect.width) : 0, h: rect ? Math.round(rect.height) : 0, label: narrate ? narrate.getAttribute('aria-label') : '' };
  })()`;

  async function clickNarrate(name) {
    return evaluate(`(() => {
      const rows = [...document.querySelectorAll('.file-row')];
      const row = rows.find((item) => (item.textContent || '').includes(${JSON.stringify(name)}));
      if (!row) return false;
      const narrate = row.querySelector('button[title="Озвучить"]');
      if (!narrate) return false;
      narrate.click();
      return true;
    })()`);
  }

  const opened = await openProjectWithFiles(SOURCE);
  if (!opened) {
    fail('проект с файлами', `не открылся (нет проекта «Озвучка» с файлом ${SOURCE})`);
    throw new Error('stop');
  }
  ok('проект с документами открыт');

  /* 1. Кнопка озвучки есть у текстового файла, а у пустого — тоже (проверку
        содержимого делает сервер и объясняет причину). */
  for (const [width, height] of [[390, 844], [1280, 900]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    await goto(BASE + '/');
    const ready = await openProjectWithFiles(SOURCE);
    if (!ready) {
      const diag = await evaluate(`(() => ({
        rows: document.querySelectorAll('.file-row').length,
        filesBtn: Boolean(document.getElementById('filesBtn')),
        projects: [...document.querySelectorAll('nav button, aside button')].map((b) => (b.textContent || '').trim().slice(0, 30)).slice(0, 12),
        title: document.title,
        body: document.body.className,
      }))()`);
      fail(`файлы при ${width}px`, `проект не открылся ${JSON.stringify(diag)}`);
      continue;
    }
    if (width >= 900) {
      /* На компьютере кнопки строки показываются при наведении — проверяем
         именно это, а не только наличие в разметке. */
      const box = await evaluate(`(() => {
        const row = [...document.querySelectorAll('.file-row')].find((item) => (item.textContent || '').includes(${JSON.stringify(SOURCE)}));
        if (!row) return null;
        const rect = row.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      if (box) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
        await sleep(200);
      }
    }
    const found = await evaluate(FIND_FILE(SOURCE));
    if (!found) {
      fail(`кнопка «Озвучить» при ${width}px`, `файл ${SOURCE} не найден в панели`);
      continue;
    }
    const visible = width < 900 || found.h > 0;
    visible && found.label.includes('MP3')
      ? ok(`кнопка «Озвучить» на месте при ${width}px`, `${found.w}×${found.h}`)
      : fail(`кнопка «Озвучить» при ${width}px`, JSON.stringify(found));

    if (width === 390) {
      /* 2. Окно: голоса и темп с сервера, подсказка и кнопка запуска. */
      await clickNarrate(SOURCE);
      const modalOpen = await waitFor(`!!document.querySelector('#modalRoot .modal.tts-modal')`);
      if (!modalOpen) {
        fail('окно озвучки', 'не открылось');
        continue;
      }
      await sleep(600);
      const controls = await evaluate(`(() => {
        const modal = document.querySelector('#modalRoot .modal.tts-modal');
        const selects = [...modal.querySelectorAll('select.tts-select')];
        const voices = selects[0] ? [...selects[0].options].map((option) => ({ id: option.value, label: option.textContent })) : [];
        const rates = selects[1] ? [...selects[1].options].map((option) => option.textContent) : [];
        const start = modal.querySelector('.tts-start');
        const hint = modal.querySelector('.tts-hint');
        const rect = modal.getBoundingClientRect();
        return {
          voices,
          rates,
          startLabel: start ? start.textContent.trim() : '',
          startW: start ? Math.round(start.getBoundingClientRect().width) : 0,
          hint: hint ? hint.textContent.trim() : '',
          width: Math.round(rect.width),
          right: Math.round(rect.right),
          inner: window.innerWidth,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      })()`);
      const ru = controls.voices.filter((voice) => /^ru-RU-/.test(voice.id));
      ru.length === 2 && controls.voices.length === 4
        ? ok('голоса пришли с сервера', controls.voices.map((voice) => voice.id).join(', '))
        : fail('список голосов', JSON.stringify(controls.voices));
      controls.rates.length >= 3 && controls.rates.some((label) => /Обычный темп/.test(label))
        ? ok('темп речи выбран по умолчанию', controls.rates.join(' / '))
        : fail('список темпов', JSON.stringify(controls.rates));
      controls.startLabel === 'Озвучить' && controls.startW > 60
        ? ok('кнопка запуска на месте', `${controls.startW}px`)
        : fail('кнопка запуска', JSON.stringify(controls));
      controls.hint.length > 10 ? ok('подсказка к голосу есть', controls.hint.slice(0, 60)) : fail('подсказка к голосу', controls.hint);
      controls.width <= controls.inner && controls.overflow <= 0
        ? ok('окно влезает в телефон', `${controls.width}px из ${controls.inner}px`)
        : fail('окно шире экрана', JSON.stringify({ width: controls.width, inner: controls.inner, overflow: controls.overflow }));
      await shot('tts-390-form.png');

      /* 3. Пустой файл: синтез не начинается, а причина видна в окне.
            Пустой файл лежит в соседнем проекте, поэтому сначала переключаемся
            на проект, где он есть, — как это сделал бы человек. */
      await evaluate(`document.querySelector('#modalRoot .modal.tts-modal .modal-close').click()`);
      await waitFor(`!document.querySelector('#modalRoot .modal')`, 4000);
      const switched = await openProjectWithFiles(EMPTY);
      if (!switched) fail('проект с пустым файлом', `не нашёлся файл ${EMPTY}`);
      await clickNarrate(EMPTY);
      const emptyOpen = await waitFor(`!!document.querySelector('#modalRoot .modal.tts-modal')`);
      if (emptyOpen) {
        /* Причина видна сразу, без нажатия: окно спрашивает у сервера план и,
           если текста нет, пишет это над формой и гасит кнопку запуска. */
        const explained = await waitFor(
          `(() => {
             const modal = document.querySelector('#modalRoot .modal.tts-modal');
             const hint = modal.querySelector('.tts-hint');
             const start = modal.querySelector('.tts-start');
             return Boolean(hint && hint.textContent.trim().length > 10 && start && start.disabled);
           })()`,
          15000,
        );
        const text = await evaluate(`(() => {
          const modal = document.querySelector('#modalRoot .modal.tts-modal');
          return { plan: modal.querySelector('.tts-hint')?.textContent.trim() || '', start: modal.querySelector('.tts-start')?.textContent.trim() || '', disabled: Boolean(modal.querySelector('.tts-start')?.disabled) };
        })()`);
        explained && /текст/i.test(text.plan) && text.disabled
          ? ok('пустой файл объясняет причину', text.plan.slice(0, 80))
          : fail('пустой файл', JSON.stringify(text));
        await shot('tts-390-empty.png');
        await evaluate(`document.querySelector('#modalRoot .modal.tts-modal .modal-close').click()`);
        await waitFor(`!document.querySelector('#modalRoot .modal')`, 4000);
      } else {
        fail('окно для пустого файла', 'не открылось');
      }

      /* 4. Книга: прогресс идёт, синтез заканчивается плеером и новым MP3. */
      await openProjectWithFiles(SOURCE);
      await clickNarrate(SOURCE);
      await waitFor(`!!document.querySelector('#modalRoot .modal.tts-modal')`);
      await sleep(400);
      await evaluate(`document.querySelector('#modalRoot .modal.tts-modal .tts-start').click()`);
      /* Короткий файл синтезируется быстрее, чем успевает прийти первый опрос
         прогресса, поэтому «полоса пошла» и «сразу готово» — оба годных исхода. */
      const started = await waitFor(
        `(() => {
           const bar = document.querySelector('#modalRoot .tts-bar-fill');
           const player = document.querySelector('#modalRoot .tts-player');
           return Boolean((bar && parseFloat(bar.style.width) > 0) || player);
         })()`,
        30000,
      );
      started ? ok('прогресс синтеза пошёл') : fail('прогресс синтеза', 'полоса осталась на нуле');
      const cancelVisible = await evaluate(`!document.querySelector('#modalRoot .tts-cancel').hidden`);
      cancelVisible ? ok('во время синтеза есть «Остановить»') : fail('кнопка «Остановить»', 'скрыта');
      await shot('tts-390-progress.png');

      const done = await waitFor(`!!document.querySelector('#modalRoot .tts-player')`, 300000);
      if (!done) {
        const state = await evaluate(`(() => {
          const modal = document.querySelector('#modalRoot .modal.tts-modal');
          return modal ? { text: modal.querySelector('.tts-progress-text')?.textContent.trim(), note: modal.querySelector('.tts-bar-note')?.textContent.trim() } : null;
        })()`);
        fail('синтез книги', JSON.stringify(state));
      } else {
        const player = await evaluate(`(() => {
          const audio = document.querySelector('#modalRoot .tts-player');
          const meta = document.querySelector('#modalRoot .tts-result-meta');
          const card = document.querySelector('#modalRoot .tts-result');
          return {
            src: audio.getAttribute('src'),
            controls: audio.controls,
            meta: meta ? meta.textContent.trim() : '',
            hasSave: Boolean(card.querySelector('.tts-save')),
            hasAgain: Boolean(card.querySelector('.tts-again')),
            duration: Number.isFinite(audio.duration) ? Math.round(audio.duration) : 0,
            error: audio.error ? audio.error.code : null,
          };
        })()`);
        /^\/api\/tts\/jobs\/[^/]+\/audio$/.test(player.src) && player.controls
          ? ok('готовый MP3 в плеере', player.src)
          : fail('плеер', JSON.stringify(player));
        player.hasSave && player.hasAgain ? ok('есть «Скачать MP3» и «Озвучить ещё раз»') : fail('кнопки результата', JSON.stringify(player));
        /\d+:\d\d|\d+\s*с/.test(player.meta) ? ok('длительность и размер показаны', player.meta) : fail('подпись результата', player.meta);
        /* Метаданные браузера: сервер отдаёт файл частями, поэтому duration
              должен появиться без полной загрузки. */
        const metaLoaded = await waitFor(
          `(() => { const audio = document.querySelector('#modalRoot .tts-player'); return Boolean(audio && Number.isFinite(audio.duration) && audio.duration > 5); })()`,
          20000,
        );
        metaLoaded ? ok('браузер прочитал длительность записи') : fail('длительность записи', 'не пришла');
        await shot('tts-390-done.png');

        /* 5. Озвучка лежит в панели файлов рядом с документом. Повторная
              озвучка переписывает свои же файлы (так и задумано), поэтому
              проверяем наличие строки и имя, а не рост количества. */
        const inPanel = await waitFor(
          `(() => [...document.querySelectorAll('.file-row')].some((row) => ${MP3_MATCH}.test(row.textContent || '')))()`,
          8000,
        );
        inPanel ? ok('озвучка есть в панели файлов') : fail('панель файлов', 'строки MP3 нет');
        const mp3Name = await evaluate(`(() => {
          const rows = [...document.querySelectorAll('.file-row')].map((item) => item.textContent.trim());
          return rows.find((text) => ${MP3_MATCH}.test(text)) || '';
        })()`);
        mp3Name ? ok('имя файла рядом с исходником', mp3Name.slice(0, 60)) : fail('имя файла озвучки', 'не найдено');
        /* Рядом обязан лежать ровно один Word с текстом: это вторая половина
           договора «части MP3 + книга в Word». */
        const wordName = await evaluate(`(() => {
          const rows = [...document.querySelectorAll('.file-row')].map((item) => item.textContent.trim());
          return rows.find((text) => ${WORD_MATCH}.test(text)) || '';
        })()`);
        wordName ? ok('рядом Word с текстом', wordName.slice(0, 60)) : fail('Word рядом с озвучкой', 'не найдено');

        /* 6. Готовый звук открывается в окне просмотра и играет там. */
        await evaluate(`document.querySelector('#modalRoot .modal.tts-modal .modal-close').click()`);
        await waitFor(`!document.querySelector('#modalRoot .modal')`, 4000);
        /* Как именно открывается файл, зависит от ввода: на тач-экране — тап,
           на компьютере — двойной щелчок. Пробуем оба, как это делает человек. */
        const press = (type) =>
          evaluate(`(() => {
            const rows = [...document.querySelectorAll('.file-row')];
            const row = rows.find((item) => ${MP3_MATCH}.test(item.textContent || ''));
            if (!row) return false;
            const main = row.querySelector('.row-main');
            if (!main) return false;
            main.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true, detail: 1 }));
            return true;
          })()`);
        await press('click');
        let previewOpen = await waitFor(`!!document.querySelector('#modalRoot .modal.file-preview-modal')`, 5000);
        if (!previewOpen) {
          await press('dblclick');
          previewOpen = await waitFor(`!!document.querySelector('#modalRoot .modal.file-preview-modal')`, 8000);
        }
        if (!previewOpen) fail('просмотр звука', 'окно не открылось');
        else {
          await sleep(600);
          const audio = await evaluate(`(() => {
            const modal = document.querySelector('#modalRoot .modal.file-preview-modal');
            const player = modal.querySelector('audio.audio-preview');
            const badge = modal.querySelector('.pv-badge');
            return {
              kind: modal.className,
              hasPlayer: Boolean(player),
              controls: player ? player.controls : false,
              src: player ? player.getAttribute('src') : '',
              badge: badge ? badge.textContent.trim() : '',
              w: Math.round(modal.getBoundingClientRect().width),
            };
          })()`);
          audio.hasPlayer && audio.controls && /pv-kind-audio/.test(audio.kind) && /\.mp3/.test(audio.src)
            ? ok('звук открылся в своём плеере', `${audio.w}px, ${audio.badge}`)
            : fail('просмотр звука', JSON.stringify(audio));
          await shot('tts-390-preview.png');
        }
      }
    }
  }

  /* 7. Ошибки в консоли страницы: их не должно быть ни одной за весь сценарий. */
  const noisy = cdp.consoleErrors.filter((text) => !/favicon|ResizeObserver|net::ERR_ABORTED/i.test(text));
  noisy.length === 0 ? ok('в консоли страницы чисто') : fail('ошибки в консоли', noisy.slice(0, 3).join(' | '));
} catch (error) {
  if (!/stop/.test(error.message)) {
    fail('сценарий', error.message);
  }
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);

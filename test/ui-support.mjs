// Поддержка: кнопка в шапке, окно обращения со скриншотом и блок «Сообщения от
// пользователя» в кабинете администратора. Проверка идёт в живом Chrome через
// DevTools-протокол (без зависимостей), поэтому смотрим ровно то, что видит
// человек: место кнопки, сжатие скриншота, отправку, цифру непрочитанных,
// отметки «Прочитано»/«Решено», удаление и вид на телефоне.
//
// Запуск (нужен уже работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='admin'; $env:DSHOW_PASS='...'
//   node test/ui-support.mjs
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
  console.log('  --  Chrome/Edge не найден, проверка поддержки пропущена');
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
const MARK = `Проверка поддержки ${Date.now()}`;

/* ---------------------------- Chrome + CDP ---------------------------- */

const PORT = Number(process.env.DSHOW_CDP_PORT || 9341);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-support-'));
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
    await sleep(800);
  }
  async function waitFor(expression, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        /* страница ещё грузится */
      }
      await sleep(160);
    }
    return false;
  }
  async function shot(name) {
    if (!OUT) return;
    fs.mkdirSync(OUT, { recursive: true });
    const data = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data.data, 'base64'));
  }
  const json = (value) => JSON.stringify(value);

  await goto(BASE + '/');
  const login = await evaluate(
    `fetch('/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:${json(USER)}, password:${json(PASS)}})}).then(r => r.status)`,
  );
  console.log(`  --  вход: ${login}\n`);
  /* Проверка не должна зависеть от того, что осталось от прошлых прогонов:
     чистим обращения администратором до начала (иначе цифры и «первая строка»
     будут чужими). */
  const purged = await evaluate(`(async () => {
    const list = await fetch('/api/admin/support').then((r) => (r.ok ? r.json() : { messages: [] }));
    for (const item of list.messages || []) await fetch('/api/admin/support/' + item.id, { method: 'DELETE' });
    return (list.messages || []).length;
  })()`);
  console.log(`  --  убрано старых обращений: ${purged}\n`);
  await goto(BASE + '/');
  await waitFor(`!!document.getElementById('supportBtn')`);

  /* 1. Кнопка стоит в шапке слева от «Дашборда», того же размера и формы. */
  const places = await evaluate(`(() => {
    const support = document.getElementById('supportBtn');
    const dash = document.getElementById('dashboardBtn');
    const a = support.getBoundingClientRect();
    const b = dash.getBoundingClientRect();
    return {
      supportRight: Math.round(a.right),
      dashLeft: Math.round(b.left),
      dy: Math.round(Math.abs((a.top + a.height / 2) - (b.top + b.height / 2))),
      size: [Math.round(a.width), Math.round(a.height)],
      dashSize: [Math.round(b.width), Math.round(b.height)],
      label: support.getAttribute('aria-label'),
      iconViewBox: support.querySelector('svg')?.getAttribute('viewBox') || '',
      badgeHidden: document.getElementById('supportBadge').hidden,
      hasLabel: !!support.querySelector('.dash-btn-label'),
    };
  })()`);
  places.supportRight <= places.dashLeft && places.dy <= 1
    ? ok('кнопка «Поддержка» стоит слева от «Дашборда» в том же ряду', `${places.supportRight} ≤ ${places.dashLeft}`)
    : fail('положение кнопки', json(places));
  places.size.join('×') === '34×34' && places.size.join('×') === places.dashSize.join('×')
    ? ok('кнопка того же размера, что «Дашборд»', places.size.join('×'))
    : fail('размер кнопки', json({ size: places.size, dash: places.dashSize }));
  places.iconViewBox === '0 0 20 20' && places.label === 'Поддержка'
    ? ok('значок в стиле шапки, подпись для экранного диктора есть')
    : fail('значок кнопки', json(places));
  places.badgeHidden ? ok('без непрочитанных цифры на кнопке нет') : fail('счётчик', 'виден при нуле');

  /* 2. Окно обращения. */
  await evaluate(`document.getElementById('supportBtn').click()`);
  const opened = await waitFor(`!!document.querySelector('#modalRoot .modal.support-modal')`);
  if (!opened) fail('окно поддержки', 'не открылось');
  await sleep(400);
  await shot('support-modal.png');

  const form = await evaluate(`(() => {
    const modal = document.querySelector('#modalRoot .modal.support-modal');
    const kinds = [...modal.querySelectorAll('.support-kind')].map((b) => ({ label: b.textContent.trim(), active: b.classList.contains('active') }));
    const rect = modal.getBoundingClientRect();
    return {
      kinds,
      hint: modal.querySelector('.support-hint')?.textContent || '',
      hasText: !!modal.querySelector('textarea.support-text'),
      hasAttach: !!modal.querySelector('.support-pick'),
      hasContact: !!modal.querySelector('.support-contact input'),
      hasSubtitle: !!modal.querySelector('.modal-sub'),
      adminLink: !!modal.querySelector('.support-admin-link'),
      width: Math.round(rect.width),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  })()`);
  form.kinds.length === 3 && form.kinds[0].active
    ? ok('три типа обращения, по умолчанию «Проблема»', form.kinds.map((k) => k.label).join(' / '))
    : fail('типы обращения', json(form.kinds));
  form.hasText && form.hasAttach && !form.hasContact
    ? ok('в окне есть поле текста и прикрепление скриншота, лишних полей нет')
    : fail('поля окна', json(form));
  form.hasSubtitle === false
    ? ok('под заголовком нет поясняющей подписи')
    : fail('подпись под заголовком', 'осталась');
  form.adminLink ? ok('администратору виден переход в кабинет') : fail('ссылка в кабинет', 'нет');

  /* 3. Скриншот: 2400×1400 вставляем как файл и ждём сжатый предпросмотр. */
  const uploaded = await evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 1400;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 2400, 1400);
    ctx.fillStyle = '#101820';
    ctx.font = '90px sans-serif';
    ctx.fillText('Скриншот из теста поддержки', 90, 160);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = i % 2 ? '#3f63bd' : '#d92d20';
      ctx.fillRect(60 + i * 55, 300 + i * 20, 300, 14);
    }
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const file = new File([blob], 'screen.png', { type: 'image/png' });
    const input = document.querySelector('#modalRoot .modal.support-modal .support-file');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return blob.size;
  })()`);
  const previewReady = await waitFor(`!!document.querySelector('#modalRoot .support-shot img')`, 8000);
  const preview = previewReady
    ? await evaluate(`(() => {
        const img = document.querySelector('#modalRoot .support-shot img');
        return {
          isJpeg: img.src.startsWith('data:image/jpeg;base64,'),
          bytes: Math.round((img.src.length - 'data:image/jpeg;base64,'.length) * 0.75),
          name: document.querySelector('.support-shot-name')?.textContent || '',
          sizeText: document.querySelector('.support-shot-size')?.textContent || '',
          width: img.naturalWidth,
          height: img.naturalHeight,
        };
      })()`)
    : null;
  preview && preview.isJpeg && preview.width <= 1600 && preview.height <= 1600
    ? ok('скриншот сжат на клиенте', `${uploaded} Б → ${preview.bytes} Б, ${preview.width}×${preview.height}`)
    : fail('сжатие скриншота', json(preview));
  preview && /\.jpg$/.test(preview.name)
    ? ok('в окне видно имя и вес вложения', `${preview.name} · ${preview.sizeText}`)
    : fail('подпись вложения', json(preview));

  /* 4. Короткий текст не отправляется — человек видит подсказку. */
  await evaluate(`(() => {
    const area = document.querySelector('#modalRoot textarea.support-text');
    area.value = 'мало';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#modalRoot .modal-foot .btn-primary').click();
  })()`);
  await sleep(500);
  const shortNote = await evaluate(`document.querySelector('#modalRoot .support .field-error')?.textContent || ''`);
  shortNote.length > 0
    ? ok('короткий текст не уходит, есть подсказка', shortNote)
    : fail('проверка длины', 'подсказки нет');

  /* 5. Настоящее обращение: тип «Идея», текст и прикреплённый скриншот. */
  await evaluate(`(() => {
    const kind = [...document.querySelectorAll('#modalRoot .support-kind')].find((b) => b.textContent.trim() === 'Идея');
    kind.click();
    const area = document.querySelector('#modalRoot textarea.support-text');
    area.value = ${json(MARK)};
    area.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await shot('support-filled.png');
  await evaluate(`document.querySelector('#modalRoot .modal-foot .btn-primary').click()`);
  const sent = await waitFor(`!!document.querySelector('#modalRoot .support-history-row')`, 8000);
  await sleep(400);
  await shot('support-sent.png');
  const afterSend = await evaluate(`(() => {
    const modal = document.querySelector('#modalRoot .modal.support-modal');
    return {
      open: !!modal,
      history: modal ? modal.querySelectorAll('.support-history-row').length : 0,
      cleared: modal ? modal.querySelector('textarea.support-text').value === '' : false,
      shotCleared: modal ? !modal.querySelector('.support-shot') : false,
      toast: document.getElementById('toastRoot')?.textContent || '',
      kindChip: modal?.querySelector('.support-history-row .support-kind-chip')?.textContent || '',
      text: modal?.querySelector('.support-history-row .support-history-text')?.textContent || '',
      status: modal?.querySelector('.support-history-row .support-status')?.textContent || '',
    };
  })()`);
  sent && afterSend.history === 1 && afterSend.cleared && afterSend.shotCleared
    ? ok('обращение отправлено, окно осталось и очистилось')
    : fail('отправка обращения', json(afterSend));
  /Сообщение отправлено администратору/.test(afterSend.toast)
    ? ok('человек видит подтверждение отправки')
    : fail('подтверждение отправки', afterSend.toast);
  afterSend.kindChip === 'Идея' && afterSend.text === MARK && afterSend.status === 'Новое'
    ? ok('своё обращение сразу видно в списке со статусом «Новое»')
    : fail('история обращений', json(afterSend));

  /* 6. Уведомление администратору: цифра на кнопке после перезагрузки и пункт
        меню профиля с той же цифрой. */
  await goto(BASE + '/');
  const badge = await waitFor(`!document.getElementById('supportBadge').hidden`, 8000);
  const badgeView = await evaluate(`(() => {
    const badge = document.getElementById('supportBadge');
    const btn = document.getElementById('supportBtn');
    const rect = badge.getBoundingClientRect();
    return {
      hidden: badge.hidden,
      text: badge.textContent,
      title: btn.title,
      onButton: rect.width > 0 && rect.right <= btn.getBoundingClientRect().right + 6,
    };
  })()`);
  badge ? ok('у администратора появилась цифра непрочитанных', badgeView.text) : fail('счётчик', json(badgeView));
  /новых обращений/.test(badgeView.title)
    ? ok('подсказка кнопки говорит о новых обращениях', badgeView.title)
    : fail('подсказка кнопки', badgeView.title);

  /* 7. Пуш приходит в открытую вкладку строкой-плашкой: воркер системное
        уведомление не показывает, окно само говорит о новом обращении. */
  const pushed = await evaluate(`(() => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dsh-push', payload: { kind: 'support', title: 'Новое сообщение от пользователя' } },
    }));
    return document.getElementById('toastRoot')?.textContent || '';
  })()`);
  /Новое сообщение от пользователя/.test(pushed)
    ? ok('пуш в открытой вкладке виден плашкой в окне')
    : fail('пуш в открытой вкладке', pushed || 'плашки нет');
  await sleep(300);

  await evaluate(`document.getElementById('userChip').click()`);
  const menuReady = await waitFor(`[...document.querySelectorAll('.menu button')].some((b) => b.textContent.includes('Сообщения от пользователя'))`);
  const menuItem = menuReady
    ? await evaluate(`(() => {
        const button = [...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('Сообщения от пользователя'));
        const badge = document.getElementById('supportBadge');
        return {
          text: button.textContent.trim(),
          badge: button.querySelector('.menu-badge')?.textContent || '',
          now: badge.hidden ? '' : badge.textContent,
        };
      })()`)
    : null;
  menuItem && menuItem.badge === menuItem.now && menuItem.badge !== ''
    ? ok('в меню профиля есть пункт с той же цифрой', `${menuItem.text} · ${menuItem.badge}`)
    : fail('пункт меню', json(menuItem));
  await shot('support-menu.png');

  /* 8. Кабинет открывается сразу на блоке обращений. */
  await evaluate(`[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes('Сообщения от пользователя')).click()`);
  const cabinet = await waitFor(`!!document.querySelector('.support-admin')`, 10000);
  await sleep(600);
  await shot('support-admin.png');
  const block = cabinet
    ? await evaluate(`(() => {
        const block = document.querySelector('.support-admin');
        const row = block.querySelector('.approval.support-row');
        const img = row?.querySelector('.support-row-shot img');
        return {
          title: block.querySelector('.support-admin-title')?.textContent.trim() || '',
          flashed: block.classList.contains('flash'),
          rows: block.querySelectorAll('.approval.support-row').length,
          kind: row?.querySelector('.support-kind-chip')?.textContent || '',
          status: row?.querySelector('.support-status')?.textContent || '',
          text: row?.querySelector('.support-row-text')?.textContent || '',
          contact: row?.querySelector('.support-row-contact')?.textContent || '',
          user: row?.querySelector('.support-row-user')?.textContent || '',
          meta: row?.querySelector('.ap-sub')?.textContent || '',
          imgWidth: img ? img.naturalWidth : 0,
          hasMarkAll: !!block.querySelector('.support-admin-all .btn'),
        };
      })()`)
    : null;
  block && block.rows >= 1 && block.text === MARK
    ? ok('обращение пришло в кабинет в блок «Сообщения от пользователя»', block.title)
    : fail('блок обращений', json(block));
  block && block.kind === 'Идея' && block.user && !block.contact
    ? ok('в строке видно тип и автора, лишних полей нет', `${block.kind} · ${block.user}`)
    : fail('строка обращения', json(block));
  block && block.imgWidth > 0
    ? ok('скриншот в кабинете открылся картинкой', `${block.imgWidth}px`)
    : fail('скриншот в кабинете', json(block));
  block && /Дашборд|Главный экран|Диалог|Проект/.test(block.meta)
    ? ok('видно, где человек был в момент обращения', block.meta)
    : fail('страница обращения', json(block));
  block && block.flashed ? ok('блок подсвечен — видно, куда смотреть') : fail('подсветка блока', 'нет класса flash');

  /* 9. «Прочитано» снимает цифру, «Решено» закрывает обращение. */
  await evaluate(`[...document.querySelectorAll('.support-admin .approval.support-row .btn')].find((b) => b.textContent.trim() === 'Прочитано').click()`);
  await waitFor(`[...document.querySelectorAll('.support-admin .support-status')].some((s) => s.textContent.trim() === 'Прочитано')`, 8000);
  const read = await evaluate(`(() => ({
    status: document.querySelector('.support-admin .support-status')?.textContent || '',
    badgeHidden: document.getElementById('supportBadge').hidden,
    title: document.getElementById('supportBtn').title,
  }))()`);
  read.status === 'Прочитано' && read.badgeHidden
    ? ok('«Прочитано» снимает цифру с кнопки')
    : fail('отметка «Прочитано»', json(read));

  await evaluate(`[...document.querySelectorAll('.support-admin .approval.support-row .btn')].find((b) => b.textContent.trim() === 'Решено').click()`);
  await waitFor(`[...document.querySelectorAll('.support-admin .support-status')].some((s) => s.textContent.trim() === 'Решено')`, 8000);
  const done = await evaluate(`(() => ({
    status: document.querySelector('.support-admin .support-status')?.textContent || '',
    done: !!document.querySelector('.support-admin .approval.support-row.done'),
  }))()`);
  done.status === 'Решено' && done.done
    ? ok('«Решено» закрывает обращение и гасит строку')
    : fail('отметка «Решено»', json(done));

  /* 10. Ссылка из уведомления открывает кабинет сразу на обращениях. */
  await goto(BASE + '/?support=admin');
  const deep = await waitFor(`!!document.querySelector('.support-admin')`, 10000);
  const clean = await evaluate(`location.search`);
  deep && clean === ''
    ? ok('ссылка ?support=admin открывает блок обращений и чистит адрес')
    : fail('ссылка из уведомления', json({ deep, clean }));

  /* 11. Телефон: окно целиком в экране, без горизонтальной прокрутки. */
  for (const [width, height] of [[390, 844], [320, 640]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await goto(BASE + '/');
    await waitFor(`!!document.getElementById('supportBtn')`);
    await evaluate(`document.getElementById('supportBtn').click()`);
    const openedMobile = await waitFor(`!!document.querySelector('#modalRoot .modal.support-modal')`, 8000);
    if (!openedMobile) {
      fail(`окно поддержки при ${width}px`, 'не открылось');
      continue;
    }
    await sleep(420);
    await shot(`support-${width}.png`);
    const mobile = await evaluate(`(() => {
      const modal = document.querySelector('#modalRoot .modal.support-modal');
      const rect = modal.getBoundingClientRect();
      const foot = modal.querySelector('.modal-foot');
      const send = [...foot.querySelectorAll('.btn')].find((b) => b.textContent.trim() === 'Отправить');
      const area = modal.querySelector('textarea.support-text');
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        inner: window.innerWidth,
        height: window.innerHeight,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        sendHeight: send ? Math.round(send.getBoundingClientRect().height) : 0,
        sendVisible: send ? send.getBoundingClientRect().bottom <= window.innerHeight + 1 : false,
        font: parseFloat(getComputedStyle(area).fontSize),
      };
    })()`);
    mobile.top >= -1 && mobile.bottom <= height + 1 && mobile.width <= width + 1
      ? ok(`окно поддержки целиком в экране при ${width}px`, `${mobile.width}×${mobile.bottom - mobile.top}`)
      : fail(`окно при ${width}px`, json(mobile));
    mobile.overflow <= 0 ? ok(`нет горизонтальной прокрутки при ${width}px`) : fail(`переполнение ${width}px`, `${mobile.overflow}px`);
    mobile.sendVisible && mobile.sendHeight >= 40
      ? ok(`кнопка «Отправить» видна и удобна при ${width}px`, `${mobile.sendHeight}px`)
      : fail(`кнопка «Отправить» при ${width}px`, json(mobile));
    mobile.font >= 16
      ? ok(`поле не мельче 16 px при ${width}px`, `${mobile.font}px`)
      : fail(`кегль поля при ${width}px`, `${mobile.font}px`);
  }

  /* 12. Уборка: удаляем обращение через кабинет и проверяем, что скриншот ушёл
         вместе с ним. */
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await goto(BASE + '/');
  await evaluate(`document.getElementById('supportBtn').click()`);
  await waitFor(`!!document.querySelector('#modalRoot .support-admin-link')`, 8000);
  await evaluate(`document.querySelector('#modalRoot .support-admin-link').click()`);
  await waitFor(`!!document.querySelector('.support-admin .approval.support-row')`, 10000);
  const shotUrl = await evaluate(`document.querySelector('.support-admin .support-row-shot img')?.src || ''`);
  const removal = await evaluate(`(async () => {
    const button = [...document.querySelectorAll('.support-admin .approval.support-row .btn')].find((b) => b.textContent.trim() === 'Удалить');
    if (!button) return 'no-button';
    button.click();
    await new Promise((r) => setTimeout(r, 500));
    const confirm = document.querySelector('.popover .btn-danger') || [...document.querySelectorAll('.popover .btn')].find((b) => b.textContent.trim() === 'Удалить');
    if (!confirm) return 'no-confirm';
    confirm.click();
    return 'clicked';
  })()`);
  const gone = removal === 'clicked' ? await waitFor(`!document.querySelector('.support-admin .approval.support-row')`, 8000) : false;
  const fileGone = shotUrl
    ? await evaluate(`fetch(${json(shotUrl)}).then((r) => r.status)`)
    : 404;
  gone && fileGone === 404
    ? ok('удаление обращения убирает и скриншот', `скриншот: ${fileGone}`)
    : fail('удаление обращения', json({ removal, gone, fileGone }));
} finally {
  chrome.kill();
  await sleep(400);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);

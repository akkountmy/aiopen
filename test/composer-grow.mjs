// Поле ввода растёт под текст — на компьютере и в узкой раскладке (телефон,
// ярлык-приложение). Проверяем ту самую жалобу: наговорил длинное сообщение в
// микрофон, текст появился, но видно его не полностью и прокрутки нет.
//
// Причина была такая: пока идёт диктовка, .composer.dictating убирает поле из
// раскладки, а распознанный текст вставляется ещё до того, как строка диктовки
// уйдёт с экрана. У скрытого поля clientHeight и scrollHeight нулевые, и
// autoResize записывал "height: 0px" — после возврата высоту держал только CSS
// min-height: одна строка, обрезанный текст, overflow скрыт. Здесь мы
// воспроизводим ровно этот порядок действий руками: скрыть поле классом,
// вставить текст, снять класс.
//
// Запуск (нужен уже работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='DSH'; $env:DSHOW_PASS='...'
//   node test/composer-grow.mjs
import { chromium } from 'playwright';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'DSH';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';

let failed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failed++;
};

const LINE = 'Длинная диктовка проверяет, что поле ввода растёт под текст.';
const few = Array.from({ length: 5 }, () => LINE).join('\n');
const many = Array.from({ length: 30 }, () => LINE).join('\n');

/* Состояние поля в цифрах: высота, сколько просит текст, включена ли прокрутка */
const probe = () => {
  const input = document.querySelector('#input');
  return {
    client: Math.round(input.clientHeight),
    scroll: Math.round(input.scrollHeight),
    inline: input.style.height,
    overflow: getComputedStyle(input).overflowY,
  };
};

/* Тот же предел, что у приложения: до него поле растёт, дальше листается */
const limit = () => {
  if (window.matchMedia('(max-width: 860px)').matches) {
    const visible = Math.round(window.visualViewport?.height || window.innerHeight);
    return Math.max(96, Math.min(200, Math.round(visible * 0.3)));
  }
  return Math.max(180, Math.min(420, Math.round(window.innerHeight * 0.42)));
};

/* Вставка текста так, как её делает распознавание речи: значение появляется
   одним куском, поле в этот момент скрыто классом .dictating. */
const insertWhileHidden = (page, text) =>
  page.evaluate((value) => {
    const composer = document.querySelector('#composer');
    const input = document.querySelector('#input');
    composer.classList.add('dictating');
    const hidden = input.getClientRects().length === 0;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const whileHidden = { hidden, inline: input.style.height };
    /* Ровно то, что делает setDictationBar(false) после распознавания */
    composer.classList.remove('dictating');
    return whileHidden;
  }, text);

const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/* Главное правило: поле выросло ровно под текст, но не выше предела; если текст
   длиннее предела — включилась прокрутка внутри поля, а не обрезка. */
function fitCheck(label, state, empty, max) {
  const expected = Math.min(state.scroll, max);
  const grown = state.client > empty + 1;
  const sized = Math.abs(state.client - expected) <= 2;
  ok(label, grown && sized, `высота ${state.client}px, текст просит ${state.scroll}px, предел ${max}px`);
  if (state.scroll <= max) {
    ok(`${label}: весь текст поместился`, state.scroll <= state.client + 1, `${state.scroll}px против ${state.client}px`);
  } else {
    ok(
      `${label}: длинный текст листается внутри поля`,
      state.overflow === 'auto' && state.scroll > state.client,
      `overflow=${state.overflow}, текст ${state.scroll}px против окна ${state.client}px`,
    );
  }
}

const browser = await chromium.launch({
  /* Виртуальный микрофон: диктовку проверяем настоящим удержанием кнопки, но
     без живого человека у компьютера — звук отдаёт сам браузер. */
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  for (const device of [
    { name: 'компьютер', context: { viewport: { width: 1280, height: 800 } } },
    { name: 'узкая раскладка', context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  ]) {
    const context = await browser.newContext(device.context);
    /* Вход через запрос самого контекста: куки достаются и странице */
    const login = await context.request.post(`${BASE}/api/login`, { data: { username: USER, password: PASS } });
    if (!login.ok()) throw new Error(`вход не удался: ${login.status()}`);
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#input');
    await frames(page);

    const compact = await page.evaluate(() => document.documentElement.classList.contains('compact-input'));
    ok(`${device.name}: раскладка опознана`, compact === (device.name !== 'компьютер'), `compact-input=${compact}`);

    const max = await page.evaluate(limit);
    const empty = await page.evaluate(probe);
    ok(
      `${device.name}: пустое поле — одна строка`,
      empty.client >= 30 && empty.client < 50,
      `высота ${empty.client}px, предел ${max}px`,
    );

    /* Обычный набор: поле обязано вырасти под текст */
    await page.fill('#input', few);
    await frames(page);
    fitCheck(`${device.name}: набор текста растягивает поле`, await page.evaluate(probe), empty.client, max);

    /* Тот же рост, но текст пришёл из диктовки — вставка при скрытом поле */
    await page.fill('#input', '');
    await frames(page);
    const whileHidden = await insertWhileHidden(page, few);
    await frames(page);
    const dictated = await page.evaluate(probe);
    ok(`${device.name}: при диктовке поле действительно скрыто`, whileHidden.hidden, `inline=${whileHidden.inline || '—'}`);
    ok(`${device.name}: скрытое поле не получает высоту 0`, whileHidden.inline !== '0px', `inline=${whileHidden.inline || '—'}`);
    fitCheck(`${device.name}: текст из диктовки виден`, dictated, empty.client, max);

    /* Текст заметно длиннее предела: поле упирается в предел и листается */
    await page.fill('#input', '');
    await frames(page);
    await insertWhileHidden(page, many);
    await frames(page);
    const capped = await page.evaluate(probe);
    ok(
      `${device.name}: очень длинный текст упирается в предел, а не в одну строку`,
      Math.abs(capped.client - max) <= 2,
      `высота ${capped.client}px при пределе ${max}px`,
    );
    ok(
      `${device.name}: у длинного текста есть прокрутка внутри поля`,
      capped.overflow === 'auto' && capped.scroll > capped.client,
      `overflow=${capped.overflow}, текст ${capped.scroll}px против окна ${capped.client}px`,
    );

    await page.fill('#input', '');
    await frames(page);
    const cleared = await page.evaluate(probe);
    ok(`${device.name}: после очистки поле возвращается к строке`, cleared.client === empty.client, `высота ${cleared.client}px`);

    /* Полный круг через настоящий микрофон: держим кнопку, отпускаем, текст
       приходит от распознавания. Микрофон виртуальный (звук даёт сам Chromium),
       а ответ /api/transcribe подменён: проверяем раскладку поля, а не Whisper. */
    const spoken = 'Я наговорил длинное сообщение голосом и хочу видеть его целиком. '.repeat(3).trim();
    await page.route('**/api/transcribe', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: spoken }) }),
    );
    const micBox = await (await page.$('#micBtn')).boundingBox();
    await page.mouse.move(micBox.x + micBox.width / 2, micBox.y + micBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1400);
    await page.mouse.up();
    let dictatedLive = true;
    try {
      await page.waitForFunction(() => document.querySelector('#input').value.length > 0, null, { timeout: 20000 });
    } catch {
      dictatedLive = false;
    }
    await frames(page);
    ok(`${device.name}: распознанный текст дошёл до поля`, dictatedLive);
    if (dictatedLive) {
      fitCheck(`${device.name}: поле после живой диктовки`, await page.evaluate(probe), empty.client, max);
    }
    await page.unroute('**/api/transcribe');

    await context.close();
  }
} finally {
  await browser.close();
}

console.log(failed ? `\nпровалено проверок: ${failed}` : '\nвсе проверки поля ввода пройдены');
process.exit(failed ? 1 : 0);

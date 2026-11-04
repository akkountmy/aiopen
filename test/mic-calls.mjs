// Сколько раз приложение просит микрофон и что говорит, когда в доступе
// отказали. Нужно, чтобы отличить «приложение дёргает браузер» от «браузер не
// запомнил разрешение»: разрешение живёт в браузере и привязано к адресу сайта,
// а приложение просит микрофон ровно один раз на нажатие и ни разу при
// открытии страницы — поэтому выкладки новой версии его не сбрасывают.
//
// Запуск (нужен работающий сервер):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='DSH'; $env:DSHOW_PASS='...'
//   node test/mic-calls.mjs
import { chromium } from 'playwright';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'DSH';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';

let failed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failed++;
};

/* Считаем каждый вызов getUserMedia ещё до загрузки приложения */
const COUNT_CALLS = () => {
  window.__micCalls = 0;
  window.__micConstraints = null;
  const devices = navigator.mediaDevices;
  const original = devices.getUserMedia.bind(devices);
  devices.getUserMedia = (constraints) => {
    window.__micCalls += 1;
    window.__micConstraints = JSON.stringify(constraints);
    return original(constraints);
  };
};

async function openPage(context) {
  const login = await context.request.post(`${BASE}/api/login`, { data: { username: USER, password: PASS } });
  if (!login.ok()) throw new Error(`вход не удался: ${login.status()}`);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#micBtn');
  await page.waitForTimeout(1200);
  return page;
}

/* Держим микрофон столько же, сколько человек при диктовке */
async function holdMic(page, ms = 1200) {
  const box = await (await page.$('#micBtn')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(2000);
}

/* --- Первый случай: разрешение уже выдано, как у человека после «Разрешить» --- */
{
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['microphone'], { origin: BASE });
  await context.addInitScript(COUNT_CALLS);
  const page = await openPage(context);

  const onLoad = await page.evaluate(() => window.__micCalls);
  ok('при открытии страницы микрофон не запрашивается', onLoad === 0, `запросов: ${onLoad}`);

  const state = await page.evaluate(async () => {
    try {
      return (await navigator.permissions.query({ name: 'microphone' })).state;
    } catch (error) {
      return 'нет проверки: ' + error.message;
    }
  });
  ok('состояние разрешения читается приложением', state === 'granted', `состояние: ${state}`);

  await holdMic(page);
  const afterFirst = await page.evaluate(() => window.__micCalls);
  const constraints = await page.evaluate(() => window.__micConstraints);
  ok('одно нажатие — ровно один запрос', afterFirst === 1, `запросов: ${afterFirst}`);
  ok('просим только звук, без камеры', /"audio"/.test(constraints) && !/"video"/.test(constraints), constraints);

  await page.fill('#input', '');
  await holdMic(page);
  const afterSecond = await page.evaluate(() => window.__micCalls);
  ok('второе нажатие — ещё один запрос (не два)', afterSecond === 2, `запросов: ${afterSecond}`);

  await context.close();
  await browser.close();
}

/* --- Второй случай: доступ запрещён. В headless-браузере настоящего окна с
   вопросом нет (он не умеет спрашивать и отвечает NotSupportedError), поэтому
   отказ подставляем сами — тем же исключением, каким его отдаёт браузер после
   «Заблокировать» --- */
{
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    const devices = navigator.mediaDevices;
    devices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  const page = await openPage(context);

  await holdMic(page, 600);
  const message = await page.evaluate(() => document.querySelector('#toastRoot .toast')?.textContent || '');
  ok('при запрете объясняем, где включить микрофон', /замка/.test(message), message || 'плашки нет');

  const stuck = await page.evaluate(() => {
    const bar = document.querySelector('#dictationBar');
    const mic = document.querySelector('#micBtn');
    return {
      barShown: bar ? getComputedStyle(bar).display !== 'none' : false,
      micActive: mic.classList.contains('active'),
      dictating: document.querySelector('#composer').classList.contains('dictating'),
    };
  });
  ok(
    'после запрета запись не остаётся висеть',
    !stuck.barShown && !stuck.micActive && !stuck.dictating,
    JSON.stringify(stuck),
  );

  await context.close();
  await browser.close();
}

console.log(failed ? `\nпровалено проверок: ${failed}` : '\nпроверки запросов микрофона пройдены');
process.exit(failed ? 1 : 0);

// Проверка кнопки вложения на телефоне: «＋» открывает то же меню, что в
// бесплатном приложении DeepSeek — снять фото камерой, выбрать фото из галереи
// или файл. На компьютере скрепка, как и раньше, сразу открывает выбор файлов.
//
// Запуск (нужен уже работающий сервер с админом из DSHOW_ADMIN_PASSWORD):
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='DSH'; $env:DSHOW_PASS='...'
//   node test/ui-attach.mjs
import { chromium } from 'playwright';

const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const USER = process.env.DSHOW_USER || 'DSH';
const PASS = process.env.DSHOW_PASS || 'Test-pass-2026';

let failed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failed++;
};

const browser = await chromium.launch();
try {
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const login = await phone.request.post(`${BASE}/api/login`, { data: { username: USER, password: PASS } });
  if (!login.ok()) throw new Error(`вход не удался: ${login.status()}`);
  const page = await phone.newPage();
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#attachBtn');
  ok('на телефоне кнопка вложения есть', await page.isVisible('#attachBtn'));

  await page.click('#attachBtn');
  await page.waitForSelector('.attach-menu', { timeout: 5000 });
  const labels = await page.$$eval('.attach-menu-item .attach-menu-label', (nodes) => nodes.map((n) => n.textContent.trim()));
  ok('меню предлагает три способа', labels.join(' / ') === 'Сфотографировать / Фото из галереи / Файл', labels.join(' / '));

  /* Камера: Chrome в headless не фотографирует, но обязан показать выбор и
     пометить себя как съёмку — иначе iPhone откроет галерею вместо камеры. */
  const cameraChooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('.attach-menu-item:has-text("Сфотографировать")');
  const camera = await cameraChooser;
  const cameraInput = await camera.element().evaluate((input) => ({
    accept: input.getAttribute('accept') || '',
    capture: input.getAttribute('capture') || '',
    multiple: input.multiple,
  }));
  ok('«Сфотографировать» включает камеру', cameraInput.accept === 'image/*' && cameraInput.capture === 'environment',
    JSON.stringify(cameraInput));

  await page.waitForSelector('.attach-menu', { state: 'hidden' }).catch(() => {});
  await page.click('#attachBtn');
  await page.waitForSelector('.attach-menu', { timeout: 5000 });
  const fileChooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('.attach-menu-item:has-text("Файл")');
  const files = await fileChooser;
  const fileInput = await files.element().evaluate((input) => ({
    accept: input.getAttribute('accept') || '',
    capture: input.hasAttribute('capture'),
    multiple: input.multiple,
  }));
  ok('«Файл» разрешает любые файлы и несколько сразу', fileInput.accept === '' && !fileInput.capture && fileInput.multiple,
    JSON.stringify(fileInput));
  await phone.close();

  /* Компьютер: то же нажатие сразу открывает выбор файлов, без меню. */
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const deskLogin = await desktop.request.post(`${BASE}/api/login`, { data: { username: USER, password: PASS } });
  if (!deskLogin.ok()) throw new Error(`вход на компьютере не удался: ${deskLogin.status()}`);
  const deskPage = await desktop.newPage();
  await deskPage.goto(BASE, { waitUntil: 'load' });
  await deskPage.waitForSelector('#attachBtn');
  const deskChooser = deskPage.waitForEvent('filechooser', { timeout: 5000 });
  await deskPage.click('#attachBtn');
  await deskChooser;
  ok('на компьютере скрепка сразу открывает выбор файлов', true);
  ok('на компьютере меню не появляется', !(await deskPage.isVisible('.attach-menu')));
  await desktop.close();
} finally {
  await browser.close();
}

console.log(failed ? `Провалов: ${failed}` : 'ВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);

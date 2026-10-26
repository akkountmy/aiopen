// Проверка прикрепления файлов в композере: «Сфотографировать», «Фото из
// галереи» и «Файл» — три отдельные кнопки в нижнем ряду, там же, где
// орфография и кнопка действия (на телефоне это одна кнопка: микрофон, пока
// поле пустое, и отправка, как только появился текст). Меню «＋» больше нет,
// каждая кнопка сразу открывает свой выбор файла.
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

const describe = (input) => ({
  accept: input.getAttribute('accept') || '',
  capture: input.getAttribute('capture') || '',
  multiple: input.multiple,
});

/* Параметры выбора читаем в самой странице: у <input type=file> они живут в
   атрибутах, а не в объекте, который вернёт выбор файла. */
const readInput = async (chooser) => (await (await chooser).element()).evaluate(describe);

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
  await page.waitForSelector('#fileBtn');
  ok('на телефоне три кнопки прикрепления есть',
    (await page.isVisible('#photoBtn')) && (await page.isVisible('#galleryBtn')) && (await page.isVisible('#fileBtn')));
  ok('кнопки «＋» больше нет', (await page.locator('#attachBtn').count()) === 0);

  /* Видимые кнопки ряда: прикрепление, орфография и действие. Отправка в этом
     состоянии скрыта — её место занимает микрофон, поэтому её верх сравнивать
     не с чем (скрытый элемент отдаёт нулевой прямоугольник). */
  const row = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const shown = (id) => document.getElementById(id).getBoundingClientRect().width > 0;
    return {
      tops: ['photoBtn', 'galleryBtn', 'fileBtn', 'spellBtn', 'micBtn'].filter(shown).map((id) => Math.round(box(id).top)),
      micVisible: shown('micBtn'),
      sendVisible: shown('sendBtn'),
    };
  });
  ok('все три кнопки в одном ряду с орфографией и кнопкой действия',
    row.tops.length === 5 && Math.max(...row.tops) - Math.min(...row.tops) < 2, row.tops.join(' / '));
  ok('пустое поле: в ряду микрофон, а отправка уступает ему место',
    row.micVisible && !row.sendVisible, JSON.stringify(row));

  /* Камера: Chrome в headless не фотографирует, но обязан показать выбор и
     пометить себя как съёмку — иначе iPhone откроет галерею вместо камеры. */
  const cameraChooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('#photoBtn');
  const cameraInput = await readInput(cameraChooser);
  ok('«Сфотографировать» зовёт камеру на фото',
    cameraInput.accept === 'image/*' && cameraInput.capture === 'environment' && !cameraInput.multiple,
    JSON.stringify(cameraInput));

  const galleryChooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('#galleryBtn');
  const galleryInput = await readInput(galleryChooser);
  ok('«Фото из галереи» берёт только снимки и без камеры',
    galleryInput.accept === 'image/*' && !galleryInput.capture, JSON.stringify(galleryInput));

  const fileChooser = page.waitForEvent('filechooser', { timeout: 5000 });
  await page.click('#fileBtn');
  const fileInput = await readInput(fileChooser);
  ok('«Файл» разрешает любые файлы и несколько сразу',
    fileInput.accept === '' && !fileInput.capture && fileInput.multiple, JSON.stringify(fileInput));

  ok('никакого меню на экране не появляется', !(await page.isVisible('.attach-menu')));

  /* С текстом в поле та же правая кнопка становится отправкой, и ряд не
     разъезжается: микрофон уходит, отправка встаёт ровно на его место. */
  const micSlot = await page.evaluate(() => {
    const rect = document.getElementById('micBtn').getBoundingClientRect();
    return { right: Math.round(rect.right), top: Math.round(rect.top) };
  });
  await page.fill('#input', 'Проверка кнопки');
  const typed = await page.evaluate(() => {
    const rect = (id) => document.getElementById(id).getBoundingClientRect();
    const send = rect('sendBtn');
    return {
      sendVisible: send.width > 0,
      micVisible: rect('micBtn').width > 0,
      sameRow: Math.abs(send.top - rect('photoBtn').top) < 2,
      right: Math.round(send.right),
      top: Math.round(send.top),
    };
  });
  ok('появился текст: отправка встала в тот же ряд на место микрофона',
    typed.sendVisible && !typed.micVisible && typed.sameRow && typed.right === micSlot.right && typed.top === micSlot.top,
    `${JSON.stringify(micSlot)} → ${JSON.stringify(typed)}`);
  await page.fill('#input', '');
  await phone.close();

  /* Компьютер: те же три кнопки, без камеры — она нужна только телефону, но
     нажатие всё равно открывает выбор файлов с подходящим accept. */
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const deskLogin = await desktop.request.post(`${BASE}/api/login`, { data: { username: USER, password: PASS } });
  if (!deskLogin.ok()) throw new Error(`вход на компьютере не удался: ${deskLogin.status()}`);
  const deskPage = await desktop.newPage();
  await deskPage.goto(BASE, { waitUntil: 'load' });
  await deskPage.waitForSelector('#fileBtn');
  ok('на компьютере три кнопки прикрепления тоже на месте',
    (await deskPage.isVisible('#photoBtn')) && (await deskPage.isVisible('#galleryBtn')) && (await deskPage.isVisible('#fileBtn')));
  ok('кнопка «Рассуждения» на компьютере скрыта', !(await deskPage.isVisible('#thinkToggle')));
  const deskChooser = deskPage.waitForEvent('filechooser', { timeout: 5000 });
  await deskPage.click('#fileBtn');
  const deskInput = await readInput(deskChooser);
  ok('на компьютере «Файл» сразу открывает выбор файлов',
    deskInput.accept === '' && deskInput.multiple, JSON.stringify(deskInput));
  ok('на компьютере меню не появляется', !(await deskPage.isVisible('.attach-menu')));
  await desktop.close();
} finally {
  await browser.close();
}

console.log(failed ? `Провалов: ${failed}` : 'ВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);

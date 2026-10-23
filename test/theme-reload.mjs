// Смена темы в приложении-ярлыке не должна переключать диалог.
// Сервер уже должен работать. Запуск:
//   $env:DSHOW_BASE='http://127.0.0.1:3131'; $env:DSHOW_USER='...'; $env:DSHOW_PASS='...'
//   node test/theme-reload.mjs
import { chromium } from 'playwright';

const base = process.env.DSHOW_BASE || 'http://127.0.0.1:3131';
const user = process.env.DSHOW_USER || 'DSH';
const pass = process.env.DSHOW_PASS || 'Test-pass-2026';

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
});
const login = await context.request.post(base + '/api/login', { data: { username: user, password: pass } });
if (!login.ok()) throw new Error('вход не удался: ' + login.status());

const page = await context.newPage();
let failed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failed++;
};
const waitApp = () =>
  page.waitForFunction(() => document.getElementById('app') && !document.getElementById('app').classList.contains('hidden'), null, {
    timeout: 20000,
  });
const snapshot = () =>
  page.evaluate(() => ({
    crumb: document.querySelector('#crumbChat')?.textContent || '',
    activeRow: document.querySelector('.chat-row.active')?.textContent?.trim() || '',
    last: localStorage.getItem('dshow.lastChat') || '',
    theme: document.documentElement.dataset.theme,
    url: location.href,
    draft: document.querySelector('#input')?.value || '',
  }));

// Ответ не нужен: проверяем только то, что диалог переживает перезагрузку.
await page.route('**/api/chats/*/messages', (route) =>
  route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'проверка' }) }),
);

try {
  await page.goto(base + '/');
  const ids = await page.evaluate(async () => {
    const project = (
      await (
        await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Проверка темы ' + Date.now() }),
        })
      ).json()
    ).project;
    const oldChat = (
      await (
        await fetch('/api/projects/' + project.id + '/chats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Старый диалог' }),
        })
      ).json()
    ).chat;
    return { projectId: project.id, oldChatId: oldChat.id };
  });

  // Старый диалог становится «последним», затем человек начинает новый с пустого экрана.
  await page.goto(base + '/?chat=' + encodeURIComponent(ids.oldChatId));
  await waitApp();
  await page.waitForFunction(() => document.querySelector('#crumbChat')?.textContent === 'Старый диалог');
  await page.goto(base + '/');
  await waitApp();
  await page.waitForSelector('#input');
  await page.fill('#input', 'Привет');
  await page.click('#sendBtn');
  await page.waitForFunction((oldId) => localStorage.getItem('dshow.lastChat') !== oldId, ids.oldChatId, { timeout: 10000 });
  await page.waitForTimeout(300);

  const before = await snapshot();
  ok('перед сменой темы открыт новый диалог', before.crumb === 'Новый диалог' && before.activeRow === 'Новый диалог', JSON.stringify(before));

  // В приложении-ярлыке смена темы меняет режим полосы и перезагружает страницу.
  await page.evaluate(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query) =>
      String(query).includes('display-mode: standalone')
        ? { matches: true, media: query, addEventListener() {}, removeEventListener() {} }
        : real(query);
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
  });
  await page.locator('#themeToggle').click();
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await waitApp();
  await page.waitForTimeout(600);

  const light = await snapshot();
  ok('тема переключилась на светлую', light.theme === 'light', light.theme);
  ok('после перезагрузки остался тот же диалог', light.crumb === before.crumb && light.last === before.last, JSON.stringify(light));
  ok('метка перезагрузки снята из адреса', !light.url.includes('themeReload'), light.url);

  // Обратное переключение и черновик: он тоже не должен потеряться.
  await page.fill('#input', 'Черновик');
  await page.locator('#themeToggle').click();
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await waitApp();
  await page.waitForTimeout(600);
  const dark = await snapshot();
  ok('тема вернулась на тёмную', dark.theme === 'dark', dark.theme);
  ok('обратное переключение не сменило диалог', dark.crumb === before.crumb && dark.last === before.last, JSON.stringify(dark));
  ok('черновик пережил переключение', dark.draft === 'Черновик', dark.draft);

  // Новый запуск ярлыка по-прежнему должен открывать стартовый экран, а не
  // возвращать последний диалог: перезагрузку из-за темы мы отличаем явно.
  await page.goto(base + '/');
  await waitApp();
  await page.waitForTimeout(300);
  const fresh = await snapshot();
  ok('новый запуск ярлыка — снова стартовый экран', !fresh.crumb && !fresh.activeRow, JSON.stringify(fresh));
} finally {
  await browser.close();
}

console.log(failed ? `ПРОВАЛОВ: ${failed}` : 'ВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);

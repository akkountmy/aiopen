// Живая проверка без входа: экран входа тоже показывает полосу состояния и
// умеет переключать тему. Запуск: node test/status-bar-live.mjs <base>.
import { chromium } from 'playwright';

const base = process.argv[2];
if (!base) throw new Error('укажите адрес сайта');
const expected = { light: '#ffffff', dark: '#151517' };
const rgb = (hex) => 'rgb(' + [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ') + ')';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
});
const page = await ctx.newPage();
let failed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failed++;
};

const snap = () => page.evaluate(() => {
  const s = (el) => (el ? getComputedStyle(el) : {});
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, w: b.width, h: b.height }; };
  const tint = document.querySelector('.status-tint');
  const meta = document.querySelector('meta[name="theme-color"]');
  const apple = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden';
  document.body.appendChild(probe);
  const safe = probe.getBoundingClientRect().height;
  probe.remove();
  return {
    theme: document.documentElement.dataset.theme,
    meta: meta && meta.content,
    apple: apple && apple.content,
    safe,
    tint: { box: tint && r(tint), bg: tint && s(tint).backgroundColor },
    htmlBg: s(document.documentElement).backgroundColor,
    bodyBg: s(document.body).backgroundColor,
    loaded: [...document.scripts].map((x) => x.src),
  };
});

await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('#auth:not(.hidden)', { timeout: 30000 });
await page.waitForTimeout(500);

for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => localStorage.setItem('dshow-theme', t), theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#auth:not(.hidden)');
  await page.waitForTimeout(250);
  const x = await snap();
  ok(`прод ${theme}: тема`, x.theme === theme, x.theme);
  ok(`прод ${theme}: theme-color`, x.meta === expected[theme], x.meta);
  ok(`прод ${theme}: полоса ровно вырез`, x.tint.box && x.tint.box.h === x.safe, `${JSON.stringify(x.tint.box)} при вырезе ${x.safe}`);
  ok(`прод ${theme}: полоса цвета темы`, x.tint.bg === rgb(expected[theme]), x.tint.bg);
  ok(`прод ${theme}: фон html`, x.htmlBg === rgb(expected[theme]), x.htmlBg);
  ok(`прод ${theme}: фон body`, x.bodyBg === rgb(expected[theme]), x.bodyBg);
  ok(`прод ${theme}: полоса не прозрачная`, x.apple === 'default', String(x.apple));
  await page.screenshot({ path: `D:/DSHarness/telegram/tmp/live-statusbar-${theme}.png`, clip: { x: 0, y: 0, width: 390, height: 170 } });
}

// Клик по кнопке темы: без перезагрузки, цвет должен смениться сразу.
const before = await page.evaluate(() => document.documentElement.dataset.theme);
await page.click('#authThemeToggle');
await page.waitForTimeout(40);
const after = await snap();
const target = before === 'dark' ? 'light' : 'dark';
ok('прод: клик сразу меняет тему', after.theme === target, after.theme);
ok('прод: клик сразу меняет theme-color', after.meta === expected[target], after.meta);
ok('прод: клик сразу меняет полоску', after.tint.bg === rgb(expected[target]), after.tint.bg);
ok('прод: клик сразу меняет фон body', after.bodyBg === rgb(expected[target]), after.bodyBg);

await browser.close();
console.log(failed ? `ПРОВАЛОВ: ${failed}` : 'ВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);

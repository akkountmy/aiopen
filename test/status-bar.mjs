// Проверка верхней полосы телефона: цвет темы должен быть у того самого
// непрозрачного fixed-слоя, который iOS 26 берёт для полосы состояния, и у
// theme-color для приложения-ярлыка. Запуск: node test/status-bar.mjs [base].
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://127.0.0.1:3131';
const expected = { light: '#ffffff', dark: '#151517' };
const rgb = (hex) => 'rgb(' + [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ') + ')';
const browser = await chromium.launch();
let failed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) failed++;
};

async function snapshot(page) {
  return page.evaluate(() => {
    const css = (el) => (el ? getComputedStyle(el) : null);
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top };
    };
    const tint = document.querySelector('.status-tint');
    const app = document.getElementById('app');
    const topbar = document.querySelector('.topbar');
    // Вырез, на который уже отступило содержимое: высота полоски должна быть
    // ровно такой, иначе она накрывает шапку и срезает верх плашек.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden';
    document.body.appendChild(probe);
    const safe = probe.getBoundingClientRect().height;
    probe.remove();
    const meta = document.querySelector('meta[name="theme-color"]');
    const apple = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    // Кандидаты по условиям WebKit 301756/325446: fixed/sticky у верхнего края,
    // ширина >= 80 %, высота >= 11 px, непрозрачный background-color.
    const candidates = [];
    for (const el of document.querySelectorAll('*')) {
      const s = css(el);
      if (!s || !['fixed', 'sticky'].includes(s.position)) continue;
      const r = el.getBoundingClientRect();
      if (r.top > 4 || r.height < 11 || r.width < innerWidth * 0.8) continue;
      const bg = s.backgroundColor;
      const m = bg.match(/rgba?\(([^)]+)\)/);
      const a = m ? (m[1].split(',').length === 4 ? Number(m[1].split(',')[3]) : 1) : 0;
      if (a < 0.99) continue;
      candidates.push({ cls: el.className || el.tagName, bg, top: r.top, w: r.width, h: r.height });
    }
    return {
      theme: document.documentElement.dataset.theme,
      meta: meta ? meta.content : null,
      apple: apple ? apple.content : null,
      tint: { rect: rect(tint), bg: tint ? css(tint).backgroundColor : null, z: tint ? css(tint).zIndex : null, safe },
      app: { rect: rect(app), bg: app ? css(app).backgroundColor : null, position: app ? css(app).position : null },
      topbar: { rect: rect(topbar), bg: topbar ? css(topbar).backgroundColor : null },
      htmlBg: css(document.documentElement).backgroundColor,
      bodyBg: css(document.body).backgroundColor,
      vw: innerWidth,
      scrollW: document.documentElement.scrollWidth,
      candidates,
    };
  });
}

async function run(width, height, label, standalone = false) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: width <= 860,
    hasTouch: width <= 1100,
    // Headless Chromium падает на второй навигации, когда работает service
    // worker (на живом сайте тоже). Для проверки вёрстки он не нужен.
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const login = await ctx.request.post(base + '/api/login', { data: { username: 'DSH', password: 'Test-pass-2026' } });
  if (!login.ok()) throw new Error(`login ${login.status()}`);
  await page.goto(base);
  await page.evaluate(() => localStorage.setItem('dshow-theme', 'light'));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('app') && !document.getElementById('app').classList.contains('hidden'));
  await page.waitForTimeout(300);

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => localStorage.setItem('dshow-theme', t), theme);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app') && !document.getElementById('app').classList.contains('hidden'));
    await page.waitForTimeout(200);
    const s = await snapshot(page);
    const color = expected[theme];
    ok(`${label} ${theme}: тема`, s.theme === theme, s.theme);
    ok(`${label} ${theme}: theme-color`, s.meta === color, s.meta);
    if (width <= 1100) {
      ok(`${label} ${theme}: полоска ровно вырез`, s.tint.rect && s.tint.rect.h === s.tint.safe, `${JSON.stringify(s.tint.rect)} при вырезе ${s.tint.safe}`);
      ok(`${label} ${theme}: полоска цвета темы`, s.tint.bg === rgb(color), s.tint.bg);
      ok(`${label} ${theme}: полоска на верху`, s.tint.rect && s.tint.rect.top === 0, String(s.tint.rect && s.tint.rect.top));
    }
    ok(`${label} ${theme}: фон html`, s.htmlBg === rgb(color), s.htmlBg);
    ok(`${label} ${theme}: фон окна`, s.app.bg === rgb(color), s.app.bg);
    if (width <= 1100) {
      // Цвет полосы состояния системе отдают непрозрачные слои у верхнего края.
      // Полоска под вырез — только один из них; при нулевом вырезе её нет, и
      // тогда обязаны быть непрозрачными html, body, .app и шапка.
      const hit = s.candidates.find((c) => c.bg === rgb(color) && c.h >= 12);
      const plates = [s.app.bg, s.topbar.bg, s.htmlBg, s.bodyBg];
      const opaque = plates.every((bg) => bg === rgb(color));
      ok(`${label} ${theme}: система найдёт цвет полосы`, s.tint.safe > 0 ? !!hit : opaque,
        `${s.tint.safe > 0 ? (hit ? hit.cls + ' ' + hit.w + '×' + hit.h : JSON.stringify(s.candidates)) : plates.join(' / ')}`);
    }
    ok(`${label} ${theme}: нет горизонтальной прокрутки`, s.scrollW <= s.vw, `${s.scrollW}/${s.vw}`);
    if (width <= 860) {
      ok(`${label} ${theme}: шапка 56 px`, Math.round(s.topbar.rect.h) === 56, String(s.topbar.rect.h));
      ok(`${label} ${theme}: полоса не прозрачная`, s.apple === 'default', String(s.apple));
    }
    await page.screenshot({ path: `D:/DSHarness/telegram/tmp/statusbar-${label}-${theme}.png`, clip: { x: 0, y: 0, width, height: Math.min(140, height) } });
  }

  if (width === 390) {
    // Переключение кнопкой, без перезагрузки: цвет должен смениться сразу.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.theme-toggle')].find((el) => el.offsetParent !== null);
      btn.click();
    });
    await page.waitForTimeout(40);
    const s = await snapshot(page);
    ok(`${label}: клик сразу меняет тему`, s.theme === 'light', s.theme);
    ok(`${label}: клик сразу меняет theme-color`, s.meta === expected.light, s.meta);
    ok(`${label}: клик сразу меняет полоску`, s.tint.bg === rgb(expected.light), s.tint.bg);
    ok(`${label}: клик сразу меняет фон окна`, s.app.bg === rgb(expected.light), s.app.bg);
  }

  if (width <= 1100) {
    await page.evaluate(() => localStorage.setItem('dshow-theme', 'light'));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app') && !document.getElementById('app').classList.contains('hidden'));
    await page.evaluate(() => document.getElementById('app').classList.add('files-open'));
    await page.waitForTimeout(350);
    const s = await snapshot(page);
    ok(`${label}: полоска при открытых файлах`, s.tint.bg === rgb(expected.light), s.tint.bg);
    ok(`${label}: шапка при открытых файлах`, s.topbar.bg === rgb(expected.light), s.topbar.bg);
    await page.evaluate(() => document.getElementById('app').classList.remove('files-open'));
  }
  await ctx.close();
}

await run(390, 844, 'phone');
await run(834, 1112, 'tablet');
await run(1440, 900, 'desktop');
await browser.close();
console.log(failed ? `ПРОВАЛОВ: ${failed}` : 'ВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);


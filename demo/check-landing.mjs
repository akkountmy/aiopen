/* Проверка лендинга «Шпатлёвка стен под покраску»: статические факты,
   живой браузер на 390/768/1440 px, снимки, счёт слов и чисел, контраст,
   поведение калькулятора и формы. Запуск: node demo/check-landing.mjs       */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { staticPageChecks, staticIssueCount } from '../src/pagecheck.mjs';
import { browserAvailable, checkPage, describePage } from '../src/browser.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:'));
const root = path.resolve(here, '..');
const file = path.join(root, 'demo', 'landing-spatlevka.html');
const html = fs.readFileSync(file, 'utf8');

/* --- счёт содержания: без кода, стилей и служебной разметки --- */
const visible = html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z]+;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const words = visible.match(/[А-Яа-яЁёA-Za-z]{2,}/g) || [];
const numbers = visible.match(/\d[\d\s.,]*/g) || [];
const sections = (html.match(/<section\b/g) || []).length;
const details = (html.match(/<details\b/g) || []).length;

/* --- JSON-LD: должен быть валидным JSON --- */
const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const ldTypes = [];
let faqJson = 0;
for (const block of ldBlocks) {
  try {
    const data = JSON.parse(block);
    const nodes = data['@graph'] || [data];
    for (const node of nodes) {
      ldTypes.push(node['@type']);
      if (node['@type'] === 'FAQPage') faqJson = (node.mainEntity || []).length;
    }
  } catch (error) {
    ldTypes.push('ОШИБКА JSON: ' + error.message);
  }
}

/* --- контраст: пары «текст на фоне» из палитры страницы --- */
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const x = lum(a);
  const y = lum(b);
  return +(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2));
};
const pairs = [
  ['основной текст', '#14171C', '#F7F5F1'],
  ['вторичный текст', '#575E68', '#F7F5F1'],
  ['вторичный на карточке', '#575E68', '#FFFFFF'],
  ['акцентный текст', '#B04A18', '#F7F5F1'],
  ['акцент на плашке', '#B04A18', '#FBEEE4'],
  ['кнопка', '#FFFFFF', '#B04A18'],
  ['кнопка при наведении', '#FFFFFF', '#8A3A12'],
  ['тёмный блок: текст', '#F7F5F1', '#14171C'],
  ['ошибка поля', '#9B2C1B', '#FFFFFF'],
  ['успех формы', '#157F5B', '#FFFFFF']
].map(([name, fg, bg]) => ({ name, fg, bg, ratio: ratio(fg, bg), ok: ratio(fg, bg) >= 4.5 }));

const facts = staticPageChecks(html, { root, file });
console.log('=== СТАТИЧЕСКИЕ ФАКТЫ ===');
console.log('знаков в файле:', html.length, '| байт:', fs.statSync(file).size);
console.log('слов смыслового текста:', words.length, '| чисел:', numbers.length);
console.log('секций <section>:', sections, '| вопросов <details>:', details, '| вопросов в JSON-LD:', faqJson);
console.log('проблем по коду:', staticIssueCount(facts));
console.log('h1:', facts.h1);
console.log('картинок:', facts.images.total, 'без alt:', facts.images.withoutAlt, '| внешних запросов:', facts.externalCount);
console.log('JSON-LD:', ldTypes.join(' + '));
console.log('контраст:');
for (const p of pairs) console.log(`  ${p.ok ? 'ok  ' : 'FAIL'} ${p.ratio}:1 — ${p.name} (${p.fg} на ${p.bg})`);
const worst = pairs.filter((p) => p.ok).map((p) => p.ratio).sort((a, b) => a - b)[0];
console.log('  минимальный по странице:', worst + ':1', '| пар ниже 4,5:1:', pairs.filter((p) => !p.ok).length);

if (!(await browserAvailable())) {
  console.log('\n=== БРАУЗЕР НЕ НАЙДЕН: живая проверка не выполнена ===');
  process.exit(0);
}

const result = await checkPage(file, {
  root,
  widths: [390, 768, 1440],
  screenshot: 'demo/screenshots/landing.png',
  fullPage: false,
  waitMs: 300
});

console.log('\n=== ЖИВАЯ ПРОВЕРКА (' + result.mode + (result.engine ? ', ' + result.engine : '') + ') ===');
for (const v of result.variants) {
  console.log(`\n${v.width} px: содержимое ${v.scrollWidth} px, окно ${v.clientWidth} px — ${v.overflow ? 'ПРОКРУТКА' : 'прокрутки нет'}`);
  console.log('  h1:', v.h1.slice(0, 80));
  console.log('  элементов шире экрана:', v.wide.length ? v.wide.join('; ') : 0);
  console.log('  ошибок консоли:', v.consoleErrors.length, v.consoleErrors.join(' | '));
  console.log('  ошибок загрузки:', v.resourceErrors.length, '| битых запросов:', v.broken.length);
  console.log('  картинок:', v.images, '| без alt:', v.imagesWithoutAlt.length, '| внешних запросов:', v.external.length);
  console.log('  видимого текста, знаков:', v.chars, '| снимок:', v.screenshot);
}

/* check_page добавляет ширину к имени файла после расширения — переименовываем
   в читаемый вид landing-390.png и убираем прежний файл. */
for (const v of result.variants) {
  const from = path.join(root, v.screenshot);
  const to = from.replace(/\.png-(\d+)\.png$/, '-$1.png');
  if (from !== to && fs.existsSync(from)) {
    fs.renameSync(from, to);
    console.log('снимок сохранён:', path.relative(root, to).replace(/\\/g, '/'));
  }
}
console.log('\n' + describePage(result).split('\n').filter((line) => /^(Проверки| ok|!!| --)/.test(line)).join('\n'));

/* --- типографика и механика страницы в живом браузере --- */
const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const jsErrors = [];
page.on('pageerror', (error) => jsErrors.push(String(error.message).slice(0, 200)));
await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
await page.waitForTimeout(200);

const sizes = {};
for (const width of [390, 768, 1440]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(80);
  sizes[width] = await page.evaluate(() => {
    const px = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return `${Math.round(parseFloat(s.fontSize))}/${Math.round(parseFloat(s.lineHeight))}`;
    };
    const small = [...document.querySelectorAll('a, button, summary, input, select')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 40;
    });
    return {
      h1: px('h1'),
      lead: px('.hero__lead') || px('.lead'),
      body: px('body'),
      small: px('.card__meta') || px('.kicker'),
      docWidth: document.documentElement.scrollWidth,
      window: document.documentElement.clientWidth,
      under40: small.length,
      under40names: small.slice(0, 8).map((el) => {
        const name = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '');
        return `${name} ${Math.round(el.getBoundingClientRect().height)}px`;
      })
    };
  });
}
console.log('\n=== ТИПОГРАФИКА И ТАП-ЗОНЫ (шрифт/межстрочный, px) ===');
for (const [width, s] of Object.entries(sizes)) {
  console.log(`  ${width} px: h1 ${s.h1}, лид ${s.lead}, текст ${s.body}, сноска ${s.small}; кликабельных ниже 40 px: ${s.under40}${s.under40names.length ? ' (' + s.under40names.join(', ') + ')' : ''}`);
}

/* --- калькулятор --- */
await page.setViewportSize({ width: 1440, height: 900 });
const sum0 = (await page.textContent('#calc-sum')).trim();
await page.selectOption('#calc-type', 'paint');
await page.fill('#calc-area', '120');
await page.click('#calc-go');
await page.waitForTimeout(80);
const sum1 = (await page.textContent('#calc-sum')).trim();
const calcRows = await page.$$eval('#calc-rows .calc__row', (rows) => rows.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
const calcNote = (await page.textContent('#calc-note')).trim();

/* --- форма: пустая отправка, ошибка согласия, успешная отправка --- */
await page.click('#lead-form button[type=submit]');
await page.waitForTimeout(80);
const statusEmpty = (await page.textContent('#form-status')).trim();
const badFields = await page.$$eval('[aria-invalid="true"]', (els) => els.map((el) => el.id));

await page.fill('#f-name', 'Иван');
await page.fill('#f-phone', '+7 999 123-45-67');
await page.uncheck('#f-consent');
await page.click('#lead-form button[type=submit]');
await page.waitForTimeout(80);
const statusConsent = (await page.textContent('#form-status')).trim();
const consentErr = (await page.textContent('#err-f-consent')).trim();

await page.check('#f-consent');
await page.click('#lead-form button[type=submit]');
await page.waitForTimeout(120);
const statusOk = (await page.textContent('#form-status')).trim();
const statusState = await page.getAttribute('#form-status', 'data-state');

/* --- клавиатура: первый Tab должен вести на ссылку «к содержанию» --- */
await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
await page.keyboard.press('Tab');
const firstFocus = await page.evaluate(() => {
  const el = document.activeElement;
  return { tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 40), outline: getComputedStyle(el).outlineStyle };
});

await browser.close();

console.log('\n=== КАЛЬКУЛЯТОР ===');
console.log('  при загрузке:', sum0);
console.log('  площадь 120 м², «под покраску свет»:', sum1);
console.log('  строк в расшифровке:', calcRows.length, '→', calcRows.join(' | '));
console.log('  примечание:', calcNote);

console.log('\n=== ФОРМА ===');
console.log('  пустая отправка →', statusEmpty, '| поля с aria-invalid:', badFields.join(', ') || '—');
console.log('  без согласия →', consentErr || statusConsent);
console.log('  корректная отправка →', statusOk, '| data-state:', statusState);

console.log('\n=== КЛАВИАТУРА ===');
console.log('  первый Tab:', firstFocus.text || '(без текста)', '| тег:', firstFocus.tag, '| outline:', firstFocus.outline);
console.log('  ошибок JS за весь прогон:', jsErrors.length, jsErrors.join(' | '));

/**
 * Навык magic-ui: страница, собранная по инструкции, должна работать.
 *
 * Инструкция отдаёт модели CSS и один script — значит проверять надо их, а не
 * текст вокруг. Тест вынимает из SKILL.md все css-блоки и html-блоки (разметка
 * компонентов + скрипт оживления), склеивает из них страницу и гоняет её в
 * jsdom: метеоры создаются, число докручивается, пятно света следует за
 * курсором, классы из разметки описаны в CSS.
 *
 * Запуск: node test/skill-magic-ui.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const skillPath = path.join(process.cwd(), 'skills', 'magic-ui', 'SKILL.md');
const markdown = fs.readFileSync(skillPath, 'utf8');

function fences(lang) {
  const out = [];
  const re = new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g');
  let match;
  while ((match = re.exec(markdown))) out.push(match[1]);
  return out;
}

const cssBlocks = fences('css');
const htmlBlocks = fences('html');
const script = htmlBlocks.find((block) => block.includes('<script>'));
const markup = htmlBlocks.filter((block) => !block.includes('<script>')).join('\n');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('инструкция содержит css, разметку и скрипт оживления', () => {
  assert.ok(cssBlocks.length >= 6, `css-блоков ${cssBlocks.length}`);
  assert.ok(markup.includes('mui-marquee'), 'нет разметки бегущей строки');
  assert.ok(markup.includes('mui-beam'), 'нет разметки луча');
  assert.ok(markup.includes('mui-meteors'), 'нет разметки метеоров');
  assert.ok(markup.includes('mui-ticker'), 'нет разметки числа');
  assert.ok(markup.includes('mui-card'), 'нет разметки карточки');
  assert.ok(script, 'нет скрипта оживления');
});

test('css: скобки сходятся и все классы из разметки описаны', () => {
  const css = cssBlocks.join('\n');
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length, 'несбалансированные скобки в CSS');
  const used = new Set();
  for (const match of markup.matchAll(/class="([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name.startsWith('mui-')) used.add(name);
  }
  for (const name of used) {
    /* Модификаторы (--fade, --pause) описаны отдельными правилами. */
    assert.ok(css.includes(`.${name}`), `в CSS нет класса .${name}`);
  }
  for (const key of ['@keyframes mui-marquee', '@keyframes mui-beam', '@keyframes mui-meteor', '@keyframes mui-gradient', '@keyframes mui-shine']) {
    assert.ok(css.includes(key), `в CSS нет ${key}`);
  }
  assert.ok(!/https?:\/\//.test(css), 'в CSS появился внешний запрос');
});

function buildPage(css) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Проверка навыка</title><style>${css}</style></head>
<body style="margin:0;background:#0b0b0f;color:#eee">
${markup}
<script>window.__errors = []; window.addEventListener('error', (event) => window.__errors.push(String(event.message)));</script>
${script}
</body></html>`;
}

/* Поля из jsdom приходят из другого realm: сверяем значения, а не прототипы. */
const errorsText = (window) => [...window.__errors].join('; ');

test('страница по инструкции: метеоры, число, пятно за курсором, без ошибок', async () => {
  const css = cssBlocks.join('\n');
  const dom = new JSDOM(buildPage(css), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://service.local/page.html',
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      /* IntersectionObserver в jsdom нет: подменяем на «всё сразу в зоне видимости». */
      window.IntersectionObserver = class {
        constructor(callback) {
          this.callback = callback;
        }
        observe(node) {
          window.setTimeout(() => this.callback([{ isIntersecting: true, target: node }]), 0);
        }
        unobserve() {}
        disconnect() {}
      };
      window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(window.performance.now()), 16);
      window.cancelAnimationFrame = (id) => window.clearTimeout(id);
    },
  });

  const { window } = dom;
  await new Promise((resolve) => window.setTimeout(resolve, 2000));

  assert.equal(window.__errors.length, 0, `ошибки JS: ${errorsText(window)}`);
  const meteors = window.document.querySelectorAll('.mui-meteor');
  assert.equal(meteors.length, 18, `метеоров ${meteors.length}, ожидалось 18`);
  assert.match(meteors[0].getAttribute('style') || '', /left:/);

  const ticker = window.document.querySelector('[data-mui-ticker]');
  assert.match(ticker.textContent, /1[\s\u00a0]284/, `число не докрутилось: «${ticker.textContent}»`);

  const card = window.document.querySelector('[data-mui-card]');
  card.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 30 }));
  assert.ok(card.style.getPropertyValue('--mui-mx'), 'пятно не получило координату X');
  assert.ok(card.style.getPropertyValue('--mui-my'), 'пятно не получило координату Y');

  dom.window.close();
});

test('с reduced-motion страница остаётся рабочей и без метеоров', async () => {
  const css = cssBlocks.join('\n');
  const dom = new JSDOM(buildPage(css), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://service.local/page.html',
    beforeParse(window) {
      window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
      window.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    },
  });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 200));
  assert.equal(dom.window.__errors.length, 0, `ошибки JS: ${errorsText(dom.window)}`);
  assert.equal(dom.window.document.querySelectorAll('.mui-meteor').length, 0, 'метеоры создались вопреки reduced-motion');
  dom.window.close();
});

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok   ${item.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${item.name}: ${error?.message || error}`);
  }
}
console.log(failed ? `\n${failed} из ${tests.length} не прошли` : `\nвсе ${tests.length} прошли`);
process.exit(failed ? 1 : 0);

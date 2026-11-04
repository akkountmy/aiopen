/* Геометрический аудит лендинга без «на глаз»: обрезка текста, наложения
   соседних карточек, ритм отступов, размеры кнопок, тёмная схема.
   Запуск: node demo/audit-landing.mjs                                      */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const url = pathToFileURL('demo/landing-spatlevka.html').href;
const browser = await chromium.launch();

const audit = async (page, width) => {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(120);
  return page.evaluate(() => {
    const name = (el) => {
      const cls = typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '';
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
    };
    const rect = (el) => el.getBoundingClientRect();

    /* 1. текст, который не влезает в свой блок (только блочные: у строчных
       clientWidth всегда 0 и они дают ложные срабатывания) */
    const blocky = (el) => ['block', 'flex', 'grid', 'list-item'].includes(getComputedStyle(el).display);
    const clipped = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && (el.textContent || '').trim())
      .filter((el) => blocky(el) && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1)
      .slice(0, 8)
      .map(name);

    /* 2. наложения соседних элементов в сетках */
    const overlaps = [];
    for (const grid of document.querySelectorAll('.cards, .steps, .hero__facts, .guarantee__grid, .case__facts')) {
      const kids = [...grid.children].map(rect);
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i];
          const b = kids[j];
          const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (dx > 1 && dy > 1) overlaps.push(`${name(grid)}: ${i + 1} и ${j + 1} пересекаются на ${Math.round(dx)}×${Math.round(dy)} px`);
        }
      }
    }

    /* 3. ритм: вертикальные отступы секций и заголовков */
    const sections = [...document.querySelectorAll('main > section')].map((el) => {
      const s = getComputedStyle(el);
      return { id: el.id || '(первая)', top: Math.round(rect(el).top + scrollY), padTop: Math.round(parseFloat(s.paddingTop)), padBottom: Math.round(parseFloat(s.paddingBottom)) };
    });
    const gaps = sections.slice(1).map((s, i) => s.top - (sections[i].top + (sections[i].padTop + sections[i].padBottom)));

    /* 4. размеры кнопок и полей */
    const buttons = [...document.querySelectorAll('.btn, button[type="submit"]')]
      .map((el) => ({ w: Math.round(rect(el).width), h: Math.round(rect(el).height) }));
    const fields = [...document.querySelectorAll('.form input:not([type="checkbox"]), .form select, .form textarea, .calc input, .calc select')]
      .map((el) => ({ id: el.id, h: Math.round(rect(el).height) }));

    /* 5. сетка контейнера и колонки */
    const wrap = document.querySelector('.wrap');
    const containerWidth = wrap ? Math.round(rect(wrap).width) : 0;
    const heroCols = getComputedStyle(document.querySelector('.hero__in') || document.body).gridTemplateColumns;

    return {
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
      containerWidth,
      heroCols,
      clipped,
      overlaps,
      sections,
      gaps,
      buttons,
      fields
    };
  });
};

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const jsErrors = [];
page.on('pageerror', (error) => jsErrors.push(String(error.message).slice(0, 160)));
await page.goto(url, { waitUntil: 'load' });

const run = audit;
for (const width of [390, 768, 1440]) {
  const result = await run(page, width);
  console.log(`\n=== ${width} px ===`);
  console.log('  контейнер:', result.containerWidth, 'px | высота страницы:', result.pageHeight, 'px | hero колонки:', result.heroCols);
  console.log('  обрезанного текста:', result.clipped.length, result.clipped.join(', '));
  console.log('  наложений в сетках:', result.overlaps.length, result.overlaps.join('; '));
  console.log('  кнопок:', result.buttons.length, '→ высоты', [...new Set(result.buttons.map((b) => b.h))].join('/'), 'px');
  console.log('  полей:', result.fields.length, '→ высоты', [...new Set(result.fields.map((f) => f.h))].join('/'), 'px');
  console.log('  отступы секций (сверху/снизу):', [...new Set(result.sections.map((s) => `${s.padTop}/${s.padBottom}`))].join(', '));
  console.log('  зазоры между секциями:', [...new Set(result.gaps)].join(', '), 'px');
}

/* тёмная схема: те же токены, другие значения */
await page.emulateMedia({ colorScheme: 'dark' });
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(150);
const dark = await page.evaluate(() => {
  const get = (sel, prop) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el)[prop] : null;
  };
  return {
    bg: get('body', 'backgroundColor'),
    ink: get('body', 'color'),
    surface: get('.card', 'backgroundColor'),
    surfaceInk: get('.card', 'color'),
    accent: get('.btn', 'backgroundColor'),
    accentInk: get('.btn', 'color'),
    h1: get('h1', 'color')
  };
});
console.log('\n=== ТЁМНАЯ СХЕМА (prefers-color-scheme: dark) ===');
console.log('  фон', dark.bg, '| текст', dark.ink, '| карточка', dark.surface, '| акцент', dark.accent, '| кнопка-текст', dark.accentInk);
console.log('  токены переопределены:', dark.bg !== 'rgb(247, 245, 241)' ? 'да' : 'НЕТ');
console.log('  ошибок JS:', jsErrors.length, jsErrors.join(' | '));

await browser.close();

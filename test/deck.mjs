/**
 * Проверка create_deck: самостоятельный HTML (шрифты внутрь, внешних файлов нет),
 * все восемь макетов, экранирование текста и настоящий PDF при наличии браузера.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_DEFS, executeTool } from '../src/tools.mjs';
import { DECK_LAYOUTS, DECK_THEMES, deckHtml, normalizeDeck } from '../src/doc/deck.mjs';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-deck-'));
const ctx = { workspace };

const cover = {
  layout: 'cover',
  kicker: 'Коммерческое предложение',
  title: 'Дизайнерский\nдек',
  subtitle: 'Типографика, палитра и поля — как в референсе.',
  action: 'Смотреть',
  tag: 'gold · 1600×900',
  items: [{ label: '01', caption: 'Дизайн' }, { label: '02', caption: 'Экспорт' }],
};

const sample = {
  path: 'Дека.pdf',
  theme: 'cobalt',
  footerText: 'DSH.OPEN.WEB',
  slides: [
    cover,
    { layout: 'rows', title: 'Что внутри', badge: { value: '3', label: 'палитры' }, rows: [{ name: 'HTML', text: 'Макет 1600×900.' }, { name: 'PDF', text: 'Печать без полей.' }] },
    { layout: 'steps', kicker: 'план', title: 'Три шага', steps: [{ title: 'Макет', text: 'HTML.' }, { title: 'Сверка', text: 'Числа.' }, { title: 'Сдача', text: 'Файл.' }] },
    { layout: 'list', title: 'Пять пунктов', bullets: [{ title: 'Первый', text: 'Коротко.' }, { title: 'Второй', text: 'Коротко.' }] },
    { layout: 'kpi', title: 'Цифры', kpi: [{ value: '17', label: 'слайдов' }, { value: '1,7%', label: 'разница' }] },
    { layout: 'quote', quote: 'Дека — это **решение**, а не файл.', author: 'Правило хансена' },
    { layout: 'section', num: '02', title: 'Что внедрено' },
    { layout: 'closing', kicker: 'Дальше', title: 'Готово', action: 'Забрать файл' },
  ],
};

test('create_deck объявлен в TOOL_DEFS с палитрами и макетами', () => {
  const def = TOOL_DEFS.find((tool) => tool.function.name === 'create_deck');
  assert.ok(def, 'инструмент create_deck отсутствует');
  const props = def.function.parameters.properties;
  assert.deepEqual([...props.theme.enum].sort(), [...DECK_THEMES].sort());
  assert.deepEqual([...props.slides.items.properties.layout.enum].sort(), [...DECK_LAYOUTS].sort());
  assert.deepEqual(def.function.parameters.required, ['path', 'slides']);
});

test('HTML самостоятельный: слайды 1600×900, шрифты внутрь, внешних ссылок нет', () => {
  const html = deckHtml(sample);
  assert.equal((html.match(/<section class="slide/g) || []).length, sample.slides.length);
  assert.match(html, /<body data-theme="cobalt">/);
  assert.match(html, /width:1600px/);
  assert.match(html, /height:900px/);
  assert.match(html, /@page\{size:1600px 900px/);
  assert.ok(html.includes('url(data:font/woff2;base64,'), 'шрифты не вложены в HTML');
  assert.ok(!/url\(https?:/.test(html), 'в HTML осталась внешняя ссылка на шрифт');
  assert.ok(!/src="http/.test(html), 'в HTML осталась внешняя картинка');
});

test('на обложке нет плейсхолдера «Aa»: знак печатается только заданный', () => {
  /* Жалоба «чёрный прямоугольник справа-снизу»: в углу печаталась табличка с
     образцом шрифта «Aa», которую никто не просил. Теперь нет знака — нет
     таблички; заданный бренд печатается словами. */
  const bare = deckHtml({ slides: [{ layout: 'cover', title: 'Только заголовок' }] });
  assert.ok(!bare.includes('class="specimen"'), 'плейсхолдер «Aa» вернулся на обложку');
  assert.ok(!bare.includes('>Aa<'), 'на обложке снова образец шрифта «Aa»');
  assert.ok(!bare.includes('class="contact"'), 'тёмное пятно .contact вернулось');

  const brand = deckHtml({ slides: [{ layout: 'cover', title: 'Бренд', mark: 'ПАР', tag: 'сезон 2026/27' }] });
  assert.match(brand, /class="specimen"[\s\S]*?<span class="big">ПАР<\/span>/);
  assert.match(brand, /<span class="tag">сезон 2026\/27<\/span>/);
});

test('фото вставляется файлом проекта: data-URI внутри HTML, макетов с кадром два', async () => {
  /* Фотографию нельзя «нарисовать» разметкой — это единственный реальный
     рычаг оформления. Проверяем весь путь: файл → base64 → HTML → PDF. */
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-deck-photo-'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVQoz2P8z8Dwn4EIwESMolGF'
    + 'o1IHVSEAhLIDAfz0Y7YAAAAASUVORK5CYII=',
    'base64',
  );
  fs.writeFileSync(path.join(proj, 'зал.png'), png);
  const result = await executeTool('create_deck', {
    path: 'Фото.pdf',
    slides: [
      { layout: 'cover', title: 'Кадр', mark: 'ПАР', image: 'зал.png' },
      { layout: 'media', title: 'Кадр во весь слайд', image: 'зал.png', caption: 'подпись' },
      { layout: 'split', title: 'Кадр справа', bullets: [{ title: 'Пункт', text: 'текст' }], image: 'зал.png' },
    ],
  }, { workspace: proj });
  const file = path.join(proj, result.meta.path);
  const html = fs.existsSync(path.join(proj, 'Фото.html'))
    ? fs.readFileSync(path.join(proj, 'Фото.html'), 'utf8')
    : null;
  if (html) assert.ok(html.includes('data:image/png;base64,'), 'картинка не вложена в HTML');
  if (result.meta.fallback) return;
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal(result.meta.slides, 3);
});

test('текст экранируется, выделение **…** превращается в акцент', () => {
  const html = deckHtml({ slides: [{ layout: 'list', title: '<script>alert(1)</script>', bullets: ['a & <b>'] }] });
  assert.ok(!html.includes('<script>alert'), 'заголовок не экранирован');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /a &amp; &lt;b&gt;/);
  const quote = deckHtml({ slides: [{ layout: 'quote', quote: 'раз и **два**' }] });
  assert.match(quote, /раз и <em>два<\/em>/);
});

test('лишние строки не влезают молча: их число попадает в warnings', () => {
  const { warnings } = normalizeDeck({
    slides: [
      { layout: 'rows', title: 'Реестр', rows: [1, 2, 3, 4, 5].map((n) => ({ name: `строка ${n}` })) },
      { layout: 'list', title: 'Тезисы', bullets: [1, 2, 3, 4, 5, 6].map((n) => ({ title: `тезис ${n}` })) },
    ],
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Слайд 1 \(rows\): помещается 4, не вошло 1/);
  assert.match(warnings[1], /Слайд 2 \(list\): помещается 5, не вошло 1/);
});

test('неизвестный макет падает в list, а не ломает деку', () => {
  const html = deckHtml({ slides: [{ layout: 'нет-такого', title: 'Запасной тезис' }] });
  assert.match(html, /<div class="list">/);
  assert.match(html, /Запасной тезис/);
  assert.ok(!/class="steps/.test(html), 'неизвестный макет утёк в план-слайд');
});

test('дека печатается: PDF на все слайды (или честный HTML без браузера)', async () => {
  const result = await executeTool('create_deck', sample, ctx);
  assert.equal(result.meta.slides, sample.slides.length);
  const file = path.join(workspace, result.meta.path);
  assert.ok(fs.existsSync(file), 'файл не создан');
  if (result.meta.fallback) {
    assert.match(result.meta.path, /\.html$/);
    assert.match(result.text, /PDF не напечатан/);
    return;
  }
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  const pages = (buf.toString('latin1').match(/\/Type \/Page(?!s)/g) || []).length;
  assert.equal(pages, sample.slides.length, `ожидали ${sample.slides.length} страниц, получили ${pages}`);
  assert.match(result.text, /Дека создана/);
  assert.equal(result.meta.layout.ok, true, `раскладка чистой деки: ${JSON.stringify(result.meta.layout)}`);
  assert.match(result.text, /Раскладка: чисто/);
});

test('переполнение видно до печати и лечится подгонкой, а не уезжает в файл', async () => {
  /* Четыре длинных строки + сноска: описание упирается в сноску и последнюю строку,
     а суммарная высота вылезает за 900 px. Такой макет раньше уезжал в PDF молча;
     теперь замер ловит дефект, а сборка раскладывает строки на два слайда. */
  const what = 'Длинное описание строки, которое тянется почти до самого края отведённой колонки и переносится на две строки целиком';
  const crowded = {
    path: 'Переполнение.pdf',
    slides: [
      {
        layout: 'rows',
        kicker: 'Проверка',
        title: 'Четыре длинных строки',
        rows: [
          { name: 'Первая', what },
          { name: 'Вторая', what },
          { name: 'Третья', what },
          { name: 'Четвёртая', what },
        ],
        footnote: 'Сноска, которая стоит внизу и может столкнуться с последней строкой',
      },
    ],
  };
  const result = await executeTool('create_deck', crowded, ctx);
  if (result.meta.fallback) return; // без браузера замера нет — проверять нечего
  /* Главное: файл вышел без наложений. Значит замер их увидел (иначе подгонки
     не было бы) и сборка успела перестроить слайд до печати. */
  assert.equal(result.meta.layout.ok, true, `раскладка после подгонки: ${JSON.stringify(result.meta.layout)}`);
  assert.equal(result.meta.slides, 2, 'переполненный слайд не разделён');
  assert.ok(result.meta.fit.length > 0, 'о подгонке не сказано в meta');
  assert.match(result.text, /Подгонка: слайд 1/);
  assert.match(result.text, /Раскладка: чисто/);
});

test('текст поверх сноски считается дефектом, даже если это «краешек»', async () => {
  /* Живой случай: строка меню задевает сноску на пару пикселей по высоте.
     Общее правило наложений считает долю площади и такой край пропускало —
     в файле это видно как текст, наехавший на сноску. Отдельное правило
     должно поймать касание и перестроить слайд. */
  const menu = {
    path: 'Сноска.pdf',
    slides: [
      {
        layout: 'list',
        kicker: 'меню',
        title: 'Кофе на четыре голоса: эспрессо, фильтр, сезон и еда под чашку',
        lead: 'Четыре направления — от классики до сезонных экспериментов. Всё варим здесь, при вас.',
        bullets: [
          { title: 'Эспрессо-бар', text: 'Двойной эспрессо, флэт-уайт, капучино. Зерно светлой обжарки, помол под каждый напиток. От 5 ₽.' },
          { title: 'Фильтр и ручная заварка', text: 'V60, аэропресс и кемекс — способ выбираете вы, остальное делаем мы. От 6 ₽.' },
          { title: 'Сезонная карта', text: 'Напитки, которые живут три месяца: осенью — пряности, летом — цитрус и тоник. От 7 ₽.' },
          { title: 'Еда под кофе', text: 'Сырники, круассаны, сэндвичи — сытно, но не заглушает вкус чашки. От 6 ₽.' },
        ],
        footnote: 'Цены ориентировочные',
      },
    ],
  };
  const result = await executeTool('create_deck', menu, ctx);
  if (result.meta.fallback) return; // без браузера замера нет — проверять нечего
  assert.equal(result.meta.layout.ok, true, `раскладка после подгонки: ${JSON.stringify(result.meta.layout)}`);
  assert.ok(result.meta.fit.length > 0, 'о подгонке не сказано в meta');
  /* Пункты не потеряны: подгонка снимает подзаголовок, а не пункты меню,
     поэтому слайд остаётся один. */
  assert.equal(result.meta.slides, 1, 'пункты меню разложены по двум слайдам вместо снятия лида');
  assert.match(result.text, /Подгонка: слайд 1/);
  assert.match(result.text, /Раскладка: чисто/);
});

test('расширение обязательное, слайды нужны, путь не выходит из проекта', async () => {
  await assert.rejects(() => executeTool('create_deck', { ...sample, path: 'Дека.pptx' }, ctx), /\.pdf/);
  await assert.rejects(() => executeTool('create_deck', { ...sample, slides: [] }, ctx), /хотя бы один слайд/);
  await assert.rejects(() => executeTool('create_deck', { ...sample, path: '../escape.pdf' }, ctx), /за пределы/);
});

test.after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

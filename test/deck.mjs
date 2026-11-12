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

test('переполнение видно до печати: замер раскладки ругается, а не молчит', async () => {
  /* Четыре длинных строки + сноска: описание упирается в сноску и последнюю строку,
     а суммарная высота вылезает за 900 px. Такой макет раньше уезжал в PDF молча. */
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
  assert.equal(result.meta.layout.ok, false, 'переполнение не заметили');
  assert.ok(result.meta.layout.issues.length > 0);
  assert.match(result.text, /Раскладка: \d+ замечани/);
  assert.match(result.text, /слайд 1/);
});

test('расширение обязательное, слайды нужны, путь не выходит из проекта', async () => {
  await assert.rejects(() => executeTool('create_deck', { ...sample, path: 'Дека.pptx' }, ctx), /\.pdf/);
  await assert.rejects(() => executeTool('create_deck', { ...sample, slides: [] }, ctx), /хотя бы один слайд/);
  await assert.rejects(() => executeTool('create_deck', { ...sample, path: '../escape.pdf' }, ctx), /за пределы/);
});

test.after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

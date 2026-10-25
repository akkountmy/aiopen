/**
 * Проверка страницы по коду — то, что работает и без Chromium (на Amvera его нет).
 *
 * Запуск: node test/pagecheck.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { staticPageChecks, describeStatic, pageTemplate, pageCheckNote } = await import('../src/pagecheck.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pagecheck-'));

const broken = `<!doctype html>
<html lang="ru">
<head>
  <title>Страница с поломками</title>
  <link rel="stylesheet" href="https://cdn.example.com/site.css">
</head>
<body>
  <div class="hero" style="width:1200px">
    <img src="нет-такого.png">
    <p class="lead">Текст без главного заголовка
    <span>вложенный блок
  </div>
  <script src="https://cdn.example.com/app.js"></script>
</body>
</html>`;

const clean = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Чистая страница</title>
</head>
<body>
  <h1>Главный вывод</h1>
  <p>Текст</p>
  <img src="picture.png" alt="Схема работы">
  <a href="#facts">К числам</a>
  <script>window.addEventListener('error', function (e) { document.title = e.message; });</script>
</body>
</html>`;

test('шаблон сервиса существует и сам проходит проверку по коду', () => {
  const html = pageTemplate();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<h1>/);
  const facts = staticPageChecks(html);
  assert.ok(facts.h1.length > 0, 'в шаблоне должен быть h1');
  assert.equal(facts.externalCount, 0, 'шаблон не должен ходить в интернет');
  assert.equal(facts.fixedWidths.length, 0, 'в шаблоне не должно быть фиксированных ширин');
  assert.equal(facts.unclosedTags.length, 0, `незакрытые теги: ${facts.unclosedTags.join(', ')}`);
  assert.equal(facts.mismatchedTags.length, 0, `кривые теги: ${facts.mismatchedTags.join('; ')}`);
  assert.equal(facts.quoteIssues.length, 0, `кавычки: ${facts.quoteIssues.join('; ')}`);
  assert.equal(facts.hasErrorPlaque, true, 'в шаблоне должна быть плашка ошибок');
  assert.equal(facts.images.withoutAlt, 0);
});

test('поломки видны по коду: h1, alt, внешние запросы, ширины, теги', () => {
  const file = path.join(tmpRoot, 'broken.html');
  fs.writeFileSync(file, broken, 'utf8');
  const facts = staticPageChecks(broken, { root: tmpRoot, file });
  assert.equal(facts.h1, '', 'h1 отсутствует');
  assert.ok(facts.images.withoutAlt >= 1, 'картинка без alt должна найтись');
  assert.equal(facts.images.total, 1);
  assert.ok(facts.externalCount >= 2, `внешние запросы: ${facts.externalCount}`);
  assert.ok(facts.external.some((url) => url.includes('cdn.example.com')), 'адрес CDN должен попасть в список');
  assert.ok(facts.missingLocal.length >= 1, 'ссылка на несуществующий файл должна найтись');
  assert.ok(facts.fixedWidths.some((item) => item.includes('1200px')), 'фиксированная ширина 1200 px должна найтись');
  assert.ok(
    [...facts.unclosedTags, ...facts.mismatchedTags].length >= 1,
    `незакрытые теги должны найтись: ${JSON.stringify({ unclosed: facts.unclosedTags, mismatched: facts.mismatchedTags })}`,
  );
  assert.equal(facts.hasErrorPlaque, false);
});

test('чистая страница проходит без замечаний', () => {
  const file = path.join(tmpRoot, 'clean.html');
  fs.writeFileSync(file, clean, 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'picture.png'), 'png', 'utf8');
  const facts = staticPageChecks(clean, { root: tmpRoot, file });
  assert.equal(facts.h1, 'Главный вывод');
  assert.equal(facts.externalCount, 0);
  assert.equal(facts.missingLocal.length, 0, `лишние замечания: ${facts.missingLocal.join('; ')}`);
  assert.equal(facts.fixedWidths.length, 0);
  assert.equal(facts.unclosedTags.length, 0, `незакрытые теги: ${facts.unclosedTags.join(', ')}`);
  assert.equal(facts.mismatchedTags.length, 0);
  assert.equal(facts.quoteIssues.length, 0);
  assert.equal(facts.hasErrorPlaque, true);
  assert.equal(facts.viewport, true);
  assert.equal(facts.charset, true);
});

test('отчёт по коду перечисляет замечания человеческим языком', () => {
  const file = path.join(tmpRoot, 'broken.html');
  const facts = staticPageChecks(broken, { root: tmpRoot, file });
  const text = describeStatic(facts);
  assert.match(text, /h1 отсутствует/);
  assert.match(text, /картинки без alt/);
  assert.match(text, /внешние запросы/);
  assert.match(text, /фиксированная ширина/);
  assert.match(text, /нет <!doctype html>|теги|кавычки/);
});

test('подпись шага говорит, чем проверяли: браузером или по коду', () => {
  const browser = pageCheckNote({
    mode: 'browser',
    variants: [
      { screenshot: 'screens/page-390.png' },
      { screenshot: 'screens/page-768.png' },
      { screenshot: 'screens/page-1440.png' },
    ],
  });
  assert.match(browser, /живом браузере/);
  assert.match(browser, /снимков 3/);

  const staticNote = pageCheckNote({ mode: 'static', variants: [] });
  assert.match(staticNote, /по коду/);
  assert.match(staticNote, /браузера в окружении нет/);
});

test('ссылка за пределы проекта не проверяется как файл проекта', () => {
  const facts = staticPageChecks('<a href="../../../etc/passwd">x</a>', { root: tmpRoot, file: path.join(tmpRoot, 'a.html') });
  assert.ok(facts.missingLocal.some((item) => item.includes('выходит за папку проекта')), `получено: ${facts.missingLocal.join('; ')}`);
});

let passed = 0;
for (const item of tests) {
  try {
    await item.fn();
    passed += 1;
    console.log(`ok — ${item.name}`);
  } catch (error) {
    console.error(`FAIL — ${item.name}: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
console.log(`\nстраница по коду: пройдено ${passed} из ${tests.length}`);

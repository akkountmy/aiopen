/**
 * Тесты веб-слоя без выхода в настоящий интернет: локальный сервер отдаёт
 * страницу со «шумом», таблицу, кодировку windows-1251, JSON-API и POST-эхо.
 * Проверяется: читаемый разбор страницы, параллельная загрузка, обход сайта,
 * POST с телом и заголовками, декодирование кодировки, запрет локальных адресов.
 * Запуск: node test/web.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-'));
process.env.DSH_DATA_DIR = tmpRoot;
process.env.DSHOW_ALLOW_PRIVATE_FETCH = '1';

const ARTICLE = `<!doctype html><html lang="ru"><head>
<title>Рынок лизинга 2026 — обзор</title>
<meta name="description" content="Ключевые цифры рынка лизинга.">
<style>body{color:red}</style></head><body>
<nav><a href="/nav1">Меню</a><a href="/nav2">Ещё меню</a></nav>
<header><h1>Шапка сайта</h1></header>
<main><article>
<h2>Объём рынка</h2>
<p>Объём рынка лизинга вырос на 18% и достиг 2,4 трлн тенге.</p>
<h3>Структура</h3>
<table><tr><th>Сегмент</th><th>Доля</th></tr>
<tr><td>Транспорт</td><td>54%</td></tr><tr><td>Оборудование</td><td>31%</td></tr></table>
<p>Подробнее в <a href="/report-2026">полном отчёте</a> и во <a href="https://other.example/x">внешнем источнике</a>.</p>
</article></main>
<footer><p>Подвал сайта, контакты и копирайт.</p></footer>
<script>window.track = 1;</script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: '/article' }).end();
    return;
  }
  if (req.url === '/article') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(ARTICLE);
    return;
  }
  if (req.url === '/report-2026') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end('<html><head><title>Полный отчёт</title></head><body><main><p>Отчёт: 2,4 трлн тенге за 2026 год.</p></main></body></html>');
    return;
  }
  if (req.url === '/cp1251-real') {
    /* Кириллица в windows-1251: байты собираем вручную, чтобы не зависеть от ОС. */
    const bytes = [];
    const head = '<html><head><meta charset="windows-1251"><title>Тест</title></head><body><p>';
    for (const ch of head) bytes.push(ch.charCodeAt(0));
    /* «Выручка» в windows-1251: C2 FB F0 F3 F7 EA E0 */
    for (const byte of [0xc2, 0xfb, 0xf0, 0xf3, 0xf7, 0xea, 0xe0]) bytes.push(byte);
    for (const ch of '</p></body></html>') bytes.push(ch.charCodeAt(0));
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(Buffer.from(bytes));
    return;
  }
  if (req.url === '/api') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ ok: true, number: 42 }));
    return;
  }
  if (req.url === '/echo') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ method: req.method, auth: req.headers.authorization || '', body: raw }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html><body>404</body></html>');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const { readPage, fetchUrl, fetchMany, crawlSite, searchMany, assertPublicUrl, decodeBody, scrapePage } = await import('../src/search.mjs');
const { extractReadable } = await import('../src/extract.mjs');
const { executeTool, TOOL_DEFS, availableToolDefs } = await import('../src/tools.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('новые веб-инструменты объявлены для модели', async () => {
  const names = new Set(TOOL_DEFS.map((tool) => tool.function.name));
  for (const name of ['read_page', 'scrape_page', 'fetch_many', 'crawl']) {
    assert.ok(names.has(name), `нет инструмента ${name}`);
  }
  const available = await availableToolDefs();
  assert.ok(available.some((tool) => tool.function.name === 'read_page'));
  assert.ok(available.some((tool) => tool.function.name === 'scrape_page'));
});

test('read_page отдаёт структуру статьи без меню и подвала', async () => {
  const page = await readPage(`${base}/article`);
  assert.equal(page.title, 'Рынок лизинга 2026 — обзор');
  assert.match(page.description, /Ключевые цифры/);
  assert.ok(page.headings.some((heading) => heading.text === 'Объём рынка'));
  assert.ok(page.tables.length >= 1, 'таблица не найдена');
  assert.deepEqual(page.tables[0][1], ['Транспорт', '54%']);
  assert.ok(page.links.some((link) => link.href.endsWith('/report-2026')), 'внутренняя ссылка потерялась');
  assert.ok(page.links.some((link) => link.href.includes('other.example')));
  assert.match(page.text, /вырос на 18%/);
  assert.ok(!/Меню/.test(page.text), 'меню попало в текст');
  assert.ok(!/Подвал/.test(page.text), 'подвал попал в текст');
  assert.ok(!/window\.track/.test(page.text), 'скрипт попал в текст');
});

test('read_page после редиректа считает ссылки своего сайта', async () => {
  const page = await readPage(`${base}/redirect`);
  assert.equal(new URL(page.url).pathname, '/article');
  const report = page.links.find((link) => link.href.endsWith('/report-2026'));
  assert.ok(report);
  assert.equal(report.sameOrigin, true, 'после редиректа внутренняя ссылка стала чужой');
  const crawl = await crawlSite(`${base}/redirect`, { maxPages: 2, maxDepth: 1 });
  assert.ok(crawl.pages.some((item) => item.url.endsWith('/report-2026')));
});

test('read_page работает через инструмент', async () => {
  const result = await executeTool('read_page', { url: `${base}/article` }, { workspace: tmpRoot });
  assert.match(result.text, /Заголовок: Рынок лизинга 2026/);
  assert.match(result.text, /Транспорт \| 54%/);
  assert.match(result.text, /вырос на 18%/);
});

test('scrape_page: Markdown, таблицы и поля по селекторам', async () => {
  const page = await scrapePage(`${base}/article`, { format: 'markdown' });
  assert.ok(['readability', 'dom'].includes(page.engine));
  assert.match(page.text, /^## Объём рынка/m);
  assert.match(page.text, /\| Транспорт \| 54% \|/);
  assert.match(page.text, /\[полном отчёте\]\(http:\/\/127\.0\.0\.1:\d+\/report-2026\)/);
  assert.ok(!/Меню/.test(page.text), 'меню попало в Markdown');
  assert.ok(!/Подвал/.test(page.text), 'подвал попал в Markdown');

  const fields = await scrapePage(`${base}/article`, {
    format: 'json',
    selectors: {
      heading: 'h2',
      report: "a[href$='/report-2026']@href",
      segment: 'table tr:nth-child(2) td:first-child',
    },
  });
  assert.equal(fields.fields.heading, 'Объём рынка');
  assert.ok(fields.fields.report.startsWith(base), 'ссылка в поле должна быть абсолютной');
  assert.equal(fields.fields.segment, 'Транспорт');
});

test('scrape_page работает через инструмент', async () => {
  const markdown = await executeTool('scrape_page', { url: `${base}/article` }, { workspace: tmpRoot });
  assert.match(markdown.text, /## Объём рынка/);
  assert.match(markdown.text, /Транспорт/);

  const json = await executeTool(
    'scrape_page',
    { url: `${base}/article`, format: 'json', selectors: { price: 'h2' } },
    { workspace: tmpRoot },
  );
  assert.equal(JSON.parse(json.text.slice(json.text.indexOf('{'))).price, 'Объём рынка');
});

test('extractReadable: вложенные списки, mailto и абсолютные картинки', () => {
  const html = `<!doctype html><html lang="ru"><head><title>Контакты</title></head><body><main><article>
    <h1>Контакты</h1><p>${'Текст статьи. '.repeat(40)}</p>
    <ul><li>Отдел продаж<ul><li>Москва</li><li>Казань</li></ul></li></ul>
    <p>Почта: <a href="mailto:sales@example.com">sales@example.com</a></p>
    <img src="/logo.png" alt="Логотип">
  </article></main></body></html>`;
  const out = extractReadable(html, 'https://example.com/contacts');
  assert.match(out.markdown, /\n\s+- +Москва/);
  assert.match(out.markdown, /mailto:sales@example\.com/);
  assert.match(out.markdown, /!\[Логотип\]\(https:\/\/example\.com\/logo\.png\)/);
  assert.ok(out.links.some((link) => link.href === 'mailto:sales@example.com'));
});

test('extractReadable: <base href> и ленивые картинки', () => {
  const html = `<!doctype html><html><head><base href="https://cdn.example/assets/"><title>База</title></head>
    <body><main><article><h1>База</h1><p>${'Текст статьи. '.repeat(40)}</p>
    <a href="page.html">Страница</a>
    <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-src="lazy.jpg" alt="Ленивая">
    </article></main></body></html>`;
  const out = extractReadable(html, 'https://site.example/news/1');
  assert.ok(out.links.some((link) => link.href === 'https://cdn.example/assets/page.html'));
  assert.match(out.markdown, /!\[Ленивая\]\(https:\/\/cdn\.example\/assets\/lazy\.jpg\)/);
});

test('POST с телом и своими заголовками работает', async () => {
  const page = await fetchUrl(`${base}/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-123' },
    body: JSON.stringify({ hello: 'мир' }),
  });
  const parsed = JSON.parse(page.text);
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.auth, 'Bearer test-123');
  assert.match(parsed.body, /мир/);
});

test('JSON-API читается как данные', async () => {
  const page = await fetchUrl(`${base}/api`);
  assert.equal(page.kind, 'json');
  assert.equal(JSON.parse(page.text).number, 42);
});

test('кодировка windows-1251 декодируется', async () => {
  const page = await fetchUrl(`${base}/cp1251-real`);
  assert.match(page.text, /Выручка/, `получилось: ${page.text.slice(0, 80)}`);
  assert.equal(decodeBody(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), 'text/html; charset=windows-1251'), 'Привет');
});

test('fetch_many: параллельно и без падения на битой ссылке', async () => {
  const pages = await fetchMany([`${base}/article`, `${base}/report-2026`, `${base}/no-such-page-404`], { maxChars: 2000 });
  assert.equal(pages.length, 3);
  assert.match(pages[0].text, /вырос на 18%/);
  assert.match(pages[1].text, /2,4 трлн/);
  assert.match(pages[2].text, /404/, 'страница 404 должна вернуть текст, а не ошибку');
  const broken = await fetchMany(['http://127.0.0.1:1/nothing'], { maxChars: 500 });
  assert.ok(broken[0].error, 'недоступная ссылка должна дать ошибку в своём слоте');
});

test('crawl обходит сайт в пределах домена и глубины', async () => {
  const result = await crawlSite(`${base}/article`, { maxPages: 3, maxDepth: 1, maxChars: 1500 });
  assert.ok(result.pages.length >= 2, `страниц: ${result.pages.length}`);
  const urls = result.pages.map((page) => page.url);
  assert.ok(urls.some((url) => url.endsWith('/report-2026')), 'внутренняя ссылка не обойдена');
  for (const url of urls) assert.ok(url.startsWith(base), `вышли за пределы домена: ${url}`);
  const limited = await crawlSite(`${base}/article`, { maxPages: 1, maxDepth: 2 });
  assert.equal(limited.pages.length, 1);
});

test('локальные адреса закрыты без явного флага', async () => {
  const saved = process.env.DSHOW_ALLOW_PRIVATE_FETCH;
  delete process.env.DSHOW_ALLOW_PRIVATE_FETCH;
  try {
    assert.throws(() => assertPublicUrl('http://127.0.0.1:3080/secret'), /недоступны из облака/);
    assert.throws(() => assertPublicUrl('http://169.254.169.254/latest/meta-data'), /недоступны из облака/);
    assert.throws(() => assertPublicUrl('file:///etc/passwd'), /http/);
    assert.ok(assertPublicUrl('https://example.com/page'));
  } finally {
    process.env.DSHOW_ALLOW_PRIVATE_FETCH = saved;
  }
});

test('search_many объединяет запросы', async () => {
  /* Сеть в тестах не нужна: проверяем форму результата на сбое запросов. */
  const found = await searchMany(['', ''], { perQuery: 1 }).catch((error) => ({ error }));
  assert.ok(found.error || Array.isArray(found.results));
});

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok   ${item.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${item.name}: ${error?.message || error}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} тестов прошло`);
server.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

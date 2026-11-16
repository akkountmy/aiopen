/* Разбор тяжёлых страниц в отдельном потоке.

   16.11.2026 страница книги на 1–1.5 МБ разбиралась синхронно (jsdom +
   Readability + Turndown) и задержала очередь событий на 229 с: не отвечал
   /api/health, мягкий сторож перезапустил сервис, задача была закрыта
   сообщением «завис». Замеры на этом коде: 0.33 МБ → 8.6 с, 1.09 МБ → 18 с,
   2.07 МБ → 44 с, 4 МБ → нехватка памяти.

   Проверяем три вещи: пока идёт разбор, главный поток отвечает; очень большая
   страница разбирается дешёвым способом, а не DOM; неудача потока не роняет
   задачу — возвращается текст, а причина уходит в журнал. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const load = (name) => import(pathToFileURL(path.join(root, 'src', name)).href);

const { extractReadable, cheapReadable } = await load('extract.mjs');
const { parseThreadStats } = await load('parse-thread.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function pageHtml(mb) {
  const part = `
    <div class="chapter">
      <h2>Глава книги</h2>
      <p>Текст абзаца о мозге и поведении человека. <a href="/x">ссылка</a> и ещё немного слов.</p>
      <table><tr><td>год</td><td>значение</td></tr></table>
      <ul><li>пункт списка</li><li>ещё пункт</li></ul>
    </div>`;
  const chunk = part.repeat(200);
  const body = chunk.repeat(Math.ceil((mb * 1024 * 1024) / Buffer.byteLength(chunk)));
  return `<html lang="ru"><head><title>Книга о мозге</title></head><body><main>${body}</main></body></html>`;
}

/* Насколько главный поток отстаёт от таймера, пока идёт разбор. */
function watchLag(ms) {
  const started = Date.now();
  let worst = 0;
  let last = started;
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last - 20);
    last = now;
  }, 20);
  return new Promise((resolve) => {
    const stop = setTimeout(() => {
      clearInterval(timer);
      resolve({ worst, elapsed: Date.now() - started });
    }, ms);
    stop.unref();
    watchLag.stop = () => {
      clearTimeout(stop);
      clearInterval(timer);
      return { worst, elapsed: Date.now() - started };
    };
  });
}

test('пока идёт тяжёлый разбор, главный поток отвечает', async () => {
  const html = pageHtml(0.35);
  const lag = watchLag(1500);
  const started = Date.now();
  const result = await extractReadable(html, 'https://example.org/book');
  const spent = Date.now() - started;
  const { worst } = watchLag.stop();
  assert.ok(result.text.length > 1000, `текста мало: ${result.text.length}`);
  assert.equal(result.engine === 'regex-big', false, 'обычная страница должна идти через DOM в потоке');
  assert.ok(worst < 500, `главный поток вставал на ${worst} мс (разбор занял ${spent} мс)`);
  const stats = parseThreadStats();
  assert.ok(stats.tasks >= 1 && stats.ok >= 1, `разбор должен был пройти в потоке: ${JSON.stringify(stats)}`);
});

test('очень большая страница разбирается без DOM и быстро', async () => {
  const html = pageHtml(3);
  const started = Date.now();
  const result = await extractReadable(html, 'https://example.org/big');
  const spent = Date.now() - started;
  assert.equal(result.engine, 'regex-big');
  assert.ok(result.text.length > 1000, `текста мало: ${result.text.length}`);
  assert.ok(spent < 5000, `дешёвый разбор занял ${spent} мс`);
});

test('дешёвый разбор сохраняет заголовки, ссылки и заголовок страницы', async () => {
  const html = `<html lang="ru"><head><title>Мы — это наш мозг</title>
    <meta name="author" content="Дик Свааб"></head>
    <body><h1>Введение</h1><p>Первый абзац.</p><a href="/next">Дальше</a>
    <script>alert('мусор')</script></body></html>`;
  const result = cheapReadable(html, 'https://example.org/book/1');
  assert.equal(result.title, 'Мы — это наш мозг');
  assert.equal(result.byline, 'Дик Свааб');
  assert.equal(result.headings[0].text, 'Введение');
  assert.equal(result.links[0].href, 'https://example.org/next');
  assert.ok(!result.text.includes('мусор'), 'скрипты должны быть вырезаны');
  assert.ok(result.text.includes('Первый абзац'));
});

test('неудача потока не роняет задачу: возвращается текст и причина в журнале', async () => {
  const saved = process.env.DSHOW_PARSE_THREAD;
  process.env.DSHOW_PARSE_THREAD = 'off';
  try {
    const html = pageHtml(0.05);
    const result = await extractReadable(html, 'https://example.org/small');
    assert.ok(result.text.length > 200, `текста мало: ${result.text.length}`);
    assert.notEqual(result.engine, 'empty');
  } finally {
    if (saved === undefined) delete process.env.DSHOW_PARSE_THREAD;
    else process.env.DSHOW_PARSE_THREAD = saved;
  }
});

test('разбор документа идёт через поток и находит текст PDF', async () => {
  const { extractDocumentTextOffThread } = await load('docparse.mjs');
  /* Маленький PDF: один поток контента с текстом. */
  const content = 'BT /F1 12 Tf 40 780 Td (Human brain from womb to Alzheimer) Tj ET';
  const objects = [
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Page /Parent 4 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 1 0 R >> >> /Contents 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Catalog /Pages 4 0 R >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const buf = Buffer.from(out, 'latin1');
  const parsed = await extractDocumentTextOffThread(buf, 'book.pdf', 'application/pdf');
  assert.match(parsed.text, /Human brain/, `текст не найден: ${JSON.stringify(parsed.text.slice(0, 120))}`);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} тестов прошло`);
if (failed) process.exit(1);

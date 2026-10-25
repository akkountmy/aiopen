/**
 * Новые инструменты: распаковка архива, проверка ссылок и сравнение версий.
 *
 * Запуск: node test/tools-extra.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

const { archiveKind, extractArchiveTo, safeEntryName, formatExtraction } = await import('../src/archive.mjs');
const { checkLinks, formatLinks, linksFromText, LINK_LIMITS } = await import('../src/linkcheck.mjs');
const { compareDocuments, diffLines, formatCompare, textLines } = await import('../src/comparedocs.mjs');
const { executeTool, TOOL_DEFS, TOOL_LABELS, toolSummary } = await import('../src/tools.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-extra-'));
const project = path.join(work, 'project');
fs.mkdirSync(project, { recursive: true });

async function makeZip(entries) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/* ---------- архив ---------- */

test('распаковка складывает файлы в папку проекта', async () => {
  const buf = await makeZip({
    'отчёт.txt': 'первый файл',
    'вложенная/смета.csv': 'позиция;цена\nфундамент;100',
    'пустая/': '',
  });
  const target = path.join(project, 'архив-1');
  const result = await extractArchiveTo(buf, target);
  const paths = result.files.map((file) => file.path).sort();
  assert.deepEqual(paths, ['вложенная/смета.csv', 'отчёт.txt'].sort());
  assert.equal(fs.readFileSync(path.join(target, 'отчёт.txt'), 'utf8'), 'первый файл');
  assert.ok(result.totalBytes > 0);
});

test('служебный мусор из архива не распаковывается', async () => {
  const zip = new JSZip();
  zip.file('__MACOSX/._мусор', 'плохо');
  zip.file('.DS_Store', 'плохо');
  zip.file('нормальный.txt', 'хорошо');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const target = path.join(project, 'архив-2');
  const result = await extractArchiveTo(buf, target);
  assert.deepEqual(result.files.map((file) => file.path), ['нормальный.txt']);
  assert.ok(!fs.existsSync(path.join(target, '__MACOSX')), 'служебная папка распакована');
  assert.ok(!fs.existsSync(path.join(target, '.DS_Store')), 'служебный файл распакован');
});

test('повторная распаковка не затирает файлы без overwrite', async () => {
  const buf = await makeZip({ 'данные.txt': 'новая версия' });
  const target = path.join(project, 'архив-3');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'данные.txt'), 'правка человека', 'utf8');
  const first = await extractArchiveTo(buf, target);
  assert.equal(first.files.length, 0);
  assert.equal(first.skipped[0].reason, 'файл уже есть');
  assert.equal(fs.readFileSync(path.join(target, 'данные.txt'), 'utf8'), 'правка человека');
  const second = await extractArchiveTo(buf, target, { overwrite: true });
  assert.equal(second.files.length, 1);
  assert.equal(fs.readFileSync(path.join(target, 'данные.txt'), 'utf8'), 'новая версия');
});

test('имя записи очищается, а поддерживаемые форматы различаются', () => {
  assert.equal(safeEntryName('папка\\файл.txt'), 'папка/файл.txt');
  assert.equal(safeEntryName('../вверх.txt'), '');
  assert.equal(safeEntryName('C:/Windows/system32.txt'), '');
  assert.equal(archiveKind('файлы.zip'), 'zip');
  assert.equal(archiveKind('лог.gz'), 'gz');
  assert.equal(archiveKind('лог.tar.gz'), 'unsupported');
  assert.match(
    formatExtraction({ files: [{ path: 'a.txt', bytes: 10 }], skipped: [], totalBytes: 10 }, { folder: 'a' }),
    /Распаковано 1 файл/,
  );
});

test('инструмент extract_archive отказывает на rar понятным текстом', async () => {
  const rel = 'Материалы.rar';
  fs.writeFileSync(path.join(project, rel), Buffer.from('Rar!'));
  await assert.rejects(() => executeTool('extract_archive', { path: rel }, { workspace: project }), /только \.zip/);
});

test('инструмент extract_archive распаковывает и называет файлы для чтения', async () => {
  const buf = await makeZip({ 'текст.md': '# заголовок' });
  fs.writeFileSync(path.join(project, 'Пакет.zip'), buf);
  const result = await executeTool('extract_archive', { path: 'Пакет.zip' }, { workspace: project });
  assert.match(result.text, /Распаковано 1 файл/);
  assert.match(result.text, /read_document/);
  assert.ok(fs.existsSync(path.join(project, 'Пакет', 'текст.md')));
});

/* ---------- ссылки ---------- */

test('ссылки из текста вынимаются без дублей и хвостовой пунктуации', () => {
  const text = 'Смотри https://a.example/x, и (https://b.example/y). Ещё раз https://a.example/x.';
  assert.deepEqual(linksFromText(text), ['https://a.example/x', 'https://b.example/y']);
  assert.equal(linksFromText('нет ссылок').length, 0);
  assert.ok(LINK_LIMITS.maxUrls >= 6);
});

test('check_links различает живую, удалённую и закрытую страницу', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/alive') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>ok</h1>');
      return;
    }
    if (req.url === '/dead') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('нет такой страницы');
      return;
    }
    if (req.url === '/gated') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('forbidden');
      return;
    }
    res.writeHead(500);
    res.end('boom');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.DSHOW_ALLOW_PRIVATE_FETCH = '1';
  try {
    const base = `http://127.0.0.1:${port}`;
    const results = await checkLinks([`${base}/alive`, `${base}/dead`, `${base}/gated`, `${base}/boom`], { timeoutMs: 4000 });
    const byUrl = new Map(results.map((item) => [item.url.slice(base.length), item]));
    assert.equal(byUrl.get('/alive').state, 'alive');
    assert.equal(byUrl.get('/dead').state, 'dead');
    assert.equal(byUrl.get('/gated').state, 'gated');
    assert.equal(byUrl.get('/boom').state, 'error');
    const text = formatLinks(results);
    assert.match(text, /живых 1, мёртвых 1/);
    assert.match(text, /сервер закрыл автоматическую проверку/);
  } finally {
    delete process.env.DSHOW_ALLOW_PRIVATE_FETCH;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('check_links с закрытым локальным адресом не врёт о живости', async () => {
  delete process.env.DSHOW_ALLOW_PRIVATE_FETCH;
  const results = await checkLinks(['http://127.0.0.1:9/что-то'], { timeoutMs: 1500 });
  assert.equal(results[0].state, 'unknown');
  assert.ok(results[0].note.length > 0);
});

test('инструмент check_links берёт ссылки из файла проекта', async () => {
  fs.writeFileSync(
    path.join(project, 'источники.md'),
    'Ссылки:\n- https://example.com/a\n- https://example.com/a\n',
    'utf8',
  );
  const result = await executeTool('check_links', { path: 'источники.md' }, { workspace: project });
  assert.match(result.text, /Проверено 1 ссылка/);
});

/* ---------- сравнение ---------- */

test('сравнение показывает удалённую и добавленную строку', () => {
  const diff = diffLines('пункт 1\nаванс 30%\nсрок 90 дней', 'пункт 1\nаванс 50%\nсрок 90 дней\nгарантия 5 лет');
  assert.equal(diff.removed, 1);
  assert.equal(diff.added, 2);
  assert.equal(diff.changed, 3);
  assert.equal(diff.exact, true);
  const text = formatCompare({ ...diff, nameLeft: 'старый.docx', nameRight: 'новый.docx' });
  assert.match(text, /добавлено 2/);
  assert.match(text, /− аванс 30%/);
  assert.match(text, /\+ аванс 50%/);
});

test('одинаковые документы не выдают ложных отличий', () => {
  const text = 'пункт 1\n\nпункт 2   с лишними пробелами';
  const diff = diffLines(text, text);
  assert.equal(diff.changed, 0);
  assert.match(formatCompare({ ...diff, nameLeft: 'a.txt', nameRight: 'b.txt' }), /Отличий нет/);
  assert.deepEqual(textLines('  \n\nпункт 1\n'), ['пункт 1']);
});

test('сравнение читает настоящие файлы проекта', async () => {
  fs.writeFileSync(path.join(project, 'v1.txt'), 'условие: аванс 30 процентов\nсрок: 60 дней\n', 'utf8');
  fs.writeFileSync(
    path.join(project, 'v2.txt'),
    'условие: аванс 50 процентов\nсрок: 60 дней\nштраф: 0,1 процента\n',
    'utf8',
  );
  const result = await executeTool('compare_documents', { left: 'v1.txt', right: 'v2.txt' }, { workspace: project });
  assert.match(result.text, /Отличий 3: удалено 1, добавлено 2/);
  assert.equal(result.meta.added, 2);
  assert.equal(result.meta.removed, 1);
});

test('документы без текста дают понятную ошибку', () => {
  const empty = Buffer.from('');
  assert.throws(() => compareDocuments(empty, empty, { nameLeft: 'a.txt', nameRight: 'b.txt' }), /сравнивать нечего/);
});

/* ---------- регистрация ---------- */

test('новые инструменты объявлены единообразно', () => {
  const names = TOOL_DEFS.map((def) => def.function.name);
  for (const name of ['extract_archive', 'check_links', 'compare_documents']) {
    assert.ok(names.includes(name), `${name} нет в TOOL_DEFS`);
    assert.ok(TOOL_LABELS[name], `нет русской метки для ${name}`);
    const def = TOOL_DEFS.find((item) => item.function.name === name);
    assert.ok(def.function.description.length > 60, `слишком короткое описание у ${name}`);
    assert.equal(def.function.parameters.type, 'object');
  }
  assert.match(toolSummary('extract_archive', { path: 'a.zip', to: 'a' }), /a\.zip → a/);
  assert.match(toolSummary('compare_documents', { left: 'a', right: 'b' }), /a ↔ b/);
  assert.match(toolSummary('check_links', { urls: ['https://a', 'https://b'] }), /2 ссылки/);
});

/* ---------- итог ---------- */

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
fs.rmSync(work, { recursive: true, force: true });
console.log(failed ? `\n${failed} из ${tests.length} не прошли` : `\nвсе ${tests.length} прошли`);
process.exit(failed ? 1 : 0);

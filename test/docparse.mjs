/**
 * Проверка извлечения текста из документов (docs → просмотр «на чтение»).
 *
 * Главное здесь — время. Разбор PDF идёт в общем процессе сервера, поэтому
 * медленный разбор означает зависший сервис для всех. Однажды так и вышло:
 * регулярное выражение с вложенными квантификаторами уходило в перебор на
 * обычном PDF, и сервер перестал отвечать. Тест держит это под замком.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDocumentText, detectKind, kindLabel } from '../src/docparse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function time(fn) {
  const started = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { value, ms };
}

/* Небольшой настоящий PDF с текстом: одна страница, один поток контента. */
function tinyPdf() {
  const content = 'BT /F1 12 Tf 72 720 Td (Hello document) Tj T* (Second line) Tj ET';
  const objs = [
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj',
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj',
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>endobj',
    `4 0 obj<< /Length ${content.length} >>stream\n${content}\nendstream endobj`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = [];
  for (const obj of objs) {
    offsets.push(pdf.length);
    pdf += obj + '\n';
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

test('типы файлов распознаются для кнопки просмотра', () => {
  assert.equal(detectKind('отчёт.docx'), 'docx');
  assert.equal(detectKind('таблица.xlsx'), 'xlsx');
  assert.equal(detectKind('слайды.pptx'), 'pptx');
  assert.equal(detectKind('текст.txt'), 'text');
  assert.equal(detectKind('данные.csv'), 'text');
  assert.equal(detectKind('фото.png'), 'image');
  assert.equal(kindLabel('docx'), 'документ Word');
  assert.equal(kindLabel('pdf'), 'PDF');
});

test('текстовый PDF: строки извлекаются, текст читаемый', () => {
  const { value, ms } = time(() => extractDocumentText(tinyPdf(), 'hello.pdf'));
  assert.equal(value.kind, 'pdf');
  assert.match(value.text, /Hello document/);
  assert.match(value.text, /Second line/);
  assert.deepEqual(value.warnings, []);
  assert.ok(ms < 500, `разбор занял ${ms.toFixed(0)} мс`);
});

test('PDF с закодированным шрифтом: вместо мусора — понятное предупреждение', () => {
  // Поток из байтов Latin-1: настоящий текст так не выглядит, буквы не совпадают.
  const gibberish = 'BT /F1 12 Tf 72 720 Td (' + 'ÿØæþûìôîö'.repeat(40) + ') Tj ET';
  const pdf = tinyPdf().toString('latin1').replace('(Hello document) Tj T* (Second line) Tj', '(' + 'ÿØæþûìôîö'.repeat(40) + ') Tj');
  const { value, ms } = time(() => extractDocumentText(Buffer.from(pdf, 'latin1'), 'encoded.pdf'));
  assert.equal(value.text, '', 'мусорный текст не должен доходить до пользователя');
  assert.ok(
    value.warnings.some((w) => /закодирован встроенным шрифтом/.test(w)),
    `ожидали предупреждение о шрифте, получили: ${JSON.stringify(value.warnings)}`,
  );
  assert.ok(ms < 500, `разбор занял ${ms.toFixed(0)} мс; ${gibberish.length}`);
});

test('обычный PDF из demo/ разбирается быстро', () => {
  const file = path.join(root, 'demo', 'Психологическая-сессия.pdf');
  if (!fs.existsSync(file)) return;
  const buf = fs.readFileSync(file);
  const { value, ms } = time(() => extractDocumentText(buf, 'Психологическая-сессия.pdf'));
  assert.equal(value.kind, 'pdf');
  assert.ok(ms < 1500, `разбор PDF на ${buf.length} байт занял ${ms.toFixed(0)} мс`);
});

test('злой PDF: тысячи скобок и массивов не вешают разбор', () => {
  /* Именно такая начинка раньше замораживала сервер: вложенные квантификаторы
     в регулярном выражении. Разбор должен оставаться линейным. */
  const nasty = 'BT ' + '[('.repeat(20000) + ')'.repeat(20000) + '] TJ ' + 'Td '.repeat(20000) + 'ET';
  const pdf = tinyPdf().toString('latin1').replace('(Hello document) Tj T* (Second line) Tj', nasty);
  const { value, ms } = time(() => extractDocumentText(Buffer.from(pdf, 'latin1'), 'nasty.pdf'));
  assert.equal(value.kind, 'pdf');
  assert.ok(ms < 1500, `разбор злого PDF занял ${ms.toFixed(0)} мс`);
});

test('zip-бомба внутри docx не раздувает память', async () => {
  /* Один сжатый поток на 60 МБ: без ограничения распаковки такой файл
     забирает гигабайты памяти сервера. Разбор обязан его отсечь. */
  const { readZip } = await import('../src/zip.mjs');
  const zlib = await import('node:zlib');
  const name = Buffer.from('word/document.xml', 'utf8');
  const rawSize = 60 * 1024 * 1024;
  const payload = zlib.deflateRawSync(Buffer.alloc(rawSize, 0x41));

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(rawSize, 22);
  local.writeUInt16LE(name.length, 26);
  const localPart = Buffer.concat([local, name, payload]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(rawSize, 24);
  central.writeUInt16LE(name.length, 28);
  const centralPart = Buffer.concat([central, name]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);

  const bomb = Buffer.concat([localPart, centralPart, end]);
  const started = process.hrtime.bigint();
  const zip = readZip(bomb);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(zip.size, 0, 'бомба не должна попадать в разобранные записи');
  assert.equal(zip.skippedCount, 1, 'пропуск должен быть учтён');
  assert.ok(ms < 2000, `распаковка заняла ${ms.toFixed(0)} мс`);
});

test('текст и Markdown отдаются как есть, размер ограничен', () => {
  const long = 'Строка текста. '.repeat(20000);
  const { value } = time(() => extractDocumentText(Buffer.from(long, 'utf8'), 'заметки.md', '', { maxChars: 5000 }));
  assert.equal(value.kind, 'text');
  assert.ok(value.text.length <= 5000 + 120, `длина ${value.text.length}`);
  assert.ok(value.warnings.some((w) => /показана только часть/.test(w)));
});

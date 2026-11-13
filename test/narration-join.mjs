// Склейка частей озвучки в один MP3: тот же звук, без переозвучки и без правки
// текста. Проверяем на синтетических MPEG-кадрах — сеть и синтез не нужны.
// Главное: результат содержит ровно сумму кадров частей, служебные теги убраны,
// а неполный комплект или разный формат частей честно отказываются склеиваться.
//
//   node test/narration-join.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { joinNarrationParts, listNarrationParts, narrationArchiveDir, scanMp3 } = await import(
  '../src/narration-join.mjs'
);

let passed = 0;
const failures = [];
const ok = (name, details = '') => {
  passed += 1;
  console.log(`  ok  ${name}${details ? ` — ${details}` : ''}`);
};
const fail = (name, error) => {
  failures.push(`${name}: ${error}`);
  console.log(`  FAIL ${name} — ${error}`);
};
async function test(name, fn) {
  try {
    await fn();
  } catch (error) {
    fail(name, error.message || String(error));
  }
}
const check = (name, condition, details = '') => (condition ? ok(name, details) : fail(name, details || 'условие не выполнено'));

/* Настоящий MPEG-1 Layer III кадр: 128 кбит/с, 44,1 кГц, стерео, 1152 сэмпла,
   длина 417 байт. Заголовок FF FB 40 40 и «тишина» в остальном кадре. */
const FRAME_SECONDS = 1152 / 44100;
function frame(byte = 0) {
  const head = Buffer.from([0xff, 0xfb, 0x40, 0x40]);
  const body = Buffer.alloc(417 - 4, byte);
  return Buffer.concat([head, body]);
}
function mpeg(count, { byte = 0, rateIndex = 0 } = {}) {
  /* rateIndex влияет на заголовок и длину кадра: 0 — 44100, 1 — 48000. */
  const head = rateIndex === 0 ? [0xff, 0xfb, 0x40, 0x40] : [0xff, 0xfb, 0x44, 0x40];
  const length = rateIndex === 0 ? 417 : Math.floor((144 * 128000) / 48000);
  const one = Buffer.concat([Buffer.from(head), Buffer.alloc(length - 4, byte)]);
  return Buffer.concat(Array.from({ length: count }, () => one));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'narration-join-'));
const book = path.join(root, 'Теория игр.pdf');
fs.writeFileSync(book, 'x');

await test('разбор одного MP3: кадры и длительность', async () => {
  const scan = scanMp3(mpeg(100));
  check('кадров 100', scan.frames === 100, String(scan.frames));
  check('длительность ≈ 2,6 с', Math.abs(scan.seconds - 100 * FRAME_SECONDS) < 0.01, `${scan.seconds} с`);
  check('формат прочитан', scan.format?.sampleRate === 44100 && scan.format?.channels === 2, JSON.stringify(scan.format));
  check('ID3-тег в начале не считается звуком', scanMp3(Buffer.concat([id3(64), mpeg(2)])).frames === 2, '');
});

function id3(size) {
  /* Синтетический ID3v2.3-тег: 10-байтный заголовок (размер — synchsafe) и
     «полезная нагрузка» size. Размер в заголовке обязателен: без него парсер
     не знает, где кончается тег, и служебные байты попали бы в звук. */
  const head = Buffer.from([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00,
    (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
  ]);
  return Buffer.concat([head, Buffer.alloc(size, 0)]);
}

await test('части находятся по имени документа', async () => {
  for (const index of [1, 2, 3]) {
    fs.writeFileSync(path.join(root, `Теория игр — часть ${index} из 3.mp3`), mpeg(10 * index));
  }
  const found = listNarrationParts(book);
  check('нашлись три части', found.parts.length === 3, found.parts.map((part) => part.name).join(' | '));
  check('комплект полный', found.complete === true);
  check('порядок по номеру', found.parts.map((part) => part.index).join(',') === '1,2,3', found.parts.map((part) => part.index).join(','));
  check('чужие mp3 не приписаны', !found.parts.some((part) => part.name.includes('Другая')), '');
});

await test('склейка: сумма кадров, части уходят в архив', async () => {
  const before = listNarrationParts(book).parts.map((part) => fs.statSync(part.path).size);
  const archive = narrationArchiveDir(root, 1234);
  const res = joinNarrationParts(book, { archiveDir: archive });
  check('результат — один файл', res.name === 'Теория игр.mp3', res.name);
  check('не «уже собран»', res.already === false);
  const scan = scanMp3(fs.readFileSync(res.path));
  check('кадров ровно сумма частей', scan.frames === 60, `${scan.frames} из 60`);
  check('длительность совпала', Math.abs(scan.seconds - 60 * FRAME_SECONDS) < 0.01, `${scan.seconds} с`);
  check('размер = сумма частей', fs.statSync(res.path).size === before.reduce((sum, size) => sum + size, 0), `${res.size} байт`);
  check('части убраны из папки', fs.readdirSync(root).filter((name) => name.includes('часть')).length === 0, fs.readdirSync(root).join(', '));
  check('части лежат в архиве', fs.readdirSync(archive).length === 3, fs.readdirSync(archive).join(', '));
  check('в отчёте три архивные части', res.archived.length === 3, res.archived.join(', '));
  check('без предупреждений', res.warnings.length === 0, res.warnings.join(', '));
});

await test('повторная склейка видит уже готовый файл', async () => {
  const res = joinNarrationParts(book, { archiveDir: narrationArchiveDir(root, 2345) });
  check('уже собран', res.already === true);
  check('имя то же', res.name === 'Теория игр.mp3', res.name);
  check('звук на месте', res.seconds > 1, `${res.seconds} с`);
});

await test('ID3-теги частей не попадают в результат', async () => {
  const dir = path.join(root, 'книга2');
  fs.mkdirSync(dir, { recursive: true });
  const doc = path.join(dir, 'Книга два.docx');
  fs.writeFileSync(doc, 'x');
  for (const index of [1, 2]) {
    const part = Buffer.concat([id3(128), mpeg(20)]);
    fs.writeFileSync(path.join(dir, `Книга два — часть ${index} из 2.mp3`), part);
  }
  const res = joinNarrationParts(doc, { archiveDir: narrationArchiveDir(dir, 3456) });
  const buffer = fs.readFileSync(res.path);
  check('тега ID3 в результате нет', buffer.subarray(0, 3).toString('latin1') !== 'ID3', buffer.subarray(0, 3).toString('latin1'));
  check('кадров 40', scanMp3(buffer).frames === 40, String(scanMp3(buffer).frames));
  check('размер = только звук', buffer.length === 40 * 417, `${buffer.length} байт`);
});

await test('неполный комплект не склеивается', async () => {
  const dir = path.join(root, 'книга3');
  fs.mkdirSync(dir, { recursive: true });
  const doc = path.join(dir, 'Книга три.pdf');
  fs.writeFileSync(doc, 'x');
  fs.writeFileSync(path.join(dir, 'Книга три — часть 1 из 3.mp3'), mpeg(5));
  fs.writeFileSync(path.join(dir, 'Книга три — часть 3 из 3.mp3'), mpeg(5));
  let error = '';
  try {
    joinNarrationParts(doc, { archiveDir: narrationArchiveDir(dir, 4567) });
  } catch (problem) {
    error = problem.message;
  }
  check('отказ с причиной', /неполные/.test(error), error);
  check('части не тронуты', fs.readdirSync(dir).filter((name) => name.includes('часть')).length === 2, '');
});

await test('части с разной частотой дискретизации не склеиваются', async () => {
  const dir = path.join(root, 'книга4');
  fs.mkdirSync(dir, { recursive: true });
  const doc = path.join(dir, 'Книга четыре.pdf');
  fs.writeFileSync(doc, 'x');
  fs.writeFileSync(path.join(dir, 'Книга четыре — часть 1 из 2.mp3'), mpeg(10));
  fs.writeFileSync(path.join(dir, 'Книга четыре — часть 2 из 2.mp3'), mpeg(10, { rateIndex: 1 }));
  let error = '';
  try {
    joinNarrationParts(doc, { archiveDir: narrationArchiveDir(dir, 5678) });
  } catch (problem) {
    error = problem.message;
  }
  check('отказ объясняет формат', /Гц/.test(error), error);
  check('единый файл не создан', !fs.existsSync(path.join(dir, 'Книга четыре.mp3')), '');
});

await test('нет ни частей, ни готового файла — понятная ошибка', async () => {
  const doc = path.join(root, 'Пустая книга.pdf');
  fs.writeFileSync(doc, 'x');
  let error = '';
  try {
    joinNarrationParts(doc, {});
  } catch (problem) {
    error = problem.message;
  }
  check('ошибка называет документ', error.includes('Пустая книга.pdf'), error);
});

await test('keepParts оставляет части на месте', async () => {
  const dir = path.join(root, 'книга5');
  fs.mkdirSync(dir, { recursive: true });
  const doc = path.join(dir, 'Книга пять.pdf');
  fs.writeFileSync(doc, 'x');
  for (const index of [1, 2]) fs.writeFileSync(path.join(dir, `Книга пять — часть ${index} из 2.mp3`), mpeg(5));
  const res = joinNarrationParts(doc, { keepParts: true });
  check('склейка сделана', scanMp3(fs.readFileSync(res.path)).frames === 10, String(scanMp3(fs.readFileSync(res.path)).frames));
  check('части остались', fs.readdirSync(dir).filter((name) => name.includes('часть')).length === 2, '');
  check('архив не тронут', res.archived.length === 0, '');
});

fs.rmSync(root, { recursive: true, force: true });

const failed = failures.length;
console.log(`\nИтого: ${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);

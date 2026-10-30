/**
 * Стелс-браузер obscura: разбор архива и признаки заглушки.
 *
 * Здесь проверяется то, что однажды уже сломалось молча: распаковка тарбола
 * потоком. Первая версия склеивала каждый приходящий чанк через Buffer.concat,
 * и на файле в 16 МБ из сети это давало гигабайты копирования — на живом сервисе
 * установка «висела» без ошибки в журнале. Поэтому тест гоняет архив кусками по
 * 16 КБ (как сеть) и требует не только правильных размеров файлов, но и
 * уложиться в бюджет времени.
 *
 * Запуск: node test/obscura.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obscura-test-'));
process.env.DSHOW_DATA_DIR = path.join(tmp, 'data');
const { extractTarStream, extractTarGz, looksLikeChallenge, obscuraInfo, obscuraConfigured } = await import(
  new URL('../src/obscura.mjs', import.meta.url).href
);

/** Заголовок ustar на 512 байт; поле размера — восьмеричное, как в настоящем tar. */
function header(name, size, type = '0') {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 'utf8');
  block.write('0000000\0', 108, 'utf8');
  block.write('0000000\0', 116, 'utf8');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
  block.write('00000000000\0', 136, 'utf8');
  block.write('        ', 148, 'utf8');
  block.write(type, 156, 'utf8');
  block.write('ustar\0', 257, 'utf8');
  block.write('00', 263, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  return block;
}

function entry(name, data) {
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header(name, data.length), data, pad]);
}

function archiveOf(files) {
  const parts = [];
  for (const [name, data] of files) parts.push(entry(name, data));
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

/** Отдаёт буфер кусками: так ведёт себя сеть, а не локальный gunzipSync. */
async function* chunks(buffer, size) {
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, Math.min(offset + size, buffer.length));
  }
}

const big = Buffer.alloc(16 * 1024 * 1024, 7);
const small = Buffer.from('obscura test: разметка не должна потеряться', 'utf8');
const gz = archiveOf([
  ['obscura', big],
  ['obscura-worker', small],
]);

const startedStream = Date.now();
const dirStream = path.join(tmp, 'stream');
await extractTarStream(Readable.from(chunks(gz, 16 * 1024)).pipe(zlib.createGunzip()), dirStream);
const streamMs = Date.now() - startedStream;

assert.equal(fs.statSync(path.join(dirStream, 'obscura')).size, big.length, 'большой файл распакован не целиком');
assert.equal(fs.readFileSync(path.join(dirStream, 'obscura-worker'), 'utf8'), small.toString('utf8'), 'текст второго файла испорчен');
assert.equal(fs.readFileSync(path.join(dirStream, 'obscura')).subarray(0, 4).toString('hex'), '07070707', 'содержимое большого файла не совпало');
console.log(`ok   поток по 16 КБ: два файла, ${streamMs} мс на 16 МБ`);

/* Старый квадратичный разбор на этом объёме шёл секундами: бюджет ловит регресс. */
assert.ok(streamMs < 4000, `распаковка потока идёт слишком долго: ${streamMs} мс`);
console.log('ok   распаковка укладывается в бюджет времени');

const startedSync = Date.now();
const dirSync = path.join(tmp, 'sync');
await extractTarGz(gz, dirSync);
const syncMs = Date.now() - startedSync;
assert.equal(fs.statSync(path.join(dirSync, 'obscura')).size, big.length);
console.log(`ok   готовый буфер через gunzipSync: ${syncMs} мс`);

/* Запись за пределы каталога распаковки не должна создаваться. */
const escape = archiveOf([['../escape.txt', Buffer.from('нельзя', 'utf8')], ['./nested/ok.txt', Buffer.from('можно', 'utf8')]]);
const dirSafe = path.join(tmp, 'safe');
await extractTarGz(escape, dirSafe);
assert.equal(fs.existsSync(path.join(tmp, 'escape.txt')), false, 'архив записал файл выше каталога распаковки');
assert.ok(fs.existsSync(path.join(dirSafe, 'nested', 'ok.txt')), 'обычный вложенный файл потерялся');
console.log('ok   выход за каталог блокируется, обычные пути работают');

assert.equal(looksLikeChallenge('Just a moment... Checking your browser before accessing'), true);
assert.equal(looksLikeChallenge('Antibot Challenge Page'), true);
assert.equal(looksLikeChallenge('Слишком много запросов с вашего IP. Обновить страницу'), true);
/* Так выглядит слайдер-капча ozon после очистки страницы браузером. */
assert.equal(looksLikeChallenge('# Slide the slider to fit the puzzle piece into the outline'), true);
assert.equal(looksLikeChallenge('![](https://cdn2.ozone.ru/s3/abt-challenge/cpt/12/x.png)'), true);
assert.equal(looksLikeChallenge('Обычная статья про кофе и рецепты'), false);
assert.equal(looksLikeChallenge(''), false);
console.log('ok   заглушки анти-бота распознаются, обычный текст — нет');

const info = obscuraInfo();
assert.equal(info.version, '0.2.5');
assert.equal(typeof info.enabled, 'boolean');
assert.equal(typeof info.ready, 'boolean');
assert.equal(info.sizeBytes, 74936793);
assert.match(info.source, /obscura-x86_64-linux-stealth\.tar\.gz$/);
console.log('ok   статус движка отдаёт версию, адрес и размер релиза');

process.env.DSHOW_OBSCURA = 'off';
assert.equal(obscuraInfo().enabled, false, 'DSHOW_OBSCURA=off должен выключать движок');
assert.equal(obscuraConfigured(), false);
delete process.env.DSHOW_OBSCURA;
console.log('ok   DSHOW_OBSCURA=off выключает движок целиком');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nвсе 7 прошли');

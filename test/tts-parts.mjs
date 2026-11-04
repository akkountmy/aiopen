/**
 * Живой тест озвучки частями. Проверяем новый договор с пользователем:
 *   • книга превращается в НЕСКОЛЬКО MP3 с понятными именами;
 *   • рядом лежит ровно один Word с текстом книги;
 *   • части пронумерованы и каждая играется отдельно;
 *   • лишних документов (txt, кусков, черновиков) не появляется.
 *
 * Требует сеть (Edge TTS) и данные предпросмотра. Запуск:
 *   node test/tts-parts.mjs            — 3 части по 3 минуты
 *   node test/tts-parts.mjs 8          — части по 8 минут
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.DSHOW_DATA_DIR = process.env.DSHOW_DATA_DIR || path.resolve('.preview-data');

const { executeTool } = await import('../src/tools.mjs');
const { getJob } = await import('../src/tts.mjs');
const { extractDocumentText } = await import('../src/docparse.mjs');
const { splitIntoParts } = await import('../src/tts.mjs');

const MINUTES = Math.max(2, Number(process.argv[2]) || 3);
const workspace = path.resolve('.preview-data/workspaces/p_mvqxx8b100c814af2d');

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
const test = async (name, fn) => {
  try {
    await fn();
  } catch (error) {
    fail(name, error.message || String(error));
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/* Исходник: две «главы» с заголовками — по ним и должны пройти границы частей. */
const BOOK = [
  'ГЛАВА ПЕРВАЯ. РЫНОК ЛИЗИНГА',
  '',
  ...Array.from({ length: 12 }, (_, index) =>
    `Лизинговый рынок растёт третий год подряд. Сегмент ${index + 1} прибавил около ${10 + index} процентов, а объём новых сделок превысил прошлогодний уровень. `.repeat(2),
  ),
  '',
  'ГЛАВА ВТОРАЯ. СДЕЛКИ',
  '',
  ...Array.from({ length: 12 }, (_, index) =>
    `Крупнейшие сделки года связаны с транспортом и оборудованием. Сделка ${index + 1} закрыта в срок, а средний чек вырос до ${3 + index} миллионов рублей. `.repeat(2),
  ),
].join('\n');

const source = path.join(workspace, 'Тестовая книга для озвучки.txt');
fs.writeFileSync(source, BOOK, 'utf8');

await test('нарезка на части по границам глав', () => {
  const parts = splitIntoParts(BOOK, { minutes: MINUTES });
  assert(parts.length >= 2, `частей ${parts.length}, ожидалось минимум 2`);
  const target = MINUTES * 750;
  for (const part of parts) {
    assert(part.length <= target * 1.8, `часть ${part.length} знаков при цели ${target}`);
  }
  const joined = parts.join(' ');
  assert(joined.includes('ГЛАВА ПЕРВАЯ') && joined.includes('ГЛАВА ВТОРАЯ'), 'заголовки потерялись при нарезке');
  assert(
    parts.every((part) => part.trim().length > 0),
    'пустая часть',
  );
});

let result = null;
await test('инструмент ставит озвучку частями', async () => {
  result = await executeTool('narrate_document', { path: path.basename(source), minutes: MINUTES }, { workspace, ownerId: 'test-parts' });
  assert(result.meta?.jobId, 'нет номера задания');
  assert(result.meta.parts >= 2, `частей ${result.meta.parts}`);
  assert(/\.docx$/.test(result.meta.word || ''), `Word не назван: ${result.meta.word}`);
  ok('имя Word', result.meta.word);
});

await test('синтез доходит до конца', async () => {
  const jobId = result.meta.jobId;
  const started = Date.now();
  for (;;) {
    const job = getJob(jobId, 'test-parts');
    assert(job, 'задание пропало');
    if (job.status === 'done') {
      ok('задание готово', `${Math.round((Date.now() - started) / 1000)} с, файлов ${job.files.length}`);
      result.job = job;
      return;
    }
    if (job.status === 'failed' || job.status === 'cancelled') throw new Error(`${job.status}: ${job.error || ''}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
});

await test('каждая часть — отдельный файл с номером в имени', () => {
  const job = result.job;
  assert(job.files.length >= 2, `файлов ${job.files.length}`);
  const indexes = job.files.map((file) => file.index).sort((a, b) => a - b);
  assert(
    indexes.every((value, index) => value === index + 1),
    `нумерация частей: ${indexes.join(',')}`,
  );
  for (const file of job.files) {
    const full = path.join(workspace, file.name);
    assert(fs.existsSync(full), `нет файла ${file.name}`);
    assert(fs.statSync(full).size > 20 * 1024, `${file.name} подозрительно мал`);
    assert(/часть \d+ из \d+\.mp3$/.test(file.name), `имя части не по шаблону: ${file.name}`);
    assert(file.seconds > 30, `длительность части ${file.name}: ${file.seconds} с`);
  }
  ok('имена частей', job.files.map((file) => file.name).join(' | '));
});

await test('Word с текстом книги один и содержит текст', () => {
  const full = path.join(workspace, result.meta.word);
  assert(fs.existsSync(full), 'Word не создан');
  const parsed = extractDocumentText(fs.readFileSync(full), result.meta.word, '', { maxChars: 300000 });
  const text = String(parsed.text || '');
  assert(text.includes('ГЛАВА ПЕРВАЯ'), 'в Word нет первой главы');
  assert(text.includes('Крупнейшие сделки года'), 'в Word нет второй главы');
  ok('Word', `${Math.round(fs.statSync(full).size / 1024)} КБ, ${text.length.toLocaleString('ru-RU')} знаков`);
});

await test('лишних файлов не появилось', () => {
  const names = fs.readdirSync(workspace).filter((name) => name.startsWith('Тестовая книга для озвучки'));
  const junk = names.filter((name) => !/\.(txt|mp3|docx)$/.test(name) || /\(озвучка \d+\)/.test(name));
  assert(!junk.length, `лишние файлы: ${junk.join(', ')}`);
  const docs = names.filter((name) => name.endsWith('.docx'));
  assert(docs.length === 1, `документов Word ${docs.length}: ${docs.join(', ')}`);
  ok('файлы в папке', names.join(' | '));
});

/* Прибираем за собой: исходник, части и Word — этой книге нечего делать в проекте. */
for (const name of fs.readdirSync(workspace)) {
  if (name.startsWith('Тестовая книга для озвучки')) fs.rmSync(path.join(workspace, name), { force: true });
}

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  for (const item of failures) console.log(`  − ${item}`);
  process.exit(1);
}

/**
 * Дневная сводка качества: запись, чтение, уборка, свод по дням.
 *
 * Запуск: node test/quality.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  QUALITY_LIMITS,
  qualityDir,
  qualityRecord,
  recordQuality,
  readQuality,
  summarizeQuality,
  formatQuality,
  pruneQuality,
  kindLabel,
} = await import('../src/quality.mjs');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quality-'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const now = new Date('2026-10-25T12:00:00.000Z');

test('запись ответа ложится в файл дня, без текста ответа', () => {
  const record = qualityRecord({
    chatId: 'chat-1',
    projectId: 'proj-1',
    route: { profile: 'pro', model: 'deepseek-pro' },
    answerChars: 1200,
    tools: ['create_word', 'use_skill', 'create_word'],
    review: { checked: true, verdict: 'fix', fixed: true, attempts: 2, model: 'deepseek-pro', issues: [{ kind: 'figure', severity: 'high' }] },
    usage: { tokensIn: 9000, tokensOut: 700 },
    now,
  });
  assert.equal(record.route, 'pro');
  assert.equal(record.issues.length, 1, 'вид находки должен сохраниться');
  assert.equal(record.chars, 1200);
  assert.equal(record.tokensIn, 9000);
  assert.ok(!('text' in record), 'текста ответа в статистике быть не должно');
  assert.ok(recordQuality(dataDir, record));
  const file = path.join(qualityDir(dataDir), '2026-10-25.jsonl');
  assert.ok(fs.existsSync(file), 'нет файла дня');
  const raw = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(raw.length, 1);
  const parsed = JSON.parse(raw[0]);
  assert.equal(parsed.chat, 'chat-1');
  assert.ok(!JSON.stringify(parsed).includes('create_word", "use_skill", "create_word'), 'инструменты должны быть без повторов');
});

test('запись не бросает на плохих данных', () => {
  assert.equal(recordQuality('', qualityRecord({ now })), false);
  assert.equal(recordQuality(dataDir, null), false);
  assert.equal(recordQuality(path.join(dataDir, 'index.json'), qualityRecord({ now })), true, 'файл вместо папки: запись упала молча, но не бросила');
});

test('чтение за N дней видит сегодняшний день', () => {
  const records = readQuality(dataDir, { days: 3, now });
  assert.equal(records.length, 1);
  assert.equal(records[0].chat, 'chat-1');
});

test('свод по дням: итоги, находки по видам, доля правок', () => {
  const records = [
    { ts: '2026-10-24T09:00:00Z', route: 'flash', checked: true, verdict: 'ok', issues: [], fixed: false, attempts: 0, tools: ['read_file'], tokensIn: 1000, tokensOut: 100 },
    { ts: '2026-10-24T10:00:00Z', route: 'flash', checked: true, verdict: 'fix', issues: [{ kind: 'figure', severity: 'high' }], fixed: true, attempts: 1, tools: ['calculate'], tokensIn: 1000, tokensOut: 100 },
    { ts: '2026-10-25T09:00:00Z', route: 'pro', checked: true, verdict: 'fix', issues: [{ kind: 'figure', severity: 'high' }, { kind: 'incomplete', severity: 'medium' }], fixed: true, attempts: 2, tools: ['calculate'], tokensIn: 2000, tokensOut: 200 },
  ];
  const summary = summarizeQuality(records);
  assert.equal(summary.days.length, 2);
  assert.deepEqual(summary.days.map((row) => row.day), ['2026-10-25', '2026-10-24'], 'дни по убыванию');
  assert.equal(summary.totals.answers, 3);
  assert.equal(summary.totals.reviewed, 3);
  assert.equal(summary.totals.fixed, 2);
  assert.equal(summary.totals.secondRounds, 1);
  assert.equal(summary.totals.pro, 1);
  assert.equal(summary.totals.high, 2);
  assert.deepEqual(summary.totals.issues, { figure: 2, incomplete: 1 });
  const text = formatQuality(summary);
  assert.match(text, /Дневная сводка качества/);
  assert.match(text, /ответов\s+3/);
  assert.match(text, /правилось 2 \(67%\)/);
  assert.match(text, /сильная модель 1 \(33%\)/);
  assert.match(text, /числа без опоры: 2/);
  assert.match(text, /«готово» при открытых пунктах: 1/);
});

test('пустая сводка объясняет себя, а не печатает пустую таблицу', () => {
  const text = formatQuality(summarizeQuality([]));
  assert.match(text, /Статистики пока нет/);
  assert.equal(kindLabel('figure'), 'числа без опоры');
  assert.equal(kindLabel('неизвестный'), 'неизвестный', 'неизвестный вид показывается как есть');
});

test('битая строка в файле не теряет весь день', () => {
  fs.writeFileSync(path.join(qualityDir(dataDir), '2026-10-23.jsonl'), '{"ts":"2026-10-23T08:00:00Z","route":"flash"}\nне json\n', 'utf8');
  const records = readQuality(dataDir, { days: 3, now });
  const day = records.filter((record) => String(record.ts).startsWith('2026-10-23'));
  assert.equal(day.length, 1, `записей за 23-е: ${day.length}`);
});

test('уборка удаляет дни старше срока и не трогает свежие', () => {
  const old = new Date(now.getTime() - (QUALITY_LIMITS.keepDays + 5) * 24 * 60 * 60 * 1000);
  const oldName = `${old.toISOString().slice(0, 10)}.jsonl`;
  fs.writeFileSync(path.join(qualityDir(dataDir), oldName), '{"ts":"x"}\n', 'utf8');
  fs.writeFileSync(path.join(qualityDir(dataDir), 'не-наш.txt'), 'x', 'utf8');
  const removed = pruneQuality(dataDir, { now });
  assert.ok(removed >= 1, 'старый день должен удалиться');
  assert.ok(!fs.existsSync(path.join(qualityDir(dataDir), oldName)), 'старый день остался');
  assert.ok(fs.existsSync(path.join(qualityDir(dataDir), '2026-10-25.jsonl')), 'свежий день удалён напрасно');
  assert.ok(fs.existsSync(path.join(qualityDir(dataDir), 'не-наш.txt')), 'чужие файлы трогать нельзя');
});

fs.rmSync(dataDir, { recursive: true, force: true });

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
console.log(failed ? `\n${failed} из ${tests.length} не прошли` : `\nвсе ${tests.length} прошли`);
process.exit(failed ? 1 : 0);

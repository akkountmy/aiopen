/**
 * Тесты резервных копий состояния: копия делается целиком, повтор в тот же день
 * перезаписывает её, старые копии ротируются. Запуск: node test/backup.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-'));
process.env.DSH_DATA_DIR = tmpRoot;

const { CHATS_DIR, DATA_DIR } = await import('../src/config.mjs');
const { backupsDir, listBackups, rotateBackups, snapshotState } = await import('../src/backup.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* Каждый тест начинает с чистой папки копий: иначе счётчики перетекают. */
function reset() {
  fs.rmSync(backupsDir(), { recursive: true, force: true });
  fs.rmSync(CHATS_DIR, { recursive: true, force: true });
  fs.mkdirSync(backupsDir(), { recursive: true });
  seed();
}

function seed() {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify({ projects: [{ id: 'p1' }], chats: [{ id: 'c1' }] }), 'utf8');
  fs.writeFileSync(path.join(CHATS_DIR, 'c1.json'), JSON.stringify({ messages: [{ role: 'user', content: 'привет' }] }), 'utf8');
  fs.writeFileSync(path.join(CHATS_DIR, 'c2.json'), JSON.stringify({ messages: [{ role: 'user', content: 'ещё' }] }), 'utf8');
}

test('копия включает индекс и все диалоги', () => {
  reset();
  const result = snapshotState({ now: new Date('2026-10-20T03:00:00.000Z') });
  assert.equal(result.id, '2026-10-20');
  assert.equal(result.chats, 2);
  const dir = path.join(backupsDir(), result.id);
  assert.ok(fs.existsSync(path.join(dir, 'index.json')));
  assert.ok(fs.existsSync(path.join(dir, 'chats', 'c1.json')));
  assert.ok(fs.existsSync(path.join(dir, 'chats', 'c2.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.chats, 2);
  assert.equal(manifest.index, true);
});

test('повтор в тот же день перезаписывает копию, а не плодит новую', () => {
  reset();
  snapshotState({ now: new Date('2026-10-21T03:00:00.000Z') });
  fs.writeFileSync(path.join(CHATS_DIR, 'c3.json'), JSON.stringify({ messages: [] }), 'utf8');
  const again = snapshotState({ now: new Date('2026-10-21T09:00:00.000Z') });
  assert.equal(again.chats, 3);
  assert.equal(listBackups().filter((item) => item.id === '2026-10-21').length, 1);
});

test('старые копии удаляются, свежие остаются', () => {
  reset();
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']) {
    snapshotState({ now: new Date(`${day}T03:00:00.000Z`), keep: 3 });
  }
  const ids = listBackups().map((item) => item.id);
  assert.equal(ids.length, 3, `осталось ${ids.length} копий: ${ids.join(', ')}`);
  assert.equal(ids[0], '2026-10-05', 'самая свежая копия должна остаться первой');
  assert.ok(!ids.includes('2026-10-01'), 'самая старая копия не удалена');
});

test('ротация по объёму не оставляет меньше двух копий', () => {
  reset();
  snapshotState({ now: new Date('2026-10-10T03:00:00.000Z') });
  snapshotState({ now: new Date('2026-10-11T03:00:00.000Z') });
  const removed = rotateBackups({ keep: 30, maxBytes: 1, minKeep: 2 });
  assert.equal(removed.length, 0, 'удалять нечего: копий всего две');
  assert.equal(listBackups().length, 2);
});

test('копия создаётся, даже если индекс не записан', () => {
  reset();
  fs.rmSync(path.join(DATA_DIR, 'index.json'), { force: true });
  const result = snapshotState({ now: new Date('2026-12-01T03:00:00.000Z') });
  assert.ok(result.id);
  assert.equal(result.chats, 2, 'диалоги копируются и без индекса');
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

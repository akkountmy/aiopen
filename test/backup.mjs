/**
 * Тесты резервных копий состояния: копия делается целиком (переписки, индекс и
 * файлы проектов), повтор в тот же день перезаписывает её, старые копии
 * ротируются, бюджет файлов не съедает переписки.
 * Запуск: node test/backup.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-'));
process.env.DSH_DATA_DIR = tmpRoot;

const { CHATS_DIR, DATA_DIR } = await import('../src/config.mjs');
const { backupsDir, listBackups, rotateBackups, snapshotState, workspacesDir } = await import('../src/backup.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* Каждый тест начинает с чистой папки копий: иначе счётчики перетекают. */
function reset() {
  fs.rmSync(backupsDir(), { recursive: true, force: true });
  fs.rmSync(CHATS_DIR, { recursive: true, force: true });
  fs.rmSync(workspacesDir(), { recursive: true, force: true });
  fs.mkdirSync(backupsDir(), { recursive: true });
  seed();
}

function seed() {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify({ projects: [{ id: 'p1' }], chats: [{ id: 'c1' }] }), 'utf8');
  fs.writeFileSync(path.join(CHATS_DIR, 'c1.json'), JSON.stringify({ messages: [{ role: 'user', content: 'привет' }] }), 'utf8');
  fs.writeFileSync(path.join(CHATS_DIR, 'c2.json'), JSON.stringify({ messages: [{ role: 'user', content: 'ещё' }] }), 'utf8');
  /* Файлы проекта и срез истории: именно их человек боится потерять. */
  const project = path.join(workspacesDir(), 'p1');
  fs.mkdirSync(path.join(project, 'Готовые документы'), { recursive: true });
  fs.mkdirSync(path.join(project, '.history'), { recursive: true });
  fs.writeFileSync(path.join(project, 'Готовые документы', 'Отчёт.docx'), 'документ', 'utf8');
  fs.writeFileSync(path.join(project, '.history', 'history-1.txt'), 'старый разговор', 'utf8');
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

test('копия включает файлы проектов и срезы истории', () => {
  reset();
  const result = snapshotState({ now: new Date('2026-10-22T03:00:00.000Z') });
  const dir = path.join(backupsDir(), result.id);
  assert.equal(result.workspaces, 1, 'проект с файлами попал в копию');
  assert.ok(fs.existsSync(path.join(dir, 'workspaces', 'p1', 'Готовые документы', 'Отчёт.docx')));
  assert.ok(fs.existsSync(path.join(dir, 'workspaces', 'p1', '.history', 'history-1.txt')));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.workspaces, 1);
  assert.equal(manifest.skippedFiles, 0);
});

test('при тесном бюджете переписки копируются целиком, файлы — что влезло', () => {
  reset();
  const result = snapshotState({ now: new Date('2026-10-23T03:00:00.000Z'), maxSnapshotBytes: 0 });
  assert.equal(result.chats, 2, 'переписки не зависят от бюджета файлов');
  assert.equal(result.workspaces, 0);
  assert.equal(result.files, 0);
  assert.ok(result.skippedFiles >= 2, `файлы помечены пропущенными: ${result.skippedFiles}`);
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

test('список копий показывает проекты и размер', () => {
  reset();
  snapshotState({ now: new Date('2026-12-02T03:00:00.000Z') });
  const [item] = listBackups();
  assert.equal(item.id, '2026-12-02');
  assert.equal(item.workspaces, 1);
  assert.ok(item.bytes > 0);
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

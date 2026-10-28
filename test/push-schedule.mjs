import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/* Каталог данных модуль читает при импорте — задаём его до динамического импорта. */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-push-schedule-'));
process.env.DSHOW_DATA_DIR = DATA_DIR;

const {
  PUSH_SCHEDULE_FILE,
  cancelPushSchedule,
  claimPushSchedule,
  createPushSchedule,
  duePushSchedule,
  finishPushSchedule,
  listPushSchedule,
  readPushSchedule,
  recoverPushSchedule,
} = await import('../src/pushschedule.mjs');

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const NOW = '2026-10-27T10:00:00.000Z';

function create(overrides = {}) {
  return createPushSchedule(
    {
      title: 'Новая функция',
      text: 'Попробуйте поиск по файлам',
      all: true,
      date: '2026-10-28',
      time: '18:30',
      ...overrides,
    },
    { createdBy: 'tester', now: NOW },
  );
}

test('время по Минску переводится в UTC и переживает запись', () => {
  const item = create();
  assert.equal(item.sendAt, '2026-10-28T15:30:00.000Z');
  assert.equal(item.status, 'scheduled');
  const saved = readPushSchedule().find((entry) => entry.id === item.id);
  assert.equal(saved.sendAt, '2026-10-28T15:30:00.000Z');
  assert.equal(saved.createdBy, 'tester');
});

test('«всем» не хранит список идентификаторов', () => {
  const item = create({ all: true, userIds: ['u1', 'u2'] });
  assert.deepEqual(item.userIds, []);
});

test('выбранные получатели сохраняются без повторов', () => {
  const item = create({ all: false, userIds: ['u1', 'u2', 'u1'] });
  assert.deepEqual(item.userIds, ['u1', 'u2']);
});

test('пустая аудитория отклоняется', () => {
  assert.throws(() => create({ all: false, userIds: [] }), /хотя бы одного получателя/);
});

test('заголовок и текст проверяются', () => {
  assert.throws(() => create({ title: '   ' }), /заголовок/);
  assert.throws(() => create({ title: 'я'.repeat(81) }), /80/);
  assert.throws(() => create({ text: '' }), /текст/);
  assert.throws(() => create({ text: 'я'.repeat(301) }), /300/);
});

test('дата и время проверяются, включая несуществующее 30 февраля', () => {
  assert.throws(() => create({ date: '' }), /дату и время/);
  assert.throws(() => create({ date: '2026-02-30' }), /дату и время/);
  assert.throws(() => create({ time: '25:00' }), /дату и время/);
  assert.throws(() => create({ time: '9:5' }), /дату и время/);
});

test('прошедшее время и слишком далёкая дата отклоняются', () => {
  assert.throws(
    () => createPushSchedule(
      { title: 'x', text: 'y', all: true, date: '2026-10-28', time: '13:29' },
      { now: '2026-10-28T10:30:00.000Z' },
    ),
    /уже прошло/,
  );
  assert.throws(
    () => createPushSchedule(
      { title: 'x', text: 'y', all: true, date: '2026-10-28', time: '13:31' },
      { now: '2026-10-28T10:30:40.000Z' },
    ),
    /меньше 30 секунд/,
  );
  assert.throws(
    () => createPushSchedule(
      { title: 'x', text: 'y', all: true, date: '2028-10-28', time: '10:00' },
      { now: NOW },
    ),
    /дальше чем на год/,
  );
});

test('список: ближайшие впереди, отправленные уходят в историю', () => {
  const later = create({ title: 'Позже', date: '2026-11-05', time: '09:00' });
  const sooner = create({ title: 'Скоро', date: '2026-10-27', time: '20:00' });
  const view = listPushSchedule(Date.parse('2026-10-27T12:00:00.000Z'));
  const indexOf = (id) => view.items.findIndex((item) => item.id === id);
  assert.ok(indexOf(sooner.id) < indexOf(later.id), 'ближайшая рассылка должна быть выше');
  assert.equal(view.nextAt, view.items[0].sendAt);
  assert.ok(view.pending >= 2);
});

test('отменить можно только ожидающую рассылку', () => {
  const item = create({ title: 'Отменяемая' });
  const canceled = cancelPushSchedule(item.id, { by: 'tester', now: '2026-10-27T11:00:00.000Z' });
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.canceledBy, 'tester');
  assert.throws(() => cancelPushSchedule(item.id), /уже нельзя отменить/);
  assert.throws(() => cancelPushSchedule('нет-такой'), /не найдена/);
});

test('пора отправлять: due видит только наступившие, claim защищает от второго тика', () => {
  const soon = create({ title: 'Созревшая', date: '2026-10-27', time: '20:00' });
  const due = duePushSchedule(Date.parse('2026-10-27T17:00:00.000Z'));
  assert.ok(due.some((item) => item.id === soon.id));
  assert.ok(!due.some((item) => item.title === 'Позже'));

  const claimed = claimPushSchedule(soon.id);
  assert.equal(claimed.status, 'sending');
  assert.equal(claimPushSchedule(soon.id), null);
  assert.equal(duePushSchedule(Date.parse('2026-10-27T17:00:00.000Z')).some((item) => item.id === soon.id), false);
});

test('итог отправки сохраняется и виден в истории', () => {
  const item = create({ title: 'Отправленная', date: '2026-10-27', time: '20:00' });
  claimPushSchedule(item.id);
  const finished = finishPushSchedule(item.id, {
    status: 'sent',
    sentAt: '2026-10-27T17:00:05.000Z',
    result: { sent: 2, failed: 0, total: 2, users: 1 },
    skipped: 3,
  });
  assert.equal(finished.status, 'sent');
  assert.equal(finished.result.sent, 2);
  assert.equal(finished.skipped, 3);
  const view = listPushSchedule(Date.parse('2026-10-28T00:00:00.000Z'));
  assert.ok(view.items.some((entry) => entry.id === item.id && entry.status === 'sent'));
});

test('зависшая отправка после перезапуска закрывается как неудачная', () => {
  const items = JSON.parse(fs.readFileSync(PUSH_SCHEDULE_FILE, 'utf8'));
  items.items.push({
    id: 'ps_stale',
    title: 'Зависшая',
    text: 'Текст',
    all: true,
    userIds: [],
    sendAt: '2026-10-27T16:00:00.000Z',
    createdAt: NOW,
    createdBy: 'tester',
    status: 'sending',
    startedAt: '2026-10-27T15:59:00.000Z',
    sentAt: null,
    canceledAt: null,
    result: null,
    skipped: 0,
    error: null,
  });
  fs.writeFileSync(PUSH_SCHEDULE_FILE, JSON.stringify(items));
  assert.equal(recoverPushSchedule(Date.parse('2026-10-27T16:10:00.000Z')), 1);
  const fixed = readPushSchedule().find((entry) => entry.id === 'ps_stale');
  assert.equal(fixed.status, 'failed');
  assert.match(fixed.error, /перезапуском/);
});

test('битый файл не роняет чтение', () => {
  fs.writeFileSync(PUSH_SCHEDULE_FILE, '{не json');
  assert.deepEqual(readPushSchedule(), []);
});

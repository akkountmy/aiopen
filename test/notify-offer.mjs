import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/* Конфигурация читает DSHOW_DATA_DIR при импорте, поэтому каталог задаём до
   динамического импорта модуля. */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-notify-offer-'));
process.env.DSHOW_DATA_DIR = DATA_DIR;

const {
  addMonths,
  createNotifyOffer,
  denyNotifyOffer,
  enableNotifyOffer,
  markNotifyOfferShown,
  notifyOfferState,
  postponeNotifyOffer,
  resetNotifyOffer,
} = await import('../src/notifyoffer.mjs');

const user = (name) => `u_${name}`;

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('старым пользователям напоминание не создаётся', () => {
  assert.deepEqual(notifyOfferState(user('old')), {
    eligible: false,
    show: false,
    status: 'none',
    stage: 0,
  });
});

test('после регистрации окно доступно сразу', () => {
  const id = user('new');
  const state = createNotifyOffer(id, { now: '2026-01-31T10:00:00.000Z' });
  assert.equal(state.eligible, true);
  assert.equal(state.show, true);
  assert.equal(state.stage, 1);
  assert.equal(state.status, 'due');
  assert.equal(state.dueAt, '2026-01-31T10:00:00.000Z');
  /* Повторный вызов при входе не сдвигает расписание. */
  const again = createNotifyOffer(id, { now: '2026-02-01T10:00:00.000Z' });
  assert.equal(again.stage, 1);
  assert.equal(again.dueAt, '2026-01-31T10:00:00.000Z');
});

test('первое «Отложить» — ровно через календарный месяц', () => {
  const id = user('month');
  createNotifyOffer(id, { now: '2026-01-31T10:00:00.000Z' });
  const state = postponeNotifyOffer(id, { now: '2026-01-31T10:00:00.000Z' });
  assert.equal(state.status, 'scheduled');
  assert.equal(state.stage, 2);
  assert.equal(state.show, false);
  assert.equal(state.dueAt, '2026-02-28T10:00:00.000Z');
  assert.equal(notifyOfferState(id, Date.parse('2026-02-28T09:59:59.000Z')).show, false);
  const due = notifyOfferState(id, Date.parse('2026-02-28T10:00:00.000Z'));
  assert.equal(due.show, true);
  assert.equal(due.stage, 2);
});

test('второе «Отложить» — через три месяца, третье выключает напоминания', () => {
  const id = user('three');
  createNotifyOffer(id, { now: '2026-02-28T10:00:00.000Z' });
  let state = postponeNotifyOffer(id, { now: '2026-02-28T10:00:00.000Z' });
  assert.equal(state.stage, 2);
  assert.equal(state.dueAt, '2026-03-28T10:00:00.000Z');
  state = postponeNotifyOffer(id, { now: '2026-03-28T10:00:00.000Z' });
  assert.equal(state.stage, 3);
  assert.equal(state.dueAt, '2026-06-28T10:00:00.000Z');
  assert.equal(notifyOfferState(id, Date.parse('2026-06-28T10:00:00.000Z')).show, true);
  state = postponeNotifyOffer(id, { now: '2026-06-28T10:00:00.000Z' });
  assert.equal(state.status, 'stopped');
  assert.equal(state.show, false);
  assert.equal(state.dueAt, null);
  /* Дальше окно не возвращается даже спустя годы. */
  assert.equal(notifyOfferState(id, Date.parse('2030-01-01T00:00:00.000Z')).show, false);
});

test('включение закрывает напоминания навсегда', () => {
  const id = user('enabled');
  createNotifyOffer(id, { now: '2026-01-01T00:00:00.000Z' });
  const state = enableNotifyOffer(id, { now: '2026-01-01T00:05:00.000Z', deviceId: 'dev-1' });
  assert.equal(state.status, 'enabled');
  assert.equal(state.show, false);
  assert.equal(notifyOfferState(id, Date.parse('2030-01-01T00:00:00.000Z')).show, false);
  assert.equal(postponeNotifyOffer(id, { now: '2026-02-01T00:00:00.000Z' }).status, 'enabled');
});

test('запрет браузера и неподдерживаемый браузер тоже останавливают окно', () => {
  const denied = user('denied');
  createNotifyOffer(denied, { now: '2026-01-01T00:00:00.000Z' });
  assert.equal(denyNotifyOffer(denied, { now: '2026-01-01T00:00:00.000Z' }).status, 'denied');
  const unsupported = user('unsupported');
  createNotifyOffer(unsupported, { now: '2026-01-01T00:00:00.000Z' });
  const state = denyNotifyOffer(unsupported, { now: '2026-01-01T00:00:00.000Z', reason: 'unsupported' });
  assert.equal(state.status, 'unsupported');
});

test('отметка «показано» не сдвигает расписание', () => {
  const id = user('shown');
  createNotifyOffer(id, { now: '2026-01-01T00:00:00.000Z' });
  const shown = markNotifyOfferShown(id, { now: '2026-01-01T00:10:00.000Z' });
  assert.equal(shown.show, true);
  assert.equal(shown.stage, 1);
  assert.equal(shown.dueAt, '2026-01-01T00:00:00.000Z');
});

test('календарные месяцы не перескакивают через конец месяца', () => {
  assert.equal(addMonths('2026-01-31T10:00:00.000Z', 1), '2026-02-28T10:00:00.000Z');
  assert.equal(addMonths('2028-01-31T10:00:00.000Z', 1), '2028-02-29T10:00:00.000Z');
  assert.equal(addMonths('2026-11-30T10:00:00.000Z', 3), '2027-02-28T10:00:00.000Z');
});

test('записи разных пользователей не смешиваются', () => {
  const first = user('first');
  const second = user('second');
  createNotifyOffer(first, { now: '2026-01-01T00:00:00.000Z' });
  createNotifyOffer(second, { now: '2026-01-01T00:00:00.000Z' });
  postponeNotifyOffer(first, { now: '2026-01-01T00:00:00.000Z' });
  assert.equal(notifyOfferState(first).stage, 2);
  assert.equal(notifyOfferState(second).stage, 1);
  assert.equal(notifyOfferState(second).show, true);
  resetNotifyOffer(first);
  resetNotifyOffer(second);
  assert.equal(notifyOfferState(first).eligible, false);
  assert.equal(notifyOfferState(second).eligible, false);
});

test('файл расписания переживает перезапуск', () => {
  const id = user('persisted');
  createNotifyOffer(id, { now: '2026-01-01T00:00:00.000Z' });
  postponeNotifyOffer(id, { now: '2026-01-01T00:00:00.000Z' });
  const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'notify-offers.json'), 'utf8'));
  const record = saved.find((item) => item.userId === id);
  assert.equal(record.status, 'scheduled');
  assert.equal(record.stage, 2);
  assert.equal(record.dueAt, '2026-02-01T00:00:00.000Z');
});

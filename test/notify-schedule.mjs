import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/* Настройки читают DSHOW_DATA_DIR при импорте — каталог задаём до него. */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-notify-schedule-'));
process.env.DSHOW_DATA_DIR = DATA_DIR;

const {
  alignNotifyMs,
  firstNotifyMs,
  notifyScheduleView,
  readNotifySchedule,
  saveNotifySchedule,
} = await import('../src/notifyschedule.mjs');
const { createNotifyOffer, notifyOfferState, postponeNotifyOffer, resetNotifyOffer } = await import('../src/notifyoffer.mjs');

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('по умолчанию — сразу после регистрации, как раньше', () => {
  const schedule = readNotifySchedule();
  assert.equal(schedule.mode, 'immediate');
  assert.equal(firstNotifyMs(Date.parse('2026-01-31T10:00:00.000Z')), Date.parse('2026-01-31T10:00:00.000Z'));
});

test('задержка отсчитывается от регистрации', () => {
  saveNotifySchedule({ mode: 'delay', delayMinutes: 90, time: '10:00' });
  const now = Date.parse('2026-01-31T10:00:00.000Z');
  assert.equal(firstNotifyMs(now), now + 90 * 60000);
});

test('время суток: сегодня, если ещё не наступило, иначе завтра', () => {
  saveNotifySchedule({ mode: 'time', time: '10:00' });
  /* 09:00 по Минску — окно сегодня в 10:00 (07:00 UTC). */
  assert.equal(
    new Date(firstNotifyMs(Date.parse('2026-01-31T06:00:00.000Z'))).toISOString(),
    '2026-01-31T07:00:00.000Z',
  );
  /* 11:00 по Минску — сегодняшние 10:00 уже прошли, значит завтра. */
  assert.equal(
    new Date(firstNotifyMs(Date.parse('2026-01-31T08:00:00.000Z'))).toISOString(),
    '2026-02-01T07:00:00.000Z',
  );
  /* Полночь: 00:30 по Минску, а окно в 00:15 — только на следующие сутки. */
  saveNotifySchedule({ mode: 'time', time: '00:15' });
  assert.equal(
    new Date(firstNotifyMs(Date.parse('2026-01-31T21:30:00.000Z'))).toISOString(),
    '2026-02-01T21:15:00.000Z',
  );
});

test('запись напоминания ждёт назначенного времени', () => {
  saveNotifySchedule({ mode: 'time', time: '10:00' });
  const id = 'u_scheduled';
  createNotifyOffer(id, { now: '2026-01-31T06:00:00.000Z' });
  assert.equal(notifyOfferState(id, Date.parse('2026-01-31T06:00:00.000Z')).show, false);
  assert.equal(notifyOfferState(id, Date.parse('2026-01-31T06:00:00.000Z')).dueAt, '2026-01-31T07:00:00.000Z');
  assert.equal(notifyOfferState(id, Date.parse('2026-01-31T06:59:59.000Z')).show, false);
  assert.equal(notifyOfferState(id, Date.parse('2026-01-31T07:00:00.000Z')).show, true);
  resetNotifyOffer(id);
});

test('повторное напоминание встаёт на тот же день, но в настроенный час', () => {
  saveNotifySchedule({ mode: 'time', time: '10:00' });
  assert.equal(
    new Date(alignNotifyMs(Date.parse('2026-02-28T17:40:00.000Z'))).toISOString(),
    '2026-02-28T07:00:00.000Z',
  );
  const id = 'u_repeat';
  createNotifyOffer(id, { now: '2026-01-31T06:00:00.000Z' });
  const next = postponeNotifyOffer(id, { now: '2026-01-31T07:10:00.000Z' });
  assert.equal(next.status, 'scheduled');
  assert.equal(next.stage, 2);
  assert.equal(next.dueAt, '2026-02-28T07:00:00.000Z');
  resetNotifyOffer(id);
});

test('время и задержку нельзя сохранить с ошибкой', () => {
  assert.throws(() => saveNotifySchedule({ mode: 'когда-нибудь' }), /когда отправлять/);
  assert.throws(() => saveNotifySchedule({ mode: 'time', time: '25:00' }), /ЧЧ:ММ/);
  assert.throws(() => saveNotifySchedule({ mode: 'time', time: '9:5' }), /ЧЧ:ММ/);
  assert.throws(() => saveNotifySchedule({ mode: 'delay', delayMinutes: 0 }), /от 1 минуты/);
  assert.throws(() => saveNotifySchedule({ mode: 'delay', delayMinutes: 8 * 24 * 60 }), /от 1 минуты/);
});

test('настройка переживает перезапуск, а панель показывает ближайшее окно', () => {
  const saved = saveNotifySchedule(
    { mode: 'time', time: '09:30', delayMinutes: 45 },
    { updatedBy: 'admin', now: '2026-01-31T06:00:00.000Z' },
  );
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'notify-schedule.json'), 'utf8'));
  assert.equal(onDisk.mode, 'time');
  assert.equal(onDisk.time, '09:30');
  assert.equal(onDisk.updatedBy, 'admin');
  assert.equal(saved.nextAt, '2026-01-31T06:30:00.000Z');
  assert.match(saved.preview, /31 января/);
  assert.equal(saved.tz, 'Europe/Minsk');

  const view = notifyScheduleView(Date.parse('2026-01-31T06:00:00.000Z'));
  assert.equal(view.mode, 'time');
  assert.equal(view.preview, '31 января в 09:30');
});

test('испорченный файл настроек не ломает регистрацию', () => {
  fs.writeFileSync(path.join(DATA_DIR, 'notify-schedule.json'), '{не json');
  const schedule = readNotifySchedule();
  assert.equal(schedule.mode, 'immediate');
  assert.equal(schedule.time, '10:00');
});

/**
 * Контекст хранится всегда: срока годности у него больше нет, вместо срока —
 * ежемесячное сжатие раздутой истории без модели. Проверяем: давний раздутый
 * диалог сжимается и выгружается в `.history/` проекта, свежий и маленький не
 * трогаются, повторный проход работу не повторяет, идущую задачу не сжимаем,
 * срез читается целиком (ничего не теряем).
 * Запуск: node test/context.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-context-'));
process.env.DSHOW_DATA_DIR = tmpRoot;
/* Фоновой тик здесь не нужен: проход зовём руками, иначе таймеры мешают выходу. */
process.env.DSHOW_CONTEXT_COMPACT = '0';

const { store } = await import('../src/store.mjs');
const { CONTEXT_KEEP, contextAgeMs, startContextCompactor, sweepStaleContexts } = await import('../src/contextkeep.mjs');

const DAY = 24 * 60 * 60 * 1000;
const user = store.createUser({ username: 'Владелец', password: 'TestPass-12345' });
const project = store.createProject({ ownerId: user.id, name: 'Давний проект' });
const historyDir = path.join(tmpRoot, 'workspaces', project.id, '.history');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/**
 * Диалог с историей на заданную давность. `pairs` — пары реплик в истории:
 * каждая длинная, чтобы перевалить порог сжатия (8 000 токенов).
 */
function makeChat(title, { days = 0, pairs = 0, running = false } = {}) {
  const chat = store.createChat({ projectId: project.id, ownerId: user.id, title });
  const messages = [
    { role: 'user', content: `давняя задача ${title}` },
    { role: 'assistant', content: 'готово' },
  ];
  const history = [];
  for (let index = 0; index < pairs; index++) {
    history.push({ role: 'user', content: `шаг ${index}: ${'проверка макета и текста. '.repeat(24)}` });
    history.push({ role: 'assistant', content: `готово ${index}: ${'макет собран, текст вычитан. '.repeat(24)}` });
  }
  store.writeChat(chat.id, { messages, history, memory: '', task: null, queue: [] });
  const meta = store.state.chats.find((item) => item.id === chat.id);
  meta.updatedAt = new Date(Date.now() - days * DAY).toISOString();
  if (running) meta.running = { runId: 'run_old', startedAt: meta.updatedAt, attempts: 0 };
  store.save();
  return chat.id;
}

const slices = () => (fs.existsSync(historyDir) ? fs.readdirSync(historyDir) : []);

test('настройки: месяц и порог по умолчанию', () => {
  assert.equal(CONTEXT_KEEP.compactAfterDays, 30);
  assert.equal(CONTEXT_KEEP.staleTokens, 8000);
  assert.ok(CONTEXT_KEEP.keepRecent >= 2);
  assert.ok(CONTEXT_KEEP.intervalMs >= DAY);
});

test('возраст контекста считается по последней записи', () => {
  const age = contextAgeMs({ updatedAt: new Date(Date.now() - 3 * DAY).toISOString() });
  assert.ok(Math.abs(age - 3 * DAY) < 2000, `возраст ${age}`);
  assert.equal(contextAgeMs({}), 0);
});

test('давний раздутый диалог сжимается в конспект и не теряет текст', () => {
  const id = makeChat('Давний', { days: 40, pairs: 40 });
  const before = store.getChat(id, user.id);
  const result = sweepStaleContexts('тест');
  assert.equal(result.compacted, 1);
  assert.ok(result.savedTokens > 0, 'экономия токенов должна быть положительной');
  const after = store.getChat(id, user.id);
  assert.ok(after.history.length < before.history.length, 'история должна стать короче');
  assert.match(after.memory, /Ранее в разговоре \(сжато\)/);
  assert.match(after.memory, /\.history\//);
  /* Ничего не теряем: срез лежит файлом и читается целиком. */
  const spilled = slices();
  assert.ok(spilled.length > 0, 'срез должен уехать в .history/ проекта');
  const text = fs.readFileSync(path.join(historyDir, spilled[0]), 'utf8');
  assert.match(text, /шаг 0: проверка макета/);
});

test('повторный проход работу не повторяет', () => {
  const again = sweepStaleContexts('повтор');
  assert.equal(again.compacted, 0);
});

test('свежий диалог не сжимаем, даже если история раздута', () => {
  const fresh = makeChat('Свежий', { days: 2, pairs: 40 });
  const before = store.getChat(fresh, user.id).history.length;
  assert.equal(sweepStaleContexts('тест').compacted, 0);
  assert.equal(store.getChat(fresh, user.id).history.length, before);
});

test('маленький давний диалог не трогаем: конспект дороже самих реплик', () => {
  const small = makeChat('Маленький', { days: 90, pairs: 2 });
  const before = store.getChat(small, user.id).history.length;
  assert.equal(sweepStaleContexts('тест').compacted, 0);
  assert.equal(store.getChat(small, user.id).history.length, before);
});

test('идущую задачу не сжимаем посреди работы', () => {
  const busy = makeChat('Идёт работа', { days: 40, pairs: 40, running: true });
  assert.equal(sweepStaleContexts('тест').compacted, 0);
  assert.equal(store.getChat(busy, user.id).history.length, 80);
});

test('тик снимается без остатка', () => {
  const stop = startContextCompactor({ intervalMs: 60 * 60 * 1000, initialDelayMs: 60 * 60 * 1000 });
  assert.equal(typeof stop, 'function');
  stop();
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`     ${error.message}`);
  }
}

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(failed ? `\nПровалов: ${failed}` : `\n${tests.length}/${tests.length} тестов прошло`);
process.exit(failed ? 1 : 0);

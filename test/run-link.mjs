/* Проверка терпения watchRun: короткий обрыв не должен показывать плашку. */
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function watchRun(');
if (start < 0) throw new Error('watchRun не найден');
let depth = 0;
let end = -1;
for (let i = source.indexOf('{', start); i < source.length; i += 1) {
  if (source[i] === '{') depth += 1;
  else if (source[i] === '}') {
    depth -= 1;
    if (depth === 0) { end = i + 1; break; }
  }
}
const fn = source.slice(start, end);
if (!fn.includes('RUN_LINK_NOTICE_MS')) throw new Error('взяли не тот кусок');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const results = [];

function makeWorld({ hidden = false, fetchImpl, readImpl, live = true }) {
  let now = 1_700_000_000_000;
  const toast = [];
  const state = {
    liveStreams: new Map(),
    liveRuns: new Map([['run-1', { id: 'run-1', chatId: 'chat-1', status: 'running' }]]),
  };
  if (!live) state.liveRuns.clear();
  const ctx = {
    state,
    RUN_LINK_NOTICE_MS: 60000,
    RUN_IDLE_MS: 25000,
    pageShownAt: now,
    document: { hidden },
    trackRun: (id, chatId) => state.liveRuns.get(id) || { id, chatId, status: 'running' },
    showAuth: () => { throw new Error('не должен требовать вход'); },
    closeRunView: () => {},
    paintRun: () => {},
    toast: (text) => toast.push(text),
    sleep: async (ms) => { now += ms; },
    fetch: fetchImpl,
    readRunStream: readImpl,
    Date: { now: () => now },
    AbortController,
    Math,
  };
  vm.createContext(ctx);
  vm.runInContext(`${fn}\nglobalThis.watchRun = watchRun;`, ctx);
  return { ctx, state, toast, now: () => now };
}

test('смену потока не провожаем плашкой', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const world = makeWorld({
    fetchImpl: async () => {
      await gate;
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    },
    readImpl: async () => false,
  });
  const task = vm.runInContext('watchRun("run-1", "chat-1")', world.ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const oldStream = world.state.liveStreams.get('run-1');
  if (!oldStream) throw new Error('старый поток не поднялся');
  const newer = { controller: new AbortController(), run: oldStream.run };
  world.state.liveStreams.set('run-1', newer);
  oldStream.controller.abort();
  release();
  await task;
  if (world.toast.length) throw new Error('плашка при смене потока');
  if (world.state.liveStreams.get('run-1') !== newer) throw new Error('чужой поток удалил новый');
});

test('короткий обрыв и переподключение — молча', async () => {
  let calls = 0;
  const world = makeWorld({
    fetchImpl: async () => {
      calls += 1;
      if (calls <= 5) throw new Error('offline');
      return { ok: true, status: 200, body: {} };
    },
    readImpl: async () => true,
  });
  await vm.runInContext('watchRun("run-1", "chat-1")', world.ctx);
  if (world.toast.length) throw new Error('плашка при коротком обрыве');
  if (calls < 6) throw new Error('не переподключился');
});

test('минута без связи на глазах — одна плашка', async () => {
  let calls = 0;
  const world = makeWorld({
    fetchImpl: async () => {
      calls += 1;
      if (calls > 40) {
        world.state.liveRuns.delete('run-1');
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      throw new Error('offline');
    },
    readImpl: async () => false,
  });
  await vm.runInContext('watchRun("run-1", "chat-1")', world.ctx);
  if (world.toast.length !== 1) throw new Error(`плашек: ${world.toast.length}, ждали одну`);
});

test('пока свёрнуто — молча', async () => {
  let calls = 0;
  const world = makeWorld({
    hidden: true,
    fetchImpl: async () => {
      calls += 1;
      if (calls > 40) {
        world.state.liveRuns.delete('run-1');
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      throw new Error('offline');
    },
    readImpl: async () => false,
  });
  await vm.runInContext('watchRun("run-1", "chat-1")', world.ctx);
  if (world.toast.length) throw new Error('плашка, пока приложение свёрнуто');
});

test('после возвращения минута терпения начинается заново', async () => {
  let calls = 0;
  let returned = false;
  const world = makeWorld({
    hidden: true,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 10) {
        world.ctx.document.hidden = false;
        world.ctx.pageShownAt = world.now();
        returned = true;
      }
      if (calls > 18) {
        world.state.liveRuns.delete('run-1');
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      throw new Error('offline');
    },
    readImpl: async () => false,
  });
  await vm.runInContext('watchRun("run-1", "chat-1")', world.ctx);
  if (!returned) throw new Error('сценарий не дошёл до возвращения');
  if (world.toast.length) throw new Error('плашка сразу после возвращения');
});

for (const { name, run } of tests) {
  try {
    await run();
    results.push(`  ok  ${name}`);
  } catch (error) {
    results.push(`  ПРОВАЛ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}
console.log(results.join('\n'));

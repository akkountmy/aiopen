/**
 * Тесты субагентов и фильтра инструментов без обращения к настоящей модели:
 * поднимается локальный SSE-сервер, который отвечает как OpenAI-совместимый API.
 * Проверяется: вызов spawn_agent из цикла, изоляция контекста, суженный набор
 * инструментов, суммирование расхода, потолок шагов и предел вложенности.
 * Запуск: node test/agents.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agents-'));
const workspace = path.join(tmpRoot, 'project');
fs.mkdirSync(workspace, { recursive: true });

const SUBAGENT_MARK = 'Ты субагент внутри большой задачи';
const requests = [];
let behavior = () => ({ kind: 'text', text: 'ок' });
let activeSubagents = 0;
let maxActiveSubagents = 0;

function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamText(res, text, usage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  sendEvent(res, { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  sendEvent(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamTool(res, name, args, usage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  sendEvent(res, {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: `call_${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  sendEvent(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer((req, res) => {
  if (!req.url.startsWith('/chat/completions')) {
    res.writeHead(404).end('nope');
    return;
  }
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const isSubagent = messages.some(
      (message) => typeof message.content === 'string' && message.content.includes(SUBAGENT_MARK),
    );
    const tools = (body.tools || []).map((tool) => tool.function.name);
    requests.push({ isSubagent, tools, system: String(messages[0]?.content || '') });

    const plan = behavior({ isSubagent, tools, messages });
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    /* Сводка срезанной истории заказывается без стрима — отвечаем как обычный
       JSON, иначе агент не разберёт ответ и сработает детерминированная выжимка. */
    if (body.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Сводка: работали с большими файлами и цифрами.' } }],
          usage,
        }),
      );
      return;
    }
    if (plan.delay) await new Promise((resolve) => setTimeout(resolve, plan.delay));
    if (plan.kind === 'tool') streamTool(res, plan.name, plan.args || {}, usage);
    else streamText(res, plan.text || '', usage);
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
process.env.DSH_DATA_DIR = tmpRoot;
process.env.DSHOW_DEEPSEEK_KEY = 'test-key';
process.env.DSHOW_MODEL_BASE = `http://127.0.0.1:${port}`;

const { runTurn } = await import('../src/agent.mjs');
const { executeTool, TOOL_DEFS } = await import('../src/tools.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
/* Часть тестов намеренно вызывает ошибки инструментов — их служебный лог
   в выводе не нужен. */
console.warn = () => {};
const reset = () => {
  requests.length = 0;
  activeSubagents = 0;
  maxActiveSubagents = 0;
};

function makeChat() {
  return { history: [], memory: null };
}

const baseTurn = (overrides = {}) => ({
  workspace,
  chat: makeChat(),
  projectName: 'Проект',
  userName: 'Иван',
  userText: 'Проверь цифры по проекту',
  emit: () => {},
  signal: new AbortController().signal,
  ...overrides,
});

test('инструмент spawn_agent объявлен для модели', () => {
  const def = TOOL_DEFS.find((tool) => tool.function.name === 'spawn_agent');
  assert.ok(def, 'spawn_agent отсутствует в TOOL_DEFS');
  assert.ok(def.function.parameters.required.includes('tasks'));
});

test('субагенты работают и отчёт попадает в историю', async () => {
  reset();
  behavior = ({ isSubagent }) => {
    if (isSubagent) {
      activeSubagents++;
      maxActiveSubagents = Math.max(maxActiveSubagents, activeSubagents);
      return { kind: 'text', text: 'Отчёт субагента: 42', delay: 40 };
    }
    const hasToolResult = requests.length > 1;
    if (!hasToolResult) {
      return {
        kind: 'tool',
        name: 'spawn_agent',
        args: {
          tasks: [
            { name: 'Проверка суммы', task: 'посчитай 40 + 2' },
            { name: 'Проверка доли', task: 'посчитай долю' },
          ],
          concurrency: 2,
        },
      };
    }
    return { kind: 'text', text: 'Итог: 42' };
  };
  const outcome = await runTurn(baseTurn());
  assert.match(outcome.text, /Итог: 42/);
  assert.ok(outcome.tools.some((tool) => tool.name === 'spawn_agent'), 'вызов субагентов не попал в список инструментов');
  const report = requests.filter((item) => item.isSubagent);
  assert.equal(report.length, 2, 'ожидались два субагента');
  assert.ok(maxActiveSubagents <= 2, `одновременных субагентов больше лимита: ${maxActiveSubagents}`);
});

test('субагент пишет только в свою папку и не запускает своих субагентов', async () => {
  reset();
  behavior = ({ isSubagent }) => (isSubagent ? { kind: 'text', text: 'готово' } : requests.length === 1
    ? { kind: 'tool', name: 'spawn_agent', args: { tasks: [{ name: 'Часть отчёта', task: 'проверь' }] } }
    : { kind: 'text', text: 'итог' });
  await runTurn(baseTurn());
  const subagentTools = requests.find((item) => item.isSubagent)?.tools || [];
  assert.ok(subagentTools.length > 0, 'субагент получил пустой список инструментов');
  /* Писать части отчёта субагенту можно — но только в свою папку (проверка
     ниже). Удалять чужое, звать других агентов и менять память — нельзя. */
  for (const forbidden of ['spawn_agent', 'delete_path', 'move_path', 'remember']) {
    assert.ok(!subagentTools.includes(forbidden), `субагенту доступен ${forbidden}`);
  }
  assert.ok(subagentTools.includes('write_file') && subagentTools.includes('create_word'), 'субагент не может писать свою часть');
  assert.ok(subagentTools.includes('run_js'), 'субагенту не дали run_js');
  const mainTools = requests.find((item) => !item.isSubagent)?.tools || [];
  assert.ok(mainTools.includes('spawn_agent') && mainTools.includes('write_file'), 'основная задача потеряла инструменты');

  /* Границы папки воркера: снаружи — отказ, внутри — обычная запись. */
  const scope = { workspace, writeRoot: 'parts/01-chast-otcheta', signal: new AbortController().signal };
  await assert.rejects(
    executeTool('write_file', { path: 'report.md', content: 'чужое' }, scope),
    /свою папку|нельзя/i,
    'субагент записал файл мимо своей папки',
  );
  const ok = await executeTool('write_file', { path: 'parts/01-chast-otcheta/report.md', content: 'своё' }, scope);
  assert.equal(ok.meta.path, 'parts/01-chast-otcheta/report.md');
  assert.ok(fs.existsSync(path.join(workspace, 'parts/01-chast-otcheta/report.md')), 'файл своей части не появился');
  await assert.rejects(
    executeTool('run_js', { code: "write('leak.txt', 'x')" }, scope),
    /свою папку|только в свою/i,
    'run_js обошёл границу папки воркера',
  );
});

test('расход субагентов учитывается в общей задаче', async () => {
  reset();
  behavior = ({ isSubagent }) => (isSubagent ? { kind: 'text', text: 'ok' } : requests.length === 1
    ? { kind: 'tool', name: 'spawn_agent', args: { tasks: [{ task: 'a' }, { task: 'b' }] } }
    : { kind: 'text', text: 'итог' });
  const outcome = await runTurn(baseTurn());
  /* три обращения: основная задача, два субагента, финал — минимум 40 входящих токенов */
  assert.ok(outcome.usage.tokensIn >= 40, `расход не сложился: ${JSON.stringify(outcome.usage)}`);
  assert.ok(outcome.usage.tokensOut >= 20, `выход не сложился: ${JSON.stringify(outcome.usage)}`);
});

test('toolFilter сужает набор инструментов хода', async () => {
  reset();
  behavior = () => ({ kind: 'text', text: 'готово' });
  await runTurn(baseTurn({ toolFilter: ['run_js'] }));
  assert.deepEqual(requests[0].tools, ['run_js']);
});

test('maxSteps ограничивает вложенную работу', async () => {
  reset();
  behavior = ({ isSubagent }) => (isSubagent
    ? { kind: 'text', text: 'ok' }
    : requests.length === 1
      ? { kind: 'tool', name: 'spawn_agent', args: { tasks: [{ task: 'a' }] } }
      : { kind: 'text', text: 'итог' });
  const outcome = await runTurn(baseTurn({ maxSteps: 1 }));
  assert.equal(outcome.steps, 1);
});

test('вложенный субагент не может запускать своих', async () => {
  reset();
  behavior = () => ({ kind: 'tool', name: 'spawn_agent', args: { tasks: [{ task: 'вложенный' }] } });
  const nested = { history: [], memory: null };
  await runTurn(baseTurn({ chat: nested, depth: 1, maxSteps: 1 }));
  const lastTool = nested.history.filter((message) => message.role === 'tool').pop();
  assert.match(String(lastTool?.content || ''), /не может запускать/);
  assert.equal(requests.filter((item) => item.isSubagent).length, 0, 'вложенный субагент всё-таки запустился');
});

test('без основной задачи инструмент субагентов честно отказывает', async () => {
  await assert.rejects(
    executeTool('spawn_agent', { tasks: [{ task: 'a' }] }, { workspace }),
    /только внутри основной задачи/,
  );
});

test('пустой список задач — понятная ошибка', async () => {
  reset();
  behavior = ({ isSubagent }) => (isSubagent
    ? { kind: 'text', text: 'ok' }
    : requests.length === 1
      ? { kind: 'tool', name: 'spawn_agent', args: { tasks: [] } }
      : { kind: 'text', text: 'итог' });
  const chat = makeChat();
  const outcome = await runTurn(baseTurn({ chat }));
  const lastTool = chat.history.filter((message) => message.role === 'tool').pop();
  assert.match(String(lastTool?.content || ''), /хотя бы один пункт tasks/);
  assert.equal(outcome.tools.length, 1);
});

test('огромный ответ инструмента приходит выжимкой со ссылкой на полный текст', async () => {
  reset();
  /* Файл побольше предела подсказки: run_js печатает его через print. */
  const big = Array.from({ length: 1500 }, (_, index) => `строка ${index}: значение ${index * 5}`).join('\n');
  fs.writeFileSync(path.join(workspace, 'big-report.txt'), big);
  behavior = ({ isSubagent }) => (isSubagent
    ? { kind: 'text', text: 'ok' }
    : requests.length === 1
      ? { kind: 'tool', name: 'run_js', args: { code: "print(read('big-report.txt'));" } }
      : { kind: 'text', text: 'итог' });

  const chat = makeChat();
  const events = [];
  const outcome = await runTurn(baseTurn({ chat, emit: (event) => events.push(event), toolFilter: ['run_js'] }));

  const toolMessage = chat.history.find((message) => message.role === 'tool');
  const content = String(toolMessage?.content || '');
  assert.match(content, /Результат сокращён/);
  assert.match(content, /\.trims\//);
  assert.ok(content.length < big.length, 'выжимка не короче исходного текста');

  const spills = fs.readdirSync(path.join(workspace, '.trims')).filter((name) => name.endsWith('.txt'));
  assert.ok(spills.length >= 1, 'полный текст не выгружен');
  assert.ok(outcome.trim.spills >= 1);
  const toolEvent = events.filter((event) => event.type === 'tool' && event.status === 'ok').pop();
  assert.match(String(toolEvent?.detail || ''), /сжато/);
  assert.match(outcome.text, /итог/);
});

test('тяжёлая история сжимается со сводкой в памяти', async () => {
  reset();
  behavior = () => ({ kind: 'text', text: 'готово' });
  const chat = makeChat();
  /* Готовим разговор сильно больше бюджета: восемь крупных реплик. */
  for (let index = 0; index < 8; index++) {
    chat.history.push({ role: 'user', content: `Шаг ${index}: ${'контекст '.repeat(2500)}` });
    chat.history.push({ role: 'assistant', content: `Ответ ${index}: ${'данные '.repeat(2500)}` });
  }
  const before = chat.history.length;
  const outcome = await runTurn(baseTurn({ chat }));

  assert.ok(chat.history.length < before, 'история не сжалась');
  assert.match(String(chat.memory || ''), /Сводка/, 'сводка не попала в память');
  assert.match(String(chat.memory || ''), /\.trims\//, 'в памяти нет ссылки на срезанную часть');
  assert.ok(outcome.trim.historyDrops >= 1);
  const historyFiles = fs.readdirSync(path.join(workspace, '.trims')).filter((name) => name.includes('history'));
  assert.ok(historyFiles.length >= 1, 'срезанная история не выгружена');
});

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok   ${item.name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${item.name}: ${error?.message || error}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} тестов прошло`);
server.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

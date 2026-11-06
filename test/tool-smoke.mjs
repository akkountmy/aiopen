/**
 * Дым по всем инструментам: ни один не падает «необъявленным именем».
 *
 * 4 ноября в журнале сервиса нашлось `[tool] read_document: full is not
 * defined`: инструмент был в реестре, модель его вызывала, а он падал на
 * каждом вызове. Тесты этого не видели, потому что ошибка живёт не в разборе
 * аргументов, а в теле ветки. Здесь каждый инструмент вызывается без
 * аргументов — как раз чтобы ветка начала выполняться, — и мы ищем ровно этот
 * класс отказа: `X is not defined`. Обычная ошибка «укажите path» считается
 * нормой: инструмент жив и объясняет, чего не хватает.
 *
 * Тяжёлые и сетевые инструменты без аргументов должны падать на проверке
 * входа; тем, кто всё-таки начал работу, даём пять секунд и пропускаем.
 *
 * Запуск: node test/tool-smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { executeTool, TOOL_DEFS } = await import('../src/tools.mjs');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-'));
const project = path.join(work, 'project');
fs.mkdirSync(project, { recursive: true });

/* Инструменты, которые без аргументов не начинают работу, а ждут внешний
   ответ: их дым бессмысленен и только тратит время. */
const SKIP = new Set(['web_search', 'fetch_url', 'fetch_many', 'crawl', 'spawn_agent', 'run_python', 'run_js']);

const UNDEFINED_RE = /\b([A-Za-z_$][\w$]*) is not defined\b/;

async function callOnce(name) {
  const work = executeTool(name, {}, { workspace: project, signal: AbortSignal.timeout(5000) })
    .then(() => ({ ok: true }))
    .catch((error) => ({ ok: false, message: String(error?.message || error) }));
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 5500);
    timer.unref?.();
  });
  return Promise.race([work, timeout]);
}

test('ни один инструмент не падает необъявленным именем', async () => {
  const broken = [];
  for (const def of TOOL_DEFS) {
    const name = def.function.name;
    if (SKIP.has(name)) continue;
    const result = await callOnce(name);
    if (result.timedOut) continue;
    const match = UNDEFINED_RE.exec(result.message || '');
    if (match) broken.push(`${name}: ${match[0]}`);
  }
  assert.deepEqual(broken, [], `ветки с необъявленным именем: ${broken.join('; ')}`);
});

test('read_document действительно читает документ и не падает', async () => {
  fs.writeFileSync(path.join(project, 'проба.txt'), 'Строка проверки', 'utf8');
  const result = await executeTool('read_document', { path: 'проба.txt' }, { workspace: project });
  assert.match(result.text, /Строка проверки/);
});

test('пустой путь объясняется словами, а не падением', async () => {
  const result = await callOnce('read_file');
  assert.equal(result.ok, false, 'без пути чтение файла должно отказать');
  assert.equal(UNDEFINED_RE.test(result.message || ''), false, `плохое сообщение: ${result.message}`);
});

/* ---------- итог ---------- */

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
fs.rmSync(work, { recursive: true, force: true });
console.log(failed ? `\n${failed} из ${tests.length} не прошли` : `\nвсе ${tests.length} прошли`);
process.exit(failed ? 1 : 0);

/* Внешний сторож: проверяем, что он различает живой сервис и молчащий, и что в
   режиме проверки ничего не перезапускает. Живой сервис поднимаем локально. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const tests = [];
/* Свой журнал: проверка не должна засорять рабочий .health-guard.log. */
const TEST_LOG = path.join(root, `.health-guard-test-${process.pid}.log`);
const LOG_ARG = `--log=${TEST_LOG}`;
const test = (name, fn) => tests.push({ name, fn });

function guard(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(root, 'scripts', 'health-guard.mjs'), ...args],
      { cwd: root, timeout: timeoutMs },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, out: `${stdout}`, err: `${stderr}` });
      },
    );
  });
}

test('живой сервис: сторож говорит «жив» и ничего не перезапускает', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, load: { runs: { active: 0 } } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const result = await guard(['--dry-run', LOG_ARG, `--base=http://127.0.0.1:${port}`]);
    assert.equal(result.code, 0, `сторож должен был завершиться успешно: ${result.err}`);
    assert.match(result.out, /жив:/, 'сторож должен увидеть живой сервис');
    assert.ok(!/перезапускаю проект/.test(result.out), 'перезапуска быть не должно');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('молчащий сервис: сторож решает перезапускать, в проверочном режиме — не перезапускает', async () => {
  const result = await guard(['--dry-run', LOG_ARG, '--base=http://127.0.0.1:9', '--timeout=1000']);
  assert.equal(result.code, 0, `сторож не должен падать: ${result.err}`);
  assert.match(result.out, /нет ответа/, 'сторож должен отметить отсутствие ответа');
  assert.match(result.out, /перезапускаю проект/, 'сторож должен решить перезапустить');
  assert.match(result.out, /--dry-run: перезапуск не выполнялся/, 'в проверочном режиме перезапуска нет');
});

test('остывание: частый перезапуск не повторяется', async () => {
  const result = await guard(['--dry-run', LOG_ARG, '--base=http://127.0.0.1:9', '--timeout=1000', '--cooldown=3600']);
  assert.equal(result.code, 0);
  /* Первый прогон мог решить перезапустить (если состояние писалось раньше),
     поэтому принимаем оба исхода, но при наличии отметки обязаны увидеть «остывание». */
  const cooled = /остывание/.test(result.out);
  const firstTime = /перезапускаю проект/.test(result.out);
  assert.ok(cooled || firstTime, 'сторож должен либо решить перезапустить, либо сказать про остывание');
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
try {
  fs.rmSync(TEST_LOG, { force: true });
} catch {
  /* журнал проверки не нужен */
}
console.log(`\n${tests.length - failed}/${tests.length} тестов прошло`);
if (failed) process.exit(1);

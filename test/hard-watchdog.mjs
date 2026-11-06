/* Жёсткий сторож: отдельный поток должен заметить, что главный поток встал.
   Проверяем на дочернем процессе — иначе проверка мешала бы сама себе.

   Два режима:
   - 'log' (по умолчанию, так работает сервис): пока главный поток стоит, сторож
     сам пишет строку в stderr, а процесс продолжает жить. Убивать себя нельзя:
     проверено в облаке 4 ноября — платформа не поднимает контейнер после
     SIGKILL, поэтому аварию закрывает внешний сторож scripts/health-guard.mjs.
   - 'kill': возможность оставлена на случай, если облако научится поднимать
     упавший контейнер; проверяем, что она работает. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshow-hardwatch-'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
/* Импорт в дочерних файлах — по file:// URL: на Windows обычный путь с D: ESM не принимает. */
const WATCHDOG_URL = JSON.stringify(pathToFileURL(path.join(root, 'src', 'watchdog.mjs')).href);

/** Дочерний процесс: запускает сторож и уходит в бесконечный цикл. */
function blockedChild({ stallSec, checkMs, blockMs, action }) {
  const file = path.join(tmp, `blocked-${action}-${stallSec}-${checkMs}.mjs`);
  fs.writeFileSync(
    file,
    `import { startHardWatchdog } from ${WATCHDOG_URL};
startHardWatchdog({ stallSec: ${stallSec}, checkMs: ${checkMs}, action: ${JSON.stringify(action)} });
process.stdout.write('started\\n');
setTimeout(() => {
  const until = Date.now() + ${blockMs};
  while (Date.now() < until) { /* занимаем главный поток целиком */ }
  process.stdout.write('survived\\n');
}, 200);
`,
    'utf8',
  );
  return file;
}

function run(file, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, ms: Date.now() - started });
    });
  });
}

test('зависший главный поток попадает в журнал, процесс остаётся жив', async () => {
  const file = blockedChild({ stallSec: 1, checkMs: 200, blockMs: 4000, action: 'log' });
  const result = await run(file);
  assert.match(result.err, /главный поток молчит/, 'сторож должен был написать строку в stderr');
  assert.equal(result.code, 0, `процесс не должен падать: code=${result.code} signal=${result.signal}`);
  assert.ok(result.out.includes('survived'), 'главный поток должен был доработать свой цикл');
});

test('живой процесс сторож не трогает и не пишет тревогу', async () => {
  const file = path.join(tmp, 'alive.mjs');
  fs.writeFileSync(
    file,
    `import { startHardWatchdog } from ${WATCHDOG_URL};
startHardWatchdog({ stallSec: 1, checkMs: 200 });
setTimeout(() => { process.stdout.write('alive'); process.exit(0); }, 2600);
`,
    'utf8',
  );
  const result = await run(file);
  assert.equal(result.code, 0, `живой процесс не должен падать: code=${result.code} signal=${result.signal}`);
  assert.ok(result.out.includes('alive'), 'процесс должен был дожить до конца');
  assert.ok(!/главный поток молчит/.test(result.err), 'тревоги быть не должно');
});

test('режим kill по-прежнему завершает зависший процесс', async () => {
  const file = blockedChild({ stallSec: 1, checkMs: 200, blockMs: 30000, action: 'kill' });
  const result = await run(file);
  assert.ok(
    result.signal === 'SIGKILL' || result.code !== 0,
    `процесс должен быть убит, а он вышел с code=${result.code} signal=${result.signal}`,
  );
  assert.ok(!result.out.includes('survived'), 'цикл не должен был закончиться сам');
  assert.ok(result.ms < 12000, `убийство заняло ${result.ms} мс — слишком долго`);
});

test('stallSec: 0 выключает жёсткий сторож', async () => {
  const file = path.join(tmp, 'off.mjs');
  fs.writeFileSync(
    file,
    `import { startHardWatchdog } from ${WATCHDOG_URL};
const guard = startHardWatchdog({ stallSec: 0 });
process.stdout.write(JSON.stringify(guard.stats()));
`,
    'utf8',
  );
  const result = await run(file);
  assert.equal(result.code, 0);
  assert.match(result.out, /"enabled":false/);
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
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* временная папка не нужна */
}
console.log(`\n${tests.length - failed}/${tests.length} тестов прошло`);
if (failed) process.exit(1);

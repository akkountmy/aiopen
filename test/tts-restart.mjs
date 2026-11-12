/**
 * Живой тест: озвучка переживает падение процесса.
 *
 * Сценарий ровно тот, из-за которого у человека не появлялся MP3: облако
 * развернуло новую версию посреди синтеза, контейнер умер, задание жило
 * только в памяти. Здесь процесс убивается по-настоящему (exit 9 из дочернего
 * процесса), а потом второй процесс поднимает журнал и дописывает файл.
 *
 * Проверяем: файл уже лежал на диске до смерти, продолжение началось с него
 * (первые байты не изменились), а не с нуля.
 *
 * Требует сеть (Edge TTS). Запуск:
 *   node test/tts-restart.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.DSHOW_DATA_DIR = process.env.DSHOW_DATA_DIR || path.resolve('.preview-data');

const tts = await import('../src/tts.mjs');

const workDir = path.resolve('.tmp/tts-restart');
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });

let passed = 0;
const failures = [];
const ok = (name, details = '') => {
  passed += 1;
  console.log(`  ok  ${name}${details ? ` — ${details}` : ''}`);
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BOOK = Array.from(
  { length: 10 },
  (_, index) =>
    `Раздел ${index + 1}. Договор лизинга описывает три стороны: лизингодатель покупает автомобиль, ` +
    'лизингополучатель платит взносы и пользуется машиной, а инвестор финансирует покупку и получает доход. ' +
    'Срок договора обычно два-три года, аванс составляет от десяти до тридцати процентов стоимости. ',
).join('\n\n');

const outPath = path.join(workDir, 'Проба перезапуска.mp3');
const readyFile = path.join(workDir, 'ready.json');

let ready = null;
try {
  const child = spawnSync(process.execPath, ['test/tts-crash-child.mjs', workDir, outPath, readyFile], {
    cwd: process.cwd(),
    env: { ...process.env, TTS_CRASH_TEXT: BOOK },
    stdio: 'ignore',
    timeout: 300_000,
  });
  assert(fs.existsSync(readyFile), `дочерний процесс не дошёл до первого куска (код ${child.status})`);
  ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
  assert(child.status === 9, `ожидали смерть посреди синтеза, код ${child.status}`);
  ok('процесс убит посреди синтеза', `${ready.written} из ${ready.total} кусков, ${ready.size} байт на диске`);
} catch (error) {
  failures.push(`подготовка: ${error.message}`);
  console.log(`  FAIL подготовка — ${error.message}`);
}

if (ready) {
  const prefix = fs.readFileSync(outPath);
  assert(prefix.length === ready.size, `файл на диске ${prefix.length} байт, а обещали ${ready.size}`);

  const report = tts.setNarrationJournal(workDir) && tts.resumeNarrations();
  const job = tts.getJob(ready.id, 'test-restart');
  if (report.resumed !== 1 || !job) {
    failures.push(`журнал: продолжено ${report.resumed}, задание ${job ? 'есть' : 'потерялось'}`);
    console.log(`  FAIL журнал — продолжено ${report.resumed}, задание ${job ? 'есть' : 'потерялось'}`);
  } else {
    ok('журнал вернул задание в работу', `возобновлений: ${job.resumed}`);
    const started = Date.now();
    let done = null;
    while (Date.now() - started < 300_000) {
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
        done = job;
        break;
      }
      await sleep(300);
    }
    if (!done || done.status !== 'done') {
      failures.push(`продолжение: ${done?.status || 'не закрылось'} ${done?.error || ''}`);
      console.log(`  FAIL продолжение — ${done?.status || 'не закрылось'} ${done?.error || ''}`);
    } else {
      const finalBuffer = fs.readFileSync(outPath);
      const kept = finalBuffer.subarray(0, prefix.length).equals(prefix);
      assert(kept, 'первые байты изменились: файл начали заново, а не продолжили');
      assert(finalBuffer.length > prefix.length, `файл не вырос: ${finalBuffer.length} при ${prefix.length}`);
      assert(done.parts[0].writtenChunks === done.chunks, `кусков ${done.parts[0].writtenChunks} из ${done.chunks}`);
      const duration = tts.mp3Duration(finalBuffer);
      ok('файл дописан с места остановки', `${prefix.length} → ${finalBuffer.length} байт, ${tts.humanDuration(duration)}`);
      ok('начало файла не переписано', 'первые байты совпадают байт в байт');
    }
  }
}

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  for (const item of failures) console.log(`  − ${item}`);
  process.exit(1);
}

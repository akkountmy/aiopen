/**
 * Живой тест доставки озвучки: файл появляется сразу и переживает перезапуск.
 *
 * Проверяем два обещания, которых раньше не было:
 *   • MP3 появляется в папке через секунды после старта и растёт по мере
 *     синтеза (раньше файл создавался один раз в самом конце части);
 *   • оборванную озвучку можно продолжить: журнал на диске возвращает задание
 *     в работу, а уже записанные куски не синтезируются заново.
 *
 * Требует сеть (Edge TTS). Запуск:
 *   node test/tts-stream.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.DSHOW_DATA_DIR = process.env.DSHOW_DATA_DIR || path.resolve('.preview-data');

const tts = await import('../src/tts.mjs');
const { synthesizeChunk } = await import('../src/edge-tts.mjs');

const workDir = path.resolve('.tmp/tts-stream');
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
const test = async (name, fn) => {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${error.message || error}`);
    console.log(`  FAIL ${name} — ${error.message || error}`);
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Метка прогона в тексте: иначе готовые куски придут из кэша, файл появится
   целиком в конце, и проверка потоковой записи ничего не проверит. */
const RUN = String(Date.now());
const BOOK = Array.from(
  { length: 8 },
  (_, index) =>
    `Абзац ${index + 1} (прогон ${RUN}). Автоинвест покупает автомобили и сдаёт их в лизинг: ` +
    'сделка оформляется на юридическое лицо, платежи идут ежемесячно, а машина остаётся в залоге до последнего взноса. ' +
    'Инвестор получает доход от платежей и может забрать автомобиль в собственность по остаточной стоимости. ',
).join('\n\n');

const waitDone = async (jobId, owner, limitMs) => {
  const started = Date.now();
  for (;;) {
    const job = tts.getJob(jobId, owner);
    assert(job, 'задание пропало из памяти');
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job;
    if (Date.now() - started > limitMs) throw new Error(`задание не закрылось за ${Math.round(limitMs / 1000)} с`);
    await sleep(300);
  }
};

/* ── 1. файл растёт, пока идёт синтез ─────────────────────────────────────── */
let streamJob = null;
await test('MP3 появляется до конца синтеза и растёт', async () => {
  const outPath = path.join(workDir, 'Потоковая проба.mp3');
  const job = tts.startNarration({
    ownerId: 'test-stream',
    title: 'Потоковая проба',
    text: BOOK,
    outPath,
    cacheDir: '',
  });
  streamJob = job;
  const sizes = [];
  let seenWhileRunning = false;
  const started = Date.now();
  while (Date.now() - started < 240_000) {
    let size = 0;
    try {
      size = fs.statSync(outPath).size;
    } catch {
      size = 0;
    }
    if (size > 0) {
      if (sizes[sizes.length - 1] !== size) sizes.push(size);
      if (job.status === 'running' || job.status === 'queued') seenWhileRunning = true;
    }
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') break;
    await sleep(120);
  }
  const final = await waitDone(job.id, 'test-stream', 240_000);
  assert(final.status === 'done', `${final.status}: ${final.error || ''}`);
  const finalSize = fs.statSync(outPath).size;
  assert(finalSize > 100_000, `файл всего ${finalSize} байт`);
  assert(seenWhileRunning, 'файл появился только после завершения задания');
  assert(sizes.length >= 2, `файл не рос: размеры ${sizes.join(' → ')}`);
  assert(sizes[0] < finalSize, `первый размер ${sizes[0]} не меньше итогового ${finalSize}`);
  assert(final.parts[0].writtenChunks === final.chunks, `кусков ${final.parts[0].writtenChunks} из ${final.chunks}`);
  ok('файл рос по ходу синтеза', `${sizes.length} замеров: ${sizes[0]} → ${finalSize} байт`);
  ok('куски записаны все', `${final.chunks} из ${final.chunks}, ${final.parts[0].file?.duration || ''}`);
});

/* ── 2. журнал возвращает оборванное задание в работу ─────────────────────── */
await test('журнал продолжает озвучку после перезапуска', async () => {
  const journalDir = path.join(workDir, 'journal');
  fs.mkdirSync(journalDir, { recursive: true });
  tts.setNarrationJournal(journalDir);

  const outPath = path.join(workDir, 'Проба после перезапуска.mp3');
  const chunks = tts.chunkText(BOOK, 700);
  assert(chunks.length >= 3, `кусков ${chunks.length}: для проверки нужно минимум 3`);

  /* Первый кусок будто синтезировался до падения и уже лежит в файле. */
  const first = await synthesizeChunk({ text: chunks[0], voice: tts.DEFAULT_VOICE, rate: '+0%' });
  fs.writeFileSync(outPath, first);
  const prefixBytes = first.length;
  assert(prefixBytes > 10_000, `первый кусок всего ${prefixBytes} байт`);

  const jobId = 'journalsim000001';
  const startedAt = Date.now() - 60_000;
  fs.writeFileSync(
    path.join(journalDir, `${jobId}.json`),
    JSON.stringify({
      version: 1,
      id: jobId,
      ownerId: 'test-resume',
      title: 'Проба после перезапуска',
      voice: tts.DEFAULT_VOICE,
      rate: tts.DEFAULT_RATE,
      provider: 'edge',
      outPath,
      wordPath: '',
      sourcePath: '',
      cacheDir: '',
      status: 'running',
      stage: 'Синтезирую речь',
      chars: BOOK.length,
      chunks: chunks.length,
      doneChunks: 1,
      percent: 10,
      seconds: 0,
      etaSeconds: null,
      partIndex: 1,
      file: null,
      files: [],
      error: '',
      warnings: [],
      resumed: 0,
      startedAt,
      finishedAt: 0,
      updatedAt: startedAt,
      parts: [
        {
          index: 1,
          label: '',
          text: BOOK,
          outPath,
          chars: BOOK.length,
          status: 'running',
          writtenChunks: 1,
          writtenBytes: prefixBytes,
          seconds: 20,
          file: null,
        },
      ],
    }),
    'utf8',
  );

  const report = tts.resumeNarrations();
  assert(report.resumed === 1, `продолжено заданий: ${report.resumed}`);
  const restored = tts.getJob(jobId, 'test-resume');
  assert(restored, 'задание не восстановилось из журнала');
  assert(restored.resumed === 1, `счётчик возобновлений: ${restored.resumed}`);

  const done = await waitDone(jobId, 'test-resume', 240_000);
  assert(done.status === 'done', `${done.status}: ${done.error || ''}`);

  const finalBuffer = fs.readFileSync(outPath);
  assert(finalBuffer.length > prefixBytes, `файл не вырос: ${finalBuffer.length} при ${prefixBytes}`);
  assert(
    finalBuffer.subarray(0, prefixBytes).equals(first),
    'первые байты файла изменились: продолжение перезаписало готовое',
  );
  const duration = tts.mp3Duration(finalBuffer);
  assert(duration > 20, `длительность ${duration} с`);
  ok('продолжил с недописанного куска', `было ${prefixBytes} → стало ${finalBuffer.length} байт, ${tts.humanDuration(duration)}`);
});

/* ── 3. в журнале не остаётся мусора после успеха ─────────────────────────── */
await test('после готовности журнал закрывает задание', async () => {
  const journalDir = tts.narrationJournalDir();
  const files = fs.readdirSync(journalDir).filter((name) => name.endsWith('.json'));
  for (const name of files) {
    const saved = JSON.parse(fs.readFileSync(path.join(journalDir, name), 'utf8'));
    const live = tts.getJob(saved.id, saved.ownerId);
    assert(live?.status === saved.status, `журнал ${name} расходится с заданием: ${saved.status} / ${live?.status}`);
  }
  ok('состояние в журнале совпадает с заданием', `${files.length} файлов`);
});

/* ── 4. повторная просьба не запускает второе задание ─────────────────────── */
await test('второй запуск на тот же MP3 отдаёт идущее задание', async () => {
  const outPath = path.join(workDir, 'Двойной запуск.mp3');
  const job = tts.startNarration({
    ownerId: 'test-dup',
    title: 'Двойной запуск',
    text: BOOK,
    outPath,
    cacheDir: '',
  });
  /* Два задания на один файл перемешали бы звук — второй раз должна вернуться
     та же работа, и только после завершения место освобождается. */
  const found = tts.findActiveNarration('test-dup', [outPath]);
  assert(found?.id === job.id, `вернулось ${found?.id || 'ничего'} вместо ${job.id}`);
  assert(tts.findActiveNarration('чужой', [outPath]) === null, 'чужое задание видно другому владельцу');
  const done = await waitDone(job.id, 'test-dup', 240_000);
  assert(done.status === 'done', `${done.status}: ${done.error || ''}`);
  assert(tts.findActiveNarration('test-dup', [outPath]) === null, 'закрытое задание считается активным');
  ok('второй запуск возвращает идущее задание', `после завершения место освободилось`);
});

console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
if (failures.length) {
  for (const item of failures) console.log(`  − ${item}`);
  process.exit(1);
}

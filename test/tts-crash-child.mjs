/**
 * Половина теста перезапуска: запускает озвучку и умирает без уборки.
 *
 * Ничего не закрывает и не сохраняет: имитирует развёртывание облака, которое
 * поднимает контейнер заново посреди синтеза. Всё, что должно пережить такую
 * смерть, обязано быть уже на диске.
 *
 * Запускается из test/tts-restart.mjs, не сам по себе.
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.DSHOW_DATA_DIR = process.env.DSHOW_DATA_DIR || path.resolve('.preview-data');

const tts = await import('../src/tts.mjs');

const [journalDir, outPath, readyFile] = process.argv.slice(2);
const text = String(process.env.TTS_CRASH_TEXT || '').trim();
if (!journalDir || !outPath || !readyFile || !text) {
  console.error('нужны: <журнал> <mp3> <готовность> и TTS_CRASH_TEXT');
  process.exit(2);
}

tts.setNarrationJournal(journalDir);
const job = tts.startNarration({
  ownerId: 'test-restart',
  title: 'Проба перезапуска',
  text,
  outPath,
  cacheDir: '',
});

/* Ждём, пока в файл ляжет хотя бы один кусок, а впереди останутся ещё два:
   так проверка «продолжил, а не начал заново» имеет смысл. */
const limit = Date.now() + 240_000;
while (Date.now() < limit) {
  const part = job.parts[0];
  const total = (part.chunks || []).length;
  const written = part.writtenChunks || 0;
  if (job.status === 'failed') {
    console.error(`синтез упал: ${job.error}`);
    process.exit(4);
  }
  if (written >= 1 && total - written >= 2) {
    fs.writeFileSync(
      readyFile,
      JSON.stringify({ id: job.id, size: fs.statSync(outPath).size, written, total, chunks: total }),
      'utf8',
    );
    /* Резкая смерть: ни закрытия дескриптора, ни финального журнала. */
    process.exit(9);
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
}
process.exit(3);

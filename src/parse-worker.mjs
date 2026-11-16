/**
 * Поток-разборщик: сюда главный поток отдаёт тяжёлый синхронный разбор.
 *
 * Здесь те же самые функции, что и раньше (jsdom + Readability + Turndown для
 * страниц, разборщики документов для файлов), — меняется только место работы.
 * Поэтому результат разбора не отличается от прежнего, а главный поток тем
 * временем отвечает на запросы и ведёт журнал.
 */
import { parentPort } from 'node:worker_threads';
import { extractFieldsLocal, extractReadableLocal } from './extract.mjs';
import { extractDocumentText } from './docparse.mjs';

if (!parentPort) {
  throw new Error('parse-worker.mjs запускается только как worker_threads');
}

parentPort.on('message', async (message) => {
  const { id, task } = message || {};
  try {
    let result;
    if (task?.kind === 'readable') {
      result = await extractReadableLocal(task.html, task.baseUrl, task.options || {});
    } else if (task?.kind === 'fields') {
      result = await extractFieldsLocal(task.html, task.baseUrl, task.selectors || {});
    } else if (task?.kind === 'document') {
      const buf = Buffer.isBuffer(task.buf)
        ? task.buf
        : Buffer.from(task.buf?.buffer ?? task.buf, task.buf?.byteOffset ?? 0, task.buf?.byteLength);
      result = extractDocumentText(buf, task.name || 'file', task.mime || '', task.limits || {});
    } else {
      throw new Error(`неизвестная задача разбора: ${task?.kind}`);
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message || error).slice(0, 500) });
  }
});

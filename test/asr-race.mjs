/**
 * Проверка распознавания речи без сети и без трат квоты.
 *
 * Подменяет `fetch` и смотрит на то, что сервис делает сам:
 *   1) тишина по краям записи срезается до отправки;
 *   2) модели идут наперегонки — ответ даёт первая успешная, а не последняя
 *      в списке, и медленная модель не задерживает остальные;
 *   3) если упали все, наружу уходит 502 с перечнем причин.
 *
 *     node test/asr-race.mjs
 */

import { ASR } from '../src/config.mjs';
import { transcribeAudio } from '../src/asr.mjs';

process.env.OPENROUTER_API_KEY = 'test-key';

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  ok — ${message}`);
    return;
  }
  failures += 1;
  console.error(`  ПРОВАЛ — ${message}`);
}

/* ── WAV 16 кГц моно 16 бит ──────────────────────────────────────────── */

function wav(parts) {
  // parts: [{ms, amplitude}] — синус заданной громкости (0 = тишина).
  const rate = 16000;
  const samples = [];
  for (const part of parts) {
    const count = Math.round((rate * part.ms) / 1000);
    for (let i = 0; i < count; i += 1) {
      const value = part.amplitude === 0 ? 0 : Math.round(part.amplitude * Math.sin((2 * Math.PI * 220 * i) / rate));
      samples.push(Math.max(-32768, Math.min(32767, value)));
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) data.writeInt16LE(samples[i], i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function wavSeconds(buffer) {
  return (buffer.length - 44) / 2 / 16000;
}

/** Подменить сеть: каждый вызов модели описывается обработчиком по имени. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    return handler(body.model, body, calls.length);
  };
  return calls;
}

function answer(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: text } }] }),
    text: async () => '',
  };
}

/* ── 1. тишина по краям ──────────────────────────────────────────────── */

console.log('тишина по краям:');
{
  const audio = wav([
    { ms: 1200, amplitude: 0 },
    { ms: 700, amplitude: 6000 },
    { ms: 1400, amplitude: 0 },
  ]);
  let sentSeconds = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const audioPart = body.messages[0].content.find((part) => part.type === 'input_audio');
    sentSeconds = Buffer.from(audioPart.input_audio.data, 'base64').length / 2 / 16000;
    return answer('проверка');
  };
  const started = Date.now();
  const result = await transcribeAudio({ buffer: audio, format: 'wav' });
  console.log(`  вход ${wavSeconds(audio).toFixed(2)} с → отправлено ${sentSeconds.toFixed(2)} с за ${String(Date.now() - started)} мс`);
  check(result.text === 'проверка', 'текст вернулся');
  check(sentSeconds > 0.6 && sentSeconds < wavSeconds(audio) - 0.6, 'тишина срезана, но речь сохранена');
}

/* ── 2. гонка моделей ────────────────────────────────────────────────── */

console.log('гонка моделей:');
{
  const audio = wav([{ ms: 400, amplitude: 5000 }]);
  const slow = ASR.models[0];
  const fast = ASR.models[1];
  stubFetch(async (model) => {
    if (model === slow) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return answer('медленная');
    }
    if (model === fast) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return answer('быстрая расшифровка');
    }
    return { ok: false, status: 429, text: async () => 'rate limit', json: async () => ({}) };
  });
  const started = Date.now();
  const result = await transcribeAudio({ buffer: audio, format: 'wav' });
  const elapsed = Date.now() - started;
  console.log(`  ответ «${result.text}» от ${result.provider} за ${String(elapsed)} мс`);
  check(result.text === 'быстрая расшифровка', 'победила первая успешная модель');
  check(result.provider === fast, 'провайдер — быстрая модель');
  check(elapsed < 1200, 'медленная модель не задержала ответ');
}

/* ── 3. все модели упали ─────────────────────────────────────────────── */

console.log('все модели упали:');
{
  const audio = wav([{ ms: 400, amplitude: 5000 }]);
  stubFetch(async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }));
  let error = null;
  try {
    await transcribeAudio({ buffer: audio, format: 'wav' });
  } catch (caught) {
    error = caught;
  }
  check(error !== null, 'ошибка выброшена');
  check(error?.status === 502, 'статус 502');
  check(Array.isArray(error?.failures) && error.failures.length === ASR.models.length, 'причины всех моделей собраны');
  check(/Не удалось распознать речь/.test(error?.message ?? ''), 'человеческое сообщение');
}

/* ── 4. пустая запись не уходит в сеть ───────────────────────────────── */

console.log('пустая запись:');
{
  let called = 0;
  stubFetch(async () => {
    called += 1;
    return answer('x');
  });
  let error = null;
  try {
    await transcribeAudio({ buffer: Buffer.alloc(0), format: 'wav' });
  } catch (caught) {
    error = caught;
  }
  check(error?.status === 400, 'пустая запись отклонена');
  check(called === 0, 'в сеть ничего не ушло');
}

console.log('');
console.log(failures === 0 ? 'ИТОГ: всё зелено' : `ИТОГ: провалов ${String(failures)}`);
process.exit(failures === 0 ? 0 : 1);

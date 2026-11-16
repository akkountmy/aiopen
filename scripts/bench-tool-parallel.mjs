import http from 'node:http';
import { groupToolCalls } from '../src/toolplan.mjs';

function arg(name, fallback) {
  const found = process.argv.find((item) => item.startsWith(`--${name}=`));
  return found ? Number(found.split('=')[1]) : fallback;
}

const DELAY = arg('delay', 700);
const CALLS = Math.max(2, arg('calls', 6));
const LIMIT = Math.max(1, arg('limit', 4));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const source = http.createServer((req, res) => {
  const n = new URL(req.url, 'http://127.0.0.1').searchParams.get('n') || '1';
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`ответ ${n}`);
  }, DELAY);
});

await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
const port = source.address().port;
const load = async (n) => {
  const response = await fetch(`http://127.0.0.1:${port}/?n=${n}`);
  await response.text();
};

const calls = Array.from({ length: CALLS }, (_, index) => ({
  id: `call_${index + 1}`,
  function: { name: 'fetch_url', arguments: JSON.stringify({ url: `/?n=${index + 1}` }) },
}));

const t0 = Date.now();
for (let i = 1; i <= CALLS; i += 1) await load(i);
const sequential = Date.now() - t0;

const t1 = Date.now();
const batches = groupToolCalls(calls, { limit: LIMIT });
let touched = 0;
for (const batch of batches) {
  if (batch.parallel && batch.calls.length > 1) {
    await Promise.all(batch.calls.map((_, index) => load(touched + index + 1)));
    touched += batch.calls.length;
  } else {
    touched += 1;
    await load(touched);
  }
}
const parallel = Date.now() - t1;

source.close();
await sleep(50);
const speedup = parallel > 0 ? sequential / parallel : 0;
console.log(`вызовов: ${CALLS}, задержка источника: ${DELAY} мс, лимит батча: ${LIMIT}`);
console.log(`последовательно: ${sequential} мс`);
console.log(`параллельно:     ${parallel} мс`);
console.log(`ускорение:       ${speedup.toFixed(2)}× (сэкономлено ${sequential - parallel} мс)`);
console.log(`батчей: ${batches.length} (из них параллельных ${batches.filter((b) => b.parallel && b.calls.length > 1).length})`);

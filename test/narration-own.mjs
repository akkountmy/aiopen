// Уборка прошлой озвучки: если частей стало меньше (книгу сократили или выбрали
// другую длину части), старые «часть 13 из 13.mp3» не должны оставаться рядом с
// новыми «часть 13 из 14.mp3». Убираем только то, что создали сами, и только
// внутри проекта. Оффлайн, без сети и сервера.
//
//   node test/narration-own.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { claimNarrationFiles, planNarrationFiles, partFileName } = await import('../src/narration-plan.mjs');

let passed = 0;
const failures = [];
const ok = (name, details = '') => {
  passed += 1;
  console.log(`  ok  ${name}${details ? ` — ${details}` : ''}`);
};
const fail = (name, error) => {
  failures.push(`${name}: ${error}`);
  console.log(`  FAIL ${name} — ${error}`);
};
async function test(name, fn) {
  try {
    await fn();
  } catch (error) {
    fail(name, error.message || String(error));
  }
}
const check = (name, condition, details = '') => (condition ? ok(name, details) : fail(name, details || 'условие не выполнено'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'narration-own-'));
const source = path.join(root, 'Белорусский рынок лизинга 2025 — обзор.pdf');
fs.writeFileSync(source, 'x');

await test('имена частей', async () => {
  check('одна часть — без номера', partFileName('Книга', 1, 1) === 'Книга.mp3', partFileName('Книга', 1, 1));
  check('много частей — с номером', partFileName('Книга', 2, 12) === 'Книга — часть 2 из 12.mp3', partFileName('Книга', 2, 12));
  const plan = planNarrationFiles(source, 3);
  check('план знает Word', path.basename(plan.word) === 'Белорусский рынок лизинга 2025 — обзор.docx', path.basename(plan.word));
});

await test('первая озвучка записывает список своих файлов', async () => {
  const plan = claimNarrationFiles(source, 3, { root });
  for (const part of plan.parts) fs.writeFileSync(part.path, 'mp3');
  fs.writeFileSync(plan.word, 'docx');
  const ledger = JSON.parse(fs.readFileSync(path.join(root, '.dshow', 'narration-own.json'), 'utf8'));
  const key = Object.keys(ledger)[0];
  check('в списке три части и Word', ledger[key].length === 4, `${key}: ${ledger[key].length}`);
});

await test('частей стало меньше — лишние файлы уходят', async () => {
  const plan = claimNarrationFiles(source, 1, { root });
  const left = fs.readdirSync(root).filter((name) => name.endsWith('.mp3'));
  check('осталась одна часть', left.length === 0 || left.length === 1, `mp3: ${left.join(', ') || 'нет'}`);
  check('имя части без номера', path.basename(plan.parts[0].path) === 'Белорусский рынок лизинга 2025 — обзор.mp3', path.basename(plan.parts[0].path));
  check('Word на месте', fs.existsSync(plan.word));
});

await test('чужое за пределами проекта не удаляется', async () => {
  const outside = path.join(os.tmpdir(), `narration-own-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'не трогать');
  fs.writeFileSync(
    path.join(root, '.dshow', 'narration-own.json'),
    JSON.stringify({ 'Белорусский рынок лизинга 2025 — обзор.pdf': ['../' + path.basename(outside)] }),
    'utf8',
  );
  claimNarrationFiles(source, 1, { root });
  check('файл вне проекта уцелел', fs.existsSync(outside));
  fs.rmSync(outside, { force: true });
});

await test('озвучка без списка не падает', async () => {
  const lonely = path.join(root, 'Другая книга.docx');
  fs.writeFileSync(lonely, 'x');
  const plan = claimNarrationFiles(lonely, 2, { root });
  check('план построен', plan.parts.length === 2);
});

fs.rmSync(root, { recursive: true, force: true });

const failed = failures.length;
console.log(`\nИтого: ${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);

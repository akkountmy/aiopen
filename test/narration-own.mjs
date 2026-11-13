// Уборка прошлой озвучки: если частей стало меньше (книгу сократили или выбрали
// другую длину части), старые «часть 13 из 13.mp3» не должны оставаться рядом с
// новыми «часть 13 из 14.mp3». Убираем только то, что создали сами, и только
// внутри проекта.
//
// Главное правило проверки: уборка отложенная. Заявка на файлы НИЧЕГО не удаляет —
// старый звук уходит только после того, как новый комплект готов (sweep), иначе
// упавшая озвучка оставляла человека без книги вообще. Оффлайн, без сети и сервера.
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

/* Настоящий звук весит десятки килобайт: файл меньше килобайта уборка не считает
   заменой, поэтому в тесте пишем заведомо «готовые» файлы. */
const writeAudio = (file) => fs.writeFileSync(file, 'x'.repeat(4096));

await test('имена частей', async () => {
  check('одна часть — без номера', partFileName('Книга', 1, 1) === 'Книга.mp3', partFileName('Книга', 1, 1));
  check('много частей — с номером', partFileName('Книга', 2, 12) === 'Книга — часть 2 из 12.mp3', partFileName('Книга', 2, 12));
  const plan = planNarrationFiles(source, 3);
  check('план знает Word', path.basename(plan.word) === 'Белорусский рынок лизинга 2025 — обзор.docx', path.basename(plan.word));
});

await test('первая озвучка записывает список своих файлов', async () => {
  const plan = claimNarrationFiles(source, 3, { root });
  for (const part of plan.parts) writeAudio(part.path);
  fs.writeFileSync(plan.word, 'docx');
  const ledger = JSON.parse(fs.readFileSync(path.join(root, '.dshow', 'narration-own.json'), 'utf8'));
  const key = Object.keys(ledger)[0];
  check('в списке три части и Word', ledger[key].length === 4, `${key}: ${ledger[key].length}`);
});

/* Заявка на файлы одна на одну озвучку — ровно как в сервисе: задание получает
   план и функцию уборки, а убирает уже после готовности. */
let pending = null;

await test('заявка на файлы не удаляет старую озвучку', async () => {
  pending = claimNarrationFiles(source, 1, { root });
  const left = fs.readdirSync(root).filter((name) => name.endsWith('.mp3'));
  check('старые части на месте, пока новой нет', left.length === 3, `mp3: ${left.length}`);
  check('план помнит прошлый комплект', pending.previous.length === 4, `прошлых: ${pending.previous.length}`);
  check('план на одну часть', pending.parts.length === 1, path.basename(pending.parts[0].path));
});

await test('новая озвучка готова — лишние файлы уходят', async () => {
  const plan = pending;
  writeAudio(plan.parts[0].path);
  fs.writeFileSync(plan.word, 'docx');
  const swept = plan.sweep();
  const left = fs.readdirSync(root).filter((name) => name.endsWith('.mp3'));
  check('осталась одна часть', left.length === 1, `mp3: ${left.join(', ') || 'нет'}`);
  check('убраны ровно три старые части', swept.removed.length === 3, swept.removed.join(', '));
  check('имя части без номера', path.basename(plan.parts[0].path) === 'Белорусский рынок лизинга 2025 — обзор.mp3', path.basename(plan.parts[0].path));
  check('Word на месте', fs.existsSync(plan.word));
  pending = null;
});

await test('замена не готова — не удаляется ничего', async () => {
  const plan = claimNarrationFiles(source, 2, { root });
  const swept = plan.sweep();
  const left = fs.readdirSync(root).filter((name) => name.endsWith('.mp3'));
  check('старый файл уцелел', left.length === 1, `mp3: ${left.join(', ') || 'нет'}`);
  check('ничего не убрано', swept.removed.length === 0, `kept: ${swept.kept.join(', ')}`);
  /* После этой проверки в журнале записан план на две части — вернём одну. */
  const again = claimNarrationFiles(source, 1, { root });
  writeAudio(again.parts[0].path);
  fs.writeFileSync(again.word, 'docx');
  again.sweep();
});

await test('чужое за пределами проекта не удаляется', async () => {
  const outside = path.join(os.tmpdir(), `narration-own-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'не трогать');
  fs.writeFileSync(
    path.join(root, '.dshow', 'narration-own.json'),
    JSON.stringify({ 'Белорусский рынок лизинга 2025 — обзор.pdf': ['../' + path.basename(outside)] }),
    'utf8',
  );
  const plan = claimNarrationFiles(source, 1, { root });
  writeAudio(plan.parts[0].path);
  fs.writeFileSync(plan.word, 'docx');
  const swept = plan.sweep();
  check('файл вне проекта уцелел', fs.existsSync(outside));
  check('и в отчёт уборки не попал', swept.removed.length === 0, swept.removed.join(', '));
  fs.rmSync(outside, { force: true });
});

await test('озвучка без списка не падает', async () => {
  const lonely = path.join(root, 'Другая книга.docx');
  fs.writeFileSync(lonely, 'x');
  const plan = claimNarrationFiles(lonely, 2, { root });
  check('план построен', plan.parts.length === 2);
  check('уборка есть, но убирать нечего', typeof plan.sweep === 'function' && plan.sweep().removed.length === 0);
});

fs.rmSync(root, { recursive: true, force: true });

const failed = failures.length;
console.log(`\nИтого: ${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);

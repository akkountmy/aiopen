// Проверка ссылок в ответах ассистента: имя файла проекта в тексте или в
// ссылке должно открывать файл целиком, даже если в имени есть пробелы и тире.
//
// Разбор живёт в public/app.js и зависит только от filesProjectId, поэтому
// вырезаем нужный кусок и вызываем inlineMd напрямую — без браузера.
//
//   node test/md-links.mjs
import fs from 'node:fs';

const code = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = code.indexOf('const MD_FILE_EXTS');
const end = code.indexOf('function renderMarkdown');
if (start < 0 || end < 0) {
  console.log('  FAIL не нашёл в public/app.js разбор ссылок');
  process.exit(1);
}
const { inlineMd } = new Function('filesProjectId', code.slice(start, end) + '\nreturn { inlineMd };')(() => 'P');

const BOOK = 'Белорусский рынок лизинга 2025 — обзор — часть 2 из 13.mp3';
const WORD = 'Предисловие к обзору лизинга 2025.docx';

const results = [];
function check(name, text, ok) {
  const html = inlineMd(text);
  const pass = ok(html);
  results.push(pass);
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : ` — ${html}`}`);
}

/* Имя в кавычках — цитата имени, ссылка обязана вести на весь файл. */
check('имя с пробелами в кавычках', `Word — «${WORD}» с текстом предисловия.`, (html) =>
  html.includes(`data-file-path="${WORD}"`) && html.includes(`>${WORD}</a>`),
);
check('длинное имя с тире', `готово: «${BOOK}».`, (html) => html.includes(`data-file-path="${BOOK}"`));

/* Имя в обратных кавычках тоже ссылка — так чаще всего пишет модель. */
check('имя с пробелами в обратных кавычках', `Открыл \`${WORD}\` и озвучил.`, (html) =>
  html.includes(`data-file-path="${WORD}"`),
);

/* Служебная ссылка на файл проекта: путь с пробелами не должен обрываться. */
check('ссылка /api/projects/…/file?path=…', `Готово: [текст](\/api\/projects\/P\/file?path=${WORD})`, (html) =>
  html.includes(`data-file-path="${WORD}"`) && html.includes('>текст</a>'),
);
check('ссылка с закодированным путём', `Готово: [MP3](/api/projects/P/file?path=${encodeURIComponent(BOOK)})`, (html) =>
  html.includes(`data-file-path="${BOOK}"`),
);

/* Имя без пробелов в обычном тексте — по-прежнему ссылка. */
check('простое имя в тексте', 'Файл Глава-первая.txt лежит рядом.', (html) => html.includes('data-file-path="Глава-первая.txt"'));

/* Ложные срабатывания: расширение без имени и внешняя ссылка. */
check('расширение без имени', 'Не нашлось ни одного .docx — и это нормально.', (html) => !html.includes('data-file-path='));
check('внешняя ссылка остаётся внешней', 'Смотри https://example.com — там всё.', (html) =>
  html.includes('href="https://example.com"') && !html.includes('data-file-path='),
);

/* Скачивание части озвучки — обычная ссылка, а не файл проекта. */
check('ссылка на звук задания', '[MP3](/api/tts/jobs/abc/audio?part=2&download=1)', (html) =>
  html.includes('href="/api/tts/jobs/abc/audio?part=2&download=1"') && !html.includes('data-file-path='),
);

const failed = results.filter((value) => !value).length;
console.log(`\nИтого: ${results.length - failed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);

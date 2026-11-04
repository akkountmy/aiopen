// Длину части озвучки выбирает не человек, а структура книги: короткие главы
// собираются в получасовые части, глава на 20–45 минут идёт целиком, простыня
// режется внутри. Отдельное правило — короткая выжимка: если весь текст
// укладывается в 45 минут звука, это всегда ОДИН MP3, даже когда внутри есть
// главы: «часть 1 из 2» у получасовой записи только мешает. Здесь проверяем
// оба правила и заодно то, что заголовки глав вообще распознаются — `\b` после
// кириллицы в JavaScript не срабатывает, и однажды из-за этого главы не
// находились вовсе, а части резались по предложениям.
//
//   node test/part-length.mjs
import {
  PART_MINUTES,
  SINGLE_FILE_MINUTES,
  choosePartMinutes,
  narrationParts,
  planParts,
  splitIntoParts,
} from '../src/tts.mjs';

let passed = 0;
const failures = [];
const ok = (name, details = '') => {
  passed += 1;
  console.log(`  ok  ${name}${details ? ` — ${details}` : ''}`);
};
const fail = (name, details) => {
  failures.push(`${name}: ${details}`);
  console.log(`  FAIL ${name} — ${details}`);
};
const check = (name, condition, details = '') => (condition ? ok(name, details) : fail(name, details || 'условие не выполнено'));

/* Глава заданной длины: заголовок отдельным абзацем и текст после него — так
   выглядит книга после разбора docx. */
const chapter = (name, minutes) =>
  `\n\n${name}\n\n` + 'Предложение про рынок лизинга и его участников. '.repeat(Math.ceil((minutes * 750) / 53));
const book = (sizes) => sizes.map((minutes, index) => chapter(`Глава ${index + 1}`, minutes)).join('\n');

/* Заголовки: кириллица и разные написания — раньше здесь молча ломался regex. */
const headings = ['Глава 1', 'ГЛАВА ПЕРВАЯ', 'Раздел 2. Итоги', 'Приложение А', 'Предисловие', 'Оглавление'];
const shortHeadings = ['Глава 1\n\n' + 'текст '.repeat(1400)];
for (const heading of headings) {
  const text = `\n\n${heading}\n\n${'текст '.repeat(1400)}\n\n${'ещё текст '.repeat(1400)}`;
  const parts = splitIntoParts(text, { minutes: 5 });
  check(`заголовок «${heading}» начинает часть`, parts.length >= 1 && parts[0].startsWith(heading.slice(0, 6)), `частей ${parts.length}`);
}
check('короткий документ — одна часть', splitIntoParts(shortHeadings[0], { minutes: 30 }).length === 1);

/* Выбор длины по главам. */
const cases = [
  { name: 'короткие главы (по 8 мин) собираются', sizes: [8, 9, 7], minutes: PART_MINUTES, pieces: 1 },
  { name: 'главы по 25 минут идут по одной', sizes: [25, 26, 24], minutes: null, pieces: 3 },
  { name: 'главы по 40 минут не дробятся', sizes: [40, 42], minutes: null, pieces: 2 },
  { name: 'глава-простыня режется внутри', sizes: [70], minutes: PART_MINUTES, pieces: 2 },
];
for (const { name, sizes, minutes, pieces } of cases) {
  const text = book(sizes);
  const chosen = choosePartMinutes(text);
  const parts = splitIntoParts(text, { minutes: chosen });
  const minutesOk = minutes === null ? chosen >= 20 && chosen <= 45 : chosen === minutes;
  check(name, minutesOk && parts.length === pieces, `целевая ${chosen} мин, частей ${parts.length}`);
}

/* Главное правило для выжимок: короткая запись — один файл, даже с главами. */
const summary = book([6, 5, 7, 6, 6]); // ≈ 30 минут звука, пять глав
const summaryParts = narrationParts(summary);
check('выжимка на 30 минут с главами — один MP3', summaryParts.length === 1, `частей ${summaryParts.length}`);
check('план той же выжимки — одна часть', planParts(summary).length === 1, `частей ${planParts(summary).length}`);

/* Порог 45 минут: ровно на нём ещё один файл, чуть больше — уже части. */
const atThreshold = 'Слово. '.repeat(Math.floor((SINGLE_FILE_MINUTES * 750) / 7));
check(
  `выжимка на ${SINGLE_FILE_MINUTES} минут — ещё один MP3`,
  narrationParts(atThreshold).length === 1,
  `${(atThreshold.length / 750).toFixed(1)} мин, частей ${narrationParts(atThreshold).length}`,
);
const overThreshold = 'Слово. '.repeat(Math.ceil(((SINGLE_FILE_MINUTES + 5) * 750) / 7));
check(
  'длиннее порога — режется на части',
  narrationParts(overThreshold).length > 1,
  `${(overThreshold.length / 750).toFixed(1)} мин, частей ${narrationParts(overThreshold).length}`,
);
check(
  'большая книга с главами — несколько частей',
  narrationParts(book([20, 22, 18, 21])).length > 1,
  `частей ${narrationParts(book([20, 22, 18, 21])).length}`,
);
/* Явный размер части — заказ, его не перебивает правило короткой выжимки. */
check(
  'явные минуты режут и короткий текст',
  narrationParts(book([9]), { minutes: 3 }).length >= 2,
  `частей ${narrationParts(book([9]), { minutes: 3 }).length}`,
);

/* Ни одна часть не выходит за разумные рамки: две части вместо одной и наоборот. */
const longBook = book([12, 30, 18, 9, 41]);
const longMinutes = choosePartMinutes(longBook);
const longParts = splitIntoParts(longBook, { minutes: longMinutes });
const sizes = longParts.map((part) => Math.round((part.length / 750) * 10) / 10);
check(
  'ни одна часть не длиннее 45 минут',
  sizes.every((size) => size <= 45.5),
  `${sizes.join(' / ')} мин`,
);

/* Документ без заголовков (PDF-выгрузка, договор) — полчаса. */
check('без заголовков — полчаса', choosePartMinutes('Предложение без заголовка. '.repeat(9000)) === PART_MINUTES);
check('пустой текст — полчаса', choosePartMinutes('') === PART_MINUTES);
check('одна короткая глава — полчаса', choosePartMinutes(book([3])) === PART_MINUTES);

console.log(`\nИтого: ${passed} ok, ${failures.length} fail`);
if (failures.length) {
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exitCode = 1;
}

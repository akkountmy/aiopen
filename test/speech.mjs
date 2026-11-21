// Текст для голоса: диктор не должен читать разметку, коды и хронометраж.
// Образцы — из настоящих книг проекта (Канеман, Фишер и Юри, Голдсмит).
//
//   node test/speech.mjs
//
// Проверок ровно 21: разметка, диапазоны, тире, адреса и почта, служебные
// коды, подпись «— выжимка 40 минут», повтор названия, отдельные строки
// заголовков, служебные строки вёрстки, дефисные диапазоны, даты и составные
// имена, идемпотентность, обычный и пустой текст, номер книги в шапке (три
// вида), значки и сокращения словами, белый список символов, html-выгрузка,
// ссылки и картинки, служебные строки вёрстки.
import { speechText } from '../src/speech.mjs';
import { normalizeText, splitBlocks } from '../src/tts.mjs';

let passed = 0;
const failures = [];
const ok = (name, details = '') => {
  passed += 1;
  console.log(`  ok  ${name}${details ? ` — ${details}` : ''}`);
};
const check = (name, condition, details = '') => {
  if (condition) ok(name, details);
  else {
    failures.push(`${name}: ${details || 'условие не выполнено'}`);
    console.log(`  FAIL ${name} — ${details || 'условие не выполнено'}`);
  }
};
const show = (text) => String(text).replace(/\n/g, ' / ');

/* 1. Разметка: заголовки, жирный текст, код и табличные черты. */
const markup = speechText('# Думай медленно\n\n## Часть 1.\n\n**Жирный** текст с `кодом` и | таблицей |.');
check(
  'разметка снята, слова на месте',
  !/[#*`|]/.test(markup) &&
    markup.includes('Думай медленно') &&
    markup.includes('Часть 1.') &&
    markup.includes('Жирный текст с кодом'),
  show(markup),
);

/* 2. Диапазоны: тире и дефис читаются словами. */
const ranges = speechText('Хронометраж 45–50 минут и 12—15 секунд.');
check(
  'диапазоны раскрыты словами',
  ranges.includes('от 45 до 50 минут') && ranges.includes('от 12 до 15 секунд'),
  ranges,
);

/* 3. Тире: не «тире», а пауза; реплика не теряется. */
const dashes = speechText('слово — слово\n— Здравствуйте!');
check(
  'тире стало паузой',
  !/[—–―]/.test(dashes) && /слово,\s*слово/.test(dashes) && dashes.includes('Здравствуйте!'),
  show(dashes),
);

/* 4. Адреса и почта: диктор не читает их посимвольно. */
const links = speechText('Источник: https://example.com/a?b=1, почта mail@test.ru и www.example.org.');
check(
  'адреса и почта не читаются',
  !/https?:|www\.|@|example\.(?:com|org)/i.test(links) && links.includes('Источник'),
  links,
);

/* 5. Служебные коды, имена файлов и UUID: таких строк в звуке нет. */
const codes = speechText('задание tts_ab12cd34, проект p_mw1n5z0o7968a8f43b, файл книга.docx и UUID 123e4567-e89b-12d3-a456-426614174000.');
check(
  'коды и имена файлов выброшены',
  !/tts_|p_mw|\.docx|123e4567|[0-9a-f]{8}-/i.test(codes) &&
    !codes.includes('_') &&
    !codes.includes('книга') &&
    codes.includes('файл'),
  codes,
);

/* 6. Подпись «— выжимка 40 минут» в названии — код конвейера, а не книга. */
const label = speechText('Прыгни выше головы — выжимка 40 минут');
check(
  'подпись хронометража снята',
  label === 'Прыгни выше головы.',
  label,
);

/* 7. Повтор названия в первой строке: книга открывается один раз. */
const kaneman = speechText(
  [
    'Думай медленно — выжимка 45–50 минут',
    '# Думай медленно… решай быстро — выжимка 45–50 минут Книга Даниэля Канемана',
    '## Часть 1. Две системы мышления',
    'Текст главы.',
  ].join('\n'),
);
check(
  'повтор названия снят',
  (kaneman.match(/Думай медленно/gi) || []).length === 1 &&
    !kaneman.includes('выжимка') &&
    !kaneman.includes('45') &&
    kaneman.includes('Книга Даниэля Канемана'),
  show(kaneman),
);

/* 8. Заголовки остаются отдельными строками: по ним режется книга. */
const headingDoc = normalizeText(
  '## Часть 1. Две системы мышления\n\nПервое предложение.\nВторое предложение.\n\n## Часть 2. Эвристики\n\nТретье.',
);
const headingLines = headingDoc.split('\n');
const blocks = splitBlocks(headingDoc);
check(
  'заголовки — отдельные строки',
  headingLines.includes('Часть 1. Две системы мышления') &&
    headingLines.includes('Часть 2. Эвристики') &&
    blocks.length === 2 &&
    blocks[0].startsWith('Часть 1.') &&
    blocks[1].startsWith('Часть 2.'),
  `${blocks.length} блока; ${show(headingDoc)}`,
);

/* 9. Служебные строки вёрстки: номера страниц, колонтитулы, метаданные docx. */
const layout = normalizeText(
  'Текст книги.\n\n12\n\n[Колонтитул] стр. 12\nЗаголовок документа: книга\n\nПродолжение.',
);
check(
  'служебные строки вёрстки убраны',
  !/Колонтитул|Заголовок документа/.test(layout) &&
    !/^\s*12\s*$/m.test(layout) &&
    layout.includes('Текст книги.') &&
    layout.includes('Продолжение.'),
  show(layout),
);

/* 10. Дефисный диапазон: «12-15 секунд» — это «от 12 до 15 секунд». */
const hyphenRange = speechText('Пауза 12-15 секунд.');
check(
  'дефисный диапазон раскрыт',
  hyphenRange.includes('от 12 до 15 секунд'),
  hyphenRange,
);

/* 11. Даты и составные имена: дефис в них — не диапазон. */
const dates = speechText('Договор от 12-05-2024, танк Т-34 и Москва-Сити.');
check(
  'даты и составные имена целы',
  dates.includes('12-05-2024') && dates.includes('Т-34') && dates.includes('Москва-Сити'),
  dates,
);

/* 12. Идемпотентность: повторная очистка ничего не меняет. */
const once = speechText('## Часть 1. Две системы\n\nТекст с 45–50 минут.');
const twice = speechText(once);
check(
  'повторная очистка не меняет текст',
  once === twice,
  `1: ${show(once)}; 2: ${show(twice)}`,
);

/* 13. Обычный текст не трогаем, пустой не роняет. */
const plain = 'Обычный текст без разметки. Второе предложение.';
check(
  'обычный текст цел, пустой не падает',
  speechText(plain) === plain && speechText('') === '' && speechText(null) === '',
  speechText(plain),
);


/* 14. Номер книги в шапке — метка библиотеки, а не название. Раньше правило
   «№ → номер» превращало её в речь «выжимка номер двенадцать», и запись
   открывалась служебным числом вместо книги. */
const bookLabel = speechText('Выжимка № 12. Трансформированная организация\nКаган и соавторы\nТекст выжимки.');
check(
  'номер книги в шапке не читается',
  !/номер|№|12/i.test(bookLabel) &&
    bookLabel.startsWith('Трансформированная организация') &&
    bookLabel.includes('Каган и соавторы') &&
    bookLabel.includes('Текст выжимки.'),
  show(bookLabel),
);

/* 15. Другие виды той же метки: «№ 3 —», «Книга 12 из 49», «Выжимка 7.». */
const noMark = speechText('№ 3 — Transformed.\nТекст.');
const noSeries = speechText('Книга 12 из 49. Transformed\nТекст.');
const noOrdinal = speechText('Выжимка 7. Эпилог\nТекст.');
check(
  'метки «№ 3», «Книга 12 из 49», «Выжимка 7» сняты',
  !/номер|49/.test(noMark) && noMark.includes('Transformed') &&
    !/Книга|49/.test(noSeries) && noSeries.includes('Transformed') &&
    !/Выжимка|7\./.test(noOrdinal) && noOrdinal.includes('Эпилог'),
  `${show(noMark)} | ${show(noSeries)} | ${show(noOrdinal)}`,
);

/* 16. Значки и сокращения — словами, а не пропуском: число в книге это смысл. */
const words = speechText('Скидка 45% при 30 °C, стр. 12, т. е. дёшево.');
check(
  'проценты, градусы и сокращения прочитаны словами',
  words.includes('45 процентов') &&
    words.includes('30 градусов') &&
    words.includes('страница 12') &&
    words.includes('то есть') &&
    !/[%°]/.test(words),
  words,
);

/* 17. Числительные согласуются: «1,5 миллиона рублей», а не «1,5 миллионов». */
const money = speechText('Бюджет 1,5 млн руб. и 5 млн руб., 3 тыс. штук.');
check(
  'числительные согласованы',
  money.includes('1,5 миллиона рублей') &&
    money.includes('5 миллионов рублей') &&
    money.includes('3 тысячи штук'),
  money,
);

/* 18. Белый список: посторонний символ не дойдёт до голоса, что бы ни пришло
   в документе — стрелки, валюты, скобки вёрстки, невидимые знаки. */
const junk = speechText('Текст ✓ ★ → € © ~ ^ [x] {y} <tag> \\ / | ° ± «цитата» № 5.');
const allowed = /^[\p{L}\p{N}\s.,;:!?…«»"“”„'’()-]*$/u;
check(
  'посторонних символов в звуке нет',
  allowed.test(junk) && junk.includes('Текст') && junk.includes('цитата') && junk.includes('номер 5'),
  junk,
);


/* 19. HTML из выгрузки: теги и сущности — вёрстка, диктор их не читает. */
const html = speechText('<p>Абзац&nbsp;текста &amp; ещё</p>');
check(
  'html-теги и сущности не читаются',
  !/[<>&]/.test(html) && html.includes('Абзац текста') && html.includes('ещё'),
  html,
);

/* 20. Ссылки и картинки: подпись остаётся, адрес и скобки от него — нет. */
const rich = speechText('Смотри [отчёт за 2025](https://example.com/a?b=1) и ![схема](img.png).');
check(
  'подпись ссылки есть, адреса нет',
  rich.includes('отчёт за 2025') && !/http|img\.png|\(|\)/.test(rich),
  rich,
);

/* 21. Служебные строки вёрстки и чек-боксы: страница, колонтитул, «[x]». */
const layout2 = speechText('Текст.\n\n12\n\n[Колонтитул] стр. 12\nЗаголовок документа: книга\n- [x] сделано');
check(
  'колонтитулы и чек-боксы убраны',
  layout2.includes('Текст.') &&
    layout2.includes('сделано') &&
    !/Колонтитул|Заголовок|страница|12/.test(layout2),
  show(layout2),
);

console.log(`\nИтого: ${passed} ok, ${failures.length} fail`);
process.exit(failures.length ? 1 : 0);

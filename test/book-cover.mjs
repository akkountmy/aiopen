/* Имя книги из имени файла: обложка ищется по чистому названию, поэтому
   «часть 1 из 12» и «— выжимка» не должны попадать в поисковый запрос.
   Сеть здесь не нужна: проверяется только разбор имени. */
import { bookTitleFromFile, coverBase } from '../src/book-cover.mjs';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
};

console.log('Проверка имени книги для обложки');
check(
  'часть книги убирается',
  bookTitleFromFile('Атомные привычки — часть 1 из 12.mp3') === 'Атомные привычки',
  bookTitleFromFile('Атомные привычки — часть 1 из 12.mp3'),
);
check(
  'слово «выжимка» убирается',
  bookTitleFromFile('Думай медленно… решай быстро — выжимка.docx') === 'Думай медленно… решай быстро',
  bookTitleFromFile('Думай медленно… решай быстро — выжимка.docx'),
);
check(
  'приписка в начале убирается',
  bookTitleFromFile('Выжимка — Атомные привычки.docx') === 'Атомные привычки',
  bookTitleFromFile('Выжимка — Атомные привычки.docx'),
);
check(
  'приписка в скобках убирается',
  bookTitleFromFile('Атомные привычки (конспект).docx') === 'Атомные привычки',
  bookTitleFromFile('Атомные привычки (конспект).docx'),
);
check(
  'обычное имя остаётся',
  bookTitleFromFile('Sapiens. Краткая история человечества.pdf') === 'Sapiens. Краткая история человечества',
  bookTitleFromFile('Sapiens. Краткая история человечества.pdf'),
);
check('пустое имя не ломает поиск', bookTitleFromFile('') === 'озвучка', bookTitleFromFile(''));
check('запрещённые знаки заменяются', !/[\\/:*?"<>|]/.test(coverBase('Книга: том 1/2')));
check('длинное имя обрезается', coverBase('я'.repeat(200)).length <= 80);

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки имени книги пройдены');

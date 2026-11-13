// Чистка разметки для голоса: диктор не должен читать «решётка решётка»,
// «звёздочка звёздочка» и «вертикальная черта». Главная проверка — обратная:
// ни одно слово, число или дата не исчезает. Именно на этом ломалась прошлая
// попытка «убрать лишние символы»: заодно из книги выпадали абзацы.
//
//   node test/speech-text.mjs
const { speechText } = await import('../src/speech-text.mjs');

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

/* Слова — это буквы и цифры: сравнение по «мешку» токенов ловит и потерянный
   абзац, и переставленное слово, и выпавшее число. */
const words = (text) => String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const sameWords = (before, after) => {
  const a = words(before).sort();
  const b = words(after).sort();
  return a.length === b.length && a.every((word, index) => word === b[index]);
};

await test('заголовки: решётки убраны, текст цел', async () => {
  const before = '### Глава первая\n\nТекст главы.';
  const after = speechText(before);
  check('решёток нет', !after.includes('#'), after.split('\n')[0]);
  check('заголовок на месте', after.startsWith('Глава первая'), after.split('\n')[0]);
  check('слова не потеряны', sameWords(before, after));
});

await test('акценты и код: звёздочки и обратные кавычки убраны', async () => {
  const before = 'Это **важное** слово, *курсив* и `код`, а ещё __подчёркнутое__.';
  const after = speechText(before);
  check('звёздочек нет', !/[*]/.test(after), after);
  check('подчёркиваний нет', !/_/.test(after), after);
  check('кавычек кода нет', !after.includes('`'), after);
  check('слова те же', sameWords(before, after));
});

await test('таблица: черты убраны, ячейки читаются словами', async () => {
  const before = '| Год | Выручка |\n| --- | :---: |\n| 2024 | 12,5 млрд |';
  const after = speechText(before);
  check('вертикальных черт нет', !after.includes('|'), after.replace(/\n/g, ' / '));
  check('разделитель таблицы вырезан', !/---/.test(after), after.replace(/\n/g, ' / '));
  check('слова и числа те же', sameWords(before, after));
});

await test('цитаты, списки и чек-боксы', async () => {
  const before = '> Цитата из книги\n\n- пункт один\n* пункт два\n- [x] сделано';
  const after = speechText(before);
  check('знаков цитаты нет', !after.includes('>'), after.replace(/\n/g, ' / '));
  check('буллитов нет', !/^\s*[-*]\s/m.test(after), after.replace(/\n/g, ' / '));
  check('чек-боксов нет', !/\[[xX ]?\]/.test(after), after.replace(/\n/g, ' / '));
  /* «[x]» — служебная галочка, а не слово: сверяем с текстом без неё. */
  check('слова те же', sameWords('Цитата из книги пункт один пункт два сделано', after), after.replace(/\n/g, ' / '));
});

await test('ссылки и картинки: остаётся подпись, адрес не читается', async () => {
  const before = 'Смотри [отчёт за 2025](https://example.com/a?b=1) и ![схема](img.png).';
  const after = speechText(before);
  check('адреса нет', !after.includes('http'), after);
  check('подпись осталась', after.includes('отчёт за 2025'), after);
  check('подпись картинки осталась', after.includes('схема'), after);
});

await test('линейки, сноски и служебные строки разбора', async () => {
  const before = 'Текст.\n\n-----\n\n[1]: https://example.com\n[Колонтитул] стр. 12\nЗаголовок документа: книга';
  const after = speechText(before);
  check('линейки нет', !/-{3,}/.test(after), after);
  check('сноски нет', !after.includes('example.com'), after);
  check('колонтитула нет', !after.includes('Колонтитул'), after);
  check('метаданных нет', !after.includes('Заголовок документа'), after);
  check('текст книги на месте', after === 'Текст.', after);
});

await test('html-теги и сущности', async () => {
  const before = '<p>Абзац&nbsp;текста &amp; ещё</p>';
  const after = speechText(before);
  check('тегов нет', !after.includes('<'), after);
  check('сущностей нет', !after.includes('&'), after);
  check('слова те же', sameWords('Абзац текста и ещё', after), after);
});

await test('диалоговое тире и настоящие числа не ломаются', async () => {
  const before = '— Здравствуйте!\n— 2 * 3 = 6, а snake_case — это имя.\nЦена 1 500 руб.';
  const after = speechText(before);
  check('тире диалога на месте', after.startsWith('— Здравствуйте!'), after.split('\n')[0]);
  check('умножение цело', after.includes('2 * 3 = 6'), after.replace(/\n/g, ' / '));
  check('snake_case цел', after.includes('snake_case'), after.replace(/\n/g, ' / '));
  check('число цело', after.includes('1 500'), after.replace(/\n/g, ' / '));
  check('слова те же', sameWords(before, after));
});

await test('большой текст: ни одно слово не пропало', async () => {
  const paragraph = '### Раздел\n\n**Жирный** абзац с «кавычками», цифрами 2024 и датой 12.03.2024.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- пункт\n- ещё пункт\n\n-----';
  const before = Array.from({ length: 40 }, (_, index) => `Абзац ${index + 1}. ${paragraph}`).join('\n\n');
  const after = speechText(before);
  /* Разделитель таблицы «| - | - |» состоит только из знаков — слов там нет,
     поэтому мешок токенов сравнивать не с чем: сверяем именно текст книги. */
  check('слов столько же', words(after).length === words(before).length, `${words(after).length} против ${words(before).length}`);
  check('абзацы начинаются с номера', /^Абзац\s+1\./m.test(after), (after.match(/^Абзац \d+\./m) || [''])[0]);
  check('дата цела', after.includes('12.03.2024'), '');
});

await test('пустой текст и текст без разметки', async () => {
  check('пустое остаётся пустым', speechText('') === '');
  check('null не падает', speechText(null) === '');
  const plain = 'Обычный текст без разметки. Второе предложение.';
  check('обычный текст не меняется', speechText(plain) === plain, speechText(plain));
});

const failed = failures.length;
console.log(`\nИтого: ${passed} ok, ${failed} fail`);
process.exit(failed ? 1 : 0);

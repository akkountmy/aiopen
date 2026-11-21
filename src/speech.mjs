/**
 * Текст, готовый к чтению вслух.
 *
 * Глазами разметка не мешает: «# Глава 1» читается как заголовок, «45–50 минут» —
 * как диапазон. Диктору всё это приходится произносить словами. Проверено на
 * живой книге: в Word выжимки Канемана заголовки были записаны как «## Часть 1.»,
 * и в MP3 голос читал «решётка решётка часть один», а подпись файла
 * «выжимка 45–50 минут» — как код из цифр. Слушать это нельзя.
 *
 * Поэтому весь текст, который уходит в синтез, проходит через `speechText`:
 *  • снимается разметка (#, ##, **, `, >, |, списки, таблицы) — остаются слова;
 *  • выбрасываются адреса, почта, имена файлов, номера заданий и служебные
 *    идентификаторы вида p_mw1n5z0o, tts_ab12cd, UUID — диктор читает их
 *    посимвольно, и это звучит как «внутренний код книги»;
 *  • номер книги в шапке («Выжимка № 12», «№ 3», «Книга 12 из 49») не читается:
 *    это метка экземпляра в библиотеке, а не название. Раньше правило «№ → номер»
 *    превращало её в речь «выжимка номер двенадцать», и запись открывалась
 *    служебным числом;
 *  • диапазоны и тире превращаются в речь: «45–50 минут» → «от 45 до 50 минут»,
 *    «слово — слово» → «слово, слово»; сокращения раскрываются: «т. е.» →
 *    «то есть», «стр. 12» → «страница 12»;
 *  • значки, стрелки и эмодзи убираются;
 *  • повтор названия в первой строке («Название — выжимка 45–50 минут» перед
 *    тем же названием) убирается: вслух это слышится как номер, а не как книга;
 *  • последний шаг — белый список: в готовом тексте остаются только буквы,
 *    цифры, пробелы и обычная пунктуация. Любой другой символ вырезается, даже
 *    если его никто не предусмотрел, — поэтому «лишние знаки» не вернутся
 *    вместе с новой разметкой или новым форматом документа.
 *
 * Правило проекта, не исключение из него: любой новый путь, который ведёт текст
 * в синтез, обязан звать `speechText` (через `normalizeText` из `src/tts.mjs`).
 * Проверка — `test/speech.mjs`, там же образцы настоящих книг.
 */

/**
 * Имена файлов: «книга.docx» человек видит значком, а диктор читает «точка docx».
 * Выбрасываем имя целиком: из «transformed-vyzhimka-12.docx» иначе остаётся
 * «transformed vyzhimka 12» — латиница и номер, которых в книге нет.
 */
const FILE_NAME = /[^\s/\\()"']+\.(?:docx|doc|pdf|mp3|wav|ogg|m4a|xlsx|xls|csv|pptx|ppt|txt|md|rtf|zip|rar|json|html?)\b/gi;

/** Служебные идентификаторы сервиса: проекты, пользователи, задания, файлы. */
const SERVICE_ID = /\b(?:p|u|c|ch|tts|job|run|wf|msg|file|chat|proj)_[a-z0-9]{5,}\b/gi;

/** Значки и стрелки, которые диктор либо пропускает, либо читает словом. */
const PICTOGRAM = /[\u2190-\u21ff\u2300-\u23ff\u25a0-\u25ff\u2600-\u27bf\ufe0f\u200d]/g;

/** Символы разметки и вёрстки: после снятия слов их в тексте быть не должно. */
const MARKUP_CHARS = /[#*`~|<>\\^{}[\]_]/g;

const EMOJI = /\p{Extended_Pictographic}/gu;

/* ───────────────────────── номер книги в шапке ──────────────────────────────
   Метка экземпляра: «Выжимка № 12», «№ 3», «Книга 12 из 49», «Конспект XII».
   Это номер записи в библиотеке, а не название. В звуке он не нужен: человек
   слышит «выжимка номер двенадцать» и решает, что диктор читает служебный код.
   Снимаем её только в шапке — первых трёх непустых строках: в теле текста
   «№ 12» может быть настоящей ссылкой на другой документ или стандарт. */
const BOOK_WORD = 'выжимк[а-яё]*|конспект[а-яё]*|книга|книги|отчёт|отчет|документ|summary|book';
const BOOK_NUMBER =
  '(?:№|#|N°?|N|номер|no)\\.?\\s*(?:\\d{1,4}|[IVXLC]{1,7})(?:\\s*(?:из|of|/)\\s*\\d{1,4})?';
const LABEL_HEAD = new RegExp(`^\\s*(?:(?:${BOOK_WORD})\\s*)?(?:книги\\s*)?${BOOK_NUMBER}\\s*[.:)\\]\\-—–]?\\s*`, 'iu');
const LABEL_ORDINAL = new RegExp(
  `^\\s*(?:${BOOK_WORD})\\s+(?:\\d{1,4}|[IVXLC]{1,7})(?:\\s*(?:из|of|/)\\s*\\d{1,4})?\\s*[.:)\\]\\-—–]?\\s*`,
  'iu',
);
const LABEL_INLINE = new RegExp(`\\s*(?:${BOOK_WORD})\\s*(?:книги\\s*)?${BOOK_NUMBER}\\s*`, 'giu');

/**
 * Снимает номер книги из шапки документа. Возвращает текст без метки; слова
 * и числа самого текста не трогаются.
 * @param {string} text
 * @returns {string}
 */
function dropBookNumber(text) {
  const lines = text.split('\n');
  let seen = 0;
  for (let index = 0; index < lines.length && seen < 3; index += 1) {
    if (!lines[index].trim()) continue;
    seen += 1;
    /* Длинная строка — это уже текст, а не шапка: там метку не ищем. */
    if (lines[index].trim().length > 140) continue;
    const before = lines[index];
    let line = before.replace(LABEL_HEAD, '').replace(LABEL_ORDINAL, '');
    line = line.replace(LABEL_INLINE, ' ');
    if (line === before) continue;
    lines[index] = line.replace(/^[\s.,:;()—–-]+/, '');
  }
  return lines.join('\n');
}

/* ─────────────────────── сокращения — словами, а не буквами ─────────────────
   «т. е.» синтезатор читает как «тэ е», «стр. 12» — как «эс эр». Человек
   произносит это словами, поэтому раскрываем: так запись понятна на слух. */
/* Числительные согласуются с существительным: «5 миллионов», «2 миллиона»,
   «1,5 миллиона». Без этого получается «1 миллионов», и слух спотыкается. */
const NUMBER_FORMS = {
  million: ['миллион', 'миллиона', 'миллионов'],
  billion: ['миллиард', 'миллиарда', 'миллиардов'],
  thousand: ['тысяча', 'тысячи', 'тысяч'],
  ruble: ['рубль', 'рубля', 'рублей'],
};

function pluralIndex(value) {
  const clean = String(value).replace(/\s/g, '').replace(',', '.');
  if (clean.includes('.')) return 1;
  const number = Math.abs(parseInt(clean, 10));
  const tail100 = number % 100;
  const tail10 = number % 10;
  if (tail100 >= 11 && tail100 <= 14) return 2;
  if (tail10 === 1) return 0;
  if (tail10 >= 2 && tail10 <= 4) return 1;
  return 2;
}

function pluralize(text, pattern, forms) {
  return text.replace(pattern, (match, number) => `${number} ${forms[pluralIndex(number)]}`);
}

/** Сокращения — словами: «т. е.» синтезатор читает как «тэ е», «стр. 12» — как «эс эр». */
function expandAbbreviations(text) {
  let out = text;
  out = out.replace(/(?<![\p{L}])т\.\s*е\./giu, 'то есть');
  out = out.replace(/(?<![\p{L}])т\.\s*д\./giu, 'так далее');
  out = out.replace(/(?<![\p{L}])т\.\s*п\./giu, 'тому подобное');
  out = out.replace(/(?<![\p{L}])т\.\s*к\./giu, 'так как');
  out = out.replace(/(?<![\p{L}])и\s+др\./giu, 'и другие');
  out = out.replace(/(?<![\p{L}])стр\.\s*(?=\d)/giu, 'страница ');
  out = out.replace(/(?<![\p{L}])рис\.\s*(?=\d)/giu, 'рисунок ');
  out = out.replace(/(?<![\p{L}])табл\.\s*(?=\d)/giu, 'таблица ');
  out = out.replace(/(?<![\p{L}])гл\.\s*(?=\d)/giu, 'глава ');
  out = pluralize(out, /(\d+(?:[.,]\d+)?)\s*млн(?![\p{L}])/giu, NUMBER_FORMS.million);
  out = pluralize(out, /(\d+(?:[.,]\d+)?)\s*млрд(?![\p{L}])/giu, NUMBER_FORMS.billion);
  out = pluralize(out, /(\d+(?:[.,]\d+)?)\s*тыс\.?/giu, NUMBER_FORMS.thousand);
  out = pluralize(out, /(\d+(?:[.,]\d+)?)\s*руб\.?/giu, NUMBER_FORMS.ruble);
  out = out.replace(/(?<![\p{L}])руб\.?(?![\p{L}])/giu, 'рублей');
  return out;
}

/**
 * Первая строка — подпись файла, а не начало книги: «Думай медленно — выжимка
 * 45–50 минут». Если следующая строка начинается теми же словами, подпись
 * выбрасываем: иначе книгу открывает название, прочитанное дважды подряд.
 */
function dropRepeatedLead(text) {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return text;
  const head = lines[first].trim();
  if (head.length > 140) return text;
  if (/[.!?…]$/.test(head)) return text;
  const next = lines.slice(first + 1).find((line) => line.trim());
  if (!next) return text;
  const words = (value) =>
    value
      .replace(/^[\s#>*+\-–—]+/, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || [];
  const left = words(head);
  const right = words(next);
  if (left.length < 2 || right.length < 2) return text;
  const same = left.slice(0, 2).every((word, index) => word === right[index]);
  if (!same) return text;
  lines.splice(first, 1);
  return lines.join('\n');
}

/**
 * Хронометраж в названии — служебная подпись конвейера: «Думай медленно —
 * выжимка 45–50 минут». Человеку она полезна на экране, а в звуке открывает
 * книгу фразой из цифр, которую на слух принимают за внутренний код. Поэтому
 * у первой строки такая подпись снимается, а сама строка закрывается точкой.
 */
function dropDurationLabel(text) {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.trim());
  if (index < 0) return text;
  const line = lines[index];
  /* Границу слова задаём явно: \b в JavaScript считает словесными только
     латиницу и цифры, после кириллицы он не срабатывает вовсе. */
  const label = /\s*[—–-]\s*выжимк[аи](?=\s|$)[^.!?…\n]{0,40}?(?:минут\w*|звука)/i;
  if (!label.test(line)) return text;
  /* Подпись может стоять и в конце строки («Название — выжимка 40 минут»), и
     в начале абзаца («Название — выжимка 45–50 минут Книга Д. Канемана…»):
     в обоих случаях название отделяем точкой, а остаток оставляем на месте. */
  const [before, after = ''] = line.split(label);
  let head = before.trim();
  if (!/[.!?…]$/.test(head)) head += '.';
  const tail = after.trim();
  lines[index] = tail ? `${head} ${tail}` : head;
  return lines.join('\n');
}

/**
 * Значки, которые человек произносит словами: «45%» → «45 процентов»,
 * «2 × 3» → «2 умножить на 3». Делается до белого списка: иначе эти знаки
 * просто исчезли бы вместе с цифрами, а число в книге — это смысл.
 */
function symbolsToWords(text) {
  let out = text;
  out = out.replace(/(\d)\s*%\s*/g, '$1 процентов ');
  out = out.replace(/(\d)\s*°\s*(?:C|С)?\s*/giu, '$1 градусов ');
  out = out.replace(/(\d)\s*[×✕✖*]\s*(\d)/g, '$1 умножить на $2');
  out = out.replace(/(\d)\s*[÷/]\s*(\d)/g, '$1 разделить на $2');
  out = out.replace(/\s*=\s*/g, ' равно ');
  out = out.replace(/([\p{L}])\s*\+\s*(?=[\p{L}])/gu, '$1 плюс ');
  out = out.replace(/(?<![\p{L}])и\s*\/\s*или(?![\p{L}])/giu, 'и или');
  out = out.replace(/(?<=[\p{L}])\s*\/\s*(?=[\p{L}])/gu, ' или ');
  return out;
}

/** Пунктуация после всех вырезаний: двойные запятые, пробел перед точкой. */
function tidyPunctuation(text) {
  let out = text;
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/\s+,/g, ',');
  out = out.replace(/(?:,\s*){2,}/g, ', ');
  out = out.replace(/,\s*([.!?;:…])/g, '$1');
  out = out.replace(/^\s*,[\s,]*/gm, '');
  out = out.replace(/([.!?…])\s*,\s*/g, '$1 ');
  out = out.replace(/(?<![\p{L}])(?:и|или|а|но)\s*([.!?…])/giu, '$1');
  out = out.replace(/[ \t]+$/gm, '');
  out = out.replace(/[ \t]+([.,;:!?…])/g, '$1');
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out.replace(/^\n+/, '');
  return out;
}

/* Сущности, которые встречаются в выгрузках Word, PDF и html. Неизвестные
   заменяются пробелом: лучше пропустить, чем произнести код вслух. */
const HTML_ENTITIES = {
  amp: ' и ',
  lt: ' ',
  gt: ' ',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  ldquo: '«',
  rdquo: '»',
  hellip: '…',
  deg: ' градусов ',
  plusmn: ' плюс-минус ',
  copy: ' ',
  reg: ' ',
  trade: ' ',
  times: ' умножить на ',
  divide: ' разделить на ',
  frac12: ' 0,5 ',
  frac14: ' 0,25 ',
  frac34: ' 0,75 ',
  euro: ' евро ',
  dollar: ' долларов ',
  permil: ' промилле ',
};

/* Белый список речи: буквы, цифры, пробелы и обычная пунктуация. Всё, чего в
   этом наборе нет, до диктора не доходит — ни «решётки», ни слэши, ни значки
   валют и градусов, ни невидимые символы из чужих выгрузок. Это и есть
   обещание «чистая озвучка», не зависящее от того, что ещё придумает формат. */
const SPEECH_CHARS = /[^\p{L}\p{N}\s.,;:!?…«»"“”„'’()\-]/gu;

/** Приводит текст документа к виду, удобному для чтения вслух. */
export function speechText(raw) {
  let text = String(raw ?? '');
  text = text.replace(/\r\n?/g, '\n');

  /* 1. Вёрстка, а не книга: колонтитулы, номера страниц, метаданные разбора
     docx. Эти строки есть в выгрузке, но человек их не читает — и слушать
     «страница 3 из 12» посреди главы не должен. */
  text = text.replace(/^\s*\d{1,4}\s*$/gm, '');
  text = text.replace(/^\[(?:Верхний|Нижний)?\s*колонтитул\][^\n]*$/gmiu, '');
  /* Определения сносок: «[1]: https://…» — адрес и номер, а не текст книги. */
  text = text.replace(/^\s*\[[^\]\n]{1,80}\]:\s*\S+[^\n]*$/gmu, '');
  text = text.replace(/^Заголовок документа:[^\n]*$/gmu, '');
  text = text.replace(/^(?:Страница|Page)\s+\d+(?:\s+(?:из|of)\s+\d+)?\s*$/gmu, '');

  /* 1a. Служебные вставки: комментарии вёрстки и блоки кода целиком не читаем. */
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1');

  /* 2. Адреса, почта, идентификаторы и имена файлов — до снятия символов:
     иначе от них останутся обрывки вида «p mw1n5z0o». */
  /* Скобки и кавычки в адрес не входят: иначе вместе с адресом исчезает
     закрывающая скобка ссылки, и на её месте в тексте остаётся обрывок «(». */
  text = text.replace(/\bhttps?:\/\/[^\s<>()\[\]"'«»]+/gi, '');
  text = text.replace(/\bwww\.[^\s<>()\[\]"'«»]+/gi, '');
  text = text.replace(/\b[\w.+-]+@[\w-]+\.[\p{L}]{2,}\b/gu, '');
  text = text.replace(SERVICE_ID, '');
  text = text.replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '');
  text = text.replace(/\b[0-9a-f]{16,}\b/gi, '');
  text = text.replace(FILE_NAME, ' ');
  /* Программные имена: «snake_case», «user_id», «tts_api_key» — диктор читает
     подчёркивание словом, поэтому такие слова из книги убираем целиком. */
  text = text.replace(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g, ' ');

  /* 3. HTML из выгрузок: теги и сущности — вёрстка, а не слова. Диктор читает
     их как «амперсэнд эн би эс пи» и «эм ди эш». */
  text = text.replace(/<\/?[a-z][^>]*>/gi, ' ');
  text = text.replace(/&#(\d{2,5});/g, (match, code) => String.fromCharCode(Number(code)));
  text = text.replace(/&([a-z]{2,10});/gi, (match, name) => HTML_ENTITIES[name.toLowerCase()] ?? ' ');
  text = text.replace(/&nbsp;?/gi, ' ');

  /* 4. Ссылки и картинки: остаётся подпись, адрес не читаем. */
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]{1,200})\]\([^)\s]*\)/g, '$1');
  /* Ссылки на сноски: «[1]», «[12]» — вслух это номер, а не слово. */
  text = text.replace(/\[\s*\d{1,3}\s*\]/g, '');
  /* Чек-боксы списков: «- [x] сделано» — галочка, а не слово «икс». */
  text = text.replace(/\[\s*[xX✓✔ ]?\s*\]/g, ' ');

  /* 4. Разметка строк: заголовки, цитаты, списки, линейки, разделители таблиц. */
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}(?:[-*+•·▪◦])\s+/gm, '');
  text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, '');
  text = text.replace(/^\s*\|?[\s:|-]*\|[\s:|-]*$/gm, '');
  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');

  /* 5. Подпись файла, хронометраж и номер книги в названии вслух звучат как код:
     снимаем их, пока строки ещё не склеились в абзац и пока тире не стало
     запятой. */
  text = dropRepeatedLead(text);
  text = dropDurationLabel(text);
  text = dropBookNumber(text);

  /* 6. Сокращения и значки — словами, как их произносит человек. */
  text = expandAbbreviations(text);

  /* 7. Диапазоны и тире. Диктор произносит тире словом «тире», поэтому тире
     становится паузой, а диапазон — словами: «от 45 до 50 минут». */
  text = text.replace(/(\d+)\s*[–—―]\s*(\d+)/g, 'от $1 до $2');
  /* Дефис в диапазоне («12-15 секунд») диктор читает как «двенадцать пятнадцать»:
     тоже раскрываем словами. Даты и составные номера не трогаем. */
  text = text.replace(/(?<![\d\p{L}-])(\d{1,4})\s*-\s*(\d{1,4})(?![\d\p{L}])(?!-\d)/gu, 'от $1 до $2');
  text = text.replace(/\s*[—–―]\s*/g, ', ');
  text = text.replace(/(?<=\s)-(?=\s)/g, ', ');
  text = text.replace(/(?<=^)-+(?=\s)/gm, '');

  /* 8. Слова вместо знаков: «№ 5» → «номер 5», «§ 3» → «параграф 3»,
     «45%» → «45 процентов». */
  text = text.replace(/№\s*/g, 'номер ');
  text = text.replace(/§\s*/g, 'параграф ');
  text = text.replace(/\s&\s/g, ' и ');
  text = text.replace(/(^|\s)\+\s*(?=\d)/g, '$1плюс ');
  text = symbolsToWords(text);

  /* 9. Остальные символы разметки, значки, эмодзи и табличные черты. */
  text = text.replace(/\|/g, ', ');
  text = text.replace(PICTOGRAM, '');
  text = text.replace(EMOJI, '');
  text = text.replace(MARKUP_CHARS, '');

  /* 10. Белый список: в звук уходит только речь. Любой символ, которого нет в
     наборе, вырезается — даже тот, о котором это правило ещё не знает. */
  text = text.replace(SPEECH_CHARS, '');

  /* 11. Мусор от снятых символов: двойные запятые, запятая перед точкой,
     запятая в начале строки. */
  return tidyPunctuation(text);
}

export default speechText;

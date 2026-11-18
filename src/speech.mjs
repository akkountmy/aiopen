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
 *  • диапазоны и тире превращаются в речь: «45–50 минут» → «от 45 до 50 минут»,
 *    «слово — слово» → «слово, слово»;
 *  • значки, стрелки и эмодзи убираются;
 *  • повтор названия в первой строке («Название — выжимка 45–50 минут» перед
 *    тем же названием) убирается: вслух это слышится как номер, а не как книга.
 *
 * Правило проекта, не исключение из него: любой новый путь, который ведёт текст
 * в синтез, обязан звать `speechText` (через `normalizeText` из `src/tts.mjs`).
 * Проверка — `test/speech.mjs`, там же образцы настоящих книг.
 */

/** Имена файлов: «книга.docx» человек видит значком, а диктор читает «точка docx». */
const FILE_EXT = /\.(?:docx|doc|pdf|mp3|wav|ogg|m4a|xlsx|xls|csv|pptx|ppt|txt|md|rtf|zip|rar|json|html?)\b/gi;

/** Служебные идентификаторы сервиса: проекты, пользователи, задания, файлы. */
const SERVICE_ID = /\b(?:p|u|c|ch|tts|job|run|wf|msg|file|chat|proj)_[a-z0-9]{5,}\b/gi;

/** Значки и стрелки, которые диктор либо пропускает, либо читает словом. */
const PICTOGRAM = /[\u2190-\u21ff\u2300-\u23ff\u25a0-\u25ff\u2600-\u27bf\ufe0f\u200d]/g;

/** Символы разметки и вёрстки: после снятия слов их в тексте быть не должно. */
const MARKUP_CHARS = /[#*`~|<>\\^{}[\]_]/g;

const EMOJI = /\p{Extended_Pictographic}/gu;

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

/** Приводит текст документа к виду, удобному для чтения вслух. */
export function speechText(raw) {
  let text = String(raw ?? '');
  text = text.replace(/\r\n?/g, '\n');

  /* 1. Служебные вставки: комментарии вёрстки и блоки кода целиком не читаем. */
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1');

  /* 2. Адреса, почта, идентификаторы и имена файлов — до снятия символов:
     иначе от них останутся обрывки вида «p mw1n5z0o». */
  text = text.replace(/\bhttps?:\/\/\S+/gi, '');
  text = text.replace(/\bwww\.\S+/gi, '');
  text = text.replace(/\b[\w.+-]+@[\w-]+\.[\p{L}]{2,}\b/gu, '');
  text = text.replace(SERVICE_ID, '');
  text = text.replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '');
  text = text.replace(/\b[0-9a-f]{16,}\b/gi, '');
  text = text.replace(FILE_EXT, '');

  /* 3. Ссылки и картинки: остаётся подпись, адрес не читаем. */
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]{1,200})\]\([^)\s]*\)/g, '$1');
  /* Ссылки на сноски: «[1]», «[12]» — вслух это номер, а не слово. */
  text = text.replace(/\[\s*\d{1,3}\s*\]/g, '');

  /* 4. Разметка строк: заголовки, цитаты, списки, линейки, разделители таблиц. */
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}(?:[-*+•·▪◦])\s+/gm, '');
  text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, '');
  text = text.replace(/^\s*\|?[\s:|-]*\|[\s:|-]*$/gm, '');
  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');

  /* 5. Подпись файла и хронометраж в названии вслух звучат как код: снимаем их,
     пока строки ещё не склеились в абзац и пока тире не стало запятой. */
  text = dropRepeatedLead(text);
  text = dropDurationLabel(text);

  /* 6. Слова вместо значков: так их читает человек, а не «диктор по символам». */
  text = text.replace(/№\s*/g, 'номер ');
  text = text.replace(/§\s*/g, 'параграф ');
  text = text.replace(/\s&\s/g, ' и ');
  text = text.replace(/(^|\s)\+\s*(?=\d)/g, '$1плюс ');

  /* 7. Диапазоны и тире. Диктор произносит тире словом «тире», поэтому тире
     становится паузой, а диапазон — словами: «от 45 до 50 минут». */
  text = text.replace(/(\d+)\s*[–—―]\s*(\d+)/g, 'от $1 до $2');
  /* Дефис в диапазоне («12-15 секунд») диктор читает как «двенадцать пятнадцать»:
     тоже раскрываем словами. Даты и составные номера не трогаем. */
  text = text.replace(/(?<![\d\p{L}-])(\d{1,4})\s*-\s*(\d{1,4})(?![\d\p{L}])(?!-\d)/gu, 'от $1 до $2');
  text = text.replace(/\s*[—–―]\s*/g, ', ');
  text = text.replace(/(?<=\s)-(?=\s)/g, ', ');
  text = text.replace(/(?<=^)-+(?=\s)/gm, '');

  /* 8. Остальные символы разметки, значки, эмодзи и табличные черты. */
  text = text.replace(/\|/g, ', ');
  text = text.replace(PICTOGRAM, '');
  text = text.replace(EMOJI, '');
  text = text.replace(MARKUP_CHARS, '');

  /* 9. Мусор от снятых символов: двойные запятые, запятая перед точкой,
     запятая в начале строки. */
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/\s+,/g, ',');
  text = text.replace(/(?:,\s*){2,}/g, ', ');
  text = text.replace(/,\s*([.!?;:…])/g, '$1');
  text = text.replace(/^\s*,[\s,]*/gm, '');
  text = text.replace(/([.!?…])\s*,\s*/g, '$1 ');

  return text;
}

export default speechText;

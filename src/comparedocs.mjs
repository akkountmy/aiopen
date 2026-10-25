import { extractDocumentText } from './docparse.mjs';

/* Сравнение двух версий документа. Вопрос «что изменилось в договоре» модель
   может решить и сама, но на документах в сотни строк это дорого и неточно:
   выравнивание строк считает машина, а объясняет изменения уже человек-модель.
   Текст берём тем же извлекателем, что и read_document, поэтому формат любой. */

export const COMPARE_LIMITS = {
  maxChars: 200000,
  maxLines: 5000,
  maxProduct: 4 * 1000 * 1000, // предел для честного выравнивания
  maxHunks: 80,
};

/** Текст документа в массив значимых строк: пустые строки и отступы не считаем. */
export function textLines(text = '') {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, COMPARE_LIMITS.maxLines);
}

/**
 * Сравнение двух текстов построчно.
 * Возвращает {leftLines, rightLines, ops, changed, added, removed, exact}.
 * exact = false означает, что для выравнивания файл был слишком большим и
 * разница посчитана по составу строк (без порядка).
 */
export function diffLines(leftText, rightText) {
  const left = textLines(leftText);
  const right = textLines(rightText);
  const product = left.length * right.length;
  if (product > COMPARE_LIMITS.maxProduct) {
    const { ops, added, removed } = diffByMembership(left, right);
    return { leftLines: left.length, rightLines: right.length, ops, added, removed, changed: added + removed, exact: false };
  }
  const { ops, added, removed } = diffByAlignment(left, right);
  return { leftLines: left.length, rightLines: right.length, ops, added, removed, changed: added + removed, exact: true };
}

/* Классическое выравнивание через наибольшую общую подпоследовательность.
   Строки сравниваем как есть: переставленные слова — это изменение. */
function diffByAlignment(left, right) {
  const n = left.length;
  const m = right.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width); // длина НОП для пар (i, j)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        left[i] === right[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ type: 'removed', text: left[i], line: i + 1 });
      removed += 1;
      i += 1;
    } else {
      ops.push({ type: 'added', text: right[j], line: j + 1 });
      added += 1;
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'removed', text: left[i], line: i + 1 });
    removed += 1;
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'added', text: right[j], line: j + 1 });
    added += 1;
    j += 1;
  }
  return { ops, added, removed };
}

/* Большие файлы: считаем, каких строк не хватает слева и справа. Порядок при
   этом не учитывается — об этом честно пишет итоговая сводка. */
function diffByMembership(left, right) {
  const budget = new Map();
  for (const line of left) budget.set(line, (budget.get(line) || 0) + 1);
  const ops = [];
  let added = 0;
  let removed = 0;
  right.forEach((line, index) => {
    const count = budget.get(line) || 0;
    if (count > 0) budget.set(line, count - 1);
    else {
      ops.push({ type: 'added', text: line, line: index + 1 });
      added += 1;
    }
  });
  left.forEach((line, index) => {
    if ((budget.get(line) || 0) > 0) {
      budget.set(line, budget.get(line) - 1);
      ops.push({ type: 'removed', text: line, line: index + 1 });
      removed += 1;
    }
  });
  return { ops, added, removed };
}

/** Сравнение двух файлов по содержимому: принимает уже прочитанные буферы. */
export function compareDocuments(left, right, { nameLeft = 'первый документ', nameRight = 'второй документ' } = {}) {
  const leftText = extractDocumentText(left, nameLeft, '', { maxChars: COMPARE_LIMITS.maxChars }).text || '';
  const rightText = extractDocumentText(right, nameRight, '', { maxChars: COMPARE_LIMITS.maxChars }).text || '';
  if (!leftText.trim() && !rightText.trim()) {
    throw new Error('В обоих документах не нашлось текста — сравнивать нечего');
  }
  const diff = diffLines(leftText, rightText);
  return { ...diff, nameLeft, nameRight, leftChars: leftText.length, rightChars: rightText.length };
}

export function formatCompare(result) {
  const head =
    `«${result.nameLeft}» — ${result.leftLines} ${plural(result.leftLines, 'строка', 'строки', 'строк')}, ` +
    `«${result.nameRight}» — ${result.rightLines}. ` +
    (result.changed
      ? `Отличий ${result.changed}: удалено ${result.removed}, добавлено ${result.added}.`
      : 'Отличий нет: тексты совпадают.');
  const note = result.exact ? '' : '\nФайлы слишком большие для построчного выравнивания: показан состав строк без порядка.';
  if (!result.changed) return `${head}${note}`;
  const shown = result.ops.slice(0, COMPARE_LIMITS.maxHunks);
  const body = shown
    .map((op) => `${op.type === 'removed' ? '−' : '+'} ${clip(op.text)}`)
    .join('\n');
  const rest = result.ops.length > shown.length ? `\n…и ещё ${result.ops.length - shown.length} отличий` : '';
  return `${head}${note}\n${body}${rest}`;
}

function clip(text, limit = 220) {
  const value = String(text || '');
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function plural(count, one, few, many) {
  const n = Math.abs(Number(count) || 0) % 100;
  const last = n % 10;
  if (n > 10 && n < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

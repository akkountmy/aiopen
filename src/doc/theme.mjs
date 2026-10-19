/**
 * Общая тема документов: цвета, шрифты, размеры.
 * Одна палитра на все четыре формата — чтобы Word, Excel, PPTX и PDF
 * выглядели как один и тот же корпоративный набор.
 */

export const COLORS = {
  ink: '1B1C21',
  navy: '10233F',
  accent: 'D4564A',
  muted: '6B6D76',
  hairline: 'D9DBE2',
  soft: 'F2F3F6',
  /** Полосатость чётных строк в таблицах: светлее soft, чтобы не спорить с итогом. */
  band: 'F8F9FB',
  white: 'FFFFFF',
  grid: 'E2E2E8',
};

/** Цвета с решёткой — для тех библиотек, которые ждут CSS-строку. */
export const hex = (value) => `#${String(value).replace(/^#/, '')}`;

export const FONTS = {
  sans: 'Segoe UI',
  mono: 'Consolas',
};

/** Базовая типографика документа A4 (пункты). */
export const DOC_TYPE = {
  body: 10.5,
  bodyLead: 1.35,
  h1: 15,
  h2: 12,
  h3: 11,
  title: 24,
  lede: 12,
  caption: 8.5,
  table: 9.5,
};

/** Типографика слайда 16:9 — единая шкала на все слайды. */
export const SLIDE_TYPE = {
  cover: 40,
  title: 28,
  section: 22,
  body: 16,
  caption: 10,
};

/** Шаг сетки слайда 13.333×7.5 дюйма. */
export const SLIDE = {
  width: 13.333,
  height: 7.5,
  margin: 0.8,
};

export const A4 = { width: 595.28, height: 841.89, margin: { top: 62, bottom: 68, left: 68, right: 57 } };

const normalise = (value) => String(value ?? '').replace(/\r\n?/g, '\n').trim();

/** Привести «строку или массив строк» к массиву непустых строк. */
export function toList(value) {
  if (Array.isArray(value)) return value.map(normalise).filter(Boolean);
  if (typeof value === 'string') return value.split('\n').map(normalise).filter(Boolean);
  return [];
}

/** Кикер: 2–4 слова капсом, без точки. */
export function normaliseKicker(value, fallback = '') {
  const text = normalise(value) || fallback;
  return text.replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Число с разделителями и валютой для подписей в документах.
 * Формат фиксированный: неразрывный пробел между тысячами, «₽» без пробела после числа.
 */
export function formatMoney(value, currency = '₽') {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(number)} ${currency}`.trim();
}

export function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(number)}%`;
}

/** Сегодняшняя дата по-русски — подпись титульного блока. */
export function todayRu() {
  return new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Неразрывные пробелы там, где перенос читается плохо: «1,48 млн ₽» не должно
 * разрываться, оставляя знак валюты или единицу на отдельной строке.
 */
export function glueUnits(text) {
  return String(text ?? '')
    .replace(/(\d)\s+(₽|\$|€|руб\.?|р\.)/g, '$1\u00A0$2')
    .replace(/(\d)\s+(млн|млрд|тыс\.?|трлн|%)(?=[\s.,;:!?)]|$)/g, '$1\u00A0$2')
    /* «10 недель», «30 дней»: число не должно отрываться от единицы.
       `\w` в JS не знает кириллицу — берём `\p{L}` с флагом u. */
    .replace(/(\d)\s+(недел|дн|мес|год|лет|час|мин|сек|шт|чел|строк|кл|польз)\p{L}*(?=[\s.,;:!?)]|$)/gu, (match, digit, unit) => `${digit}\u00A0${match.slice(digit.length + 1)}`)
    .replace(/\s+(₽|\$|€)(?=[\s.,;:!?)]|$)/g, '\u00A0$1');
}

export function safeText(value, limit = 4000) {
  return glueUnits(normalise(value)).slice(0, limit);
}

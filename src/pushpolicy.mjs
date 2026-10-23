/**
 * Стоит ли беспокоить человека уведомлением о конце задачи.
 *
 * Уведомления нужны не на каждый ответ: короткий вопрос-ответ человек увидит,
 * когда вернётся, а пуш на «2 + 2» только раздражает. Поэтому пушим только
 * задачи, которые сервис сам считает тяжёлыми: сильная модель, несколько
 * инструментов или шагов, создание документа, субагенты либо долгая работа.
 *
 * Порог настраивается не из настроек, а кодом: это осознанное правило, а не
 * пользовательская опция. Если однажды понадобится чаще/реже — меняются
 * константы ниже, и тест push-policy.mjs сразу покажет, что изменилось.
 */

/** Дольше этого — задача явно не короткая. */
export const PUSH_COMPLEX_SECONDS = 75;
/** Столько шагов модели — задача потребовала нескольких итераций. */
export const PUSH_COMPLEX_STEPS = 4;
/** Столько инструментов — задача не обошлась одним действием. */
export const PUSH_COMPLEX_TOOLS = 3;

/**
 * @param {object|null} outcome результат runTurn (route, steps, tools)
 * @param {object} extra durationMs — сколько шла работа; tools — запасной
 *   список инструментов для упавшей задачи, у которой нет outcome;
 *   background — задача по расписанию: её результат ждут в фоне
 * @returns {{complex: boolean, reasons: string[]}}
 */
export function classifyCompletion({ outcome = null, durationMs = 0, tools = [], approval = null, background = false } = {}) {
  /* Пауза на подтверждение — всегда важное событие, независимо от размера. */
  if (approval) return { complex: true, reasons: ['нужно подтверждение'] };

  const reasons = [];
  /* Задание «Дашборда» запущено без человека и без открытого приложения:
     его результат существует только в уведомлении, поэтому не молчим. */
  if (background) reasons.push('задача по расписанию');
  const route = outcome?.route;
  if (route?.profile === 'pro') reasons.push('сильная модель');

  const steps = Number(outcome?.steps) || 0;
  if (steps >= PUSH_COMPLEX_STEPS) reasons.push(`шагов: ${steps}`);

  const used =
    Array.isArray(outcome?.tools) && outcome.tools.length ? outcome.tools : Array.isArray(tools) ? tools : [];
  const names = used.map((tool) => String(tool?.name || '')).filter(Boolean);
  if (names.includes('spawn_agent')) reasons.push('субагенты');
  if (names.some((name) => name.startsWith('create_'))) reasons.push('документ');
  if (used.length >= PUSH_COMPLEX_TOOLS) reasons.push(`инструментов: ${used.length}`);

  const seconds = Math.max(0, Number(durationMs) || 0) / 1000;
  if (seconds >= PUSH_COMPLEX_SECONDS) reasons.push(`${Math.round(seconds)} с`);

  return { complex: reasons.length > 0, reasons };
}

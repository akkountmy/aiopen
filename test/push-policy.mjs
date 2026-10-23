/**
 * Проверка правила «пуш только по сложным задачам»: короткий вопрос-ответ не
 * будит человека, а сильная модель, несколько инструментов, документ, субагенты
 * или долгая работа — будят.
 *   node test/push-policy.mjs
 */
import {
  PUSH_COMPLEX_SECONDS,
  PUSH_COMPLEX_STEPS,
  PUSH_COMPLEX_TOOLS,
  classifyCompletion,
} from '../src/pushpolicy.mjs';

let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok  ${label}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ''}`);
}

function tool(name) {
  return { id: `t-${name}`, name, label: name, status: 'done' };
}

/* 1. Обычный короткий ответ без инструментов — тишина. */
const simple = classifyCompletion({
  outcome: { route: { profile: 'flash', score: 0 }, steps: 1, tools: [] },
  durationMs: 8_000,
});
check('короткий ответ не считается сложным', !simple.complex, JSON.stringify(simple.reasons));

/* 2. Сильная модель — сложная по определению сервиса. */
const pro = classifyCompletion({
  outcome: { route: { profile: 'pro', score: 4 }, steps: 2, tools: [] },
  durationMs: 20_000,
});
check('сильная модель включает пуш', pro.complex && pro.reasons.includes('сильная модель'));

/* 3. Несколько инструментов. */
const tools = classifyCompletion({
  outcome: { route: { profile: 'flash' }, steps: 2, tools: Array.from({ length: PUSH_COMPLEX_TOOLS }, (_, i) => tool(`t${i}`)) },
  durationMs: 20_000,
});
check(`${PUSH_COMPLEX_TOOLS} инструмента включают пуш`, tools.complex);

/* 4. Один инструмент и мало шагов — ещё не сложно. */
const oneTool = classifyCompletion({
  outcome: { route: { profile: 'flash' }, steps: 1, tools: [tool('read_file')] },
  durationMs: 10_000,
});
check('одно действие не считается сложным', !oneTool.complex);

/* 5. Много шагов модели. */
const steps = classifyCompletion({
  outcome: { route: { profile: 'flash' }, steps: PUSH_COMPLEX_STEPS, tools: [tool('read_file')] },
  durationMs: 20_000,
});
check(`${PUSH_COMPLEX_STEPS} шага включают пуш`, steps.complex);

/* 6. Создание документа — результат, который человек ждёт. */
const document = classifyCompletion({
  outcome: { route: { profile: 'flash' }, steps: 2, tools: [tool('create_pdf')] },
  durationMs: 20_000,
});
check('создание документа включает пуш', document.complex && document.reasons.includes('документ'));

/* 7. Субагенты. */
const agents = classifyCompletion({
  outcome: { route: { profile: 'flash' }, steps: 2, tools: [tool('spawn_agent')] },
  durationMs: 20_000,
});
check('субагенты включают пуш', agents.complex && agents.reasons.includes('субагенты'));

/* 8. Долгая работа. */
const long = classifyCompletion({
  outcome: { route: { profile: 'flash' }, steps: 2, tools: [tool('read_file')] },
  durationMs: PUSH_COMPLEX_SECONDS * 1000,
});
check(`работа дольше ${PUSH_COMPLEX_SECONDS} с включает пуш`, long.complex);
const almost = classifyCompletion({
  outcome: { route: { profile: 'flash' }, steps: 2, tools: [tool('read_file')] },
  durationMs: PUSH_COMPLEX_SECONDS * 1000 - 1,
});
check('работа чуть короче порога не включает пуш', !almost.complex);

/* 9. Подтверждение по бюджету — всегда важное событие. */
const approval = classifyCompletion({ outcome: null, durationMs: 5_000, approval: { id: 'a1' } });
check('запрос подтверждения включает пуш', approval.complex && approval.reasons.includes('нужно подтверждение'));

/* 10. Задача по расписанию: её результат ждут только в уведомлении. */
const scheduled = classifyCompletion({
  outcome: { route: { profile: 'flash' }, steps: 1, tools: [tool('web_search')] },
  durationMs: 10_000,
  background: true,
});
check('задача по расписанию включает пуш', scheduled.complex && scheduled.reasons.includes('задача по расписанию'));

/* 11. Упавшая задача без outcome: правило работает по длительности и инструментам. */
const failedLong = classifyCompletion({ outcome: null, durationMs: PUSH_COMPLEX_SECONDS * 1000, tools: [] });
check('долгая упавшая задача включает пуш', failedLong.complex);
const failedShort = classifyCompletion({ outcome: null, durationMs: 5_000, tools: [tool('read_file')] });
check('короткая упавшая задача не включает пуш', !failedShort.complex);

console.log(failed ? `\n  провалено проверок: ${failed}` : '\n  правило уведомлений о сложных задачах в порядке');
process.exitCode = failed ? 1 : 0;

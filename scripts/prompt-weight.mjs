/**
 * Сколько на самом деле весит запрос к модели: системный промпт и схемы инструментов.
 *
 * Мерите то, что уходит в тело запроса, а не «на глаз»: собираем тот же системный
 * промпт и тот же список инструментов, что и src/agent.mjs, и считаем знаки. Токены
 * оцениваем по якорю: живой замер `skill-matrix.mjs --probe` на пустом вопросе дал
 * tokensIn (см. --probe-tokens), отсюда берём среднее «знаков на токен».
 *
 * Запуск: node scripts/prompt-weight.mjs [--probe-tokens=22471] [--json]
 */
import { systemPrompt } from '../src/prompt.mjs';
import { availableToolDefs } from '../src/tools.mjs';
import { skillsPromptText, listSkills } from '../src/skills.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const asJson = process.argv.includes('--json');
const probeTokens = Number(arg('probe-tokens', 22471)) || 0;

const system = systemPrompt({
  projectName: 'Проект',
  projectContext: '',
  memory: '',
  userName: '',
  question: 'сколько будет 2+2',
  facts: [],
  skillsText: skillsPromptText(),
  filesBrief: '',
  task: null,
  modes: { thinking: false, search: false },
});

const toolDefs = await availableToolDefs();
const toolsJson = JSON.stringify(toolDefs);
const perTool = toolDefs
  .map((def) => ({
    name: def.function?.name || '?',
    chars: JSON.stringify(def).length,
    descChars: String(def.function?.description || '').length,
    paramChars: JSON.stringify(def.function?.parameters || {}).length,
  }))
  .sort((a, b) => b.chars - a.chars);

/* Тело запроса пустого вопроса: system + один короткий ход пользователя + tools. */
const body = {
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: 'сколько будет 2+2' },
  ],
  tools: toolDefs,
};
const bodyChars = JSON.stringify(body).length;
const ratio = probeTokens > 0 ? bodyChars / probeTokens : 0;

const pct = (part) => (ratio ? Math.round((part / ratio / probeTokens) * 1000) / 10 : null);
const report = {
  probeTokens,
  charsPerToken: Math.round(ratio * 100) / 100,
  systemChars: system.length,
  toolsChars: toolsJson.length,
  bodyChars,
  tools: toolDefs.length,
  skillsInCatalog: listSkills().length,
  share: {
    systemPct: pct(system.length),
    toolsPct: pct(toolsJson.length),
  },
  tokensEstimate: {
    system: ratio ? Math.round(system.length / ratio) : null,
    tools: ratio ? Math.round(toolsJson.length / ratio) : null,
    body: probeTokens || null,
  },
  heaviestTools: perTool.slice(0, 10),
  cheapestTools: perTool.slice(-5).reverse(),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`запрос «сколько будет 2+2»: тело ${bodyChars} знаков, якорь ${probeTokens} токенов, ${report.charsPerToken} знака на токен`);
  console.log(`системный промпт: ${system.length} знаков${ratio ? ` ≈ ${report.tokensEstimate.system} токенов (${report.share.systemPct} %)` : ''}`);
  console.log(`схемы инструментов: ${toolsJson.length} знаков, ${toolDefs.length} инструментов${ratio ? ` ≈ ${report.tokensEstimate.tools} токенов (${report.share.toolsPct} %)` : ''}`);
  console.log(`каталог навыков внутри промпта: ${listSkills().length} навыков, ${skillsPromptText().length} знаков`);
  console.log('');
  console.log('самые дорогие инструменты (знаки: всего / описание / параметры):');
  for (const item of report.heaviestTools) {
    console.log(`  ${item.name}: ${item.chars} / ${item.descChars} / ${item.paramChars}`);
  }
  console.log('самые дешёвые:');
  for (const item of report.cheapestTools) {
    console.log(`  ${item.name}: ${item.chars} / ${item.descChars} / ${item.paramChars}`);
  }
}

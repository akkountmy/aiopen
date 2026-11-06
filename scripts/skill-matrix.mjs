/**
 * Матрица самовызова навыков: живые запросы к сервису, проверка срабатывания.
 *
 * Для каждого запроса смотрим, открыла ли модель навык (`use_skill`), тот ли
 * навык, вызвала ли инструменты из его инструкции и проверила ли результат.
 *
 * Запуск: node scripts/skill-matrix.mjs [--live] [--only=word,excel] [--keep] [--probe]
 *   без --live печатается план (запросы и ожидаемые навыки), сеть не трогается;
 *   с --live создаётся отдельный проект и диалог на каждый запрос;
 *   с --probe вместо матрицы задаётся один короткий вопрос и печатается usage —
 *   так видно постоянную часть запроса (правила + каталог + схемы инструментов).
 * Пароль администратора берётся из хранилища (dshow-admin) или из
 * DSHOW_ADMIN_USER / DSHOW_ADMIN_PASSWORD. Значения не печатаются.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const args = process.argv.slice(2);
const live = args.includes('--live');
const keep = args.includes('--keep');
const probe = args.includes('--probe');
const onlyArg = args.find((item) => item.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((item) => item.trim()).filter(Boolean) : null;
const baseArg = args.find((item) => item.startsWith('--base='));
const base = baseArg ? baseArg.slice('--base='.length).replace(/\/$/, '') : 'http://127.0.0.1:3080';

/* Запросы выбраны по навыкам: каждый проверяет один навык и его инструменты. */
const CASES = [
  {
    key: 'word',
    prompt: 'Сделай служебную записку по подписанному договору на 1 страницу: заказчик ООО «Ромашка», подрядчик ООО «Вектор», сумма 480 000 ₽, срок 45 дней, аванс 30%. Оформи файлом Word.',
    skill: 'office-docx',
    tools: ['create_word'],
    verify: ['check_document', 'read_document'],
  },
  {
    key: 'excel',
    prompt: 'Посчитай смету на забор из профнастила: 42 метра, столбы каждые 2,5 м, профиль 1 250 ₽ за метр, столб 900 ₽, ворота 18 000 ₽. Сделай Excel с формулами и итогом.',
    skill: 'office-xlsx',
    tools: ['create_excel'],
    verify: ['check_document', 'read_document'],
  },
  {
    key: 'pdf',
    prompt: 'Сделай PDF-отчёт на 2 страницы по итогам месяца: выручка 1 200 000 ₽, расходы 800 000 ₽, чистыми 400 000 ₽, маржа 33%. Печать A4.',
    skill: 'pdf-report',
    tools: ['create_pdf'],
    verify: ['check_document'],
  },
  {
    key: 'pptx',
    prompt: 'Собери презентацию на 5 слайдов для инвестора: наш продукт — сервис расчёта смет для частных застройщиков, рынок 12 млрд ₽, команда 3 человека, просим 15 млн ₽ за 15%.',
    skill: 'office-pptx',
    tools: ['create_pptx'],
    verify: ['check_document'],
  },
  {
    key: 'site',
    prompt: 'Сделай одностраничный сайт-визитку для бригады отделочников: три услуги, цены от, телефон и форма заявки. Один HTML-файл.',
    skill: 'web-page',
    tools: ['write_file'],
    verify: ['check_page'],
  },
  {
    key: 'data',
    prompt: 'Проанализируй таблицу продаж за квартал и найди аномалии: выручка по месяцам 1 200 000, 980 000, 1 350 000; количество сделок 120, 84, 131. Нужен вывод по динамике и среднему чеку.',
    skill: 'data-analysis',
    tools: ['calculate'],
    verify: [],
  },
  {
    key: 'research',
    prompt: 'Исследуй рынок электрогрузовиков в России на 2026 год: кто продаёт, объёмы, цены, господдержка. Нужны источники со ссылками и датами.',
    skill: 'web-research',
    tools: ['web_search'],
    verify: [],
  },
  {
    key: 'legal',
    prompt: 'Клиент не заплатил 620 000 ₽ по договору подряда, подписан акт, срок оплаты прошёл 40 дней. Что делать по шагам: претензия, неустойка, суд. Посчитай неустойку по 1/300 ключевой ставки 16%.',
    skill: 'house-build-claims',
    tools: ['calculate'],
    verify: [],
  },
  {
    key: 'estimate',
    prompt: 'Сколько стоит построить дом 120 м² из газобетона под чистовую отделку в Подмосковье? Нужна смета по разделам с итогом и Excel.',
    skill: 'house-build-estimate',
    tools: ['create_excel'],
    verify: ['check_document'],
  },
  {
    key: 'fin-audit',
    prompt: 'Проведи финансовый аудит небольшой компании за год: выручка 48 млн ₽, себестоимость 31 млн ₽, дебиторка 9 млн ₽, кредиты 12 млн ₽ под 21%. Дай коэффициенты, red flags и заключение.',
    skill: 'fin-audit',
    tools: ['calculate'],
    verify: [],
  },
  {
    key: 'incident',
    prompt: 'Сервис на Amvera ночью перезапускался три раза, пользователи видели 502. Разбери инцидент: что смотреть в логах, как найти причину, что делать, чтобы не повторилось.',
    skill: 'incident-response',
    tools: [],
    verify: [],
  },
  {
    key: 'diagram',
    prompt: 'Нарисуй схему процесса согласования сметы: заявка, проверка объёмов, расчёт, согласование, подпись. Нужен файл, чтобы вставить в презентацию.',
    skill: 'canvas-diagram',
    tools: ['write_file'],
    verify: [],
  },
];

const chosen = only ? CASES.filter((item) => only.includes(item.key)) : CASES;

if (!live) {
  console.log(`план матрицы: ${chosen.length} запросов, база ${base}`);
  for (const item of chosen) {
    console.log(`  ${item.key.padEnd(10)} навык ${item.skill.padEnd(20)} инструменты: ${item.tools.join(', ') || '—'}`);
  }
  console.log('\nс --live запросы уйдут в сервис настоящей моделью');
  process.exit(0);
}

/* --- логин: только служебный клиент, чужие сессии не выбиваем --- */
const VAULT = path.join(os.homedir(), '.dsh', 'secrets', '_vault.ps1');

function serviceHeaders() {
  return { 'user-agent': 'DSH-OPEN-WEB-skill-matrix/1.0', 'x-dshow-service': '1' };
}

function fromVault(field) {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `& '${VAULT}' get dshow-admin -Field ${field}`],
    { encoding: 'utf8' },
  ).trim();
}

async function readCreds() {
  if (process.env.DSHOW_ADMIN_USER && process.env.DSHOW_ADMIN_PASSWORD) {
    return { username: process.env.DSHOW_ADMIN_USER, password: process.env.DSHOW_ADMIN_PASSWORD };
  }
  if (!fs.existsSync(VAULT)) throw new Error(`нет хранилища паролей: ${VAULT}`);
  return { username: fromVault('login'), password: fromVault('password') };
}

let cookie = '';

async function login() {
  const { username, password } = await readCreds();
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...serviceHeaders() },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`вход не удался: ${response.status}`);
  const raw = response.headers.getSetCookie?.() || [];
  cookie = raw.map((item) => item.split(';')[0]).join('; ');
  if (!cookie) throw new Error('сервер не выдал сессию');
}

async function api(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', cookie, ...serviceHeaders(), ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`${pathname}: ${response.status} ${await response.text().then((text) => text.slice(0, 200))}`);
  return response.json();
}

/** Убрать проект матрицы из сервиса: чужие проекты в дашборде не нужны. */
async function dropProject(projectId) {
  if (!projectId || keep) return;
  try {
    await api(`/api/projects/${projectId}`, { method: 'DELETE' });
  } catch (error) {
    console.log(`  (проект ${projectId} не удалился: ${error?.message || error})`);
  }
}

/** Один запрос: сообщение в новый диалог, разбор событий потока. */
async function runCase(item) {
  const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: `матрица ${item.key} ${Date.now()}` }) });
  const projectId = project.project?.id || project.id;
  try {
    const chat = await api(`/api/projects/${projectId}/chats`, { method: 'POST', body: JSON.stringify({ title: `матрица ${item.key}` }) });
    const chatId = chat.chat?.id || chat.id;
    const started = Date.now();
    const tools = [];
    let text = '';
    let error = '';
    let usage = null;
    const response = await fetch(`${base}/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...serviceHeaders() },
      body: JSON.stringify({ text: item.prompt }),
    });
    if (!response.ok) throw new Error(`запуск: ${response.status} ${(await response.text()).slice(0, 200)}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 12 * 60 * 1000;
    while (Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const block of events) {
        const line = block.split('\n').find((entry) => entry.startsWith('data: '));
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (event.type === 'tool' && event.status !== 'run') tools.push({ name: event.name, summary: event.summary || '', status: event.status });
        if (event.type === 'delta') text += event.text || '';
        if (event.type === 'error') error = event.message || 'ошибка';
        if (event.type === 'done' && event.usage) usage = event.usage;
        if (event.type === 'end') {
          reader.cancel().catch(() => {});
          return { seconds: Math.round((Date.now() - started) / 1000), tools, text, error, usage };
        }
      }
    }
    reader.cancel().catch(() => {});
    return { seconds: Math.round((Date.now() - started) / 1000), tools, text, error: error || 'поток не закрылся за 12 минут' };
  } finally {
    await dropProject(projectId);
  }
}

await login();

if (probe) {
  /* Постоянная часть запроса: короткий вопрос без навыков показывает, сколько
     токенов сервис платит до первого слова ответа (правила + каталог + схемы). */
  const item = {
    key: 'probe',
    prompt: 'Ответь одним коротким предложением: сколько будет два плюс два?',
    skill: '',
    tools: [],
    verify: [],
  };
  const run = await runCase(item);
  console.log(
    JSON.stringify(
      { base, answer: run.text.trim().slice(0, 120), seconds: run.seconds, usage: run.usage, tools: run.tools.map((tool) => tool.name) },
      null,
      2,
    ),
  );
  process.exit(run.error ? 1 : 0);
}

const results = [];
for (const item of chosen) {
  process.stdout.write(`${item.key.padEnd(10)} … `);
  try {
    const run = await runCase(item);
    const names = run.tools.map((tool) => tool.name);
    const skillHit = run.tools.find((tool) => tool.name === 'use_skill');
    const firedSkill = skillHit ? String(skillHit.summary || '').trim() : '';
    const rightSkill = firedSkill === item.skill;
    const anySkill = Boolean(skillHit);
    const toolsHit = item.tools.length ? item.tools.some((name) => names.includes(name)) : true;
    const verified = item.verify.length ? item.verify.some((name) => names.includes(name)) : true;
    const ok = !run.error && anySkill && toolsHit;
    results.push({
      key: item.key,
      expected: item.skill,
      fired: firedSkill,
      anySkill,
      rightSkill,
      toolsHit,
      verified,
      seconds: run.seconds,
      tokensIn: run.usage?.tokensIn ?? null,
      tokensOut: run.usage?.tokensOut ?? null,
      tools: [...new Set(names)],
      chars: run.text.length,
      error: run.error,
    });
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${run.seconds}s навык=${firedSkill || '—'}${rightSkill ? '' : ` (ждали ${item.skill})`} ` +
        `инструменты=${[...new Set(names)].join(',') || '—'}${verified ? '' : ' · нет проверки'}${run.error ? ` · ${run.error}` : ''}`,
    );
  } catch (error) {
    results.push({ key: item.key, expected: item.skill, error: String(error?.message || error) });
    console.log(`FAIL ${error?.message || error}`);
  }
}

const report = {
  checkedAt: new Date().toISOString(),
  base,
  total: results.length,
  fired: results.filter((item) => item.anySkill).length,
  right: results.filter((item) => item.rightSkill).length,
  withTools: results.filter((item) => item.toolsHit).length,
  verified: results.filter((item) => item.verified !== false).length,
  failed: results.filter((item) => item.error),
  results,
};
const out = path.join(root, `.skill-matrix-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  `\nнавык открыт: ${report.fired}/${report.total}, тот самый: ${report.right}/${report.total}, ` +
    `инструменты из навыка: ${report.withTools}/${report.total}, проверка результата: ${report.verified}/${report.total}`,
);
console.log(`отчёт: ${out}`);
console.log(keep ? 'проекты матрицы оставлены в сервисе (--keep)' : 'проекты матрицы удалены из сервиса');
process.exit(report.failed.length ? 1 : 0);

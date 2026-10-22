/**
 * Состояние задачи — короткая карточка длинной работы.
 *
 * Проблема, которую это решает: в задаче на сотни шагов модель получает
 * «продолжай» и через несколько отрезков теряет нить — что уже сделано, что
 * осталось, какие файлы готовы, какие цифры проверены. Человек в этот момент
 * видит «работаю…» и не понимает, движется ли дело.
 *
 * Решение: после каждого отрезка собирается карточка {цель, сделано, осталось,
 * файлы, факты} и подставляется в сообщение о продолжении и в системную
 * подсказку следующего хода. Карточка детерминированная (без лишних вызовов
 * модели), переживает перезапуск: лежит в файле диалога как chat.task.
 */

import { TASK_STATE } from './config.mjs';

export function emptyTaskState() {
  return { goal: '', done: [], next: [], files: [], facts: [], steps: 0, segments: 0, updatedAt: '' };
}

/** Приведение любого входа к карточке: старые файлы и мусор не ломают ход. */
export function normalizeTaskState(value) {
  const base = emptyTaskState();
  if (!value || typeof value !== 'object') return base;
  const list = (items, max = TASK_STATE.maxItems) =>
    (Array.isArray(items) ? items : [])
      .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(-max);
  return {
    goal: String(value.goal || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    done: list(value.done),
    next: list(value.next),
    files: list(value.files, 12),
    facts: list(value.facts, 12),
    steps: Number(value.steps) || 0,
    segments: Number(value.segments) || 0,
    updatedAt: String(value.updatedAt || ''),
  };
}

const TASK_WORDS = /^(задача|цель|нужно|требуется|сделай|подготовь|собери|проведи|проанализируй)\b/i;

/** Цель — первая содержательная строка запроса, без служебных приветствий. */
export function goalFromText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const marked = lines.find((line) => TASK_WORDS.test(line));
  const chosen = marked || lines[0];
  return chosen.slice(0, 400);
}

/** Пункты запроса: нумерованные строки и маркеры — это будущие «осталось». */
export function itemsFromText(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:\d+[.)]|[-—•*])\s+(.{3,200})$/);
    if (match) out.push(match[1].replace(/\s+/g, ' ').trim());
  }
  return out.slice(0, TASK_STATE.maxItems);
}

/** Признак продвижения: файл создан, данные посчитаны, источник открыт. */
function toolFact(tool) {
  if (!tool || tool.status === 'error') return '';
  const name = String(tool.name || '');
  const summary = String(tool.summary || '').replace(/\s+/g, ' ').trim();
  const label = String(tool.label || name);
  if (!summary) return '';
  if (/^create_/.test(name) || name === 'write_file' || name === 'append_file') return `${label}: ${summary}`;
  if (name === 'web_search' || name === 'fetch_url' || name === 'read_page') return `${label}: ${summary}`;
  if (name === 'run_js' || name === 'run_python') return `${label}: ${summary}`;
  return '';
}

/** Файлы, которые реально появились в проекте за ход. */
function createdPath(tool) {
  if (!tool || tool.status === 'error') return '';
  const path = String(tool.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return path || '';
}

/** Итог работы по ходу: обновляет карточку на месте (её же сохраняет сервер). */
export function updateTaskState(state, { userText = '', tools = [], steps = 0, segments = 0, note = '' } = {}) {
  const task = normalizeTaskState(state);
  if (!task.goal) task.goal = goalFromText(userText);
  const planned = itemsFromText(userText);

  for (const tool of Array.isArray(tools) ? tools : []) {
    const fact = toolFact(tool);
    if (fact && !task.facts.includes(fact)) task.facts.push(fact);
    const file = createdPath(tool);
    if (file && !task.files.includes(file)) task.files.push(file);
    if (tool?.status !== 'error' && tool?.name && /^(create_[a-z]+|write_file|append_file|run_js|run_python)$/.test(String(tool.name))) {
      const summary = String(tool.summary || tool.name).replace(/\s+/g, ' ').slice(0, 160);
      if (summary && !task.done.includes(summary)) task.done.push(summary);
    }
  }

  if (note && !task.done.includes(note)) task.done.push(note);

  /* «Осталось» — это пункты запроса, по которым ещё нет сделанного пункта.
     Сравнение по словам: план «раздел 1: рынок» закрывается фактом «Раздел 1:
     рынок — 12 источников». */
  const doneText = task.done.join(' \n ').toLowerCase();
  const next = planned.filter((item) => {
    const words = item.toLowerCase().split(/\s+/).filter((word) => word.length >= 4);
    if (!words.length) return true;
    const hits = words.filter((word) => doneText.includes(word)).length;
    return hits / words.length < 0.6;
  });
  task.next = next.length ? next.slice(0, TASK_STATE.maxItems) : task.next;

  task.done = task.done.slice(-TASK_STATE.maxItems);
  task.facts = task.facts.slice(-12);
  task.files = task.files.slice(-12);
  task.steps = Math.max(task.steps, Number(steps) || 0);
  task.segments = Math.max(task.segments, Number(segments) || 0);
  task.updatedAt = new Date().toISOString();
  return task;
}

/**
 * Текст карточки для подсказки. Пустая карточка ничего не добавляет —
 * короткие задачи не должны платить за служебный блок.
 */
export function renderTaskState(state, { budget = TASK_STATE.promptChars } = {}) {
  const task = normalizeTaskState(state);
  if (!TASK_STATE.enabled) return '';
  if (!task.goal && !task.done.length && !task.files.length) return '';
  const blocks = ['Состояние текущей задачи (держи линию, не начинай заново):'];
  if (task.goal) blocks.push(`Цель: ${task.goal}`);
  if (task.done.length) blocks.push(`Уже сделано:\n${task.done.map((item) => `— ${item}`).join('\n')}`);
  if (task.files.length) blocks.push(`Готовые файлы: ${task.files.join(', ')}`);
  if (task.next.length) blocks.push(`Осталось:\n${task.next.map((item) => `— ${item}`).join('\n')}`);
  if (task.steps || task.segments) {
    blocks.push(`Продвижение: шагов ${task.steps}${task.segments ? `, отрезков ${task.segments}` : ''}.`);
  }
  const text = blocks.join('\n');
  return text.length > budget ? `${text.slice(0, Math.max(0, budget - 1))}…` : text;
}

/**
 * Сообщение о продолжении вместо голого «продолжай»: КПД отрезка зависит от
 * того, напомнили ли модели, что уже готово и что осталось.
 */
export function continuePrompt(state, basePrompt) {
  const card = renderTaskState(state);
  if (!card) return basePrompt;
  return `${basePrompt}\n\n${card}\nПродолжай с первого пункта «Осталось», не повторяя уже сделанное.`;
}

/** Итог работы: короткая карточка для финального ответа и для нового хода. */
export function taskSummaryLine(state) {
  const task = normalizeTaskState(state);
  if (!task.goal) return '';
  const files = task.files.length ? ` Файлы: ${task.files.slice(0, 6).join(', ')}.` : '';
  const open = task.next.length ? ` Осталось: ${task.next.slice(0, 3).join('; ')}.` : '';
  return `Задача: ${task.goal.slice(0, 200)}.${files}${open}`;
}

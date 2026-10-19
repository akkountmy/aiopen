import { CONTEXT, MODEL, costUsd } from './config.mjs';
import { getDeepSeekKey } from './keys.mjs';
import { summaryPrompt, systemPrompt } from './prompt.mjs';
import { availableToolDefs, TOOL_LABELS, executeTool, toolSummary } from './tools.mjs';
import { estimateTokens, sleep, truncate } from './util.mjs';

const MAX_IMAGE_PARTS = 6;

function contentText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : part?.type === 'image_url' ? '[изображение]' : ''))
      .join('\n');
  }
  return '';
}

function messageCost(message) {
  let cost = estimateTokens(contentText(message)) + 4;
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      cost += estimateTokens(call?.function?.name || '') + estimateTokens(call?.function?.arguments || '') + 6;
    }
  }
  return cost;
}

function friendlyError(error) {
  const status = error?.status;
  if (error?.name === 'AbortError') return 'Генерация остановлена.';
  if (status === 401 || status === 403) return 'Нет доступа к сервису. Сообщите администратору.';
  if (status === 429) return 'Слишком много запросов подряд. Подождите пару секунд и повторите.';
  if (status === 402) return 'Закончился баланс сервиса. Сообщите администратору.';
  if (status >= 500) return 'Сервис временно перегружен. Попробуйте ещё раз.';
  const message = String(error?.message || '');
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network|socket/i.test(message)) {
    return 'Нет связи с сервисом. Проверьте интернет и повторите.';
  }
  return 'Не удалось получить ответ. Попробуйте ещё раз.';
}

export function describeFailure(error) {
  return friendlyError(error);
}

async function requestCompletion(body, { signal, onDelta, onReasoning }) {
  const key = getDeepSeekKey();
  if (!key) {
    const error = new Error('Ключ сервиса не настроен');
    error.status = 401;
    throw error;
  }
  const payload = { ...body, stream: true, stream_options: { include_usage: true } };
  const response = await fetch(`${MODEL.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    const error = new Error(`upstream ${response.status}: ${raw.slice(0, 400)}`);
    error.status = response.status;
    error.raw = raw;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  let usage = null;
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onReasoning?.(delta.reasoning_content);
      }
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onDelta?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const part of delta.tool_calls) {
          const index = part.index ?? 0;
          if (!toolCalls[index]) {
            toolCalls[index] = { id: part.id || `call_${index}`, type: 'function', function: { name: '', arguments: '' } };
          }
          if (part.id) toolCalls[index].id = part.id;
          if (part.function?.name) toolCalls[index].function.name += part.function.name;
          if (part.function?.arguments) toolCalls[index].function.arguments += part.function.arguments;
        }
      }
    }
  }

  return { text, reasoning, toolCalls: toolCalls.filter(Boolean), usage, finishReason };
}

export async function simpleCompletion(messages, { maxTokens = 500, signal, effort = 'low' } = {}) {
  const key = getDeepSeekKey();
  if (!key) return '';
  const call = (withEffort) => {
    const body = { model: MODEL.name, messages, max_tokens: maxTokens, stream: false };
    if (withEffort) body.reasoning_effort = effort;
    return fetch(`${MODEL.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  };
  let response = await call(true);
  if (response.status === 400) response = await call(false);
  if (!response.ok) throw new Error(`simple completion ${response.status}`);
  const json = await response.json();
  return String(json?.choices?.[0]?.message?.content || '').trim();
}

function trimHistory(chat, budget) {
  const removed = [];
  let total = chat.history.reduce((sum, m) => sum + messageCost(m), 0);
  let guard = 0;
  while (total > budget && chat.history.length > CONTEXT.keepRecentMessages && guard < 200) {
    guard++;
    let cut = 1;
    while (cut < chat.history.length && chat.history[cut].role !== 'user') cut++;
    if (cut >= chat.history.length) break;
    const slice = chat.history.splice(0, cut);
    for (const message of slice) {
      total -= messageCost(message);
      removed.push(message);
    }
  }
  return removed;
}

function buildUserContent(text, images) {
  if (!images.length) return text;
  const parts = [{ type: 'text', text }];
  for (const image of images.slice(0, MAX_IMAGE_PARTS)) {
    parts.push({ type: 'image_url', image_url: { url: image } });
  }
  return parts;
}

/**
 * Выполняет один ход агента: стримит ответ и выполняет инструменты.
 * @param {object} params
 * @param {string} params.workspace путь рабочей папки проекта
 * @param {{history: Array, memory: string}} params.chat
 * @param {string} params.userText текст пользователя с уже вставленными выдержками из файлов
 * @param {string[]} params.images data-url изображений текущего сообщения
 * @param {Function} params.emit события для UI
 * @param {AbortSignal} params.signal
 */
export async function runTurn({ workspace, chat, projectName, userName, userText, images = [], emit, signal, budget = null }) {
  const usage = { tokensIn: 0, tokensOut: 0 };
  const toolsUsed = [];
  const removed = trimHistory(chat, CONTEXT.historyTokens);

  if (removed.length) {
    const removedText = removed.map((m) => `${m.role}: ${contentText(m)}`).join('\n').slice(0, 14000);
    if (removedText.length > 2500 && !signal.aborted) {
      try {
        const summary = await simpleCompletion(
          [
            { role: 'user', content: summaryPrompt(removedText) },
          ],
          { maxTokens: 600, signal },
        );
        if (summary) {
          const merged = `${chat.memory ? `${chat.memory}\n` : ''}${summary}`;
          chat.memory = truncate(merged, CONTEXT.summaryChars);
        }
      } catch {
        /* без памяти тоже работает */
      }
    }
  }

  const turnMessage = { role: 'user', content: buildUserContent(userText, images) };
  chat.history.push(turnMessage);

  const toolDefs = await availableToolDefs();
  let finalText = '';
  let steps = 0;

  while (steps < CONTEXT.maxSteps) {
    steps++;
    const system = systemPrompt({ projectName, memory: chat.memory, userName, question: userText });
    const messages = [{ role: 'system', content: system }, ...chat.history];

    let result;
    try {
      result = await requestCompletion(
        {
          model: MODEL.name,
          messages,
          tools: toolDefs,
          tool_choice: 'auto',
          max_tokens: CONTEXT.maxOutputTokens,
          reasoning_effort: MODEL.effort,
        },
        {
          signal,
          onDelta: (text) => emit({ type: 'delta', text }),
          onReasoning: () => emit({ type: 'reasoning' }),
        },
      );
    } catch (error) {
      // Некоторые маршруты не принимают reasoning_effort — повторяем без него.
      if (error?.status === 400 && /reasoning_effort|unsupported|unknown/i.test(error?.raw || '')) {
        result = await requestCompletion(
          {
            model: MODEL.name,
            messages,
            tools: toolDefs,
            tool_choice: 'auto',
            max_tokens: CONTEXT.maxOutputTokens,
          },
          {
            signal,
            onDelta: (text) => emit({ type: 'delta', text }),
            onReasoning: () => emit({ type: 'reasoning' }),
          },
        );
      } else {
        throw error;
      }
    }

    if (result.usage) {
      usage.tokensIn += result.usage.prompt_tokens || 0;
      usage.tokensOut += result.usage.completion_tokens || 0;
    }

    finalText += result.text || '';

    /* Стоимость именно этой задачи превысила порог: останавливаемся, чтобы не
       жечь деньги пользователя. Накопленный расход проекта здесь не участвует —
       иначе сотня мелких задач упиралась бы в лимит. */
    if (budget && Number(budget.limitUsd) > 0) {
      const spentUsd = costUsd(usage.tokensIn, usage.tokensOut);
      if (spentUsd >= Number(budget.limitUsd)) {
        const budgetHit = {
          spentUsd: Math.round(spentUsd * 100) / 100,
          limitUsd: Math.round(Number(budget.limitUsd) * 100) / 100,
        };
        emit({ type: 'budget', ...budgetHit });
        return { text: finalText, usage, tools: toolsUsed, steps, memory: chat.memory, budgetHit };
      }
    }

    if (!result.toolCalls.length) {
      chat.history.push({ role: 'assistant', content: result.text || '' });
      break;
    }

    const assistantMessage = {
      role: 'assistant',
      content: result.text || null,
      tool_calls: result.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments || '{}' },
      })),
    };
    chat.history.push(assistantMessage);
    chat.history.push(...[]);

    for (const call of assistantMessage.tool_calls) {
      let args = {};
      let brokenArguments = false;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = {};
        brokenArguments = true;
      }
      const label = TOOL_LABELS[call.function.name] || call.function.name;
      const summary = toolSummary(call.function.name, args);
      const toolId = call.id || `${Date.now()}`;
      emit({ type: 'tool', id: toolId, name: call.function.name, label, summary, status: 'run' });
      const started = Date.now();
      let content = '';
      let status = 'ok';
      if (brokenArguments) {
        status = 'error';
        content =
          'Ошибка инструмента: аргументы вызова пришли обрезанными (слишком длинный ответ). ' +
          'Не повторяй тот же вызов целиком: для большого файла сначала write_file с первой частью (4–8 КБ), ' +
          'затем append_file с остальными частями.';
        emit({
          type: 'tool',
          id: toolId,
          name: call.function.name,
          label,
          summary,
          status: 'error',
          detail: 'аргументы обрезаны',
          ms: 0,
        });
        console.warn(`[tool] ${call.function.name}: аргументы обрезаны`);
      } else {
        try {
          const executed = await executeTool(call.function.name, args, { workspace, signal });
          content = truncate(String(executed.text ?? ''), CONTEXT.toolResultChars);
          emit({
            type: 'tool',
            id: toolId,
            name: call.function.name,
            label,
            summary,
            status: 'ok',
            detail: executed.meta?.path ? String(executed.meta.path) : '',
            ms: Date.now() - started,
          });
        } catch (error) {
          status = 'error';
          content = `Ошибка инструмента: ${error.message}`;
          console.warn(`[tool] ${call.function.name}: ${error.message}`);
          emit({
            type: 'tool',
            id: toolId,
            name: call.function.name,
            label,
            summary,
            status: 'error',
            detail: String(error.message || '').slice(0, 160),
            ms: Date.now() - started,
          });
        }
      }
      toolsUsed.push({ id: toolId, name: call.function.name, label, summary, status });
      chat.history.push({
        role: 'tool',
        tool_call_id: call.id,
        content: content || 'Готово.',
      });
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }

  if (steps >= CONTEXT.maxSteps) {
    const note = '\n\n_Достигнут предел шагов для одной задачи — уточните, что продолжить._';
    finalText += note;
    emit({ type: 'delta', text: note });
  }

  return { text: finalText, usage, tools: toolsUsed, steps, memory: chat.memory };
}

export async function generateTitle(text, { signal } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  try {
    const raw = await simpleCompletion(
      [{ role: 'user', content: `Придумай короткое название (2–5 слов) для диалога по первой реплике. Только название, без кавычек и точки.\n\nРеплика: ${clean.slice(0, 500)}` }],
      { maxTokens: 400, signal, effort: 'low' },
    );
    return raw.replace(/^["В«В»'`]+|["В«В»'`]+$/g, '').replace(/\s+/g, ' ').slice(0, 80);
  } catch {
    return '';
  }
}

export async function waitMs(ms) {
  await sleep(ms);
}


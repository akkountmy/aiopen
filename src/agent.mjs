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
      .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : part?.type === 'image_url' ? '[РёР·РѕР±СЂР°Р¶РµРЅРёРµ]' : ''))
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
  if (error?.name === 'AbortError') return 'Р“РµРЅРµСЂР°С†РёСЏ РѕСЃС‚Р°РЅРѕРІР»РµРЅР°.';
  if (status === 401 || status === 403) return 'РќРµС‚ РґРѕСЃС‚СѓРїР° Рє СЃРµСЂРІРёСЃСѓ. РЎРѕРѕР±С‰РёС‚Рµ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂСѓ.';
  if (status === 429) return 'РЎР»РёС€РєРѕРј РјРЅРѕРіРѕ Р·Р°РїСЂРѕСЃРѕРІ РїРѕРґСЂСЏРґ. РџРѕРґРѕР¶РґРёС‚Рµ РїР°СЂСѓ СЃРµРєСѓРЅРґ Рё РїРѕРІС‚РѕСЂРёС‚Рµ.';
  if (status === 402) return 'Р—Р°РєРѕРЅС‡РёР»СЃСЏ Р±Р°Р»Р°РЅСЃ СЃРµСЂРІРёСЃР°. РЎРѕРѕР±С‰РёС‚Рµ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂСѓ.';
  if (status >= 500) return 'РЎРµСЂРІРёСЃ РІСЂРµРјРµРЅРЅРѕ РїРµСЂРµРіСЂСѓР¶РµРЅ. РџРѕРїСЂРѕР±СѓР№С‚Рµ РµС‰С‘ СЂР°Р·.';
  const message = String(error?.message || '');
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network|socket/i.test(message)) {
    return 'РќРµС‚ СЃРІСЏР·Рё СЃ СЃРµСЂРІРёСЃРѕРј. РџСЂРѕРІРµСЂСЊС‚Рµ РёРЅС‚РµСЂРЅРµС‚ Рё РїРѕРІС‚РѕСЂРёС‚Рµ.';
  }
  return 'РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕР»СѓС‡РёС‚СЊ РѕС‚РІРµС‚. РџРѕРїСЂРѕР±СѓР№С‚Рµ РµС‰С‘ СЂР°Р·.';
}

export function describeFailure(error) {
  return friendlyError(error);
}

async function requestCompletion(body, { signal, onDelta, onReasoning }) {
  const key = getDeepSeekKey();
  if (!key) {
    const error = new Error('РљР»СЋС‡ СЃРµСЂРІРёСЃР° РЅРµ РЅР°СЃС‚СЂРѕРµРЅ');
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
 * Р’С‹РїРѕР»РЅСЏРµС‚ РѕРґРёРЅ С…РѕРґ Р°РіРµРЅС‚Р°: СЃС‚СЂРёРјРёС‚ РѕС‚РІРµС‚ Рё РІС‹РїРѕР»РЅСЏРµС‚ РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹.
 * @param {object} params
 * @param {string} params.workspace РїСѓС‚СЊ СЂР°Р±РѕС‡РµР№ РїР°РїРєРё РїСЂРѕРµРєС‚Р°
 * @param {{history: Array, memory: string}} params.chat
 * @param {string} params.userText С‚РµРєСЃС‚ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ СЃ СѓР¶Рµ РІСЃС‚Р°РІР»РµРЅРЅС‹РјРё РІС‹РґРµСЂР¶РєР°РјРё РёР· С„Р°Р№Р»РѕРІ
 * @param {string[]} params.images data-url РёР·РѕР±СЂР°Р¶РµРЅРёР№ С‚РµРєСѓС‰РµРіРѕ СЃРѕРѕР±С‰РµРЅРёСЏ
 * @param {Function} params.emit СЃРѕР±С‹С‚РёСЏ РґР»СЏ UI
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
        /* Р±РµР· РїР°РјСЏС‚Рё С‚РѕР¶Рµ СЂР°Р±РѕС‚Р°РµС‚ */
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
    const system = systemPrompt({ projectName, memory: chat.memory, userName });
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
      // РќРµРєРѕС‚РѕСЂС‹Рµ РјР°СЂС€СЂСѓС‚С‹ РЅРµ РїСЂРёРЅРёРјР°СЋС‚ reasoning_effort вЂ” РїРѕРІС‚РѕСЂСЏРµРј Р±РµР· РЅРµРіРѕ.
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
          'РћС€РёР±РєР° РёРЅСЃС‚СЂСѓРјРµРЅС‚Р°: Р°СЂРіСѓРјРµРЅС‚С‹ РІС‹Р·РѕРІР° РїСЂРёС€Р»Рё РѕР±СЂРµР·Р°РЅРЅС‹РјРё (СЃР»РёС€РєРѕРј РґР»РёРЅРЅС‹Р№ РѕС‚РІРµС‚). ' +
          'РќРµ РїРѕРІС‚РѕСЂСЏР№ С‚РѕС‚ Р¶Рµ РІС‹Р·РѕРІ С†РµР»РёРєРѕРј: РґР»СЏ Р±РѕР»СЊС€РѕРіРѕ С„Р°Р№Р»Р° СЃРЅР°С‡Р°Р»Р° write_file СЃ РїРµСЂРІРѕР№ С‡Р°СЃС‚СЊСЋ (4вЂ“8 РљР‘), ' +
          'Р·Р°С‚РµРј append_file СЃ РѕСЃС‚Р°Р»СЊРЅС‹РјРё С‡Р°СЃС‚СЏРјРё.';
        emit({
          type: 'tool',
          id: toolId,
          name: call.function.name,
          label,
          summary,
          status: 'error',
          detail: 'Р°СЂРіСѓРјРµРЅС‚С‹ РѕР±СЂРµР·Р°РЅС‹',
          ms: 0,
        });
        console.warn(`[tool] ${call.function.name}: Р°СЂРіСѓРјРµРЅС‚С‹ РѕР±СЂРµР·Р°РЅС‹`);
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
          content = `РћС€РёР±РєР° РёРЅСЃС‚СЂСѓРјРµРЅС‚Р°: ${error.message}`;
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
        content: content || 'Р“РѕС‚РѕРІРѕ.',
      });
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }

  if (steps >= CONTEXT.maxSteps) {
    const note = '\n\n_Р”РѕСЃС‚РёРіРЅСѓС‚ РїСЂРµРґРµР» С€Р°РіРѕРІ РґР»СЏ РѕРґРЅРѕР№ Р·Р°РґР°С‡Рё вЂ” СѓС‚РѕС‡РЅРёС‚Рµ, С‡С‚Рѕ РїСЂРѕРґРѕР»Р¶РёС‚СЊ._';
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
      [{ role: 'user', content: `РџСЂРёРґСѓРјР°Р№ РєРѕСЂРѕС‚РєРѕРµ РЅР°Р·РІР°РЅРёРµ (2вЂ“5 СЃР»РѕРІ) РґР»СЏ РґРёР°Р»РѕРіР° РїРѕ РїРµСЂРІРѕР№ СЂРµРїР»РёРєРµ. РўРѕР»СЊРєРѕ РЅР°Р·РІР°РЅРёРµ, Р±РµР· РєР°РІС‹С‡РµРє Рё С‚РѕС‡РєРё.\n\nР РµРїР»РёРєР°: ${clean.slice(0, 500)}` }],
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


import { TELEGRAM } from './config.mjs';

/**
 * Уведомление администратору в Telegram (бот «Василина»).
 * Токен и chat id приходят только из окружения и в интерфейс не попадают.
 * Ошибка доставки не ломает задачу: просто пишем в лог.
 */
export async function notifyAdmin(text) {
  if (!TELEGRAM.token || !TELEGRAM.chatId) {
    console.warn('[notify] Telegram не настроен: DSHOW_TG_TOKEN/DSHOW_TG_CHAT пусты');
    return { ok: false, reason: 'not-configured' };
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) {
      console.warn('[notify] Telegram отклонил сообщение:', response.status, data?.description || '');
      return { ok: false, status: response.status };
    }
    console.log('[notify] запрос отправлен администратору, message_id=' + (data?.result?.message_id ?? '?'));
    return { ok: true };
  } catch (error) {
    console.warn('[notify] Telegram недоступен:', error?.message || error);
    return { ok: false, reason: String(error?.message || error) };
  }
}

function escapeTelegram(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function approvalMessage({ username, projectName, chatTitle, spentUsd, limitUsd, when }) {
  const url = TELEGRAM.publicUrl;
  return [
    '⚠️ <b>Тяжёлая задача в DSH OPEN WEB</b>',
    '',
    `Пользователь: <b>${escapeTelegram(username)}</b>`,
    `Проект: ${escapeTelegram(projectName)}`,
    chatTitle ? `Диалог: ${escapeTelegram(chatTitle)}` : null,
    `Израсходовано: <b>$${spentUsd.toFixed(2)}</b> при пороге $${limitUsd.toFixed(2)} за одну задачу`,
    `Время: ${escapeTelegram(when)}`,
    '',
    'Работа пользователя приостановлена до вашего ответа.',
    `Подтвердить или отклонить: ${url} → меню пользователя → «Пользователи» → «Запросы».`,
  ]
    .filter(Boolean)
    .join('\n');
}

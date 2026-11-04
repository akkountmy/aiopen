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

function shortUa(ua) {
  const text = String(ua || '');
  if (!text) return 'неизвестный клиент';
  const os = /Windows NT 10/.test(text) ? 'Windows' : /Windows/.test(text) ? 'Windows' : /Android/.test(text)
    ? 'Android' : /iPhone|iPad|iOS/.test(text) ? 'iOS' : /Mac OS X/.test(text) ? 'macOS' : /Linux/.test(text)
      ? 'Linux' : 'другая ОС';
  const browser = /YaBrowser/.test(text) ? 'Yandex' : /Edg\//.test(text) ? 'Edge' : /OPR\//.test(text)
    ? 'Opera' : /Chrome\//.test(text) ? 'Chrome' : /Firefox\//.test(text) ? 'Firefox' : /Safari\//.test(text)
      ? 'Safari' : 'браузер';
  return `${browser}/${os}`;
}

function whenText(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Предупреждение о подозрении на передачу логина и пароля.
 * Один аккаунт — одна машина, поэтому частая смена устройств и «выбивания»
 * активного сеанса — повод проверить, не работает ли кто-то чужой.
 */
export function suspicionMessage({ username, displayName, reasons, events, ips, devices, displaced, windowHours }) {
  const list = (events || [])
    .slice(-6)
    .map((event) => {
      const parts = [whenText(event.at), event.ip || 'без IP', shortUa(event.ua)];
      if (event.displaced) parts.push('выбил прежний сеанс');
      return `• ${parts.join(' — ')}`;
    })
    .join('\n');
  return [
    '🚨 <b>Подозрение на передачу доступа в DSH OPEN WEB</b>',
    '',
    `Аккаунт: <b>${escapeTelegram(displayName || username)}</b> (логин <code>${escapeTelegram(username)}</code>)`,
    `Причина: ${escapeTelegram((reasons || []).join('; '))}`,
    '',
    `За ${windowHours} ч: устройств — ${(devices || []).length}, адресов — ${(ips || []).length}, выбито сеансов — ${displaced || 0}`,
    ips && ips.length ? `IP: ${escapeTelegram(ips.slice(0, 6).join(', '))}` : null,
    '',
    'Последние входы:',
    list || '• нет данных',
    '',
    'Что делать: сменить пароль этого аккаунта в панели администратора и уточнить у владельца, кому он давал доступ.',
  ]
    .filter((line) => line !== null)
    .join('\n');
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

/* Обращение из окна «Поддержка». Текст приходит от человека, поэтому весь
   пользовательский ввод проходит через escapeTelegram: иначе символ «<» в
   описании ошибки ломал бы разметку и Telegram отклонял бы сообщение целиком. */
export function supportMessage({ kind, kindLabel, username, displayName, text, contact, page, ua, hasScreenshot }) {
  const url = TELEGRAM.publicUrl;
  const who = displayName && displayName !== username ? `${displayName} (${username})` : username;
  const trimmed = String(text || '').trim();
  const body = trimmed.length > 900 ? `${trimmed.slice(0, 900)}…` : trimmed;
  return [
    `💬 <b>Сообщение от пользователя: ${escapeTelegram(kindLabel || 'обращение')}</b>`,
    '',
    `От: <b>${escapeTelegram(who)}</b>`,
    page ? `Страница: ${escapeTelegram(page)}` : null,
    contact ? `Связаться: ${escapeTelegram(contact)}` : null,
    '',
    `<blockquote>${escapeTelegram(body)}</blockquote>`,
    hasScreenshot ? 'Скриншот приложен — он виден в кабинете администратора.' : null,
    '',
    `Ответить: ${url} → меню пользователя → «Пользователи» → «Сообщения от пользователя».`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/* Подпись для уведомления на устройстве администратора. */
export function supportPushText({ kindLabel, username, text }) {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  return {
    title: `${kindLabel || 'Сообщение'} от ${username}`,
    body: trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed,
  };
}

// Проверка стелс-движка на живом сервисе: один настоящий запрос через агента.
//
// Зачем: установленный бинарник ещё не доказывает, что страница, которую не
// отдаёт обычная загрузка, действительно приходит. Скрипт входит в сервис,
// создаёт временный диалог, просит модель загрузить адрес через obscura
// (engine=obscura), читает ответ и удаляет диалог за собой. Запускать вручную —
// это стоит одного обращения к модели.
//
// Запуск (PowerShell):
//   $env:DSHOW_BASE='https://dshopen-vladimir00177.msk1.amvera.tech'
//   $env:DSHOW_ADMIN_USER='DSH'; $env:DSHOW_ADMIN_PASSWORD='…'
//   node scripts/check-stealth-live.mjs
//
// Аргументы: первый — адрес для загрузки (по умолчанию reddit), второй — какой
// движок считать успехом (по умолчанию obscura).
const BASE = String(process.env.DSHOW_BASE || 'http://127.0.0.1:3123').replace(/\/+$/, '');
const USER = String(process.env.DSHOW_ADMIN_USER || '').trim();
const PASS = String(process.env.DSHOW_ADMIN_PASSWORD || '');
const URL_TO_LOAD = process.argv[2] || 'https://www.reddit.com/r/rust/';
const WANT_ENGINE = process.argv[3] || 'obscura';

if (!USER || !PASS) {
  console.error('задайте DSHOW_ADMIN_USER и DSHOW_ADMIN_PASSWORD');
  process.exit(2);
}

let cookie = '';

function keepCookie(response) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  if (list.length) cookie = list.map((item) => item.split(';')[0]).join('; ');
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  keepCookie(response);
  if (raw) return response;
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${data.error || ''}`.trim());
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const login = await api('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
console.log(`вошёл как ${login.user?.username || USER}, адрес ${BASE}`);

const boot = await api('/api/bootstrap');
const project = (boot.projects || [])[0];
if (!project) throw new Error('у аккаунта нет проекта — сначала войдите в интерфейс');
const created = await api(`/api/projects/${project.id}/chats`, { method: 'POST', body: {} });
const chatId = created.chat.id;
console.log(`временный диалог ${chatId} в проекте «${project.name || project.id}»`);

const prompt = [
  'Проверка движка загрузки (служебная).',
  `Вызови инструмент fetch_url ровно один раз для адреса ${URL_TO_LOAD} с параметром engine="${WANT_ENGINE}".`,
  'Затем ответь двумя строками и ничего больше не делай:',
  'ENGINE=<значение meta.engine из ответа инструмента>',
  'CHARS=<сколько символов текста пришло>',
].join('\n');

const started = Date.now();
try {
  /* Ответ на сообщение — поток задачи; читаем его до конца, иначе сервер
     продолжит писать в закрытое соединение. */
  const stream = await api(`/api/chats/${chatId}/messages`, { method: 'POST', body: { text: prompt }, raw: true });
  if (!stream.ok) throw new Error(`сообщение не принято: HTTP ${stream.status}`);
  const runId = stream.headers.get('x-dshow-run') || '';
  console.log(`задача ${runId || '(без идентификатора)'} пошла, читаю поток…`);
  const reader = stream.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }

  let answer = '';
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const data = await api(`/api/chats/${chatId}`);
    const messages = data.chat?.messages || [];
    const last = messages[messages.length - 1];
    /* Сообщение ассистента хранит текст в поле content, а не text. */
    const text = String(last?.content || '').trim();
    if (last && last.role === 'assistant' && text) {
      answer = text;
      break;
    }
    await sleep(2000);
  }
  const elapsed = Math.round((Date.now() - started) / 1000);
  if (!answer) throw new Error(`за ${elapsed} с ответ не пришёл`);

  const engine = (/ENGINE=(\S+)/.exec(answer) || [])[1] || '';
  const chars = (/CHARS=(\d+)/.exec(answer) || [])[1] || '?';
  console.log(`\nответ за ${elapsed} с:\n${answer.trim().slice(0, 700)}\n`);
  console.log(`движок: ${engine || 'не назван'}, символов: ${chars}`);
  if (engine === WANT_ENGINE) {
    console.log(`\nок: страница пришла через ${WANT_ENGINE}`);
  } else {
    console.log(`\nВНИМАНИЕ: ожидался ${WANT_ENGINE}, а движок — ${engine || 'не назван'}`);
    process.exitCode = 1;
  }
} finally {
  try {
    await api(`/api/chats/${chatId}`, { method: 'DELETE' });
    console.log(`временный диалог ${chatId} удалён`);
  } catch (error) {
    console.log(`диалог ${chatId} не удалился: ${error.message}`);
  }
}

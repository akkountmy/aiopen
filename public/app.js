const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function plural(count, one, few, many) {
  const n = Math.abs(Number(count) || 0) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

const ICONS = {
  folder:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 014.5 5h3l1.5 2h6.5A1.5 1.5 0 0117 8.5v6A1.5 1.5 0 0115.5 16h-11A1.5 1.5 0 013 14.5v-8z"/></svg>',
  file: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3.5A1.5 1.5 0 016.5 2h4L15 6.5v10A1.5 1.5 0 0113.5 18h-7A1.5 1.5 0 015 16.5v-13z"/><path d="M10.5 2v4.5H15"/></svg>',
  image:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="1.6"/><circle cx="7.4" cy="8.2" r="1.1"/><path d="M3.5 14l4-4 3 3 2.4-2.4 3.6 3.6"/></svg>',
  dots: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15.5" cy="10" r="1.4"/></svg>',
  download:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v9M6.2 9.5L10 13.3l3.8-3.8M4 16h12"/></svg>',
  trash:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4.5A1.5 1.5 0 019.5 3h1A1.5 1.5 0 0112 4.5V6M6 6l.8 9.6A1.5 1.5 0 018.3 17h3.4a1.5 1.5 0 001.5-1.4L14 6"/></svg>',
  copy: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="10" rx="1.5"/><path d="M13 7V5.5A1.5 1.5 0 0011.5 4H5.5A1.5 1.5 0 004 5.5v7A1.5 1.5 0 005.5 14H7"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg>',
  key: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7.5" cy="12.5" r="3.5"/><path d="M10 10l6-6M14 6l1.5 1.5M16 4l1.5 1.5"/></svg>',
  users:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7.5" cy="7" r="2.6"/><path d="M3 16c0-2.2 2-3.6 4.5-3.6S12 13.8 12 16"/><path d="M13 5.2a2.4 2.4 0 010 4.6M14 12.6c1.9.3 3 1.6 3 3.4"/></svg>',
  logout:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4H5.5A1.5 1.5 0 004 5.5v9A1.5 1.5 0 005.5 16H12"/><path d="M11 10h6M14.5 7L17.5 10l-3 3"/></svg>',
  pen: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.5 4.5l2 2L7 15H5v-2z"/></svg>',
  plus: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 5v10M5 10h10"/></svg>',
  archive:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 8h14M9 4v4"/></svg>',
  upload:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V4M5.5 8.5L10 4l4.5 4.5"/></svg>',
  theme:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.6"/><path d="M10 2.4v1.8M10 15.8v1.8M2.4 10h1.8M15.8 10h1.8M4.6 4.6l1.3 1.3M14.1 14.1l1.3 1.3M15.4 4.6l-1.3 1.3M5.9 14.1l-1.3 1.3"/></svg>',
  eye: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 10s2.9-4.5 7.5-4.5S17.5 10 17.5 10s-2.9 4.5-7.5 4.5S2.5 10 2.5 10z"/><circle cx="10" cy="10" r="1.9"/></svg>',
};

const WHALE_SVG =
  '<svg class="whale" viewBox="0 0 24 24" aria-hidden="true"><path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" /></svg>';

const state = {
  user: null,
  projects: [],
  workflows: [],
  activeProjectId: null,
  activeChatId: null,
  chat: null,
  attachments: [],
  streaming: false,
  /* Незавершённые задачи (ключ — id запуска на сервере) и открытые к ним
     потоки. Живут отдельно от текущего диалога: диалог можно закрыть, а
     задача продолжается и видна в списке. */
  liveRuns: new Map(),
  liveStreams: new Map(),
  filesOpen: true,
  filesDrawerOpen: false,
  filesPath: '.',
  filesLoading: false,
  dragOut: false,
  expanded: new Set(),
  collapsedWorkflows: new Set(),
  lastTitle: '',
};

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/* Имя файла в списке может не поместиться, но формат (.pdf, .docx, .xlsx, .pptx)
   обрезать нельзя: режем только основу имени, а расширение оставляем целым.
   Тогда длинное название превращается в «Отчёт по итогам… .pdf», а не в «Отчёт по и». */
function fileNameEl(name, cls) {
  const wrap = el('span', cls);
  const text = String(name ?? '');
  const dot = text.lastIndexOf('.');
  if (dot <= 0 || dot === text.length - 1) {
    wrap.textContent = text;
    return wrap;
  }
  wrap.appendChild(el('span', 'nm-base', text.slice(0, dot)));
  wrap.appendChild(el('span', 'nm-ext', text.slice(dot)));
  return wrap;
}

function fmtUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

/* Баланс в долларах в правом верхнем углу. У администратора лимита нет,
   поэтому счётчик ему не показываем; подсказки при наведении тоже нет. */
function renderBalance() {
  const chip = $('#balanceChip');
  if (!chip) return;
  const user = state.user;
  const visible = Boolean(user) && user.role !== 'admin';
  chip.classList.toggle('hidden', !visible);
  if (!visible) return;
  chip.textContent = fmtUsd(user.balanceUsd);
  chip.classList.toggle('balance-empty', Number(user.balanceUsd || 0) <= 0);
}

function updateBalance(value) {
  if (!state.user || state.user.role === 'admin') return;
  if (value === undefined || value === null) return;
  state.user.balanceUsd = Number(value);
  renderBalance();
}

function toast(message, type = 'error') {
  const root = $('#toastRoot');
  const node = el('div', `toast ${type}`, message);
  root.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s ease';
    setTimeout(() => node.remove(), 220);
  }, 5200);
}

/* ------------------------------ markdown ------------------------------ */

const copyStore = new Map();
let copySeq = 0;

function inlineMd(text) {
  const codes = [];
  let src = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const id = `\u0001${codes.length}\u0001`;
    codes.push(code);
    return id;
  });
  src = src
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  src = src.replace(/(^|[\s(])(https?:\/\/[^\s<)\]]+)/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  src = src.replace(/\u0001(\d+)\u0001/g, (_, idx) => `<code>${codes[Number(idx)]}</code>`);
  return src;
}

function renderMarkdown(raw) {
  const codeBlocks = [];
  let src = String(raw ?? '');
  src = src.replace(/```([\w+#.-]*)\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
    return `\u0000${codeBlocks.length - 1}\u0000`;
  });
  src = escapeHtml(src);

  const lines = src.split(/\r?\n/);
  const out = [];
  let paragraph = [];
  let listStack = [];
  let i = 0;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inlineMd(paragraph.join(' ').trim())}</p>`);
      paragraph = [];
    }
  };
  const closeLists = () => {
    while (listStack.length) out.push(`</${listStack.pop()}>`);
  };

  const splitRow = (line) =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => cell.trim());

  /* В узкой таблице «12 340 000 ₽» рвалось на три строки по пробелам.
     Склеиваем разряды и валюту неразрывным пробелом. */
  const tightNumbers = (text) =>
    text
      .replace(/(\d)[ \u00A0](?=\d{3}(?!\d))/g, '$1\u00A0')
      .replace(/(\d)[ \u00A0](?=[₽$€])/g, '$1\u00A0');

  while (i < lines.length) {
    const line = lines[i];
    const codeMatch = line.match(/^\u0000(\d+)\u0000$/);

    if (codeMatch) {
      flushParagraph();
      closeLists();
      const block = codeBlocks[Number(codeMatch[1])];
      const id = `code-${++copySeq}`;
      copyStore.set(id, block.code);
      const lang = block.lang ? `<span>${escapeHtml(block.lang)}</span>` : '<span>код</span>';
      out.push(
        `<pre><div class="code-head">${lang}<button type="button" data-copy-code="${id}">Копировать</button></div><code>${escapeHtml(block.code)}</code></pre>`,
      );
      i++;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeLists();
      i++;
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph();
      closeLists();
      out.push('<hr/>');
      i++;
      continue;
    }

    const heading = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMd(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    /* Текст уже прошёл escapeHtml, поэтому цитата начинается с &gt; —
       раньше ветка не срабатывала и в ответе печатался сам знак «>». */
    if (/^\s*(?:&gt;|>)\s?/.test(line)) {
      flushParagraph();
      closeLists();
      const quote = [];
      while (i < lines.length && /^\s*(?:&gt;|>)\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*(?:&gt;|>)\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inlineMd(quote.join(' '))}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushParagraph();
      closeLists();
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const head = header.map((cell) => `<th>${inlineMd(tightNumbers(cell))}</th>`).join('');
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inlineMd(tightNumbers(cell))}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      const indent = Math.floor(listMatch[1].replace(/\t/g, '  ').length / 2);
      const type = /\d+\./.test(listMatch[2]) ? 'ol' : 'ul';
      const level = Math.min(indent, 3);
      while (listStack.length > level + 1) out.push(`</${listStack.pop()}>`);
      if (listStack.length === level + 1 && listStack[listStack.length - 1] !== type) {
        out.push(`</${listStack.pop()}>`);
      }
      while (listStack.length < level + 1) {
        out.push(`<${type}>`);
        listStack.push(type);
      }
      out.push(`<li>${inlineMd(listMatch[3].trim())}</li>`);
      i++;
      continue;
    }

    closeLists();
    paragraph.push(line.trim());
    i++;
  }

  flushParagraph();
  closeLists();
  return out.join('');
}

/* ------------------------------ api ------------------------------ */

async function api(path, options = {}) {
  const { method = 'GET', body, raw, headers = {}, signal, anonymous = false } = options;
  const init = { method, credentials: 'same-origin', headers: { ...headers }, signal };
  /* Если страница открыта не во вкладке, а как приложение (ярлык на домашнем
     экране), сообщаем об этом серверу: у такого входа своя полка сеансов и он
     не выбивает обычную вкладку телефона. */
  if (openedAsApp()) init.headers['X-Dshow-Display'] = 'standalone';
  if (body !== undefined && !raw) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (raw) {
    init.body = body;
  }
  const response = await fetch(path, init);
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  /* 401 от /api/login и /api/signup — это «неверные данные», а не потеря
     сеанса: экран входа уже открыт, а пользователю нужно показать причину.
     Поэтому такие запросы помечены anonymous и проходят ниже, к обычному
     разбору ошибки. */
  if (response.status === 401 && !anonymous) {
    showAuth();
    /* Сеанс мог быть закрыт новым входом с другого устройства — объясняем это
       прямо на экране входа, чтобы выход не выглядел случайным сбоем. */
    const notice = data.reason === 'displaced' ? data.error || 'Вход выполнен на другом устройстве' : '';
    const box = $('#loginError');
    if (box) box.textContent = notice;
    const error = new Error(notice || 'unauthorized');
    error.unauthorized = true;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data.error || `Ошибка ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

/* ------------------------------ auth ------------------------------ */

function showAuth() {
  state.streaming = false;
  state.user = null;
  state.chat = null;
  $('#app').classList.add('hidden');
  $('#boot').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  setTimeout(() => $('#loginUser').focus(), 40);
}

function hideAuth() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  // Поле ввода измеряем уже после того, как контейнер стал видимым.
  syncInputPlaceholder();
  requestAnimationFrame(() => autoResize());
  setTimeout(autoResize, 80);
}

async function onLogin(event) {
  event.preventDefault();
  const button = $('#loginSubmit');
  const errorBox = $('#loginError');
  errorBox.textContent = '';
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  /* Пустые поля — не повод идти на сервер: подсказка появляется сразу, а
     счётчик неудачных попыток входа не тратится. */
  if (!username || !password) {
    errorBox.textContent = 'Введите логин и пароль';
    (username ? $('#loginPass') : $('#loginUser')).focus();
    return;
  }
  button.disabled = true;
  button.textContent = 'Вход…';
  try {
    const payload = await api('/api/login', {
      method: 'POST',
      anonymous: true,
      body: { username, password },
    });
    $('#loginPass').value = '';
    await startApp(payload);
  } catch (error) {
    errorBox.textContent = error.message || 'Не удалось войти';
    $('#loginPass').value = '';
    $('#loginPass').focus();
  } finally {
    button.disabled = false;
    button.textContent = 'Войти';
  }
}

async function onSignup(event) {
  event.preventDefault();
  const button = $('#signupSubmit');
  const errorBox = $('#signupError');
  errorBox.textContent = '';
  const username = $('#signupUser').value.trim();
  const password = $('#signupPass').value;
  if (!username) {
    errorBox.textContent = 'Придумайте логин';
    $('#signupUser').focus();
    return;
  }
  if (password.length < 8) {
    errorBox.textContent = 'Пароль должен быть не короче 8 символов';
    $('#signupPass').focus();
    return;
  }
  if (password !== $('#signupPass2').value) {
    errorBox.textContent = 'Пароли не совпадают';
    $('#signupPass2').focus();
    return;
  }
  button.disabled = true;
  button.textContent = 'Создаём…';
  try {
    const payload = await api('/api/signup', {
      method: 'POST',
      anonymous: true,
      body: { username, password },
    });
    $('#signupPass').value = '';
    $('#signupPass2').value = '';
    await startApp(payload);
  } catch (error) {
    errorBox.textContent = error.message || 'Не удалось создать аккаунт';
  } finally {
    button.disabled = false;
    button.textContent = 'Создать аккаунт';
  }
}

/* Открытая регистрация включается на сервере (DSHOW_OPEN_SIGNUP=1).
   Пока она выключена, ссылки «Создать» на экране входа нет вовсе. */
async function syncSignupAvailability() {
  const alt = $('#authAlt');
  if (!alt) return;
  try {
    const config = await api('/api/auth-config');
    alt.classList.toggle('hidden', !config.signupOpen);
  } catch {
    alt.classList.add('hidden');
  }
}

function switchAuthForm(mode) {
  const signup = mode === 'signup';
  $('#loginForm').classList.toggle('hidden', signup);
  $('#signupForm').classList.toggle('hidden', !signup);
  /* Заголовка в карточке входа нет: её верх занимает логотип. */
  $('#signupError').textContent = '';
  if (signup) setTimeout(() => $('#signupUser').focus(), 30);
  else setTimeout(() => $('#loginUser').focus(), 30);
}

/* ------------------------------ app init ------------------------------ */

async function startApp(payload) {
  /* Чистим всё, что могло остаться от предыдущего аккаунта в этой же вкладке. */
  resetClientState();
  state.user = payload.user;
  state.projects = payload.projects || [];
  state.workflows = payload.workflows || [];
  hideAuth();
  $('#boot').classList.add('hidden');
  $('#userName').textContent = state.user.displayName || state.user.username;
  renderBalance();
  if (!state.projects.length) {
    try {
      const created = await api('/api/projects', { method: 'POST', body: { name: 'Мой проект' } });
      state.projects.push({ ...created.project, chats: [] });
    } catch {
      /* ignore */
    }
  }
  const first = state.projects[0];
  state.expanded.clear();
  if (first) {
    state.expanded.add(first.id);
    state.activeProjectId = first.id;
  }
  /* Задачи, которые шли в момент перезагрузки страницы: подхватываем их сразу,
     чтобы работа выглядела непрерывной. */
  for (const run of payload.runs || []) trackRun(run.id, run.chatId);
  renderSidebar();
  /* Открываем диалог с живой задачей, иначе последний открытый, иначе первый
     в проекте — после перезагрузки человек возвращается туда, где работал. */
  const runningChat = (payload.runs || []).find((run) => findChatProject(run.chatId));
  const remembered = lastChatId();
  const target =
    runningChat?.chatId || (remembered && findChatProject(remembered) ? remembered : '') || first?.chats?.[0]?.id || '';
  if (target) await openChat(target);
  else renderThread();
  updateCrumbs();
  watchWideBlocks();
  if (state.activeProjectId) syncFilesPanel({ reload: true });
  /* Черновик возвращаем, если страница сама обновилась до новой версии. */
  restoreDraft();
  checkAppVersion();
  $('#input').focus();
}

function activeProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

function workflowOf(project) {
  if (!project.workflowId) return null;
  return state.workflows.find((workflow) => workflow.id === project.workflowId) || null;
}

function projectNode(project) {
  const chats = project.chats || [];
  const open = state.expanded.has(project.id);
  const collapsed = Boolean(chats.length) && !open;
  /* Знак того, что внутри проекта идёт работа: видно и при свёрнутом списке. */
  const hasLiveRun = chats.some((chat) => liveRunFor(chat.id));
  const wrap = el(
    'div',
    `project${project.id === state.activeProjectId ? ' active' : ''}${project.workflowId ? ' in-workflow' : ''}${collapsed ? ' collapsed' : ''}${hasLiveRun ? ' live' : ''}`,
  );
  const row = el('div', 'project-row');
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.title = chats.length ? (open ? 'Свернуть диалоги' : 'Раскрыть диалоги') : project.name;
  if (chats.length) row.setAttribute('aria-expanded', String(open));
  /* Треугольник слева — та же деталь, что у папок: по нему видно, раскрыт ли
     список диалогов. У проекта без диалогов место остаётся пустым, чтобы
     имена не прыгали. */
  /* Модификатор назван is-empty, а не empty: класс .empty — это пустое
     состояние чата (большой блок с отступами), и на треугольнике он ломал
     размеры строки проекта без диалогов. */
  row.innerHTML = `<span class="p-caret${chats.length ? '' : ' is-empty'}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 8l4 4 4-4"/></svg></span><span class="f-icon">${ICONS.folder}</span><span class="p-name">${escapeHtml(project.name)}</span>`;
  const count = el('span', 'p-count', project.chats?.length ? String(project.chats.length) : '');
  row.appendChild(count);

  const plus = el('button', 'row-plus');
  plus.type = 'button';
  plus.title = 'Новый диалог в проекте';
  plus.setAttribute('aria-label', 'Новый диалог в проекте');
  plus.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 5v10M5 10h10"/></svg>';
  plus.addEventListener('click', (event) => {
    event.stopPropagation();
    newChatFor(project);
  });
  row.appendChild(plus);

  const menuBtn = el('button', 'row-menu');
  menuBtn.type = 'button';
  menuBtn.title = 'Действия с проектом';
  menuBtn.innerHTML = ICONS.dots;
  menuBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openProjectMenu(event, project);
  });
  row.appendChild(menuBtn);
  /* Нажатие по имени проекта: первый раз открывает проект и показывает его
     диалоги, повторное — сворачивает и раскрывает список. На телефоне ящик
     остаётся открытым, пока есть из чего выбирать. */
  const activate = () => {
    const wasActive = project.id === state.activeProjectId;
    state.activeProjectId = project.id;
    if (!wasActive) {
      if (chats.length) state.expanded.add(project.id);
      /* Проект — это отдельная папка со своими файлами. При переключении
         закрываем диалог прошлого проекта и перечитываем «Файлы проекта»,
         иначе справа оставался список чужой папки. */
      state.chat = null;
      state.activeChatId = null;
      /* Здесь ответ не показываем, но задача в покинутом диалоге продолжается:
         в списке она отмечена точкой «идёт». */
      setStreaming(false);
      state.attachments = [];
      renderAttachStrip();
      state.filesPath = '.';
      if (state.filesOpen) loadFiles('.');
    } else if (chats.length) {
      if (state.expanded.has(project.id)) state.expanded.delete(project.id);
      else state.expanded.add(project.id);
    }
    renderSidebar();
    if (!wasActive) {
      renderThread();
      updateCrumbs();
    }
    if (!wasActive && !chats.length) closeSidebar();
  };
  row.addEventListener('click', activate);
  row.addEventListener('keydown', (event) => {
    if (event.target !== row) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate();
  });
  wrap.appendChild(row);

  if (open && chats.length) {
    const list = el('div', 'chat-list');
    for (const chat of chats) {
      /* Подсветка выбранного диалога — только у активного проекта: иначе после
         переключения проекта подсветка остаётся в чужом списке. */
      const chatActive = chat.id === state.activeChatId && project.id === state.activeProjectId;
      const chatRow = el('div', `chat-row${chatActive ? ' active' : ''}`);
      const title = el('span', 'c-title', chat.title || 'Новый диалог');
      title.title = chat.title || '';
      chatRow.appendChild(title);
      if (liveRunFor(chat.id)) {
        const live = el('span', 'c-live');
        live.title = 'В диалоге идёт задача';
        live.setAttribute('aria-label', 'Идёт задача');
        chatRow.appendChild(live);
      }
      const chatMenu = el('button', 'row-menu');
      chatMenu.type = 'button';
      chatMenu.title = 'Действия с диалогом';
      chatMenu.innerHTML = ICONS.dots;
      chatMenu.addEventListener('click', (event) => {
        event.stopPropagation();
        openChatMenu(event, chat);
      });
      chatRow.appendChild(chatMenu);
      chatRow.addEventListener('click', () => openChat(chat.id));
      /* Диалог — тоже кнопка: с клавиатуры он открывается Enter и пробелом. */
      chatRow.setAttribute('role', 'button');
      chatRow.tabIndex = 0;
      chatRow.addEventListener('keydown', (event) => {
        if (event.target !== chatRow) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openChat(chat.id);
      });
      list.appendChild(chatRow);
    }
    wrap.appendChild(list);
  }
  return wrap;
}

function workflowNode(workflow) {
  const collapsed = state.collapsedWorkflows.has(workflow.id);
  const node = el('div', `workflow${collapsed ? ' collapsed' : ''}`);
  const projects = state.projects.filter((project) => project.workflowId === workflow.id);
  const row = el('div', 'workflow-row');
  row.setAttribute('role', 'button');
  row.title = collapsed ? 'Развернуть папку' : 'Свернуть папку';
  row.innerHTML = `<span class="workflow-caret"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 8l4 4 4-4"/></svg></span><span class="w-icon">${ICONS.folder}</span><span class="w-name">${escapeHtml(workflow.name)}</span>`;
  row.appendChild(el('span', 'w-count', String(projects.length)));
  const menuBtn = el('button', 'row-menu');
  menuBtn.type = 'button';
  menuBtn.title = 'Действия с папкой';
  menuBtn.innerHTML = ICONS.dots;
  menuBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openWorkflowMenu(event, workflow);
  });
  row.appendChild(menuBtn);
  const toggleFolder = () => {
    if (state.collapsedWorkflows.has(workflow.id)) state.collapsedWorkflows.delete(workflow.id);
    else state.collapsedWorkflows.add(workflow.id);
    renderSidebar();
  };
  row.addEventListener('click', toggleFolder);
  /* Папка раскрывается и с клавиатуры — как строка проекта. */
  row.tabIndex = 0;
  row.addEventListener('keydown', (event) => {
    if (event.target !== row) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleFolder();
  });
  node.appendChild(row);

  const body = el('div', 'workflow-body');
  if (!projects.length) body.appendChild(el('div', 'workflow-empty', 'Папка пуста'));
  for (const project of projects) body.appendChild(projectNode(project));
  node.appendChild(body);
  return node;
}

function renderSidebar() {
  const root = $('#projectList');
  root.innerHTML = '';
  if (!state.projects.length && !state.workflows.length) {
    root.appendChild(el('div', 'files-empty', 'Пока нет проектов'));
  } else {
    for (const project of state.projects) {
      if (workflowOf(project)) continue;
      root.appendChild(projectNode(project));
    }
    for (const workflow of state.workflows) root.appendChild(workflowNode(workflow));
  }
  /* Запоминаем, что именно нарисовано: тихая синхронизация сравнивает подпись
     и не трогает панель без изменений. */
  sidebarSignature = sidebarKey(state.projects, state.workflows);
}

function updateCrumbs() {
  const project = activeProject();
  /* В шапке — проект и название диалога. Проект стоит первым и виден всегда:
     документы из ответа попадают в его папку, и человек должен видеть, куда
     именно, даже когда боковая панель на телефоне свёрнута. */
  const projectName = project?.name || '';
  const chatTitle = state.chat?.title || '';
  const chip = $('#crumbProject');
  chip.textContent = projectName;
  chip.title = projectName ? `Проект «${projectName}» — сюда попадут документы` : '';
  chip.classList.toggle('hidden', !projectName);
  const crumb = $('#crumbChat');
  crumb.textContent = chatTitle;
  crumb.title = chatTitle;
  crumb.classList.toggle('hidden', !chatTitle);
  /* Та же подпись над списком файлов: панель всегда показывает только файлы
     выбранного проекта, и её заголовок это подтверждает. */
  const filesName = $('#filesProjectName');
  filesName.textContent = projectName;
  filesName.title = projectName;
  filesName.classList.toggle('hidden', !projectName);
  document.title = chatTitle ? `${chatTitle} — DSH Open` : projectName ? `${projectName} — DSH Open` : 'DSH Open';
}

/* Какой диалог был открыт последним: после перезагрузки страницы человек
   возвращается туда же, а не в первый попавшийся диалог. */
function rememberChat(chatId) {
  try {
    if (chatId) localStorage.setItem('dshow.lastChat', chatId);
  } catch {
    /* приватный режим браузера — не критично */
  }
}

function lastChatId() {
  try {
    return localStorage.getItem('dshow.lastChat') || '';
  } catch {
    return '';
  }
}

function findChatProject(chatId) {
  return state.projects.find((project) => (project.chats || []).some((chat) => chat.id === chatId)) || null;
}

async function openChat(chatId) {
  /* Переключение во время ответа теперь разрешено: работа идёт на сервере, а
     вкладка просто показывает другой диалог и возвращается к потоку позже. */
  try {
    const data = await api(`/api/chats/${chatId}`);
    state.chat = data.chat;
    state.activeChatId = chatId;
    state.activeProjectId = state.chat.projectId;
    state.expanded.add(state.activeProjectId);
    state.attachments = [];
    renderAttachStrip();
    if (data.chat.run?.id) trackRun(data.chat.run.id, chatId);
    renderSidebar();
    renderThread();
    updateCrumbs();
    if (state.filesOpen) loadFiles('.');
    closeSidebar();
    rememberChat(chatId);
    /* В этом диалоге идёт задача — подключаемся и показываем накопленное. */
    const run = liveRunFor(chatId);
    if (run) {
      paintRun(run);
      if (!state.liveStreams.has(run.id)) watchRun(run.id, chatId);
    } else {
      setStreaming(false);
    }
    $('#input').focus();
  } catch (error) {
    if (!error.unauthorized) toast(error.message);
  }
}

async function ensureChat() {
  if (state.chat) return state.chat;
  if (!state.activeProjectId) {
    const created = await api('/api/projects', { method: 'POST', body: { name: 'Мой проект' } });
    state.projects.push({ ...created.project, chats: [] });
    state.activeProjectId = created.project.id;
  }
  const project = activeProject();
  const created = await api(`/api/projects/${state.activeProjectId}/chats`, { method: 'POST', body: {} });
  const chat = { id: created.chat.id, projectId: state.activeProjectId, title: 'Новый диалог', messages: [] };
  if (project) {
    project.chats = project.chats || [];
    project.chats.unshift(created.chat);
  }
  state.chat = chat;
  state.activeChatId = chat.id;
  state.expanded.add(state.activeProjectId);
  renderSidebar();
  updateCrumbs();
  return state.chat;
}

/* ------------------------------ thread ------------------------------ */

function nearBottom() {
  const scroll = $('#scroll');
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160;
}

function scrollToBottom(force = false) {
  const scroll = $('#scroll');
  if (force || nearBottom()) {
    requestAnimationFrame(() => {
      scroll.scrollTop = scroll.scrollHeight;
    });
  }
}

function renderEmpty() {
  const thread = $('#thread');
  thread.innerHTML = '';
  const empty = el('div', 'empty');
  empty.innerHTML = `
    <div class="empty-mark">${WHALE_SVG}</div>
    <h2 class="empty-title">Чем помочь?</h2>
    <p class="empty-sub">Поставьте задачу — файлы, расчёты и поиск подключу сам.</p>
    <div class="suggestions">
      <button class="suggestion" data-prompt="Проанализируй таблицу из файлов проекта и сделай краткий вывод с ключевыми числами.">Разобрать таблицу и найти главное</button>
      <button class="suggestion" data-prompt="Распознай текст на изображениях проекта и собери из него структурированный документ.">Распознать текст со скриншотов</button>
      <button class="suggestion" data-prompt="Подготовь отчёт в Word и Excel по данным проекта, с таблицами и выводами.">Сделать отчёт Word и Excel</button>
      <button class="suggestion" data-prompt="Найди актуальную информацию по теме в интернете, проверь по первоисточникам и оформи ссылки.">Найти и проверить информацию</button>
    </div>`;
  empty.addEventListener('click', (event) => {
    const button = event.target.closest('[data-prompt]');
    if (!button) return;
    const input = $('#input');
    input.value = button.dataset.prompt;
    autoResize();
    input.focus();
  });
  thread.appendChild(empty);
}

/* Служебную ленту действий («Чтение файла», «Поиск в интернете», «Загрузка
   страницы») в интерфейсе не показываем: человек видит только, что ассистент
   работает. Данные о вызовах остаются в задаче на сервере — для разбора и
   проверок, но в ленту сообщения они не попадают. */

function messageActions(text) {
  const actions = el('div', 'msg-actions');
  const copy = el('button');
  copy.type = 'button';
  copy.innerHTML = `${ICONS.copy}<span>Копировать</span>`;
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.querySelector('span').textContent = 'Скопировано';
      setTimeout(() => {
        copy.querySelector('span').textContent = 'Копировать';
      }, 1500);
    } catch {
      toast('Не удалось скопировать');
    }
  });
  actions.appendChild(copy);
  return actions;
}

function userAttachmentChips(attachments) {
  const wrap = el('div', 'attachments');
  for (const att of attachments || []) {
    const chip = el('span', 'file-chip');
    chip.innerHTML = `<span class="f-icon">${att.kind === 'image' ? ICONS.image : ICONS.file}</span>`;
    const name = fileNameEl(att.name, 'fc-name');
    name.title = att.name;
    chip.appendChild(name);
    if (att.size) chip.appendChild(el('span', 'fc-size', fmtSize(att.size)));
    wrap.appendChild(chip);
  }
  return wrap;
}

function renderMessage(message) {
  const wrap = el('article', `msg msg-${message.role}`);
  if (message.role === 'user') {
    if (message.attachments?.length) wrap.appendChild(userAttachmentChips(message.attachments));
    if (message.content) {
      const bubble = el('div', 'bubble');
      bubble.textContent = message.content;
      wrap.appendChild(bubble);
    }
    return wrap;
  }

  const head = el('div', 'msg-head');
  head.innerHTML = '<span class="dot"></span><span>AI-ассистент</span><span class="work-label">работаю…</span>';
  wrap.appendChild(head);

  if (message.streaming) wrap.classList.add('streaming');
  else wrap.classList.remove('streaming');

  if (message.error) {
    const error = el('div', 'msg-error');
    error.innerHTML = '<span>⚠</span>';
    error.appendChild(el('span', '', message.error));
    wrap.appendChild(error);
  }

  if (message.budget) {
    const note = el('div', 'msg-budget');
    note.innerHTML = '<span>⚠</span>';
    const label =
      message.budget.status === 'approved'
        ? 'Администратор подтвердил продолжение задачи.'
        : message.budget.status === 'rejected'
          ? 'Администратор отклонил продолжение задачи.'
          : 'Задача тяжелее обычного порога для одной задачи. Жду подтверждения администратора.';
    note.appendChild(el('span', '', label));
    wrap.appendChild(note);
  }

  if (message.content) {
    const md = el('div', 'md');
    md.innerHTML = renderMarkdown(message.content);
    wrap.appendChild(md);
  }

  if (message.content) wrap.appendChild(messageActions(message.content));
  return wrap;
}

function renderThread() {
  const thread = $('#thread');
  if (!state.chat || !state.chat.messages.length) {
    renderEmpty();
    return;
  }
  thread.innerHTML = '';
  for (const message of state.chat.messages) {
    thread.appendChild(renderMessage(message));
  }
  scrollToBottom(true);
  requestAnimationFrame(markWideBlocks);
}

/* На телефоне полосы прокрутки не видно, и широкая таблица выглядит как
   обрезанная. Тень у правого края подсказывает, что её можно листать вбок. */
let wideObserver = null;
function markWideBlocks() {
  for (const wrap of document.querySelectorAll('#thread .md .table-wrap')) {
    wrap.classList.toggle('scroll-x', wrap.scrollWidth - wrap.clientWidth > 2);
  }
}
function watchWideBlocks() {
  if (wideObserver) return;
  let queued = false;
  wideObserver = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      markWideBlocks();
    });
  });
  wideObserver.observe($('#thread'), { childList: true, subtree: true, characterData: true });
}

/* ------------------------------ живые задачи ------------------------------
   Ответ выполняет сервер, а не вкладка. Поэтому страницу можно перезагрузить,
   уйти в другой проект или свернуть телефон: задача продолжается, вкладка
   отключается от потока, а при возвращении забирает всё пропущенное. */

/* Сколько поток может молчать, прежде чем считать его мёртвым. Сервис присылает
   пустой комментарий раз в 15 секунд, так что молчание дольше — обрыв. */
const RUN_IDLE_MS = 25000;

function liveRunFor(chatId) {
  for (const run of state.liveRuns.values()) if (run.chatId === chatId) return run;
  return null;
}

function currentLiveRun() {
  return state.chat ? liveRunFor(state.chat.id) : null;
}

/* Пузырь ответа, который сейчас наполняется. Если человек смотрит на этот
   диалог — берём (или создаём) сообщение в нём, иначе обновляем только данные
   запуска: при возвращении в диалог всё нарисуется из них. */
function streamingMessageOf(run) {
  if (!run || !state.chat || state.chat.id !== run.chatId) return null;
  const messages = state.chat.messages;
  let message = messages.find((item) => item.runId === run.id);
  if (!message) message = messages.find((item) => item.streaming && !item.runId);
  if (!message) {
    message = { role: 'assistant', content: '', streaming: true, at: new Date().toISOString() };
    messages.push(message);
  }
  message.runId = run.id;
  return message;
}

function trackRun(runId, chatId) {
  let run = state.liveRuns.get(runId);
  if (!run) {
    run = {
      id: runId,
      chatId: chatId || state.chat?.id,
      projectId: state.chat?.projectId,
      content: '',
      budget: null,
      error: '',
      status: 'running',
    };
    state.liveRuns.set(runId, run);
    /* Точка «идёт задача» в списке диалогов должна появляться сразу, а не после
       первого события задачи: иначе, уйдя в другой проект в первую секунду,
       человек не увидит, что работа продолжается. */
    renderSidebar();
  }
  return run;
}

function applyRunTitle(run, title) {
  if (!title) return;
  const project = state.projects.find((item) => item.id === run.projectId);
  const meta = project?.chats?.find((chat) => chat.id === run.chatId);
  if (meta) meta.title = title;
  if (state.chat && state.chat.id === run.chatId) state.chat.title = title;
  renderSidebar();
  updateCrumbs();
}

function paintRun(run) {
  const message = streamingMessageOf(run);
  if (message) {
    message.content = run.content;
    if (run.budget) message.budget = run.budget;
    if (run.error && !run.content) message.error = run.error;
    else if (run.content) delete message.error;
    message.streaming = run.status === 'running' && !run.error;
    scheduleStreamRender();
  }
  setStreaming(Boolean(currentLiveRun()));
}

function closeRunView(run, status) {
  state.liveRuns.delete(run.id);
  const streamState = state.liveStreams.get(run.id);
  if (streamState) {
    state.liveStreams.delete(run.id);
    try {
      streamState.controller.abort();
    } catch {
      /* ignore */
    }
  }
  const viewing = state.chat && state.chat.id === run.chatId;
  const message = viewing ? state.chat.messages.find((item) => item.runId === run.id) : null;
  if (message) {
    message.streaming = false;
    if (run.content) message.content = run.content;
    if (run.error && !run.content) message.error = run.error;
  }
  setStreaming(Boolean(currentLiveRun()));
  renderSidebar();
  if (viewing) {
    renderThread();
    /* Окончательный вид ответа берём с сервера: там уже сохранённые пометки
       инструментов, расход и заголовок диалога. */
    reloadChatInPlace(run.chatId);
  } else if (status === 'done') {
    toast('Задача в другом диалоге завершена');
  }
  if (state.filesOpen) loadFiles(state.filesPath);
}

async function reloadChatInPlace(chatId) {
  try {
    const data = await api(`/api/chats/${chatId}`);
    const project = state.projects.find((item) => item.id === data.chat.projectId);
    const meta = project?.chats?.find((chat) => chat.id === chatId);
    if (meta) {
      meta.title = data.chat.title;
      meta.messageCount = data.chat.messages.length;
      meta.running = false;
    }
    if (state.chat && state.chat.id === chatId) {
      state.chat = data.chat;
      renderThread();
      updateCrumbs();
    }
    renderSidebar();
  } catch {
    /* нет связи — остаётся то, что уже нарисовано */
  }
}

function applyRunEvent(run, event) {
  if (event.type === 'snapshot' && event.run) {
    run.content = event.run.text || '';
    if (event.run.status) run.status = event.run.status;
    if (event.run.title) applyRunTitle(run, event.run.title);
  } else if (event.type === 'delta') {
    run.content += event.text || '';
  } else if (event.type === 'tool' || event.type === 'progress') {
    /* Действия ассистента в ленту не попадают: человек видит только «работаю…». */
  } else if (event.type === 'title') {
    applyRunTitle(run, event.title);
  } else if (event.type === 'budget') {
    run.budget = { spentUsd: event.spentUsd, limitUsd: event.limitUsd, status: 'pending' };
  } else if (event.type === 'approval' && event.approval) {
    run.budget = {
      spentUsd: event.approval.spentUsd,
      limitUsd: event.approval.limitUsd,
      status: event.approval.status || 'pending',
    };
    toast('Запрос отправлен администратору: задача тяжелее обычного порога.', 'warn');
  } else if (event.type === 'done') {
    run.status = 'done';
    updateBalance(event.balanceUsd);
  } else if (event.type === 'error') {
    run.status = event.aborted ? 'stopped' : 'error';
    run.error = event.message || 'Ошибка';
    if (event.message && !event.aborted) toast(event.message);
  } else if (event.type === 'end') {
    closeRunView(run, event.status || run.status);
    return;
  }
  paintRun(run);
}

/* Разбор потока событий задачи. */
async function readRunStream(response, streamState) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    /* Любой байт из потока — признак живой связи: сервис присылает и пустые
       комментарии, пока задача думает. */
    streamState.lastEventAt = Date.now();
    buffer += decoder.decode(chunk.value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event.runId && event.runId !== streamState.run.id) continue;
        if (event.type === 'end') ended = true;
        applyRunEvent(streamState.run, event);
      }
    }
  }
  return ended;
}

/* Подключение к задаче на сервере. Снимок даёт всё, что уже готово, дальше идёт
   живой поток; если связь оборвалась, а задача жива — повторяем подключение. */
async function watchRun(runId, chatId) {
  const run = trackRun(runId, chatId);
  if (state.liveStreams.has(runId)) return;
  const streamState = { controller: new AbortController(), run, lastEventAt: Date.now() };
  state.liveStreams.set(runId, streamState);
  let attempt = 0;
  while (attempt < 10) {
    attempt += 1;
    try {
      const response = await fetch(`/api/runs/${runId}/stream`, {
        credentials: 'same-origin',
        signal: streamState.controller.signal,
      });
      if (response.status === 401) {
        showAuth();
        break;
      }
      if (response.status === 404) {
        /* Задачу уже убрали из памяти — показываем то, что сохранено. */
        state.liveStreams.delete(runId);
        closeRunView(run, 'done');
        return;
      }
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const ended = await readRunStream(response, streamState);
      if (ended || !state.liveRuns.has(runId)) break;
      await sleep(Math.min(4000, 500 * attempt));
    } catch (error) {
      if (error.name === 'AbortError') break;
      if (!state.liveRuns.has(runId)) break;
      await sleep(Math.min(4000, 500 * attempt));
    }
  }
  if (state.liveStreams.get(runId) === streamState) state.liveStreams.delete(runId);
  if (!state.liveRuns.has(runId)) return;
  /* Связь пропала, а «конца» не было. Спрашиваем сервис прямо: если задачи уже
     нет, показываем сохранённый ответ, иначе оставляем пометку «идёт». */
  try {
    const data = await api(`/api/runs/${runId}`);
    if (data.run && data.run.status !== 'running') {
      closeRunView(run, data.run.status);
      return;
    }
  } catch (error) {
    if (error.status === 404) {
      closeRunView(run, 'done');
      return;
    }
  }
  paintRun(run);
  toast('Связь с задачей прервалась — она продолжается на сервере. Откройте диалог заново.', 'warn');
}

/* Возвращение на страницу: телефон вышел из сна, вкладку открыли снова,
   пропала и вернулась сеть — догоняем все незавершённые задачи. Телефон мог
   «заморозить» соединение, поэтому давно молчащий поток пересоздаём: сервер
   отдаст свежий снимок, а старую подписку закроет сам. */
function resumeLiveRuns() {
  if (!state.user) return;
  for (const run of state.liveRuns.values()) {
    const stream = state.liveStreams.get(run.id);
    if (stream && Date.now() - (stream.lastEventAt || 0) < RUN_IDLE_MS) continue;
    if (stream) {
      state.liveStreams.delete(run.id);
      try {
        stream.controller.abort();
      } catch {
        /* уже закрыт */
      }
    }
    watchRun(run.id, run.chatId);
  }
}

function setStreaming(active) {
  state.streaming = active;
  $('#sendBtn').classList.toggle('hidden', active);
  $('#stopBtn').classList.toggle('hidden', !active);
  $('#input').disabled = false;
}

/* ------------------------------ синхронизация ------------------------------ */
/* Сервис работает на сервере: задачу могли поставить из ярлыка на телефоне, а
   смотреть — на ноутбуке. Поэтому список проектов и диалогов, открытый диалог и
   «Файлы проекта» подтягиваются сами. Возвращаться на вкладку и нажимать F5,
   чтобы увидеть готовые документы, больше не нужно. */
let syncInFlight = false;

function chatHasLiveRun(chatId) {
  for (const run of state.liveRuns.values()) if (run.chatId === chatId) return true;
  return false;
}

function filesSignature(items) {
  return (items || []).map((item) => `${item.path}|${item.size}|${item.modified}`).join('\n');
}

function chatSignature(chat) {
  const messages = chat?.messages || [];
  const last = messages[messages.length - 1] || {};
  return `${chat?.title || ''}|${messages.length}|${last.role || ''}|${(last.content || '').length}`;
}

/* Подпись левой панели: пока проекты, диалоги и выбранный проект не менялись,
   список не перерисовываем. Иначе каждые 20 секунд слетала бы прокрутка и
   закрывались открытые меню. */
let sidebarSignature = '';

function sidebarKey(projects, workflows) {
  const parts = [`a:${state.activeProjectId || ''}`];
  for (const project of projects || []) {
    parts.push(`p:${project.id}:${project.name}:${project.chats?.length || 0}`);
    for (const chat of project.chats || []) parts.push(`c:${chat.id}:${chat.title}:${chat.messageCount || 0}`);
  }
  for (const workflow of workflows || []) parts.push(`w:${workflow.id}:${workflow.name}`);
  return parts.join('\n');
}

function renderSidebarQuietly() {
  if (sidebarKey(state.projects, state.workflows) === sidebarSignature) return;
  /* В панели открыто меню или карточка: их нельзя выбивать из-под руки.
     Перерисуем на следующем тике, когда всё закроется. */
  if (menuAnchor) return;
  const list = $('#projectList');
  const top = list ? list.scrollTop : 0;
  renderSidebar();
  if (list) list.scrollTop = top;
}

/* Список файлов обновляем без «мигания»: пока содержимое папки не изменилось,
   ничего не перерисовываем — иначе прокрутка списка сбрасывалась бы каждые
   несколько секунд. */
async function refreshFilesQuietly() {
  const projectId = state.activeProjectId;
  if (!projectId || !state.filesOpen) return;
  let data;
  try {
    data = await api(`/api/projects/${projectId}/files?path=${encodeURIComponent(state.filesPath)}&depth=6`);
  } catch {
    return; /* нет связи — остаётся то, что уже нарисовано */
  }
  if (projectId !== state.activeProjectId) return;
  const items = data.items || [];
  if (filesSignature(items) === filesSignature(state.files)) return;
  state.files = items;
  renderFiles();
}

/* Открытый диалог мог получить новый ответ с другого устройства — сверяем
   подпись и перерисовываем только при настоящих изменениях. */
async function refreshOpenChatQuietly() {
  const chatId = state.activeChatId;
  if (!chatId || !state.chat || chatHasLiveRun(chatId)) return;
  let data;
  try {
    data = await api(`/api/chats/${chatId}`);
  } catch {
    return;
  }
  if (chatId !== state.activeChatId) return;
  if (chatSignature(data.chat) === chatSignature(state.chat)) return;
  const stick = nearBottom();
  state.chat = data.chat;
  renderThread();
  updateCrumbs();
  if (stick) scrollToBottom(true);
}

async function syncFromServer() {
  if (!state.user || document.hidden || syncInFlight) return;
  syncInFlight = true;
  try {
    const payload = await api('/api/me');
    if (!state.user || !payload?.projects) return;
    state.projects = payload.projects;
    state.workflows = payload.workflows || [];
    /* Проект удалили с другого устройства — переключаемся на первый живой,
       чтобы панель файлов не показывала папку, которой больше нет. */
    if (!state.projects.some((project) => project.id === state.activeProjectId)) {
      const first = state.projects[0] || null;
      state.activeProjectId = first?.id || null;
      state.activeChatId = null;
      state.chat = null;
      state.filesPath = '.';
      state.files = [];
      if (first) state.expanded.add(first.id);
      renderThread();
    } else if (state.activeProjectId) {
      state.expanded.add(state.activeProjectId);
    }
    /* Диалог удалён с другого устройства — вкладка не должна показывать призрак. */
    if (
      state.activeChatId &&
      !state.projects.some((project) => (project.chats || []).some((chat) => chat.id === state.activeChatId))
    ) {
      state.activeChatId = null;
      state.chat = null;
      renderThread();
    }
    renderSidebarQuietly();
    updateCrumbs();
    await refreshOpenChatQuietly();
    await refreshFilesQuietly();
  } catch {
    /* нет сети — повторим на следующем тике */
  } finally {
    syncInFlight = false;
  }
}

/* Версия страниц: когда на сервере выложили новую сборку, вкладка обновляется
   сама, без F5 — но только когда человек ничего не печатает и ответ не идёт. */
let appVersion = '';

function saveDraft() {
  try {
    sessionStorage.setItem('dshow.draft', $('#input').value || '');
  } catch {
    /* приватный режим — не критично */
  }
}

function restoreDraft() {
  try {
    const draft = sessionStorage.getItem('dshow.draft');
    if (!draft) return;
    sessionStorage.removeItem('dshow.draft');
    const input = $('#input');
    if (!input.value) {
      input.value = draft;
      input.dispatchEvent(new Event('input'));
    }
  } catch {
    /* не критично */
  }
}

function reloadForUpdate() {
  const input = $('#input');
  const busy = state.streaming || (input === document.activeElement && input.value.trim().length > 0);
  if (busy) {
    setTimeout(reloadForUpdate, 20000);
    return;
  }
  saveDraft();
  location.reload();
}

async function checkAppVersion() {
  if (!state.user) return;
  let data;
  try {
    data = await api('/api/version');
  } catch {
    return;
  }
  const version = data?.version || '';
  if (!version) return;
  if (!appVersion) {
    appVersion = version;
    return;
  }
  if (version === appVersion) return;
  appVersion = version;
  reloadForUpdate();
}

function getStreamingMessage() {
  const messages = state.chat?.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].streaming) return messages[i];
  }
  return null;
}

let renderQueued = false;
function scheduleStreamRender() {
  if (renderQueued) return;
  renderQueued = true;
  const message = getStreamingMessage();
  requestAnimationFrame(() => {
    renderQueued = false;
    const thread = $('#thread');
    const nodes = thread.querySelectorAll('.msg-assistant');
    const target = message && nodes[nodes.length - 1];
    if (!message || !target) {
      renderThread();
      return;
    }
    target.classList.toggle('streaming', Boolean(message.streaming));
    const md = target.querySelector('.md');
    if (md) md.innerHTML = renderMarkdown(message.content || '') + '<span class="cursor"></span>';
    else {
      const block = el('div', 'md');
      block.innerHTML = renderMarkdown(message.content || '') + '<span class="cursor"></span>';
      target.appendChild(block);
    }
    if (message.tools?.length) {
      const existing = target.querySelector('.tools');
      if (existing) existing.remove();
    }
    scrollToBottom();
  });
}

async function streamMessage(text, attachmentIds) {
  const chatId = state.chat.id;
  const response = await fetch(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(openedAsApp() ? { 'X-Dshow-Display': 'standalone' } : {}),
    },
    body: JSON.stringify({ text, attachmentIds }),
  });
  if (response.status === 429) {
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (data.run?.id) {
      /* В диалоге уже идёт ответ — например, начатый с другого устройства или
         переживший перезагрузку страницы. Подключаемся к нему. */
      toast('Подключился к уже идущей задаче');
      await watchRun(data.run.id, data.run.chatId || chatId);
      return;
    }
  }
  if (!response.ok) {
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    throw new Error(data.error || 'Не удалось отправить сообщение');
  }
  const runId = response.headers.get('X-DShow-Run');
  if (!runId || !response.body) throw new Error('Сервер не начал задачу');
  const run = trackRun(runId, chatId);
  const streamState = { controller: new AbortController(), run };
  state.liveStreams.set(runId, streamState);
  /* Работа уже идёт на сервере: даже если это соединение оборвётся (страницу
     обновили, ушли в другой проект), ответ сохранится, а вкладка догонит его. */
  const ended = await readRunStream(response, streamState);
  if (state.liveStreams.get(runId) === streamState) state.liveStreams.delete(runId);
  if (!ended && state.liveRuns.has(runId)) await watchRun(runId, chatId);
}

async function sendMessage(event) {
  if (event) event.preventDefault();
  /* Занят именно этот диалог: в другом проекте задача может идти спокойно. */
  if (currentLiveRun()) return;
  const input = $('#input');
  const text = input.value.trim();
  const ready = state.attachments.filter((att) => att.id && att.status !== 'error');
  const uploading = state.attachments.filter((att) => att.status === 'uploading' || att.status === 'processing');
  if (!text && !ready.length) return;

  try {
    await ensureChat();
  } catch (error) {
    toast(error.message);
    return;
  }

  if (uploading.length) {
    for (const att of uploading) {
      if (att.promise) {
        try {
          await att.promise;
        } catch {
          /* ignore */
        }
      }
    }
  }
  const attachments = state.attachments.filter((att) => att.id && att.status !== 'error' && att.status !== 'uploading');
  const ids = attachments.map((att) => att.id);
  const attachedMeta = attachments.map((att) => ({
    id: att.id,
    name: att.name,
    kind: att.kind,
    label: att.label,
    size: att.size,
  }));

  input.value = '';
  autoResize();
  state.attachments = [];
  renderAttachStrip();

  const userMessage = { role: 'user', content: text, attachments: attachedMeta, at: new Date().toISOString() };
  state.chat.messages.push(userMessage);
  const assistant = { role: 'assistant', content: '', tools: [], streaming: true, at: new Date().toISOString() };
  state.chat.messages.push(assistant);
  renderThread();
  setStreaming(true);
  scrollToBottom(true);

  try {
    await streamMessage(text, ids);
  } catch (error) {
    if (error.name !== 'AbortError' && !error.unauthorized) toast(error.message || 'Ошибка отправки');
    const message = getStreamingMessage();
    if (message) {
      message.streaming = false;
      if (!message.content) message.error = error.message;
    }
    setStreaming(Boolean(currentLiveRun()));
    renderThread();
  }
}

async function stopGeneration() {
  const run = currentLiveRun();
  if (!run) return;
  /* Останавливает сервер: закрытие вкладки больше не считается отказом от
     задачи, поэтому «Стоп» — единственный способ её прервать. */
  try {
    await api(`/api/runs/${run.id}/stop`, { method: 'POST' });
  } catch (error) {
    if (!error.unauthorized) toast(error.message || 'Не удалось остановить');
    return;
  }
  if (!state.liveStreams.has(run.id)) await watchRun(run.id, run.chatId);
}

/* ------------------------------ attachments ------------------------------ */

function renderAttachStrip() {
  const strip = $('#attachStrip');
  strip.innerHTML = '';
  if (!state.attachments.length) {
    strip.classList.add('hidden');
    return;
  }
  strip.classList.remove('hidden');
  for (const att of state.attachments) {
    const chip = el('span', 'file-chip');
    chip.innerHTML = `<span class="f-icon">${att.kind === 'image' ? ICONS.image : ICONS.file}</span>`;
    const name = fileNameEl(att.name, 'fc-name');
    name.title = att.name;
    chip.appendChild(name);
    chip.appendChild(el('span', 'fc-size', fmtSize(att.size)));
    if (att.status === 'uploading' || att.status === 'processing') {
      const status = el('span', 'fc-status');
      status.innerHTML = '<span class="spinner"></span>';
      chip.appendChild(status);
    } else if (att.status === 'error') {
      const status = el('span', 'fc-status', 'ошибка');
      status.style.color = 'var(--danger)';
      chip.appendChild(status);
    } else {
      chip.appendChild(el('span', 'fc-status ready', '✓'));
    }
    const remove = el('button');
    remove.type = 'button';
    remove.title = 'Убрать';
    remove.innerHTML = '<svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg>';
    remove.addEventListener('click', () => {
      state.attachments = state.attachments.filter((item) => item !== att);
      renderAttachStrip();
      if (att.id) api(`/api/attachments/${att.id}`, { method: 'DELETE' }).catch(() => {});
    });
    chip.appendChild(remove);
    strip.appendChild(chip);
  }
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  try {
    await ensureChat();
  } catch (error) {
    toast(error.message);
    return;
  }
  for (const file of files) {
    if (state.attachments.length >= 10) {
      toast('Можно прикрепить не более 10 файлов');
      break;
    }
    if (file.size > 32 * 1024 * 1024) {
      toast(`Файл «${file.name}» больше 32 МБ`);
      continue;
    }
    const local = { id: null, name: file.name, size: file.size, kind: file.type?.startsWith('image/') ? 'image' : 'file', status: 'uploading', label: '' };
    state.attachments.push(local);
    renderAttachStrip();
    const task = (async () => {
      try {
        const response = await fetch('/api/attachments', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-Filename': encodeURIComponent(file.name),
            'X-Project-Id': state.activeProjectId,
            'X-Chat-Id': state.chat?.id || '',
          },
          body: file,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Не удалось загрузить файл');
        local.id = data.attachment.id;
        local.kind = data.attachment.kind;
        local.label = data.attachment.label;
        local.status = data.attachment.status;
        renderAttachStrip();
        pollAttachment(local);
      } catch (error) {
        local.status = 'error';
        local.error = error.message;
        renderAttachStrip();
        toast(error.message);
      }
    })();
    local.promise = task;
    await task;
  }
}

async function pollAttachment(local) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (!state.attachments.includes(local)) return;
    if (local.status !== 'processing') return;
    await sleep(1300);
    try {
      const data = await api(`/api/attachments/${local.id}`);
      local.status = data.attachment.status;
      local.label = data.attachment.label;
      local.warnings = data.attachment.warnings;
      if (local.status === 'error') {
        local.status = 'error';
        toast('Файл не удалось обработать');
      }
      renderAttachStrip();
      if (local.status !== 'processing') return;
    } catch {
      return;
    }
  }
}

/* ------------------------------ files panel ------------------------------ */

function closeSidebar() {
  closeMenus();
  closePopover();
  $('#app').classList.remove('sidebar-open');
}

/* Панель «Файлы проекта» — постоянный правый блок: на широком экране её
   нельзя закрыть (ничего в разметке этого и не обещает). До 1100 px ширина
   экрана мала, поэтому панель превращается в выезжающий ящик, который
   открывается и закрывается кнопкой-папкой в шапке. */
const filesNarrow = () => window.matchMedia('(max-width: 1100px)').matches;

function syncFilesPanel({ reload = false } = {}) {
  const app = $('#app');
  const panel = $('#filesPanel');
  if (!app || !panel) return;
  const drawer = filesNarrow();
  const open = drawer ? Boolean(state.filesDrawerOpen) : true;
  panel.classList.toggle('hidden', !open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  app.classList.toggle('with-files', !drawer);
  app.classList.toggle('files-open', drawer && open);
  if (drawer && open) app.classList.remove('sidebar-open');
  state.filesOpen = open;
  applyLayout();
  if (open && reload && state.activeProjectId) {
    state.filesPath = '.';
    loadFiles('.');
  }
}

function toggleFilesDrawer() {
  if (!filesNarrow()) return;
  state.filesDrawerOpen = !state.filesDrawerOpen;
  syncFilesPanel({ reload: state.filesDrawerOpen });
}

function closeFilesDrawer() {
  if (!state.filesDrawerOpen) return;
  state.filesDrawerOpen = false;
  syncFilesPanel();
}

async function loadFiles(relPath) {
  if (!state.activeProjectId) return;
  /* Проект мог смениться, пока шёл запрос: ответ от прошлого проекта не должен
     перерисовать список уже выбранного. */
  const projectId = state.activeProjectId;
  const list = $('#filesList');
  list.innerHTML = '<div class="files-empty"><div class="spin-lg"></div></div>';
  state.filesLoading = true;
  try {
    const data = await api(`/api/projects/${projectId}/files?path=${encodeURIComponent(relPath)}&depth=6`);
    if (projectId !== state.activeProjectId) return;
    state.filesPath = relPath;
    state.files = data.items || [];
    renderFiles();
  } catch (error) {
    if (projectId !== state.activeProjectId) return;
    list.innerHTML = '';
    list.appendChild(el('div', 'files-empty', error.message));
  } finally {
    if (projectId === state.activeProjectId) state.filesLoading = false;
  }
}

function renderFiles() {
  const list = $('#filesList');
  const crumb = $('#filesCrumb');
  /* В корне проекта строка пути не нужна: заголовок панели уже говорит «Файлы
     проекта», а слово «проект» вверху панели только повторяло шапку. */
  const atRoot = state.filesPath === '.';
  crumb.textContent = atRoot ? '' : `/ ${state.filesPath}`;
  crumb.classList.toggle('hidden', atRoot);
  list.innerHTML = '';
  if (state.filesPath !== '.') {
    const up = el('div', 'file-row');
    up.innerHTML = `<span class="f-icon">${ICONS.folder}</span><span class="f-name">Наверх</span>`;
    const goUp = () => {
      const parent = state.filesPath.split('/').slice(0, -1).join('/') || '.';
      loadFiles(parent);
    };
    up.addEventListener('click', goUp);
    /* Строка ведёт себя как кнопка и с клавиатуры — так же, как строки файлов. */
    up.setAttribute('role', 'button');
    up.tabIndex = 0;
    up.setAttribute('aria-label', 'Наверх, в родительскую папку');
    up.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        goUp();
      }
    });
    list.appendChild(up);
  }
  if (!state.files.length) {
    list.appendChild(el('div', 'files-empty', 'Пока пусто. Загрузите файл кнопкой выше.'));
    return;
  }
  for (const item of state.files) {
    if (state.filesPath !== '.' && !item.path.startsWith(state.filesPath.replace(/\/?$/, '/'))) continue;
    const row = el('div', 'file-row');
    const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(item.name);
    row.innerHTML = `<span class="f-icon">${item.dir ? ICONS.folder : isImage ? ICONS.image : ICONS.file}</span>`;
    const name = fileNameEl(item.name, 'f-name');
    const officeApp = item.dir ? null : officeOpener(item.name);
    /* Подсказка про управление: на телефоне — тап, на компьютере — двойной щелчок. */
    const touch = window.matchMedia('(pointer: coarse)').matches;
    name.title = item.dir
      ? item.path
      : touch
        ? `${item.path} — нажмите, чтобы открыть в приложении; кнопка «Скачать» — сохранить файл`
        : `${item.path} — двойной щелчок: открыть${officeApp ? ` в ${officeApp.label}` : ''}; кнопка «Скачать» — сохранить файл`;
    row.appendChild(name);
    if (!item.dir) row.appendChild(el('span', 'f-size', fmtSize(item.size)));
    const actions = el('div', 'f-actions');
    if (!item.dir) {
      /* Файл можно утащить мышью из панели на рабочий стол (или в любую папку):
         Chrome скачивает по DownloadURL, остальные браузеры берут ссылку из uri-list. */
      row.draggable = true;
      row.addEventListener('dragstart', (event) => {
        state.dragOut = true;
        const url = new URL(fileUrl(item.path, true), location.origin).href;
        const fileName = item.name.replace(/:/g, '_');
        try {
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData('DownloadURL', `${mimeOf(fileName)}:${fileName}:${url}`);
          event.dataTransfer.setData('text/uri-list', url);
          event.dataTransfer.setData('text/plain', fileName);
        } catch {
          /* старые браузеры без DataTransfer.setData */
        }
      });
      row.addEventListener('dragend', () => {
        state.dragOut = false;
      });
      const download = el('button', 'btn btn-ghost btn-icon');
      download.type = 'button';
      download.title = 'Скачать';
      download.setAttribute('aria-label', `Скачать «${item.name}»`);
      download.innerHTML = ICONS.download;
      download.addEventListener('click', (event) => {
        event.stopPropagation();
        openFileViewer(item);
      });
      actions.appendChild(download);
    }
    const del = el('button', 'btn btn-ghost btn-icon');
    del.type = 'button';
    del.title = 'Удалить';
    del.innerHTML = ICONS.trash;
    del.addEventListener('click', async (event) => {
      event.stopPropagation();
      /* Подтверждение — та же карточка в панели файлов, что и удаление проекта
         в панели проектов: один стиль у всех удалений. */
      const ok = await confirmPopover({
        anchor: del,
        title: 'Удалить файл?',
        text: `«${item.path}» будет удалён из проекта.`,
        confirmLabel: 'Удалить',
      });
      if (!ok) return;
      try {
        await api(`/api/projects/${state.activeProjectId}/file?path=${encodeURIComponent(item.path)}`, { method: 'DELETE' });
        loadFiles(state.filesPath);
      } catch (error) {
        toast(error.message);
      }
    });
    actions.appendChild(del);
    row.appendChild(actions);
    const activate = () => {
      if (item.dir) loadFiles(item.path);
      else openInOffice(item);
    };
    row.addEventListener('click', () => {
      if (item.dir) {
        loadFiles(item.path);
        return;
      }
      /* На телефоне кнопки строки появляются по тапу: одиночный тап открывает
         файл в своём окне (скачивание — только кнопкой «Скачать»).
         На компьютере двойной щелчок открывает документ в Word/Excel/PowerPoint. */
      if (window.matchMedia('(pointer: coarse)').matches) openFilePreview(item);
    });
    row.addEventListener('dblclick', (event) => {
      if (item.dir || window.matchMedia('(pointer: coarse)').matches) return;
      /* Двойной щелчок по кнопке «Скачать» — это два скачивания, а не открытие. */
      if (event.target.closest('.f-actions')) return;
      event.preventDefault();
      openInOffice(item);
    });
    /* Строка — это кнопка: с клавиатуры она тоже открывает папку или файл. */
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
    list.appendChild(row);
  }
}

function fileUrl(relPath, download = false) {
  const suffix = download ? '&download=1' : '';
  return `/api/projects/${state.activeProjectId}/file?path=${encodeURIComponent(relPath)}${suffix}`;
}

/* Тип файла нужен, чтобы система знала, чем открыть файл, вытащенный из панели. */
function mimeOf(fileName) {
  const ext = String(fileName).split('.').pop().toLowerCase();
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    html: 'text/html',
    htm: 'text/html',
    zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] || 'application/octet-stream';
}

/* Клик по кнопке «Скачать» сохраняет оригинал: браузер отдаёт файл системе, и
   дальше его открывает программа по умолчанию — на компьютере или телефоне.
   Двойной щелчок по строке открывает документ сразу в Office по протоколу
   ms-word/ms-excel/ms-powerpoint; для этого ему нужна короткая подписанная
   ссылка, потому что у Word и Excel нет cookie браузера. */
function openFileViewer(item) {
  /* Двойной щелчок и случайный повторный тап не должны скачивать файл дважды. */
  const key = `${state.activeProjectId}:${item.path}`;
  const now = Date.now();
  if (key === openFileViewer.lastKey && now - openFileViewer.lastAt < 600) return;
  openFileViewer.lastKey = key;
  openFileViewer.lastAt = now;
  const link = document.createElement('a');
  link.href = fileUrl(item.path, true);
  link.download = item.name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  toast(`«${item.name}» скачивается — откройте файл в программе по умолчанию.`, 'ok');
}

const OFFICE_OPENERS = [
  {
    test: /^(doc|docx|docm|dot|dotx|rtf|odt)$/i,
    protocol: 'ms-word',
    label: 'Word',
  },
  {
    test: /^(xls|xlsx|xlsm|xlsb|csv|ods)$/i,
    protocol: 'ms-excel',
    label: 'Excel',
  },
  {
    test: /^(ppt|pptx|pptm|pps|ppsx|odp)$/i,
    protocol: 'ms-powerpoint',
    label: 'PowerPoint',
  },
];

function officeOpener(name) {
  const ext = String(name || '').split('.').pop();
  return OFFICE_OPENERS.find((opener) => opener.test.test(ext)) || null;
}

function launchProtocol(href) {
  const link = document.createElement('a');
  link.href = href;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function openInOffice(item) {
  /* На телефоне документ открываем у себя: системная страница «Открыть в…»
     уводит из приложения, и вернуться из неё нечем — ни кнопки, ни жеста. */
  if (window.matchMedia('(pointer: coarse)').matches) {
    openFilePreview(item);
    return;
  }
  const opener = officeOpener(item.name);
  if (!opener) {
    /* Не Office: PDF и картинки показываем в новой вкладке браузера, остальное
       отдаём системе как обычное скачивание — один раз. */
    if (/\.(pdf|png|jpe?g|webp|gif|bmp|svg|txt|md|html?)$/i.test(item.name)) {
      window.open(fileUrl(item.path, false), '_blank', 'noopener');
      return;
    }
    openFileViewer(item);
    return;
  }
  try {
    const data = await api(`/api/projects/${state.activeProjectId}/file-link?path=${encodeURIComponent(item.path)}`);
    launchProtocol(`${opener.protocol}:ofe|u|${encodeURI(data.url)}`);
    toast(`«${item.name}» открывается в ${opener.label}. Если окно не появилось, скачайте файл кнопкой «Скачать».`, 'ok');
  } catch (error) {
    toast(`${error.message}. Файл можно скачать кнопкой «Скачать».`);
  }
}

/* -------------------- просмотр файла внутри приложения -------------------- */

/* Раньше тап по файлу на телефоне сразу скачивал его: iOS открывал чужую
   программу (или страницу «Открыть в WeChat»), из которой не было выхода.
   Теперь файл открывается в своём окне с кнопкой «Закрыть»: PDF, картинки и
   текст показываем здесь же, а для Word/Excel/PowerPoint подсказываем
   бесплатные приложения и оставляем явную кнопку «Скачать». */

const PREVIEW_IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;
const PREVIEW_TEXT = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml|ini|conf|srt)$/i;

/* pdf.js лежит рядом с приложением (/vendor/pdfjs) и грузится только при
   первом открытии PDF — остальные экраны он не задерживает. */
let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/vendor/pdfjs/pdf.min.mjs')
      .then((mod) => {
        const lib = mod.default || mod;
        lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
        return lib;
      })
      .catch((error) => {
        pdfjsPromise = null;
        throw error;
      });
  }
  return pdfjsPromise;
}

/* Бесплатные программы, которые читают Word, Excel и презентации на телефоне.
   Список показываем вместо перехода в чужое приложение по системной ссылке. */
const PREVIEW_APPS = [
  ['Word, Excel, PowerPoint', 'приложения Microsoft, бесплатны для чтения и правки этих форматов.'],
  ['Google Документы, Таблицы, Презентации', 'приложения Google, открывают те же файлы Office.'],
  ['WPS Office', 'один бесплатный редактор на все три формата и PDF.'],
  ['LibreOffice Viewer', 'бесплатный просмотрщик для Android.'],
];

/* Подсказка для форматов, которые телефон сам не рисует: что поставить, чтобы
   открыть файл, — вместо ссылки «открыть в чужом мессенджере». */
function officeHintBody() {
  const wrap = el('div', 'file-hint');
  wrap.appendChild(
    el('p', '', 'Телефон не открывает файлы Word, Excel и PowerPoint сам. Бесплатные приложения, которые их читают:'),
  );
  const apps = el('ul', 'file-hint-apps');
  for (const [name, note] of PREVIEW_APPS) {
    const item = el('li', '');
    item.appendChild(el('b', '', name));
    item.appendChild(document.createTextNode(' — ' + note));
    apps.appendChild(item);
  }
  wrap.appendChild(apps);
  wrap.appendChild(el('p', '', 'Кнопка «Скачать» сохранит файл в «Файлы», после чего его можно открыть в любом из них.'));
  return wrap;
}

async function mountPdfPreview(container, url) {
  const status = el('div', 'preview-status', 'Открываем PDF…');
  container.appendChild(status);
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('файл не отдался');
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await response.arrayBuffer());
    /* isEvalSupported: false — иначе часть PDF не отрисуется: политика
       безопасности сайта запрещает eval. */
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    status.remove();

    const canvas = el('canvas', 'pdf-canvas');
    const holder = el('div', 'pdf-holder');
    holder.appendChild(canvas);
    const pager = el('div', 'pdf-pager');
    const prev = el('button', 'btn btn-quiet', '‹');
    const next = el('button', 'btn btn-quiet', '›');
    const label = el('span', 'pdf-page', '');
    prev.type = 'button';
    next.type = 'button';
    pager.append(prev, label, next);
    container.append(holder, pager);

    let pageNo = 1;
    const draw = async () => {
      const page = await doc.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const width = Math.max(240, holder.clientWidth || 320);
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }).promise;
      label.textContent = `${pageNo} / ${doc.numPages}`;
      prev.disabled = pageNo <= 1;
      next.disabled = pageNo >= doc.numPages;
    };
    const go = (delta) => {
      const target = pageNo + delta;
      if (target < 1 || target > doc.numPages) return;
      pageNo = target;
      draw().catch(() => {});
    };
    prev.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    /* Свайп влево-вправо листает страницы: на телефоне это привычнее кнопок. */
    let touchX = 0;
    holder.addEventListener('touchstart', (event) => {
      touchX = event.touches[0]?.clientX || 0;
    }, { passive: true });
    holder.addEventListener('touchend', (event) => {
      const dx = (event.changedTouches[0]?.clientX || 0) - touchX;
      if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    });
    if (doc.numPages === 1) pager.classList.add('hidden');
    /* Телефон повернули — страница должна занять новую ширину. Слушатель снимает
       себя сам, когда окно просмотра закрыли. */
    const onResize = () => {
      if (!document.body.contains(holder)) {
        window.removeEventListener('resize', onResize);
        return;
      }
      draw().catch(() => {});
    };
    window.addEventListener('resize', onResize);
    await draw();
  } catch (error) {
    status.textContent = 'Не удалось показать PDF. Скачайте файл — он откроется в приложении для PDF.';
    status.classList.add('preview-status-error');
  }
}

async function mountTextPreview(container, url) {
  const status = el('div', 'preview-status', 'Открываем файл…');
  container.appendChild(status);
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('файл не отдался');
    const text = await response.text();
    status.remove();
    const pre = el('pre', 'preview-text', text.slice(0, 200000));
    container.appendChild(pre);
    if (text.length > 200000) container.appendChild(el('p', 'preview-more', 'Показаны первые 200 000 символов.'));
  } catch {
    status.textContent = 'Не удалось показать файл. Скачайте его кнопкой ниже.';
  }
}

/* Word, Excel, презентации и остальные «офисные» файлы телефон сам не рисует.
   Текст документа вытаскивает сервер — файл можно прочитать прямо здесь, а
   рядом подсказка, какими бесплатными приложениями его открыть целиком. */
async function mountDocPreview(container, item) {
  const status = el('div', 'preview-status', 'Читаем документ…');
  container.appendChild(status);
  try {
    const data = await api(`/api/projects/${state.activeProjectId}/file-preview?path=${encodeURIComponent(item.path)}`);
    status.remove();
    const text = String(data.text || '').trim();
    if (text) {
      container.appendChild(el('pre', 'preview-text', text.slice(0, 200000)));
      if (text.length > 200000) container.appendChild(el('p', 'preview-more', 'Показаны первые 200 000 символов.'));
    } else {
      container.appendChild(el('p', 'preview-more', 'Из этого файла текст не извлекается — скачайте его, чтобы открыть в приложении.'));
    }
    container.appendChild(officeHintBody());
  } catch (error) {
    status.remove();
    container.appendChild(el('p', 'preview-more', `${error.message}. Скачайте файл — он откроется в приложении.`));
    container.appendChild(officeHintBody());
  }
}

function openFilePreview(item) {
  /* Та же защита от двойного тапа, что и у скачивания. */
  const key = `${state.activeProjectId}:${item.path}`;
  const now = Date.now();
  if (key === openFilePreview.lastKey && now - openFilePreview.lastAt < 600) return;
  openFilePreview.lastKey = key;
  openFilePreview.lastAt = now;

  const url = fileUrl(item.path, false);
  const body = el('div', 'file-preview');

  if (PREVIEW_IMAGE.test(item.name)) {
    const img = el('img', 'preview-img');
    img.src = url;
    img.alt = item.name;
    body.appendChild(img);
  } else if (/\.pdf$/i.test(item.name)) {
    const holder = el('div', 'pdf-box');
    body.appendChild(holder);
    mountPdfPreview(holder, url);
  } else if (PREVIEW_TEXT.test(item.name)) {
    mountTextPreview(body, url);
  } else {
    mountDocPreview(body, item);
  }

  openModal({
    title: item.name,
    body,
    wide: true,
    className: 'file-preview-modal',
    actions: [
      {
        label: 'Скачать',
        onClick: () => {
          openFileViewer(item);
        },
      },
      { label: 'Закрыть', kind: 'primary' },
    ],
  });
}


/* Загрузка файлов в проект. dir — папка внутри проекта ('.' — корень):
   файл попадает туда, где пользователь сейчас находится в «Файлах проекта». */
async function uploadToProject(fileList, dir = state.filesPath) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!state.activeProjectId) {
    toast('Сначала выберите проект');
    return;
  }
  const folder = dir && dir !== '.' ? String(dir).replace(/\/+$/, '') : '';
  const button = $('#filesUploadBtn');
  const label = $('#filesUploadLabel');
  const previousLabel = label ? label.textContent : '';
  if (button) button.disabled = true;
  if (label) label.textContent = 'Загружаем…';
  let added = 0;
  try {
    for (const file of files) {
      try {
        const rel = folder ? `${folder}/${file.name}` : file.name;
        const response = await fetch(`/api/projects/${state.activeProjectId}/upload?path=${encodeURIComponent(rel)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
          body: file,
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Не удалось загрузить «${file.name}»`);
        }
        added += 1;
      } catch (error) {
        toast(error.message);
      }
    }
  } finally {
    if (button) button.disabled = false;
    if (label) label.textContent = previousLabel;
  }
  if (added) {
    toast(added === 1 ? 'Файл добавлен в проект' : `Добавлено файлов: ${added}`, 'ok');
    await loadFiles(state.filesPath);
  }
}

/* ------------------------------ modals ------------------------------ */

let menuAnchor = null;

function closeMenus() {
  menuAnchor = null;
  $$('.menu').forEach((menu) => menu.remove());
}

/* Панель, из которой вызвана карточка или меню: слева «Проекты», справа «Файлы
   проекта». Внутри панели окно живёт в ней самой (абсолютное позиционирование),
   встаёт по её границам с равными полями слева и справа и не вылезает за
   скруглённые края — одинаково на широком экране и в выезжающем ящике. */
function panelHostFor(anchor) {
  if (!anchor || !anchor.closest) return null;
  return anchor.closest('.sidebar, .files-panel');
}

/* Нижняя граница видимой области: при открытой клавиатуре это её верх, а не
   низ окна браузера. Карточка в панели должна целиком помещаться над ней. */
function viewportBottom() {
  const vv = window.visualViewport;
  return vv ? vv.height + (vv.offsetTop || 0) : window.innerHeight;
}

/* Вертикаль карточки внутри панели: под якорем, а если снизу нет места — над
   ним. Горизонталь задана стилями (.in-panel): равные поля слева и справа. */
function placeInPanel(node, anchor, host) {
  if (!anchor.isConnected) return;
  const hostRect = host.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  const pad = 10;
  const height = node.offsetHeight;
  /* Панель тянется до низа окна, но клавиатура перекрывает его часть —
     считаем доступной только видимую высоту. */
  const limit = Math.min(hostRect.height, viewportBottom() - hostRect.top);
  /* Если карточка выше видимой области, она прокручивается внутри себя —
     тогда поле и кнопки всё равно доступны над клавиатурой. */
  node.style.maxHeight = `${Math.max(160, limit - pad * 2)}px`;
  node.style.overflowY = 'auto';
  let top = rect.bottom - hostRect.top + 8;
  if (top + height > limit - pad) {
    const above = rect.top - hostRect.top - height - 8;
    top = above > pad ? above : limit - height - pad;
  }
  node.style.top = `${Math.max(pad, top)}px`;
}

/* Правая граница блока, в котором стоит кнопка: у шапки это её внутренний
   край с учётом поля. Меню учётной записи прижимается к нему, а не к самой
   кнопке — иначе карточка висела бы в середине полосы. */
function anchorBlockRight(anchor) {
  const block = anchor.closest?.('.topbar, .sidebar, .files-panel');
  if (!block) return null;
  const rect = block.getBoundingClientRect();
  const style = getComputedStyle(block);
  const padding = Number.parseFloat(style.paddingRight) || 0;
  return rect.right - padding;
}

function openContextMenu(anchor, items) {
  closeMenus();
  menuAnchor = anchor;
  const menu = el('div', 'menu');
  const rect = anchor.getBoundingClientRect();
  for (const item of items) {
    if (item.sep) {
      menu.appendChild(el('div', 'sep'));
      continue;
    }
    const button = el('button', item.danger ? 'danger' : '');
    button.type = 'button';
    button.innerHTML = `${item.icon || ''}<span>${escapeHtml(item.label)}</span>`;
    button.addEventListener('click', () => {
      closeMenus();
      item.action();
    });
    menu.appendChild(button);
  }
  const host = panelHostFor(anchor);
  if (host) {
    menu.classList.add('in-panel');
    host.appendChild(menu);
    placeInPanel(menu, anchor, host);
  } else {
    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();
    const rightEdge = anchorBlockRight(anchor) ?? rect.right;
    let left = rightEdge - menuRect.width;
    let top = rect.bottom + 6;
    if (top + menuRect.height > viewportBottom() - 8) top = rect.top - menuRect.height - 6;
    left = Math.max(8, Math.min(left, window.innerWidth - menuRect.width - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  }
  setTimeout(() => {
    const closer = (event) => {
      if (!menu.contains(event.target)) {
        closeMenus();
        document.removeEventListener('mousedown', closer);
      }
    };
    document.addEventListener('mousedown', closer);
  }, 0);
}

function openModal({ title, body, actions = [], wide = false, className = '', onMount }) {
  const root = $('#modalRoot');
  root.innerHTML = '';
  root.classList.remove('hidden');
  const modal = el('div', `modal${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`);
  const head = el('div', 'modal-head');
  head.appendChild(el('div', 'modal-title', title));
  const close = el('button', 'btn btn-ghost btn-icon');
  close.type = 'button';
  close.innerHTML = '<svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg>';
  close.addEventListener('click', () => closeModal());
  head.appendChild(close);
  modal.appendChild(head);
  const bodyNode = el('div', 'modal-body');
  if (typeof body === 'string') bodyNode.innerHTML = body;
  else if (body) bodyNode.appendChild(body);
  modal.appendChild(bodyNode);

  const foot = el('div', 'modal-foot');
  const apiActions = { close: closeModal };
  for (const action of actions) {
    const button = el('button', `btn ${action.kind === 'primary' ? 'btn-primary' : action.kind === 'danger' ? 'btn-danger' : 'btn-quiet'}`);
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', async () => {
      if (!action.onClick) {
        closeModal();
        return;
      }
      button.disabled = true;
      try {
        const result = await action.onClick(apiActions);
        if (result !== false) closeModal();
      } finally {
        button.disabled = false;
      }
    });
    foot.appendChild(button);
    apiActions[action.id || action.label] = () => button.click();
  }
  modal.appendChild(foot);
  root.appendChild(modal);

  root.onmousedown = (event) => {
    if (event.target === root) closeModal();
  };
  document.onkeydown = (event) => {
    if (event.key === 'Escape') {
      closeModal();
      document.onkeydown = null;
    }
  };
  if (onMount) onMount(bodyNode, modal, apiActions);
  return modal;
}

function closeModal() {
  const root = $('#modalRoot');
  root.classList.add('hidden');
  root.innerHTML = '';
  root.onmousedown = null;
  document.onkeydown = null;
}

/* ------------------------------ popover ------------------------------ */

let popoverNode = null;
let popoverAnchor = null;
let popoverHost = null;
let popoverCleanup = null;
let popoverOnClose = null;

function closePopover() {
  if (popoverCleanup) {
    popoverCleanup();
    popoverCleanup = null;
  }
  const onClose = popoverOnClose;
  popoverOnClose = null;
  if (popoverNode) popoverNode.remove();
  popoverNode = null;
  popoverAnchor = null;
  popoverHost = null;
  if (onClose) onClose();
}

function placePopover(node, anchor, { align = 'anchor' } = {}) {
  const rect = anchor.getBoundingClientRect();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  /* align: 'sidebar' — держим карточку у левого края панели проектов, как «Новый проект». */
  let left = align === 'sidebar' ? 10 : rect.left;
  let top = rect.bottom + 8;
  if (left + width > window.innerWidth - 10) left = window.innerWidth - width - 10;
  left = Math.max(10, left);
  if (top + height > viewportBottom() - 10) {
    const above = rect.top - height - 8;
    top = above > 10 ? above : Math.max(10, viewportBottom() - height - 10);
  }
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

function openPopover({ anchor, title = '', body, actions = [], onMount, onClose = null, align = 'anchor' }) {
  closePopover();
  const node = el('div', 'popover');
  node.setAttribute('role', 'dialog');
  if (title) {
    node.appendChild(el('div', 'popover-title', title));
    node.setAttribute('aria-label', title);
  }
  const bodyNode = el('div', 'popover-body');
  if (typeof body === 'string') bodyNode.innerHTML = body;
  else if (body) bodyNode.appendChild(body);
  node.appendChild(bodyNode);

  const api = { close: closePopover };
  if (actions.length) {
    const row = el('div', 'popover-actions');
    for (const action of actions) {
      const kind = action.kind === 'primary' ? 'btn-primary' : action.kind === 'danger' ? 'btn-danger' : 'btn-quiet';
      const button = el('button', `btn ${kind}`);
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', async () => {
        if (!action.onClick) {
          closePopover();
          return;
        }
        button.disabled = true;
        try {
          const result = await action.onClick(api);
          if (result !== false) closePopover();
        } finally {
          button.disabled = false;
        }
      });
      row.appendChild(button);
      api[action.id || action.label] = () => button.click();
    }
    node.appendChild(row);
  }

  const host = panelHostFor(anchor);
  if (host) {
    node.classList.add('in-panel');
    host.appendChild(node);
  } else {
    document.body.appendChild(node);
  }
  popoverNode = node;
  popoverAnchor = anchor;
  popoverHost = host;
  popoverOnClose = onClose;
  if (host) placeInPanel(node, anchor, host);
  else placePopover(node, anchor, { align });

  const onDocDown = (event) => {
    if (node.contains(event.target)) return;
    if (anchor.contains(event.target)) return;
    closePopover();
  };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (event.target instanceof HTMLElement) event.target.blur();
    closePopover();
  };
  const onViewportChange = () => {
    if (popoverNode && popoverHost) {
      placeInPanel(popoverNode, anchor, popoverHost);
      return;
    }
    closePopover();
  };
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);

  popoverCleanup = () => {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
  };

  if (onMount) onMount(bodyNode, node, api);
  return node;
}

function togglePopover(options) {
  if (popoverAnchor === options.anchor && popoverNode) {
    closePopover();
    return null;
  }
  return openPopover(options);
}

function promptDialog({ title, label, value = '', placeholder = '', confirm = 'Сохранить', password = false }) {
  return new Promise((resolve) => {
    const form = el('form', 'form-grid');
    const field = el('label', 'field');
    field.appendChild(el('span', 'field-label', label));
    const input = el('input');
    input.type = password ? 'password' : 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = password ? 'new-password' : 'off';
    field.appendChild(input);
    form.appendChild(field);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    openModal({
      title,
      body: form,
      actions: [
        { label: 'Отмена', kind: 'quiet', onClick: () => finish(null) },
        {
          label: confirm,
          kind: 'primary',
          onClick: () => {
            finish(input.value.trim());
          },
        },
      ],
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      finish(input.value.trim());
      closeModal();
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 40);
  });
}

function confirmDialog(title, text, confirmLabel = 'Подтвердить', danger = false) {
  return new Promise((resolve) => {
    let settled = false;
    const root = $('#modalRoot');
    const cleanup = () => {
      root.removeEventListener('mousedown', onBackdrop);
      document.removeEventListener('keydown', onKey);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onBackdrop = (event) => {
      if (event.target === root) finish(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') finish(false);
    };
    openModal({
      title,
      body: `<p>${escapeHtml(text)}</p>`,
      actions: [
        { label: 'Отмена', kind: 'quiet', onClick: () => finish(false) },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => finish(true) },
      ],
    });
    root.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

/* Ввод в виде карточки рядом с кнопкой, из которой его открыли, — тот же блок,
   что «Новый проект» и подтверждение удаления: заголовок, поле, «Отмена» и
   главная кнопка. Возвращает введённое значение или null, если отменили. */
function promptPopover({ anchor, title, label = '', value = '', placeholder = '', confirm = 'Сохранить', password = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const form = el('form', 'popover-form');
    if (label) form.appendChild(el('div', 'popover-label', label));
    const input = el('input', 'popover-input');
    input.type = password ? 'password' : 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = password ? 'new-password' : 'off';
    input.setAttribute('aria-label', label || title);
    form.appendChild(input);
    const submit = (api) => {
      finish(input.value.trim());
      if (api) api.close();
    };
    openPopover({
      anchor,
      title,
      body: form,
      actions: [
        { label: 'Отмена', kind: 'quiet', onClick: () => finish(null) },
        { label: confirm, kind: 'primary', onClick: () => submit() },
      ],
      onClose: () => finish(null),
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
      closePopover();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submit();
      closePopover();
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 40);
  });
}

/* Подтверждение в виде карточки в своей панели — тем же блоком, что и «Новый проект». */
function confirmPopover({ anchor, title, text, confirmLabel = 'Удалить' }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openPopover({
      anchor,
      title,
      body: el('p', 'popover-text', text),
      actions: [
        { label: 'Отмена', kind: 'quiet', onClick: () => finish(false) },
        { label: confirmLabel, kind: 'danger', onClick: () => finish(true) },
      ],
      onClose: () => finish(false),
    });
  });
}

/* ------------------------------ menus ------------------------------ */

function openUserMenu(event) {
  const isAdmin = state.user?.role === 'admin';
  const items = [
    {
      label: 'Сменить пароль',
      icon: ICONS.key,
      action: () => changePasswordModal(),
    },
    {
      label: 'Что сервис помнит',
      icon: ICONS.eye,
      action: () => memoryModal(),
    },
  ];
  if (isAdmin) {
    items.push(
      { sep: true },
      { label: 'Пользователи', icon: ICONS.users, action: () => adminModal() },
    );
  }
  items.push({ sep: true }, { label: 'Выйти', icon: ICONS.logout, danger: true, action: () => logout() });
  openContextMenu(event.currentTarget, items);
}

function openProjectMenu(event, project) {
  const anchor = event.currentTarget;
  const items = [
    { label: 'Переименовать', icon: ICONS.pen, action: () => renameProject(project, anchor) },
    { label: 'Новый диалог', icon: ICONS.file, action: () => newChatFor(project) },
  ];
  if (state.workflows.length) {
    items.push({ label: 'Переместить в папку', icon: ICONS.folder, action: () => moveProjectPopover(project, anchor) });
  }
  items.push({ sep: true }, { label: 'Удалить проект', icon: ICONS.trash, danger: true, action: () => deleteProject(project, anchor) });
  openContextMenu(anchor, items);
}

function openWorkflowMenu(event, workflow) {
  const anchor = event.currentTarget;
  openContextMenu(anchor, [
    { label: 'Новый проект в папке', icon: ICONS.folder, action: () => createProjectModal({ workflowId: workflow.id, anchor }) },
    { label: 'Переименовать папку', icon: ICONS.pen, action: () => renameWorkflow(workflow, anchor) },
    { sep: true },
    { label: 'Удалить папку', icon: ICONS.trash, danger: true, action: () => deleteWorkflow(workflow, anchor) },
  ]);
}

function openChatMenu(event, chat) {
  const anchor = event.currentTarget;
  openContextMenu(anchor, [
    { label: 'Переименовать', icon: ICONS.pen, action: () => renameChat(chat, anchor) },
    { sep: true },
    { label: 'Удалить диалог', icon: ICONS.trash, danger: true, action: () => deleteChat(chat, anchor) },
  ]);
}

async function renameProject(project, anchor = null) {
  const name = await promptPopover({
    anchor: anchor || $('#newProjectBtn'),
    title: 'Название проекта',
    label: 'Как назвать проект?',
    value: project.name,
    confirm: 'Сохранить',
  });
  if (!name || name === project.name) return;
  try {
    await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { name } });
    project.name = name;
    renderSidebar();
    updateCrumbs();
  } catch (error) {
    toast(error.message);
  }
}

async function deleteProject(project, anchor = null) {
  if (!anchor) return;
  const ok = await confirmPopover({
    anchor,
    title: 'Удалить проект?',
    text: `Проект «${project.name}» и его диалоги с файлами удалятся безвозвратно.`,
    confirmLabel: 'Удалить проект',
  });
  if (!ok) return;
  try {
    await api(`/api/projects/${project.id}`, { method: 'DELETE' });
    state.projects = state.projects.filter((item) => item.id !== project.id);
    if (state.activeProjectId === project.id) {
      state.activeProjectId = null;
      state.activeChatId = null;
      state.chat = null;
      const first = state.projects[0];
      if (first) {
        state.activeProjectId = first.id;
        state.expanded.add(first.id);
        if (first.chats?.[0]) await openChat(first.chats[0].id);
        else {
          renderThread();
          updateCrumbs();
        }
      } else {
        renderThread();
        updateCrumbs();
      }
    }
    renderSidebar();
  } catch (error) {
    toast(error.message);
  }
}

async function newChatFor(project) {
  closeSidebar();
  try {
    const created = await api(`/api/projects/${project.id}/chats`, { method: 'POST', body: {} });
    project.chats = project.chats || [];
    project.chats.unshift(created.chat);
    state.activeProjectId = project.id;
    state.expanded.add(project.id);
    await openChat(created.chat.id);
  } catch (error) {
    toast(error.message);
  }
}

async function newChat() {
  const project = activeProject() || state.projects[0];
  if (!project) {
    try {
      const created = await api('/api/projects', { method: 'POST', body: { name: 'Мой проект' } });
      state.projects.push({ ...created.project, chats: [] });
      return newChatFor(created.project);
    } catch (error) {
      toast(error.message);
      return;
    }
  }
  newChatFor(project);
}

/* ---------------------- проекты и workflow ---------------------- */

function workflowSelectField({ value = '', allowNone = true, variant = 'form' } = {}) {
  const inPopover = variant === 'popover';
  const field = el(inPopover ? 'div' : 'label', inPopover ? 'popover-field' : 'field');
  field.appendChild(el(inPopover ? 'div' : 'span', inPopover ? 'popover-label' : 'field-label', 'Папка проектов'));
  const select = el('select', inPopover ? 'popover-select' : '');
  if (allowNone) {
    const none = el('option');
    none.value = '';
    none.textContent = '— Без папки —';
    select.appendChild(none);
  }
  for (const workflow of state.workflows) {
    const option = el('option');
    option.value = workflow.id;
    option.textContent = workflow.name;
    select.appendChild(option);
  }
  select.value = value;
  field.appendChild(select);
  return { field, select };
}

function createProjectModal({ workflowId = '', anchor = null } = {}) {
  const folder = workflowId ? state.workflows.find((item) => item.id === workflowId) : null;
  const form = el('form', 'popover-form');
  const nameInput = el('input', 'popover-input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Название проекта';
  nameInput.autocomplete = 'off';
  nameInput.setAttribute('aria-label', 'Название проекта');
  form.appendChild(nameInput);

  /* В окне «Новый проект» — только название: папка создаётся отдельной строкой
     внизу списка, а «Новый проект в папке» запускается из меню папки. */
  const submit = async () => {
    const name = nameInput.value.trim() || 'Новый проект';
    const chosenWorkflow = folder ? workflowId : '';
    try {
      const created = await api('/api/projects', {
        method: 'POST',
        body: { name, workflowId: chosenWorkflow || null },
      });
      const project = { ...created.project, chats: [] };
      state.projects.unshift(project);
      state.activeProjectId = project.id;
      state.activeChatId = null;
      state.chat = null;
      state.attachments = [];
      state.expanded.add(project.id);
      if (chosenWorkflow) state.collapsedWorkflows.delete(chosenWorkflow);
      renderAttachStrip();
      renderSidebar();
      renderThread();
      updateCrumbs();
      if (state.filesOpen) loadFiles('.');
      /* Телефон: проект создаётся из ящика «Проекты», и ящик закрывается сам —
         иначе новый диалог оставался под ним: поля ввода не видно, сообщение
         отправить некуда. На широком экране эта строка ничего не меняет. */
      closeSidebar();
      $('#input').focus();
      toast(`Проект «${project.name}» создан`, 'ok');
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    }
  };

  togglePopover({
    anchor: anchor || $('#newProjectBtn'),
    title: folder ? `Новый проект в «${folder.name}»` : 'Новый проект',
    body: form,
    /* Тот же низ карточки, что у подтверждения удаления: «Отмена» и главная
       кнопка. Раньше здесь была одна кнопка, и окно выглядело чужим. */
    actions: [
      { id: 'cancel', label: 'Отмена', kind: 'quiet' },
      { id: 'create', label: 'Создать проект', kind: 'primary', onClick: submit },
    ],
    onMount: (_body, _node, actions) => {
      nameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          actions.create();
        }
      });
      setTimeout(() => nameInput.focus(), 30);
    },
  });
}

async function renameWorkflow(workflow, anchor = null) {
  const name = await promptPopover({
    anchor: anchor || $('#newProjectBtn'),
    title: 'Название папки',
    label: 'Как назвать папку проектов?',
    value: workflow.name,
    confirm: 'Сохранить',
  });
  if (!name || name === workflow.name) return;
  try {
    await api(`/api/workflows/${workflow.id}`, { method: 'PATCH', body: { name } });
    workflow.name = name;
    renderSidebar();
    toast('Название обновлено', 'ok');
  } catch (error) {
    toast(error.message);
  }
}

async function deleteWorkflow(workflow, anchor = null) {
  const count = state.projects.filter((project) => project.workflowId === workflow.id).length;
  if (!anchor) return;
  const ok = await confirmPopover({
    anchor,
    title: 'Удалить папку проектов?',
    text: count
      ? `Папка «${workflow.name}» удалится, проекты (${count}) останутся в общем списке.`
      : `Папка «${workflow.name}» удалится.`,
    confirmLabel: 'Удалить папку',
  });
  if (!ok) return;
  try {
    await api(`/api/workflows/${workflow.id}`, { method: 'DELETE' });
    state.workflows = state.workflows.filter((item) => item.id !== workflow.id);
    state.collapsedWorkflows.delete(workflow.id);
    for (const project of state.projects) {
      if (project.workflowId === workflow.id) project.workflowId = null;
    }
    renderSidebar();
    toast('Папка удалена', 'ok');
  } catch (error) {
    toast(error.message);
  }
}

function moveProjectPopover(project, anchor = null) {
  if (!state.workflows.length) {
    toast('Сначала создайте папку проектов');
    return;
  }
  if (!anchor) return;
  const form = el('div', 'popover-form');
  const { field, select } = workflowSelectField({ value: project.workflowId || '', variant: 'popover' });
  form.appendChild(field);
  form.appendChild(el('p', 'form-hint', 'Файлы проекта останутся на месте.'));
  openPopover({
    anchor,
    title: 'Переместить проект',
    body: form,
    actions: [
      { label: 'Отмена', kind: 'quiet' },
      {
        label: 'Переместить',
        kind: 'primary',
        onClick: async () => {
          const target = select.value || null;
          if ((project.workflowId || null) === target) return true;
          try {
            await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { workflowId: target } });
            project.workflowId = target;
            renderSidebar();
            toast('Проект перемещён', 'ok');
            return true;
          } catch (error) {
            toast(error.message);
            return false;
          }
        },
      },
    ],
  });
}

async function renameChat(chat, anchor = null) {
  const title = await promptPopover({
    anchor: anchor || $('#newProjectBtn'),
    title: 'Название диалога',
    label: 'Как назвать диалог?',
    value: chat.title,
    confirm: 'Сохранить',
  });
  if (!title || title === chat.title) return;
  try {
    await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: { title } });
    chat.title = title;
    if (state.chat?.id === chat.id) state.chat.title = title;
    renderSidebar();
    updateCrumbs();
  } catch (error) {
    toast(error.message);
  }
}

async function deleteChat(chat, anchor = null) {
  if (!anchor) return;
  const ok = await confirmPopover({
    anchor,
    title: 'Удалить диалог?',
    text: `Диалог «${chat.title}» будет удалён вместе с сообщениями.`,
    confirmLabel: 'Удалить',
  });
  if (!ok) return;
  try {
    await api(`/api/chats/${chat.id}`, { method: 'DELETE' });
    const project = state.projects.find((item) => item.id === chat.projectId);
    if (project) project.chats = (project.chats || []).filter((item) => item.id !== chat.id);
    if (state.activeChatId === chat.id) {
      state.activeChatId = null;
      state.chat = null;
      if (project?.chats?.[0]) await openChat(project.chats[0].id);
      else {
        renderThread();
        updateCrumbs();
      }
    }
    renderSidebar();
  } catch (error) {
    toast(error.message);
  }
}

async function changePasswordModal() {
  const form = el('form', 'form-grid');
  const mk = (label, type) => {
    const field = el('label', 'field');
    field.appendChild(el('span', 'field-label', label));
    const input = el('input');
    input.type = type;
    input.autocomplete = 'new-password';
    field.appendChild(input);
    form.appendChild(field);
    return input;
  };
  const current = mk('Текущий пароль', 'password');
  const next = mk('Новый пароль', 'password');
  const repeat = mk('Повторите новый пароль', 'password');
  const note = el('p', 'field-error');
  form.appendChild(note);
  let settled = false;
  openModal({
    title: 'Смена пароля',
    body: form,
    actions: [
      { label: 'Отмена', kind: 'quiet', onClick: () => {} },
      {
        label: 'Сохранить',
        kind: 'primary',
        onClick: async () => {
          note.textContent = '';
          if (next.value !== repeat.value) {
            note.textContent = 'Пароли не совпадают';
            return false;
          }
          try {
            await api('/api/account/password', { method: 'POST', body: { current: current.value, next: next.value } });
            closeModal();
            toast('Пароль обновлён', 'ok');
          } catch (error) {
            note.textContent = error.message;
          }
          return false;
        },
      },
    ],
  });
  setTimeout(() => current.focus(), 40);
}

/* Что сервис запомнил о человеке: список фактов, удаление по одному и сброс.
   Память влияет на ответы, поэтому она должна быть видимой и управляемой. */
async function memoryModal() {
  const body = el('div', 'admin');
  const list = el('div', 'memory-list');
  const note = el('p', 'field-error');
  body.append(
    el(
      'p',
      'ap-sub',
      'Это то, что сервис запомнил из прошлых разговоров и учитывает в новых. Удалите лишнее — модель перестанет это использовать.',
    ),
    list,
    note,
  );

  const refresh = async () => {
    note.textContent = '';
    list.innerHTML = '';
    let facts = [];
    try {
      facts = (await api('/api/memory')).facts || [];
    } catch (error) {
      note.textContent = error.message;
      return;
    }
    if (!facts.length) {
      list.appendChild(el('div', 'files-empty', 'Пока ничего не записано'));
      return;
    }
    for (const fact of facts) {
      const row = el('div', 'approval');
      const main = el('div', 'ap-main');
      main.appendChild(el('div', 'ap-title', fact.text));
      const when = fact.createdAt
        ? new Date(fact.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';
      main.appendChild(el('div', 'ap-sub', when ? `записано ${when}` : 'записано'));
      row.appendChild(main);
      const actions = el('div', 'ap-actions');
      const remove = el('button', 'btn btn-quiet', 'Удалить');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          await api('/api/memory', { method: 'DELETE', body: { id: fact.id } });
          await refresh();
        } catch (error) {
          note.textContent = error.message;
          remove.disabled = false;
        }
      });
      actions.appendChild(remove);
      row.appendChild(actions);
      list.appendChild(row);
    }
  };

  list.innerHTML = '<div class="files-empty"><div class="spin-lg"></div></div>';
  openModal({
    title: 'Что сервис помнит',
    body,
    wide: true,
    actions: [
      {
        label: 'Очистить всё',
        kind: 'danger',
        onClick: async () => {
          try {
            await api('/api/memory', { method: 'DELETE', body: {} });
            toast('Память очищена', 'ok');
            await refresh();
          } catch (error) {
            note.textContent = error.message;
          }
          return false;
        },
      },
      { label: 'Закрыть', kind: 'quiet' },
    ],
  });
  await refresh();
}

/* Полный сброс клиентского состояния при смене аккаунта: у каждого
   пользователя свои проекты, история и файлы, поэтому после выхода в памяти
   страницы не должно остаться ничего от предыдущего человека. */
function resetClientState() {
  /* Потоки прежнего аккаунта закрываем: их задачи ему и принадлежат. */
  for (const streamState of state.liveStreams.values()) {
    try {
      streamState.controller.abort();
    } catch {
      /* ignore */
    }
  }
  state.liveStreams = new Map();
  state.liveRuns = new Map();
  state.streaming = false;
  state.user = null;
  state.projects = [];
  state.workflows = [];
  state.activeProjectId = null;
  state.activeChatId = null;
  state.chat = null;
  state.attachments = [];
  state.filesPath = '.';
  state.filesLoading = false;
  state.expanded = new Set();
  state.collapsedWorkflows = new Set();
  state.lastTitle = '';
  state.dragOut = false;
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST', body: {} });
  } catch {
    /* ignore */
  }
  resetClientState();
  showAuth();
}

/* ------------------------------ admin ------------------------------ */

async function adminModal() {
  const body = el('div', 'admin');
  body.innerHTML = '<div class="files-empty"><div class="spin-lg"></div></div>';
  openModal({
    title: 'Пользователи',
    wide: true,
    body,
    actions: [{ label: 'Закрыть', kind: 'quiet' }],
  });
  const refresh = async () => {
    const [usersData, statsData, approvalsData] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/stats'),
      api('/api/admin/approvals').catch(() => ({ approvals: [] })),
    ]);
    renderAdmin(body, usersData.users, statsData.overview, approvalsData.approvals || [], refresh);
  };
  try {
    await refresh();
  } catch (error) {
    body.innerHTML = '';
    body.appendChild(el('div', 'files-empty', error.message));
  }
}

/* Запросы на подтверждение тяжёлых задач: одобряем или отклоняем прямо здесь. */
function renderApprovals(body, approvals, refresh) {
  if (!approvals.length) return;
  body.appendChild(el('div', 'admin-section-title', 'Запросы на тяжёлые задачи'));
  const pending = approvals.filter((item) => item.status === 'pending');
  const decided = approvals.filter((item) => item.status !== 'pending').slice(0, 6);
  for (const approval of [...pending, ...decided]) {
    const row = el('div', `approval${approval.status === 'pending' ? '' : ' done'}`);
    const main = el('div', 'ap-main');
    main.appendChild(el('div', 'ap-title', `${approval.username} · ${approval.projectName}`));
    const when = new Date(approval.createdAt).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const status =
      approval.status === 'pending' ? 'ждёт решения' : approval.status === 'approved' ? 'одобрено' : 'отклонено';
    main.appendChild(
      el('div', 'ap-sub', `${fmtUsd(approval.spentUsd)} из ${fmtUsd(approval.limitUsd)} · ${when} · ${status}`),
    );
    row.appendChild(main);

    const actions = el('div', 'ap-actions');
    const decide = async (action) => {
      try {
        const data = await api(`/api/admin/approvals/${approval.id}`, { method: 'POST', body: { action } });
        toast(
          action === 'approve'
            ? `Продолжение разрешено, новый лимит ${fmtUsd(data.budgetUsd)}`
            : 'Запрос отклонён',
          action === 'approve' ? 'ok' : 'error',
        );
        if (refresh) await refresh();
      } catch (error) {
        toast(error.message);
      }
    };
    if (approval.status !== 'approved') {
      const approve = el('button', 'btn btn-primary', 'Одобрить');
      approve.type = 'button';
      approve.addEventListener('click', () => decide('approve'));
      actions.appendChild(approve);
    }
    if (approval.status === 'pending') {
      const reject = el('button', 'btn', 'Отклонить');
      reject.type = 'button';
      reject.addEventListener('click', () => decide('reject'));
      actions.appendChild(reject);
    }
    row.appendChild(actions);
    body.appendChild(row);
  }
}

function renderAdmin(body, users, overview, approvals = [], refresh = null) {
  body.innerHTML = '';
  const stats = el('div', 'stats');
  const mkStat = (value, label) => {
    const box = el('div', 'stat');
    box.appendChild(el('div', 'stat-value', String(value)));
    box.appendChild(el('div', 'stat-label', label));
    return box;
  };
  stats.appendChild(mkStat(users.length, plural(users.length, 'пользователь', 'пользователя', 'пользователей')));
  stats.appendChild(mkStat(overview.projects, plural(overview.projects, 'проект', 'проекта', 'проектов')));
  stats.appendChild(mkStat(overview.chats, plural(overview.chats, 'диалог', 'диалога', 'диалогов')));
  const messages = overview.total?.messages || 0;
  stats.appendChild(mkStat(messages, plural(messages, 'сообщение', 'сообщения', 'сообщений')));
  body.appendChild(stats);

  const form = el('form', 'inline-form');
  const userField = el('label', 'field');
  userField.appendChild(el('span', 'field-label', 'Новый логин'));
  const userInput = el('input');
  userInput.placeholder = 'например, ivan';
  userInput.autocomplete = 'off';
  userField.appendChild(userInput);
  form.appendChild(userField);
  const passField = el('label', 'field');
  passField.appendChild(el('span', 'field-label', 'Пароль'));
  const passInput = el('input');
  passInput.type = 'text';
  passInput.placeholder = 'минимум 8 символов';
  passInput.autocomplete = 'off';
  passField.appendChild(passInput);
  form.appendChild(passField);
  const creditField = el('label', 'field field-credit');
  creditField.appendChild(el('span', 'field-label', 'Баланс, $'));
  const creditInput = el('input');
  creditInput.type = 'text';
  creditInput.inputMode = 'decimal';
  creditInput.placeholder = '20';
  creditInput.autocomplete = 'off';
  creditField.appendChild(creditInput);
  form.appendChild(creditField);
  const createBtn = el('button', 'btn btn-primary', 'Создать');
  createBtn.type = 'submit';
  form.appendChild(createBtn);
  const note = el('p', 'field-error');
  form.appendChild(note);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    note.textContent = '';
    createBtn.disabled = true;
    try {
      const credit = creditInput.value.trim() ? Number(creditInput.value.replace(',', '.').replace(/[^\d.-]/g, '')) : undefined;
      const data = await api('/api/admin/users', {
        method: 'POST',
        body: { username: userInput.value.trim(), password: passInput.value, creditUsd: credit },
      });
      users.push({ ...data.user, usage: [] });
      userInput.value = '';
      passInput.value = '';
      creditInput.value = '';
      renderAdmin(body, users, overview, approvals, refresh);
    } catch (error) {
      note.textContent = error.message;
    } finally {
      createBtn.disabled = false;
    }
  });
  body.appendChild(form);

  renderApprovals(body, approvals, refresh);

  const list = el('div');
  for (const user of users) {
    const row = el('div', 'admin-user');
    const avatar = el('span', 'avatar', (user.displayName || user.username).charAt(0));
    row.appendChild(avatar);
    const main = el('div', 'au-main');
    const nameLine = el('div', 'au-name');
    nameLine.textContent = user.displayName || user.username;
    if (user.role === 'admin') {
      const badge = el('span', 'badge', 'админ');
      nameLine.appendChild(badge);
    }
    if (user.disabled) {
      const badge = el('span', 'badge danger', 'заблокирован');
      nameLine.appendChild(badge);
    }
    main.appendChild(nameLine);
    const last = user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString('ru-RU') : 'ещё не входил';
    const balanceNote = user.role === 'admin' ? '' : ` · баланс ${fmtUsd(user.balanceUsd)}`;
    main.appendChild(el('div', 'au-sub', `${user.username} · ${last}${balanceNote}`));
    row.appendChild(main);

    const actions = el('div', 'au-actions');
    if (user.id !== state.user.id) {
      const credit = el('button', 'btn', 'Начислить');
      credit.type = 'button';
      credit.addEventListener('click', async () => {
        const raw = await promptDialog({
          title: 'Начислить баланс',
          label: `Сумма в долларах для «${user.username}» (минус — списать)`,
          confirm: 'Начислить',
        });
        if (!raw) return;
        const usd = Number(String(raw).replace(',', '.').replace(/[^\d.-]/g, ''));
        if (!Number.isFinite(usd) || !usd) {
          toast('Укажите сумму в долларах, например 10');
          return;
        }
        try {
          const data = await api(`/api/admin/users/${user.id}/credit`, { method: 'POST', body: { usd } });
          user.balanceUsd = data.user.balanceUsd;
          user.spentUsd = data.user.spentUsd;
          toast(`Баланс «${user.username}»: ${fmtUsd(user.balanceUsd)}`, 'ok');
          // Диалог суммы закрывает окно «Пользователи» — открываем его снова с новыми балансами.
          setTimeout(() => adminModal(), 0);
        } catch (error) {
          toast(error.message);
        }
      });
      actions.appendChild(credit);
    }
    const reset = el('button', 'btn', 'Пароль');
    reset.type = 'button';
    reset.addEventListener('click', async () => {
      const password = await promptDialog({
        title: 'Новый пароль',
        label: `Пароль для «${user.username}»`,
        confirm: 'Сбросить',
      });
      if (!password) return;
      try {
        await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { password } });
        toast('Пароль изменён', 'ok');
      } catch (error) {
        toast(error.message);
      }
    });
    actions.appendChild(reset);
    if (user.id !== state.user.id) {
      const block = el('button', 'btn', user.disabled ? 'Разблокировать' : 'Блокировать');
      block.type = 'button';
      block.addEventListener('click', async () => {
        try {
          await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { disabled: !user.disabled } });
          user.disabled = !user.disabled;
          renderAdmin(body, users, overview, approvals, refresh);
        } catch (error) {
          toast(error.message);
        }
      });
      actions.appendChild(block);
      const del = el('button', 'btn', 'Удалить');
      del.type = 'button';
      del.addEventListener('click', async () => {
        const ok = await confirmDialog('Удалить пользователя?', `Учётная запись «${user.username}» и все её проекты будут удалены.`, 'Удалить', true);
        if (!ok) return;
        try {
          await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
          const idx = users.findIndex((item) => item.id === user.id);
          if (idx >= 0) users.splice(idx, 1);
          renderAdmin(body, users, overview, approvals, refresh);
        } catch (error) {
          toast(error.message);
        }
      });
      actions.appendChild(del);
    }
    row.appendChild(actions);
    list.appendChild(row);
  }
  body.appendChild(list);
}

/* ------------------------------ composer ------------------------------ */

function autoResize() {
  const input = $('#input');
  if (!input) return;
  // Пустое поле — всегда одна строка: иначе подсказка в тесной строке ввода
  // переносится и раздувает её до двух-трёх строк ещё до начала набора.
  if (!input.value.trim()) {
    input.style.height = '';
    input.style.overflowY = 'hidden';
    return;
  }
  const max = Math.max(180, Math.min(420, Math.round(window.innerHeight * 0.42)));
  input.style.height = 'auto';
  const next = Math.min(input.scrollHeight + 3, max);
  input.style.height = `${next}px`;
  input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden';
}

// На узком экране длинная подсказка переносится в две строки и раздувает поле ввода.
function syncInputPlaceholder() {
  const input = $('#input');
  if (!input) return;
  const veryNarrow = window.matchMedia('(max-width: 420px)').matches;
  const narrow = window.matchMedia('(max-width: 560px)').matches;
  input.placeholder = veryNarrow ? 'Вопрос…' : narrow ? 'Задайте вопрос…' : 'Спросите или поставьте задачу…';
}

/* ------------------------------ theme ------------------------------ */

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme, persist = true) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  if (persist) {
    try {
      localStorage.setItem('dshow-theme', next);
    } catch {
      /* ignore */
    }
  }
  /* Кнопка темы есть и на экране входа: обе должны показывать одно и то же. */
  const light = next === 'light';
  const toggles = document.querySelectorAll('.theme-toggle');
  for (const toggle of toggles) {
    toggle.title = light ? 'Тёмная тема' : 'Светлая тема';
    toggle.setAttribute('aria-label', light ? 'Включить тёмную тему' : 'Включить светлую тему');
    const moon = $('.icon-moon', toggle);
    const sun = $('.icon-sun', toggle);
    if (moon) moon.classList.toggle('hidden', light);
    if (sun) sun.classList.toggle('hidden', !light);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? '#ffffff' : '#151517');
}

/* ------------------------------ voice input ------------------------------ */

const dictation = {
  recorder: null,
  stream: null,
  chunks: [],
  startedAt: 0,
  tick: null,
  cancelled: false,
  busy: false,
};

function setDictationBar(visible, text) {
  const bar = $('#dictationBar');
  if (!bar) return;
  bar.classList.toggle('hidden', !visible);
  const composer = $('#composer');
  if (composer) composer.classList.toggle('dictating', visible);
  if (text) $('#dictationText').textContent = text;
}

function updateDictationText() {
  if (!dictation.startedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - dictation.startedAt) / 1000));
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  /* Одна строка: время + короткая подсказка, при нехватке места текст обрезается. */
  $('#dictationText').textContent = `Слушаю… ${mm}:${ss} · микрофон — закончить`;
}

function stopDictationStream() {
  if (dictation.stream) {
    for (const track of dictation.stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
  }
}

function cleanupDictation() {
  clearInterval(dictation.tick);
  dictation.tick = null;
  stopDictationStream();
  dictation.recorder = null;
  dictation.stream = null;
  dictation.chunks = [];
  dictation.startedAt = 0;
  const mic = $('#micBtn');
  if (mic) {
    mic.classList.remove('active');
    mic.setAttribute('aria-pressed', 'false');
    mic.disabled = false;
  }
}

async function startDictation() {
  if (dictation.busy || dictation.recorder) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('Голосовой ввод не поддерживается этим браузером');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    let mimeType = '';
    for (const candidate of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
      if (window.MediaRecorder.isTypeSupported?.(candidate)) {
        mimeType = candidate;
        break;
      }
    }
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    dictation.stream = stream;
    dictation.recorder = recorder;
    dictation.chunks = [];
    dictation.cancelled = false;
    dictation.startedAt = Date.now();
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size) dictation.chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      finalizeDictation().catch(() => {});
    });
    recorder.start(250);
    const mic = $('#micBtn');
    mic.classList.add('active');
    mic.setAttribute('aria-pressed', 'true');
    setDictationBar(true, 'Слушаю…');
    updateDictationText();
    dictation.tick = setInterval(() => {
      updateDictationText();
      if (Date.now() - dictation.startedAt > 180000) stopDictation(false);
    }, 500);
  } catch (error) {
    cleanupDictation();
    setDictationBar(false);
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    toast(denied ? 'Разрешите доступ к микрофону в настройках браузера' : 'Не удалось включить микрофон');
  }
}

function stopDictation(cancelled = false) {
  if (!dictation.recorder) {
    if (cancelled) setDictationBar(false);
    return;
  }
  dictation.cancelled = cancelled;
  setDictationBar(true, cancelled ? 'Запись отменена' : 'Обрабатываю запись…');
  try {
    if (dictation.recorder.state !== 'inactive') dictation.recorder.stop();
  } catch {
    cleanupDictation();
    setDictationBar(false);
  }
}

function encodeWavMono(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function blobToWav(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioCtx || !OfflineCtx) throw new Error('Браузер не поддерживает обработку звука');
  const encoded = await blob.arrayBuffer();
  const ctx = new AudioCtx();
  let decoded;
  try {
    decoded = await new Promise((resolve, reject) => {
      const promise = ctx.decodeAudioData(encoded, resolve, reject);
      if (promise && typeof promise.then === 'function') promise.then(resolve, reject);
    });
  } finally {
    ctx.close?.().catch?.(() => {});
  }
  const sampleRate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * sampleRate));
  const offline = new OfflineCtx(1, frames, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return encodeWavMono(rendered.getChannelData(0), sampleRate);
}

function insertTranscript(text) {
  const input = $('#input');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const prefix = before && !/[\s\n]$/.test(before) ? ' ' : '';
  const suffix = after && !/^[\s\n.,!?;:)]/.test(after) ? ' ' : '';
  input.value = `${before}${prefix}${text}${suffix}${after}`;
  const caret = (before + prefix + text).length;
  input.setSelectionRange(caret, caret);
  autoResize();
  input.focus();
}

async function finalizeDictation() {
  const chunks = dictation.chunks;
  const cancelled = dictation.cancelled;
  const startedAt = dictation.startedAt;
  const mimeType = dictation.recorder?.mimeType || 'audio/webm';
  clearInterval(dictation.tick);
  dictation.tick = null;
  stopDictationStream();
  $('#micBtn').classList.remove('active');
  $('#micBtn').setAttribute('aria-pressed', 'false');
  $('#micBtn').disabled = false;
  dictation.recorder = null;
  dictation.stream = null;
  dictation.startedAt = 0;

  if (cancelled) {
    dictation.chunks = [];
    setDictationBar(false);
    return;
  }
  if (!chunks.length || Date.now() - startedAt < 500) {
    dictation.chunks = [];
    setDictationBar(false);
    toast('Слишком короткая запись');
    return;
  }

  dictation.busy = true;
  $('#micBtn').disabled = true;
  setDictationBar(true, 'Распознаю речь…');
  try {
    const blob = new Blob(chunks, { type: mimeType });
    const wav = await blobToWav(blob);
    if (wav.size > 20 * 1024 * 1024) throw new Error('Запись слишком длинная');
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'audio/wav', 'X-Audio-Format': 'wav' },
      body: wav,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
    const text = String(data.text || '').trim();
    if (!text) {
      toast('Речь не распознана — попробуйте говорить ближе к микрофону');
    } else {
      insertTranscript(text);
    }
  } catch (error) {
    toast(error.message || 'Не удалось распознать речь');
  } finally {
    dictation.busy = false;
    dictation.chunks = [];
    setDictationBar(false);
    $('#micBtn').disabled = false;
  }
}

function toggleDictation() {
  if (dictation.busy) return;
  if (dictation.recorder) stopDictation(false);
  else startDictation();
}

/* ------------------------------ spellcheck ------------------------------ */

async function checkSpelling() {
  if (state.streaming) {
    toast('Дождитесь ответа — проверка начнётся после');
    return;
  }
  const input = $('#input');
  const source = input.value;
  if (!source.trim()) {
    toast('Сначала введите текст');
    input.focus();
    return;
  }
  if (source.length > 24000) {
    toast('Текст длиннее 24 000 символов — проверьте частями');
    return;
  }
  const button = $('#spellBtn');
  if (button.classList.contains('busy')) return;
  button.classList.add('busy');
  button.disabled = true;
  try {
    const data = await api('/api/proofread', { method: 'POST', body: { text: source } });
    const fixed = String(data.text || '').trim();
    if (fixed && fixed !== source.trim()) {
      input.value = fixed;
      autoResize();
      input.focus();
      toast('Орфография и пунктуация исправлены', 'ok');
    } else {
      toast('Ошибок не найдено', 'ok');
    }
  } catch (error) {
    if (!error.unauthorized) toast(error.message || 'Не удалось проверить текст');
  } finally {
    button.classList.remove('busy');
    button.disabled = false;
  }
}

/* ------------------------------ wiring ------------------------------ */

$('#loginForm').addEventListener('submit', onLogin);
$('#signupForm').addEventListener('submit', onSignup);
$('#authSwitchToSignup').addEventListener('click', () => switchAuthForm('signup'));
$('#authSwitchToLogin').addEventListener('click', () => switchAuthForm('login'));
$('#userChip').addEventListener('click', openUserMenu);
$('#newProjectBtn').addEventListener('click', (event) => createProjectModal({ anchor: event.currentTarget }));
$('#composer').addEventListener('submit', sendMessage);
$('#stopBtn').addEventListener('click', stopGeneration);
$('#attachBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (event) => {
  uploadFiles(event.target.files);
  event.target.value = '';
});
$('#filesBtn').addEventListener('click', () => toggleFilesDrawer());
$('#filesUploadBtn').addEventListener('click', () => $('#filesPanelInput').click());
$('#filesPanelInput').addEventListener('change', (event) => {
  uploadToProject(event.target.files);
  event.target.value = '';
});
$('#exportProjectBtn').addEventListener('click', () => {
  if (state.activeProjectId) window.open(`/api/projects/${state.activeProjectId}/download`, '_blank');
});
$('#sidebarToggle').addEventListener('click', () => {
  const app = $('#app');
  const willOpen = !app.classList.contains('sidebar-open');
  app.classList.toggle('sidebar-open', willOpen);
  if (willOpen) closeFilesDrawer();
});
/* Ярлык проекта в шапке — это ещё и кнопка «выбрать проект»: на телефоне она
   открывает тот же список слева, что и кнопка меню. */
$('#crumbProject').addEventListener('click', () => {
  const toggle = $('#sidebarToggle');
  if (!toggle || getComputedStyle(toggle).display === 'none') return;
  $('#app').classList.add('sidebar-open');
  closeFilesDrawer();
});
$('#backdrop').addEventListener('click', () => {
  $('#app').classList.remove('sidebar-open');
  closeFilesDrawer();
});
/* Крестик в заголовке ящика: тем же путём, что затемнение и кнопка-папка. */
$('#filesClose').addEventListener('click', () => closeFilesDrawer());
/* ------------------------------ panel resize ------------------------------ */
/* Полная версия: ширину панели проектов и панели файлов можно тянуть мышью
   за разделитель, ширины запоминаются. На телефоне панели — выезжающие ящики,
   там ширина задана экраном, поэтому ручки скрыты. */

const LAYOUT_KEY = 'dshow-layout-v3';
/* Боковые панели одинаковые по ширине: слева «Проекты», справа «Файлы проекта»,
   по умолчанию 280 px у обеих, каждая тянется в пределах 264…420 px, диалогу
   всегда остаётся минимум 400 px. Пока правую панель не тянули, она повторяет
   ширину левой — блоки симметричны, и это видно на любой ширине окна. */
const PANEL_RULES = {
  sidebar: { min: 264, max: () => 420, def: () => 280 },
  files: { min: 264, max: () => 420, def: () => 280 },
};

function readLayoutRaw() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

/* Правая панель без своего размера равна левой: отдельного значения нет —
   значит тянем её вслед за левой. */
function readLayout() {
  const raw = readLayoutRaw();
  const sidebar = Number.isFinite(raw.sidebar) ? Math.round(raw.sidebar) : PANEL_RULES.sidebar.def();
  const filesCustom = Number.isFinite(raw.files);
  return { sidebar, files: filesCustom ? Math.round(raw.files) : sidebar, filesCustom };
}

function saveLayout(patch) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...readLayoutRaw(), ...patch }));
  } catch {
    /* приватный режим — просто не запоминаем */
  }
}

function forgetLayout(key) {
  const raw = readLayoutRaw();
  delete raw[key];
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(raw));
  } catch {
    /* приватный режим — просто не запоминаем */
  }
}

function clampPanel(kind, width, other) {
  const rule = PANEL_RULES[kind];
  const limit = Math.min(rule.max(), window.innerWidth - other - 400);
  return Math.max(rule.min, Math.min(limit, Math.round(width)));
}

/* Фактическая ширина панели на экране: из инлайнового стиля, а если его ещё
   нет — из самого блока. */
function appliedPanel(kind) {
  const app = $('#app');
  if (!app) return 0;
  const value = Number.parseFloat(app.style.getPropertyValue(kind === 'sidebar' ? '--sidebar' : '--files'));
  if (Number.isFinite(value)) return value;
  const node = kind === 'sidebar' ? $('#sidebar') : $('#filesPanel');
  return node ? Math.round(node.getBoundingClientRect().width) : 0;
}

function panelOtherWidth(kind) {
  const app = $('#app');
  if (!app) return 0;
  if (kind === 'sidebar') return app.classList.contains('with-files') ? appliedPanel('files') : 0;
  return appliedPanel('sidebar');
}

function applyLayout() {
  const app = $('#app');
  if (!app) return;
  if (!window.matchMedia('(min-width: 1101px)').matches) {
    app.style.removeProperty('--sidebar');
    app.style.removeProperty('--files');
    return;
  }
  const prefs = readLayout();
  const sidebar = clampPanel('sidebar', prefs.sidebar, prefs.filesCustom ? prefs.files : 0);
  app.style.setProperty('--sidebar', `${sidebar}px`);
  /* Правую панель не настраивали — она равна левой, без собственного размера. */
  const files = prefs.filesCustom ? clampPanel('files', prefs.files, sidebar) : sidebar;
  app.style.setProperty('--files', `${files}px`);
}

function initPanelResize(handle, kind) {
  if (!handle) return;
  const app = $('#app');
  const prop = kind === 'sidebar' ? '--sidebar' : '--files';
  const canResize = () => window.matchMedia('(min-width: 1101px)').matches;
  const applied = () => {
    const value = Number.parseFloat(app.style.getPropertyValue(prop));
    return Number.isFinite(value) ? value : PANEL_RULES[kind].def();
  };

  const setWidth = (width, persist) => {
    const next = clampPanel(kind, width, panelOtherWidth(kind));
    app.style.setProperty(prop, `${next}px`);
    /* Пока правую панель не настраивали отдельно, она повторяет левую: блоки
       остаются одинаковыми, даже если потянуть разделитель проектов. */
    if (kind === 'sidebar' && !readLayout().filesCustom) app.style.setProperty('--files', `${next}px`);
    if (persist) saveLayout({ [kind]: next });
    return next;
  };

  /* Сброс (двойной щелчок или Home) возвращает правую панель к ширине левой,
     а левую — к обычным 280 px. */
  const resetWidth = () => {
    if (kind === 'files') {
      forgetLayout('files');
      app.style.setProperty('--files', `${appliedPanel('sidebar')}px`);
      return;
    }
    setWidth(PANEL_RULES.sidebar.def(), true);
  };

  let drag = null;
  handle.addEventListener('pointerdown', (event) => {
    if (!canResize() || event.button !== 0) return;
    event.preventDefault();
    drag = { x: event.clientX, width: applied(), moved: false };
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* старые движки — тянем и без захвата */
    }
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
  });
  handle.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const delta = event.clientX - drag.x;
    if (Math.abs(delta) > 1) drag.moved = true;
    setWidth(kind === 'sidebar' ? drag.width + delta : drag.width - delta, false);
  });
  const finish = (event) => {
    if (!drag) return;
    if (drag.moved) saveLayout({ [kind]: applied() });
    drag = null;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    try {
      if (event && handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);

  // Двойной щелчок — вернуть обычную ширину (правая панель снова равна левой).
  handle.addEventListener('dblclick', () => {
    if (canResize()) resetWidth();
  });
  handle.addEventListener('keydown', (event) => {
    if (!canResize()) return;
    const step = event.shiftKey ? 48 : 16;
    const grow = kind === 'sidebar' ? 1 : -1;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setWidth(applied() - step * grow, true);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setWidth(applied() + step * grow, true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      resetWidth();
    }
  });
  handle.title =
    kind === 'sidebar'
      ? 'Потяните, чтобы изменить ширину панели проектов (двойной щелчок — сбросить)'
      : 'Потяните, чтобы изменить ширину панели файлов (двойной щелчок — как у левой панели)';
  handle.setAttribute('aria-label', handle.title);
}

initPanelResize($('#sidebarResizer'), 'sidebar');
initPanelResize($('#filesResizer'), 'files');
applyLayout();
syncFilesPanel();

$('#input').addEventListener('input', autoResize);
window.addEventListener('resize', () => {
  syncInputPlaceholder();
  autoResize();
  markWideBlocks();
  // При переходе на узкий экран выезжающий ящик не должен перекрывать диалог,
  // а на широком панель файлов обязана быть открытой колонкой.
  if (filesNarrow() && state.filesDrawerOpen) state.filesDrawerOpen = false;
  syncFilesPanel();
});
window.addEventListener('orientationchange', () => setTimeout(autoResize, 120));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(autoResize).catch(() => {});

/* Клавиатура телефона: окно держим по видимой области, иначе поле ввода
   уезжает под клавиатуру или страница прыгает при фокусе. */
function syncKeyboardViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  /* Safari и Chrome подкручивают страницу, чтобы показать поле над
     клавиатурой. От этого правый край уезжал за экран, а внизу оставалась
     полоса с адресом. Возвращаем саму страницу на место (окно прокрутки, а не
     видимую область) — поле и так видно: высоту мы считаем сами. */
  if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0);
  /* Сдвиг видимой области вниз: телефон подтянул страницу к полю ввода. Этот
     сдвиг не уменьшает клавиатуру — высоту клавиатуры считаем отдельно, а
     сдвиг компенсируем отступом сверху (--kb-pan), иначе подвал уезжает выше
     клавиатуры и накрывает поле ввода, а экран «скачет». */
  const pan = Math.max(0, Math.round(vv.offsetTop || 0));
  const hidden = Math.round(window.innerHeight - vv.height);
  /* На экране входа клавиатуру считаем открытой и тогда, когда Safari не
     уменьшает innerHeight: ориентируемся на низкую видимую область. Иначе
     карточка оставалась по центру и поле пароля уходило под клавиатуру. */
  const authVisible = !document.getElementById('auth')?.classList.contains('hidden');
  const compactAuth = authVisible && vv.height < 560;
  /* Масштаб больше 1 — это зум страницы (двойной тап, пинч, авто-увеличение
     поля), а не клавиатура: видимая область у него тоже меньше окна. Раньше
     такой зум принимался за клавиатуру, окно подстраивалось под урезанную
     высоту и оставалось увеличенным, пока страницу не вернут руками. Теперь
     при зуме вёрстка не трогается. */
  const zoomed = Number(vv.scale) > 1.01;
  /* Порог с запасом в обе стороны: пока клавиатура выезжает, видимая область
     дёргается на десяток пикселей, и от жёсткого порога подвал «подпрыгивал».
     Открываем от 140 px, закрываем ниже 70 px — между ними состояние стоит. */
  const wasOpen = root.classList.contains('kb-open');
  const shouldOpen = !zoomed && (hidden > (wasOpen ? 70 : 140) || compactAuth);
  if (shouldOpen) {
    root.classList.add('kb-open');
    root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    root.style.setProperty('--kb-offset', `${Math.max(0, hidden)}px`);
    root.style.setProperty('--kb-pan', `${pan}px`);
  } else {
    root.classList.remove('kb-open');
    root.style.removeProperty('--app-h');
    root.style.removeProperty('--kb-offset');
    root.style.removeProperty('--kb-pan');
  }
  /* Карточка в панели проектов/файлов не должна прятаться за клавиатурой:
     пересчитываем её положение по новой видимой высоте. */
  if (popoverNode && popoverHost) {
    placeInPanel(popoverNode, popoverAnchor, popoverHost);
  }
}

(function watchKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      syncKeyboardViewport();
    });
  };
  syncKeyboardViewport();
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', () => setTimeout(syncKeyboardViewport, 250));
})();

/* Клавиатура выезжает с анимацией 250–350 мс, на медленных телефонах дольше.
   Один замер через 300 мс иногда попадал в середину движения, и подвал вставал
   по промежуточной высоте — поле уезжало под клавиатуру, а потом всё прыгало на
   место. Поэтому пересчитываем несколько раз подряд. */
function settleKeyboardViewport() {
  [60, 160, 320, 520, 800].forEach((delay) => setTimeout(syncKeyboardViewport, delay));
}

/* Поле внутри карточки, окна или экрана входа: после появления клавиатуры
   поднимаем его в видимую часть экрана. Ждём конца анимации клавиатуры — на
   телефоне это около 300 мс. */
document.addEventListener('focusin', (event) => {
  if (!window.matchMedia('(max-width: 860px)').matches) return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.matches('input, textarea, select')) return;
  const inAuth = !!target.closest('#auth');
  if (!target.closest('.popover, .modal') && !inAuth) return;
  settleKeyboardViewport();
  setTimeout(() => {
    syncKeyboardViewport();
    /* Вход: карточка прокручивается внутри видимой области, поэтому поле
       пароля и кнопка «Войти» остаются над клавиатурой и нижней панелью. */
    if (inAuth) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (popoverNode && popoverHost) {
      placeInPanel(popoverNode, popoverAnchor, popoverHost);
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 320);
});

// На телефоне фокус в поле ввода поднимает клавиатуру: лента должна
// остаться у последнего сообщения, а не показывать середину переписки.
$('#input').addEventListener('focus', () => {
  if (!window.matchMedia('(max-width: 860px)').matches) return;
  settleKeyboardViewport();
  const toBottom = () => {
    const scroll = $('#scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  };
  /* Ленту подтягиваем к последнему сообщению дважды: сразу и после того, как
     клавиатура доехала — иначе лента оставалась на середине переписки. */
  setTimeout(toBottom, 120);
  setTimeout(toBottom, 420);
});
$('#input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});
for (const toggle of document.querySelectorAll('.theme-toggle')) {
  toggle.addEventListener('click', () => {
    applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
  });
}
$('#micBtn').addEventListener('click', toggleDictation);
$('#dictationCancel').addEventListener('click', () => stopDictation(true));
$('#spellBtn').addEventListener('click', checkSpelling);
applyTheme(currentTheme(), false);

$('#thread').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-code]');
  if (button) {
    const text = copyStore.get(button.dataset.copyCode) || '';
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Скопировано';
      setTimeout(() => {
        button.textContent = 'Копировать';
      }, 1400);
    } catch {
      toast('Не удалось скопировать');
    }
  }
});

document.addEventListener('click', (event) => {
  if (event.target.closest('.menu')) return;
  if (menuAnchor && menuAnchor.contains(event.target)) return;
  closeMenus();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if ($$('.menu').length) {
    closeMenus();
    return;
  }
  if (!$('#modalRoot').classList.contains('hidden')) closeModal();
});

/* drag and drop + paste */

const composer = $('#composer');
['dragenter', 'dragover'].forEach((type) => {
  composer.addEventListener(type, (event) => {
    event.preventDefault();
    composer.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((type) => {
  composer.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'dragleave' && composer.contains(event.relatedTarget)) return;
    composer.classList.remove('dragover');
  });
});
composer.addEventListener('drop', (event) => {
  if (event.dataTransfer?.files?.length) uploadFiles(event.dataTransfer.files);
});

/* Перетаскивание файлов с компьютера в панель «Файлы проекта»: файл сразу
   сохраняется в проект (в ту папку, которая открыта), а не прикрепляется к сообщению. */
const filesPanel = $('#filesPanel');

function dragCarriesFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

['dragenter', 'dragover'].forEach((type) => {
  filesPanel.addEventListener(type, (event) => {
    if (!dragCarriesFiles(event)) return;
    // Новый drag с файлами сбрасывает след от предыдущего перетаскивания наружу.
    state.dragOut = false;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    filesPanel.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((type) => {
  filesPanel.addEventListener(type, (event) => {
    if (type === 'dragleave' && filesPanel.contains(event.relatedTarget)) return;
    filesPanel.classList.remove('dragover');
  });
});

filesPanel.addEventListener('drop', (event) => {
  const files = event.dataTransfer?.files;
  if (!files || !files.length) return;
  event.preventDefault();
  if (state.dragOut) return;
  uploadToProject(files, state.filesPath);
});

/* Файл, вытащенный из панели, не должен открываться в самой странице:
   гасим переход, если его бросили мимо рабочего стола. */
document.addEventListener('dragover', (event) => {
  if (state.dragOut) event.preventDefault();
});
document.addEventListener('drop', (event) => {
  if (!state.dragOut) return;
  event.preventDefault();
  state.dragOut = false;
});
/* dragend приходит, даже если файл бросили мимо окна — сбрасываем флаг всегда. */
document.addEventListener('dragend', () => {
  state.dragOut = false;
});

document.addEventListener('paste', (event) => {
  const items = Array.from(event.clipboardData?.items || []);
  const files = items.filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean);
  if (files.length) uploadFiles(files);
});

/* ---------------------- ярлык на домашний экран ---------------------- */

/* Подсказка «поставьте ярлык» — ровно один раз на телефон и только в браузере:
   если страница уже открыта как приложение, предлагать нечего. */
const HOME_SCREEN_KEY = 'dshow-home-screen-offer-v1';

function homeScreenPlatform() {
  const ua = navigator.userAgent || '';
  /* iPadOS с 13 версии представляется настольным Mac — отличаем планшет по мультитачу. */
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return '';
}

function openedAsApp() {
  return (
    window.navigator.standalone === true ||
    ['standalone', 'fullscreen', 'minimal-ui'].some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches)
  );
}

const HOME_SCREEN_STEPS = {
  ios: [
    'Нажмите «Поделиться» (значок квадрата со стрелкой вверх) внизу экрана.',
    'Выберите «На экран „Домой“».',
    'Нажмите «Добавить» — ярлык встанет рядом с приложениями.',
  ],
  android: [
    'Откройте меню браузера — три точки в правом верхнем углу.',
    'Выберите «Установить приложение» или «Добавить на главный экран».',
    'Подтвердите «Установить» — ярлык появится на рабочем столе.',
  ],
};

function offerHomeScreenOnce() {
  const platform = homeScreenPlatform();
  if (!platform || openedAsApp()) return;
  try {
    if (localStorage.getItem(HOME_SCREEN_KEY)) return;
    /* Отмечаем сразу: подсказка не должна возвращаться ни при отказе, ни при сбое. */
    localStorage.setItem(HOME_SCREEN_KEY, String(Date.now()));
  } catch {
    /* Без хранилища подсказка стала бы вечной — молчим. */
    return;
  }

  const body = el('div', 'a2hs');
  const icon = el('img', 'a2hs-icon');
  icon.src = '/icons/icon-192.png';
  icon.alt = '';
  icon.width = 56;
  icon.height = 56;
  const text = el('div', 'a2hs-text');
  text.appendChild(
    el(
      'p',
      '',
      'Вижу, вы открыли сервис с телефона. Добавьте DSH Open на домашний экран — тогда он запускается в одно касание и выглядит как обычное приложение, без адресной строки.',
    ),
  );
  const steps = el('ol', 'a2hs-steps');
  for (const step of HOME_SCREEN_STEPS[platform] || HOME_SCREEN_STEPS.android) {
    steps.appendChild(el('li', '', step));
  }
  text.appendChild(steps);
  body.append(icon, text);
  openModal({ title: 'Добавить на домашний экран', body, actions: [{ label: 'Понятно', kind: 'primary' }] });
}

/* Воркер нужен только ради установки ярлыка как приложения (см. /sw.js): кэша
   в нём нет, обновления подхватываются сразу. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    /* Без воркера сайт работает как раньше: ярлык просто станет закладкой. */
  });
}

/* ------------------------------ boot ------------------------------ */

(async function boot() {
  try {
    const payload = await api('/api/me');
    await startApp(payload);
    $('#boot').classList.add('hidden');
  } catch (error) {
    if (!error.unauthorized) {
      $('#boot').classList.add('hidden');
      showAuth();
    }
  }
  syncSignupAvailability();
  registerServiceWorker();
  /* Телефон вернулся из сна, вкладку открыли снова, сеть восстановилась —
     догоняем задачи, которые всё это время шли на сервере, и заодно
     подтягиваем свежие проекты, диалоги и файлы. */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    resumeLiveRuns();
    syncFromServer();
    checkAppVersion();
  });
  window.addEventListener('online', () => {
    resumeLiveRuns();
    syncFromServer();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      resumeLiveRuns();
      syncFromServer();
    }
  });
  /* Пока вкладка открыта, раз в 20 секунд сверяемся с сервером сами: документы,
     сделанные с телефона, появляются в панели файлов без перезагрузки. */
  setInterval(() => {
    if (!document.hidden) syncFromServer();
  }, 20000);
  /* И раз в минуту смотрим, не выложена ли новая версия страницы. */
  setInterval(checkAppVersion, 60000);
  window.addEventListener('focus', () => {
    syncFromServer();
    checkAppVersion();
  });
  /* Подсказку показываем, когда экран уже нарисован: иначе окно висит над пустой страницей. */
  setTimeout(offerHomeScreenOnce, 1200);
})();

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
  /* Открытая папка — как у открытой рабочей области в Harness: отогнутая
     передняя створка шире задней, поэтому силуэт сразу отличается от
     закрытой папки даже на 17 px. Толщина штриха задана в самой иконке:
     она нарисована в сетке 24, а не 20, и без этого была бы тоньше соседней
     закрытой папки. */
  folderOpen:
    '<svg viewBox="0 0 24 24" aria-hidden="true" style="stroke-width:1.9"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/></svg>',
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
  /* Значки шести блоков «Дашборда»: весы (законы), чек (налоги), столбцы
     (финансы), куб лота (закупки), глобус (рынок). Нарисованы в той же сетке
     20 и той же толщиной, что остальные иконки, поэтому в шапке карточки и в
     списке выглядят как один набор. */
  scale:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.4v13M6.6 16.4h6.8"/><path d="M4.1 6.6h11.8"/><path d="M4.1 6.6L2.3 11.2h3.6zM15.9 6.6l-1.8 4.6h3.6z"/></svg>',
  receipt:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.4 3.4h9.2v13.2l-1.9-1.2-1.6 1.2-1.3-1.2-1.3 1.2-1.6-1.2-1.5 1.2z"/><path d="M7.4 7.2h5.2M7.4 10h5.2"/></svg>',
  chart:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.4 16.6h13.2"/><path d="M6.2 16.6V9.8M10 16.6V4.9M13.8 16.6v-4.4"/></svg>',
  lot: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.4l6.6 3.5L10 10.4 3.4 6.9z"/><path d="M3.4 6.9v6.2L10 16.6l6.6-3.5V6.9"/><path d="M10 10.4v6.2"/></svg>',
  globe:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.6"/><path d="M3.4 10h13.2"/><path d="M10 3.4c3.4 3.7 3.4 9.5 0 13.2M10 3.4c-3.4 3.7-3.4 9.5 0 13.2"/></svg>',
  sliders:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.4 6.4h13.2M3.4 13.6h13.2"/><circle cx="7.6" cy="6.4" r="1.7"/><circle cx="12.4" cy="13.6" r="1.7"/></svg>',
  play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.2 5.2l7.6 4.8-7.6 4.8z"/></svg>',
  calendar:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.4" y="4.6" width="13.2" height="12" rx="1.6"/><path d="M3.4 8.4h13.2M7 3.4v2.4M13 3.4v2.4"/></svg>',
  refresh:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.2 6.6A6.6 6.6 0 105 16.2M16.2 3.6v3.4h-3.4"/></svg>',
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
  /* Уведомления: поддержка браузера, разрешение и подписка этого устройства. */
  push: { supported: false, permission: 'default', subscribed: false, subscriptions: 0, publicKey: '' },
  /* «Дашборд»: шесть постоянных заданий и их настройки. loaded — чтобы не
     запрашивать список заново при каждом открытии экрана. */
  dashboard: emptyDashboardState(),
};

function emptyDashboardState() {
  return { loaded: false, loading: false, tasks: [], tz: 'Europe/Minsk', nextRunAt: null, canAutoRun: false, balanceUsd: 0 };
}

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

/* Уведомление о состоянии — плашкой под шапкой, а не подсказкой внизу экрана.
   Раньше плашка вставала внизу по центру: она перекрывала поле ввода и закрывала
   текст, который человек в этот момент печатал. Теперь она сверху, живёт 5 секунд
   и закрывается щелчком. */
const toastTimers = new Map();

function toastTimer(node) {
  clearTimeout(toastTimers.get(node));
  const timer = setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s ease';
    setTimeout(() => node.remove(), 220);
  }, 5200);
  toastTimers.set(node, timer);
}

function toast(message, type = 'error') {
  const root = $('#toastRoot');
  if (!root) return;
  /* Одна и та же новость не должна вставать стопкой: если такая плашка уже
     висит, продлеваем ей жизнь вместо второй копии. */
  const alive = [...root.children].find((node) => node.dataset.text === message && node.classList.contains(type));
  if (alive) {
    toastTimer(alive);
    return;
  }
  const node = el('div', `toast ${type}`, message);
  node.dataset.text = message;
  node.addEventListener('click', () => node.remove());
  root.appendChild(node);
  /* Больше трёх плашек не держим: старое убираем, чтобы экран не застило. */
  while (root.childElementCount > 3) root.firstElementChild.remove();
  toastTimer(node);
}

/* ------------------------------ markdown ------------------------------ */

const copyStore = new Map();
let copySeq = 0;

/* Файл проекта, упомянутый в ответе, открывается кликом в окне просмотра —
   как двойной щелчок в панели «Файлы проекта». Адрес собираем здесь, а не в
   момент рендера: проект можно сменить, не перерисовывая переписку. */
const MD_FILE_EXTS = 'html?|pdf|docx?|xlsx?|pptx?|csv|tsv|md|txt|json|ya?ml|xml|png|jpe?g|webp|gif|svg|zip';
const MD_FILE_ONE = new RegExp(`^[^\\s/\\\\:*?"'<>|()«»]+\\.(?:${MD_FILE_EXTS})$`, 'i');
const MD_FILE_MANY = new RegExp(
  `^[^\\s/\\\\:*?"'<>|()«»]+(?:/[^\\s/\\\\:*?"'<>|()«»]+)*\\.(?:${MD_FILE_EXTS})$`,
  'i',
);

/* Зоны доменов, которые встречаются в ответах: без списка «отчёт.html» и
   «app.js» тоже стали бы адресами. */
const MD_TLDS =
  'ru|su|by|kz|ua|uz|am|ge|az|com|net|org|io|dev|app|ai|tech|site|online|store|pro|info|biz|cloud|space|xyz|me|mail|page|shop|click|website|digital|media|world|club|live|link|top|news|blog|рф';

const MD_HOST_RE = new RegExp(
  `(^|[\\s(«"'\\[<])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${MD_TLDS})(?::\\d{2,5})?(?:\\/[^\\s<>"'«»()\\[\\]]*)?)`,
  'gi',
);

const MD_FILE_RE = new RegExp(
  `(^|[\\s(«"'\\[<])((?:[^\\s/\\\\:*?"'<>|()«»]+/)*[^\\s/\\\\:*?"'<>|()«»]+\\.(?:${MD_FILE_EXTS}))(?=$|[\\s),.;:!?»"'\\]<])`,
  'gi',
);

function htmlUnescape(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/* Ссылка на файл проекта: относительный путь внутри выбранного проекта. */
function projectFileHref(relPath) {
  const projectId = filesProjectId();
  const clean = String(htmlUnescape(relPath) || '').replace(/^\.?\//, '');
  if (!projectId || !clean) return '#';
  return `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(clean)}`;
}

function inlineMd(text) {
  const codes = [];
  const links = [];
  const holdLink = (html) => {
    const id = `\u0002${links.length}\u0002`;
    links.push(html);
    return id;
  };
  const externalLink = (label, url) =>
    holdLink(`<a class="msg-link" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  const fileLink = (label, path) =>
    holdLink(
      `<a class="msg-link msg-file" href="${projectFileHref(path)}" data-file-path="${path}" title="Открыть в просмотре сервиса">${label}</a>`,
    );

  let src = text.replace(/`([^`\n]+)`/g, (_, code) => {
    /* Имя файла в обратных кавычках — тоже ссылка: в ответах ассистента так
       чаще всего и называют созданную страницу («index.html»). */
    if (MD_FILE_MANY.test(code.trim())) return fileLink(code, code.trim());
    const id = `\u0001${codes.length}\u0001`;
    codes.push(code);
    return id;
  });

  /* [текст](адрес): адрес с протоколом, почта или файл проекта. */
  src = src.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
    if (/^https?:\/\//i.test(href)) return externalLink(label, href);
    if (/^mailto:/i.test(href)) return holdLink(`<a class="msg-link" href="${href}">${label}</a>`);
    const clean = href.replace(/^\.?\//, '');
    if (MD_FILE_MANY.test(clean)) return fileLink(label, clean);
    if (MD_FILE_ONE.test(clean)) return fileLink(label, clean);
    return whole;
  });

  /* Знаки препинания в конце адреса принадлежат фразе, а не ссылке:
     «открой https://example.com, там всё» — запятая остаётся текстом. */
  const trimUrlTail = (url) => url.replace(/[.,;:!?…]+$/, '');

  /* Адрес с протоколом в обычном тексте. */
  src = src.replace(/(^|[\s(«"])(https?:\/\/[^\s<)\]]+)/g, (m, pre, url) => {
    const clean = trimUrlTail(url);
    return `${pre}${externalLink(clean, clean)}${url.slice(clean.length)}`;
  });

  /* «example.ru/путь» и «www.example.ru» без протокола — дописываем https://. */
  src = src.replace(MD_HOST_RE, (m, pre, host) => {
    const clean = trimUrlTail(host);
    return `${pre}${externalLink(clean, `https://${clean}`)}${host.slice(clean.length)}`;
  });

  /* Имя файла проекта в обычном тексте: страница.html, docs/отчёт.pdf. */
  src = src.replace(MD_FILE_RE, (m, pre, path) => `${pre}${fileLink(path, path)}`);

  src = src
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  src = src.replace(/\u0002(\d+)\u0002/g, (_, idx) => links[Number(idx)]);
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
    /* Сеанс мог закончиться по сроку или потому, что в этом же браузере вошли
       заново — объясняем это прямо на экране входа, чтобы выход не выглядел
       случайным сбоем. Число одновременных устройств больше не ограничено. */
    const notice =
      data.reason === 'displaced' && data.error
        ? data.error
        : data.reason === 'displaced'
          ? 'Этот сеанс закрыт — войдите снова.'
          : '';
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

/* Ник запоминаем на этом устройстве: вход обычно живёт сам, но если сеанс всё
   же закончился, человек вводит только пароль — искать ник заново не нужно. */
const LOGIN_NAME_KEY = 'dshow.lastLogin';

function rememberLoginName(username) {
  try {
    if (username) localStorage.setItem(LOGIN_NAME_KEY, username);
  } catch {
    /* Приватный режим: память недоступна — обойдёмся без подсказки. */
  }
}

function rememberedLoginName() {
  try {
    return localStorage.getItem(LOGIN_NAME_KEY) || '';
  } catch {
    return '';
  }
}

function showAuth() {
  state.streaming = false;
  state.user = null;
  state.chat = null;
  $('#app').classList.add('hidden');
  $('#boot').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  /* Уже знакомому устройству подставляем ник и ставим курсор в пароль. */
  const userField = $('#loginUser');
  const known = rememberedLoginName();
  if (known && !userField.value) userField.value = known;
  setTimeout(() => (userField.value ? $('#loginPass') : userField).focus(), 40);
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
    rememberLoginName(username);
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
  const userField = $('#loginUser');
  if (!signup && !userField.value) userField.value = rememberedLoginName();
  if (signup) setTimeout(() => $('#signupUser').focus(), 30);
  else setTimeout(() => (userField.value ? $('#loginPass') : userField).focus(), 30);
}

/* ------------------------------ app init ------------------------------ */

async function startApp(payload) {
  /* При открытии ярлыка показываем стартовый экран, при обычной перезагрузке
     возвращаем открытый диалог. */
  const freshOpen = openedFresh();
  /* Панель файлов, открытую до перезагрузки, запоминаем до сброса состояния:
     resetClientState затирает память вкладки. */
  const savedUi = readFilesUi();
  /* Чистим всё, что могло остаться от предыдущего аккаунта в этой же вкладке. */
  resetClientState();
  state.user = payload.user;
  state.projects = payload.projects || [];
  state.workflows = payload.workflows || [];
  hideAuth();
  $('#boot').classList.add('hidden');
  const accountName = state.user.displayName || state.user.username;
  $('#userName').textContent = accountName;
  /* На телефоне и в приложении-ярлыке подпись у профиля спрятана — имя живёт
     в раскрывающемся списке, поэтому у самой кнопки оно остаётся в подсказке
     и в подписи для чтения с экрана. */
  $('#userChip').title = `Учётная запись: ${accountName}`;
  $('#userChip').setAttribute('aria-label', `Учётная запись: ${accountName}`);
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
  /* Проект, в котором человек работал в момент закрытия: сначала наша
     постоянная память, затем открытая панель файлов, и только потом первый
     проект. Проект мог быть удалён с другого устройства — такую запись
     пропускаем. */
  const lastProject = lastProjectId();
  const lastProjectAlive = lastProject && state.projects.some((project) => project.id === lastProject);
  const uiProject = savedUi ? state.projects.find((project) => project.id === savedUi.projectId) : null;
  const preferredProjectId = (lastProjectAlive ? lastProject : '') || uiProject?.id || first?.id || '';
  state.expanded.clear();
  if (preferredProjectId) {
    state.expanded.add(preferredProjectId);
    state.activeProjectId = preferredProjectId;
  }
  rememberProject(state.activeProjectId);
  /* Панель файлов показывает файлы проекта диалога: отдельного выбора в её
     заголовке нет, поэтому активный проект — единственный источник. */
  syncFilesProjectLabel();
  /* Задачи, которые шли в момент перезагрузки страницы: подхватываем их сразу,
     чтобы работа выглядела непрерывной. */
  for (const run of payload.runs || []) trackRun(run.id, run.chatId);
  renderSidebar();
  if (freshOpen) {
    /* Стартовый экран: поле ввода и подсказки, но без автоматически открытого
       диалога — человек сам решит, продолжить прошлый разговор или начать новый. */
    state.chat = null;
    state.activeChatId = null;
    renderThread();
  } else {
    /* Перезагрузка страницы: открываем диалог с живой задачей, иначе последний
       открытый, иначе первый в проекте — человек возвращается туда, где работал. */
    const runningChat = (payload.runs || []).find((run) => findChatProject(run.chatId));
    const remembered = lastChatId();
    const target =
      runningChat?.chatId || (remembered && findChatProject(remembered) ? remembered : '') || activeProject()?.chats?.[0]?.id || '';
    if (target) await openChat(target);
    else renderThread();
  }
  updateCrumbs();
  watchWideBlocks();
  /* Панель «Файлы проекта», открытая до перезагрузки, возвращается открытой:
     так после системного просмотрщика на телефоне человек остаётся у списка
     файлов, а не оказывается в чате. */
  const restoredUi = restoreFilesUi(savedUi);
  if (state.activeProjectId) syncFilesPanel({ reload: !restoredUi });
  /* Черновик возвращаем, если страница сама обновилась до новой версии. */
  restoreDraft();
  /* Уведомления включаются сами после входа: человек ничего не настраивает. */
  pushRegistered = false;
  void ensurePush();
  /* Сервер должен знать, что человек сейчас в сервисе: тогда пуш о готовой
     задаче не уйдёт ни на это устройство, ни на телефон. */
  startPresence();
  checkAppVersion();
  /* На телефоне не забираем фокус сами: при открытии ярлыка клавиатура
     выезжала поверх ещё не отрисованного диалога. Фокус — только по тапу. */
  focusComposerOnOpen();
}

function activeProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

/* Правая панель всегда показывает файлы активного проекта — того, который
   открыт в панели «Проекты» слева. Отдельного выбора в заголовке нет: два
   источника проекта (панель слева и заголовок справа) расходились, и файлы
   «пропадали» после очередной сверки с сервером. */
function filesProjectId() {
  const id = state.activeProjectId || '';
  return id && state.projects.some((project) => project.id === id) ? id : '';
}

function filesProject() {
  const id = filesProjectId();
  return state.projects.find((project) => project.id === id) || null;
}

/* Заголовок панели — подпись, а не кнопка. Имя проекта видно во всплывающей
   подсказке: сама подпись остаётся неизменной и стоит по центру блока. */
function syncFilesProjectLabel() {
  const title = $('#filesProjectTitle');
  const label = $('#filesProjectName');
  if (!label) return;
  label.textContent = 'Файлы проекта';
  const project = filesProject();
  if (title) title.title = project ? `Файлы проекта «${project.name}»` : 'Файлы проекта';
}

/* Переключение диалога или проекта просто освежает подпись: файлы панели уже
   принадлежат активному проекту. */
function followActiveProject() {
  rememberProject(state.activeProjectId);
  syncFilesProjectLabel();
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
  /* Открытый проект — открытая папка (как в рабочей области Harness):
     переключатель состояния виден прямо на значке строки. */
  const projectIcon = project.id === state.activeProjectId ? ICONS.folderOpen : ICONS.folder;
  row.innerHTML = `<span class="p-caret${chats.length ? '' : ' is-empty'}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 8l4 4 4-4"/></svg></span><span class="f-icon">${projectIcon}</span><span class="p-name">${escapeHtml(project.name)}</span>`;
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
      /* Панель файлов возвращается к проекту, который открыли в диалоге. */
      followActiveProject();
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

/* Кнопка-меню в шапке подсвечивается, когда проект выбран: по ней видно, что
   в ящике проектов есть открытый проект, — так же, как подсвечена кнопка
   «Дашборд», пока открыт дашборд. */
function syncSidebarToggle() {
  const burger = $('#sidebarToggle');
  if (!burger) return;
  const hasProject = Boolean(state.activeProjectId);
  burger.classList.toggle('active', hasProject);
  burger.setAttribute('aria-pressed', String(hasProject));
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
  syncSidebarToggle();
}

function updateCrumbs() {
  /* Подсветка кнопки-меню не зависит от того, что показано в колонке диалога. */
  syncSidebarToggle();
  /* Экран «Дашборд» сам держит заголовок в крошке: перерисовка диалога в фоне
     не должна подменять его названием чата. */
  if (dashboardOpen()) return;
  const project = activeProject();
  const projectName = project?.name || '';
  const chatTitle = state.chat?.title || '';
  const crumb = $('#crumbChat');
  crumb.textContent = chatTitle;
  crumb.title = chatTitle;
  crumb.classList.toggle('hidden', !chatTitle);
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

/* Последний проект, в котором человек работал. В отличие от открытого диалога,
   он нужен и тогда, когда в момент закрытия приложения человек стоял на
   стартовом экране: запоминаем проект при каждом переключении, а не только
   вместе с диалогом. */
const LAST_PROJECT_KEY = 'dshow.lastProject';

function rememberProject(projectId) {
  if (!state.user || !projectId) return;
  try {
    localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    /* Приватный режим браузера — не критично. */
  }
}

function lastProjectId() {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY) || '';
  } catch {
    return '';
  }
}

/* Ярлык-приложение открыли заново или страницу просто обновили? При
   перезагрузке возвращаем человека в открытый диалог, а при новом запуске
   показываем стартовый экран в последнем проекте. */
function openedFresh() {
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    if (nav?.type) return nav.type === 'navigate';
    if (performance.navigation) return performance.navigation.type === 0;
  } catch {
    /* остаёмся на безопасном варианте — как при новом запуске */
  }
  return true;
}

async function openChat(chatId) {
  /* Переключение во время ответа теперь разрешено: работа идёт на сервере, а
     вкладка просто показывает другой диалог и возвращается к потоку позже. */
  hideDashboard();
  try {
    const data = await api(`/api/chats/${chatId}`);
    state.chat = data.chat;
    state.activeChatId = chatId;
    state.activeProjectId = state.chat.projectId;
    state.expanded.add(state.activeProjectId);
    state.attachments = [];
    renderAttachStrip();
    /* Диалог другого проекта — панель файлов переходит к его проекту. */
    followActiveProject();
    state.filesPath = '.';
    if (data.chat.run?.id) trackRun(data.chat.run.id, chatId);
    renderSidebar();
    renderThread();
    updateCrumbs();
    if (state.filesOpen) loadFiles('.');
    if (!restoreFilesUi()) closeSidebar();
    rememberChat(chatId);
    /* В этом диалоге идёт задача — подключаемся и показываем накопленное. */
    const run = liveRunFor(chatId);
    if (run) {
      paintRun(run);
      if (!state.liveStreams.has(run.id)) watchRun(run.id, chatId);
    } else {
      setStreaming(false);
    }
    /* Открытие диалога на телефоне не должно само поднимать клавиатуру:
       человек сначала читает переписку, а поле получает фокус по тапу. */
    focusComposerOnOpen();
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
    followActiveProject();
  }
  const project = activeProject();
  const created = await api(`/api/projects/${state.activeProjectId}/chats`, { method: 'POST', body: {} });
  const chat = { id: created.chat.id, projectId: state.activeProjectId, title: 'Новый диалог', messages: [] };
  if (project) {
    project.chats = project.chats || [];
    /* Новый диалог встаёт в конец: список идёт по времени создания, а не по
       последней активности. */
    project.chats.push(created.chat);
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

/* Стрелки прокрутки у правого края ленты. Колонка показывается, только когда
   ленте есть куда листать, и гаснет у верхнего и нижнего края — нажатие на
   неактивную стрелку ничего не делает, но фокус с кнопки не слетает. */
let syncScrollJump = () => {};

function initScrollJump() {
  const scroller = $('#scroll');
  const jump = $('#scrollJump');
  const up = $('#scrollUp');
  const down = $('#scrollDown');
  if (!scroller || !jump || !up || !down) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0;
  let placedTop = '';

  const measure = () => ({
    max: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    top: scroller.scrollTop,
  });

  /* Центр колонки — центр именно ленты, а не всей колонки приложения: сверху
     шапка, снизу поле ввода, и их высоты меняются (ввод растёт, клавиатура
     поднимается). Поэтому положение считается по фактическим прямоугольникам. */
  function place() {
    const main = jump.offsetParent;
    if (!(main instanceof HTMLElement)) return;
    const box = scroller.getBoundingClientRect();
    if (box.height < 1) return;
    const mainBox = main.getBoundingClientRect();
    const value = `${Math.round(box.top - mainBox.top + box.height / 2)}px`;
    if (value !== placedTop) {
      placedTop = value;
      jump.style.top = value;
    }
  }

  function sync() {
    frame = 0;
    place();
    const { max, top } = measure();
    const scrollable = max > 24;
    jump.classList.toggle('on', scrollable);
    jump.inert = !scrollable;
    jump.setAttribute('aria-hidden', scrollable ? 'false' : 'true');
    const atTop = !scrollable || top <= 1;
    const atBottom = !scrollable || top >= max - 1;
    up.classList.toggle('is-off', atTop);
    down.classList.toggle('is-off', atBottom);
    up.setAttribute('aria-disabled', String(atTop));
    down.setAttribute('aria-disabled', String(atBottom));
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(sync);
  }

  function step(direction) {
    const { max, top } = measure();
    if (max <= 24) return;
    /* Одна страница — чуть меньше видимой высоты, чтобы у следующего экрана
       оставалась зацепка: последняя строка предыдущего остаётся на виду. */
    const page = Math.max(140, Math.round(scroller.clientHeight * 0.82));
    const target = Math.max(0, Math.min(max, top + direction * page));
    if (target === top) return;
    scroller.scrollTo({ top: target, behavior: reduceMotion.matches ? 'instant' : 'smooth' });
  }

  up.addEventListener('click', () => step(-1));
  down.addEventListener('click', () => step(1));
  scroller.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    if ($('#thread')) observer.observe($('#thread'));
  }
  if ('MutationObserver' in window && $('#thread')) {
    new MutationObserver(schedule).observe($('#thread'), {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  syncScrollJump = schedule;
  sync();
}

function renderEmpty() {
  const thread = $('#thread');
  thread.innerHTML = '';
  const empty = el('div', 'empty');
  empty.innerHTML = `
    <div class="empty-mark">${WHALE_SVG}</div>
    <h2 class="empty-title">Чем помочь?</h2>
    <p class="empty-sub">Выберите подсказку или напишите задачу.</p>
    <div class="suggestions" aria-label="Возможности ассистента">
      <button class="suggestion" type="button" data-prompt="Подготовь отчёт в Word и Excel по данным проекта: таблицы, расчёты и выводы.">Word и Excel</button>
      <button class="suggestion" type="button" data-prompt="Сделай презентацию по материалам проекта: слайды с тезисами, цифрами и выводами.">Презентация</button>
      <button class="suggestion" type="button" data-prompt="Разбери файлы проекта: выдели главное, ключевые цифры и возможные ошибки.">Разбор файлов</button>
      <button class="suggestion" type="button" data-prompt="Распознай текст на скриншотах или фото проекта и собери его в аккуратный документ.">Фото в текст</button>
      <button class="suggestion" type="button" data-prompt="Найди актуальные данные по теме в интернете, проверь по первоисточникам и оформи ссылки.">Поиск в интернете</button>
      <button class="suggestion" type="button" data-prompt="Собери по описанию готовую страницу сайта, лендинг или 3D-схему, с адаптацией под телефон. Для лендинга: первый экран с заголовком и призывом к действию, блоки с выгодами и ценами, форма заявки.">Сайт, лендинг, 3D</button>
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
  /* Проект берём оттуда же, откуда его берёт панель: иначе фоновая сверка
     приносила файлы другого проекта и подменяла список под рукой. */
  const projectId = filesProjectId();
  if (!projectId || !state.filesOpen) return;
  let data;
  try {
    data = await api(`/api/projects/${projectId}/files?path=${encodeURIComponent(state.filesPath)}&depth=6`);
  } catch {
    return; /* нет связи — остаётся то, что уже нарисовано */
  }
  if (projectId !== filesProjectId() || state.filesPath !== (data.path || '.')) return;
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
      syncFilesProjectLabel();
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

/* Ящик «Проекты» открывается кнопкой-меню и свайпом вправо на телефоне.
   Панель файлов при этом закрываем: два затемнения поверх друг друга не
   нужны, а открытым должен остаться ровно один ящик. */
function openSidebarDrawer() {
  closeMenus();
  closePopover();
  if (state.filesDrawerOpen) closeFilesDrawer();
  $('#app').classList.add('sidebar-open');
}

function toggleSidebarDrawer() {
  if ($('#app').classList.contains('sidebar-open')) closeSidebar();
  else openSidebarDrawer();
}

/* Панель «Файлы проекта» — постоянный правый блок: на широком экране её
   нельзя закрыть (ничего в разметке этого и не обещает). До 1100 px ширина
   экрана мала, поэтому панель превращается в выезжающий ящик, который
   открывается и закрывается кнопкой-папкой в шапке. */
const filesNarrow = () => window.matchMedia('(max-width: 1100px)').matches;

/* Открытая панель файлов переживает перезагрузку страницы. Телефон иногда
   показывает файл системным окном и возвращает уже новую страницу — без этой
   памяти человек оказывался в чате вместо списка, из которого открывал файл. */
const FILES_UI_KEY = 'dshow:files-ui';

function saveFilesUi() {
  /* До входа в аккаунт запоминать нечего: разметка страницы строится раньше,
     чем приходит сессия, и такая «пустая» запись затирала открытую панель. */
  if (!state.user) return;
  try {
    sessionStorage.setItem(
      FILES_UI_KEY,
      JSON.stringify({ projectId: filesProjectId(), drawer: Boolean(state.filesDrawerOpen), path: state.filesPath || '.' }),
    );
  } catch {
    /* Приватный режим может запрещать хранилище — панель просто не запомнится. */
  }
}

function readFilesUi() {
  try {
    const raw = sessionStorage.getItem(FILES_UI_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return saved && typeof saved === 'object' ? saved : null;
  } catch {
    return null;
  }
}

function restoreFilesUi(saved = readFilesUi()) {
  if (!saved || !saved.drawer) return false;
  if (!filesNarrow() || !state.activeProjectId) return false;
  if (saved.projectId && saved.projectId !== filesProjectId()) return false;
  if (state.filesDrawerOpen) return false;
  state.filesDrawerOpen = true;
  state.filesPath = saved.path && saved.path !== '.' ? saved.path : '.';
  syncFilesPanel();
  loadFiles(state.filesPath);
  return true;
}

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
  saveFilesUi();
  applyLayout();
  syncFilesProjectLabel();
  if (open && reload && filesProjectId()) {
    state.filesPath = '.';
    loadFiles('.');
  }
}

function openFilesDrawer({ reload = true } = {}) {
  if (!filesNarrow() || state.filesDrawerOpen) return;
  state.filesDrawerOpen = true;
  syncFilesPanel({ reload });
}

function toggleFilesDrawer() {
  if (!filesNarrow()) return;
  if (state.filesDrawerOpen) closeFilesDrawer();
  else openFilesDrawer();
}

function closeFilesDrawer() {
  if (!state.filesDrawerOpen) return;
  state.filesDrawerOpen = false;
  syncFilesPanel();
}

/* Сообщение о файлах — строкой в самой панели, а не всплывающей подсказкой внизу
   экрана: подсказка вставала поверх поля ввода и закрывала набранный текст.
   Строка занимает своё место в потоке панели и исчезает сама. */
function filesNote(text) {
  const node = $('#filesNote');
  if (!node) return;
  clearTimeout(filesNote.timer);
  node.textContent = text;
  node.classList.remove('hidden');
  filesNote.timer = setTimeout(() => node.classList.add('hidden'), 9000);
}

async function loadFiles(relPath) {
  const projectId = filesProjectId();
  if (!projectId) return;
  /* Проект мог смениться, пока шёл запрос: ответ от прошлого проекта не должен
     перерисовать список уже выбранного. */
  const list = $('#filesList');
  list.innerHTML = '<div class="files-empty"><div class="spin-lg"></div></div>';
  state.filesLoading = true;
  try {
    const data = await api(`/api/projects/${projectId}/files?path=${encodeURIComponent(relPath)}&depth=6`);
    if (projectId !== filesProjectId()) return;
    state.filesPath = relPath;
    state.files = data.items || [];
    renderFiles();
  } catch (error) {
    if (projectId !== filesProjectId()) return;
    list.innerHTML = '';
    list.appendChild(el('div', 'files-empty', error.message));
  } finally {
    if (projectId === filesProjectId()) state.filesLoading = false;
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
    /* Подсказка про управление: на телефоне — тап, на компьютере — двойной щелчок.
       В обоих случаях файл открывается в окне просмотра приложения. */
    const touch = isTouchUi();
    name.title = item.dir
      ? item.path
      : touch
        ? `${item.path} — нажмите, чтобы открыть в приложении; кнопка «Скачать» — сохранить файл`
        : `${item.path} — двойной щелчок: открыть в приложении; кнопка «Скачать» — сохранить файл`;
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
        await api(`/api/projects/${filesProjectId()}/file?path=${encodeURIComponent(item.path)}`, { method: 'DELETE' });
        loadFiles(state.filesPath);
      } catch (error) {
        filesNote(error.message);
      }
    });
    actions.appendChild(del);
    row.appendChild(actions);
    const activate = () => {
      if (item.dir) loadFiles(item.path);
      else openFilePreview(item);
    };
    row.addEventListener('click', () => {
      if (item.dir) {
        loadFiles(item.path);
        return;
      }
      /* На тач-экране одиночный тап открывает файл в окне просмотра (скачивание —
         только кнопкой «Скачать»). На компьютере открывает двойной щелчок — и тоже
         в окне просмотра: внешние Word/Excel/PowerPoint больше не вызываются, они
         показывали системное окно «Microsoft Office» с вопросом про безопасность. */
      if (isTouchUi()) openFilePreview(item);
    });
    row.addEventListener('dblclick', (event) => {
      if (item.dir || isTouchUi()) return;
      /* Двойной щелчок по кнопке «Скачать» — это два скачивания, а не открытие. */
      if (event.target.closest('.f-actions')) return;
      event.preventDefault();
      openFilePreview(item);
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
  return `/api/projects/${filesProjectId()}/file?path=${encodeURIComponent(relPath)}${suffix}`;
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

/* Сохранение файла внутрь устройства без выхода из приложения.

   Раньше кнопка «Скачать» отдавала системе прямую ссылку на файл: в
   приложении-ярлыке (и на телефоне, и на компьютере) это открывало чужое окно
   «чем открыть файл» — уже не наше приложение, без «назад» и без «закрыть».
   Вернуться оттуда было нечем, приходилось закрывать и открывать ярлык.

   Теперь файл сначала забирается внутрь приложения обычным fetch, а дальше
   сохраняется из памяти (blob): окно приложения остаётся на месте со всем
   разговором, загрузка уходит в «Загрузки» — и там уже человек сам решает,
   чем открывать. */
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  /* Ссылку отпускаем не мгновенно: браузеру нужно успеть начать сохранение. */
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* Забрать файл у сервера и сразу сохранить. Возвращает имя файла. */
async function saveFileFromServer(url, name) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Не удалось скачать «${name}» (${response.status})`);
  saveBlob(await response.blob(), name);
  return name;
}

/* Клик по кнопке «Скачать» сохраняет оригинал к себе — молча, без всплывающих
   подсказок: подсказка вставала снизу поверх поля ввода и закрывала текст,
   который человек в этот момент печатал. Об успехе говорит сама загрузка
   браузера, об ошибке — тихая строка в панели файлов.

   Скачивание — единственный путь к правке в Word/Excel: открывать документ
   сразу во внешней программе больше нельзя (см. ниже). */
function openFileViewer(item) {
  /* Один файл — одно сохранение. Пока запрос за файлом не завершился, повторные
     нажатия (двойной щелчок, второй тап, кнопка в окне просмотра) игнорируются:
     иначе браузер показывал в «Загрузках» две строки одного файла. */
  const key = `${filesProjectId()}:${item.path}`;
  const busy = openFileViewer.busy || (openFileViewer.busy = new Set());
  if (busy.has(key)) return;
  busy.add(key);
  saveFileFromServer(fileUrl(item.path, true), item.name)
    .catch((error) => {
      filesNote(`${error.message}. Попробуйте ещё раз.`);
    })
    .finally(() => {
      busy.delete(key);
    });
}

/* Тач-устройство определяем по трём признакам: сенсорные экраны бывают и с
   «мышиным» указателем (планшеты с пером, режим DeX), а вести себя они должны
   как телефон: одиночный тап по файлу сразу открывает окно просмотра. */
function isTouchUi() {
  return (
    (navigator.maxTouchPoints || 0) > 0 ||
    window.matchMedia('(pointer: coarse)').matches ||
    window.matchMedia('(any-pointer: coarse)').matches
  );
}

/* Телефон или компьютер — от этого зависит текст подсказок. Мобильную систему
   узнаём по тому же User-Agent, что и ярлык на домашний экран; узкий
   тач-экран тоже считаем телефоном, даже если система представилась
   настольной (так делает iPadOS). */
function isPhoneUi() {
  return Boolean(homeScreenPlatform()) || (isTouchUi() && window.matchMedia('(max-width: 860px)').matches);
}

/* Куда попадёт скачанный файл — для подсказок «он откроется на телефоне /
   на компьютере». */
function onPhoneWord() {
  return isPhoneUi() ? 'телефоне' : 'компьютере';
}

/* Открытие диалога на телефоне не должно само поднимать клавиатуру: человек
   сначала читает переписку, а поле получает фокус по тапу. На узком окне
   (в том числе в ярлыке-приложении) ведём себя так же. */
function focusComposerOnOpen() {
  if (window.matchMedia('(max-width: 860px)').matches || isPhoneUi()) return;
  const input = $('#input');
  if (input) input.focus({ preventScroll: true });
}

/* Внешние Word, Excel и PowerPoint сервис больше не вызывает — ни на телефоне,
   ни на компьютере. Раньше документ уходил в них по протоколу
   ms-word:ofe|u|<ссылка>, программа сама скачивала файл из интернета, и после
   этого Office показывал системное окно «Microsoft Office» с вопросом, открывать
   ли файл (а внутри — защищённый просмотр).

   Окно нельзя убрать со стороны сервера: метку «файл из интернета»
   (Mark-of-the-Web, поток Zone.Identifier) ставит Windows в момент скачивания,
   и никакой заголовок ответа её не отменяет. Поэтому документ открывается в окне
   просмотра самого сервиса (там он читается без всяких окон), а для правки
   остаётся кнопка «Скачать» — файл сохраняется в «Загрузки». */

/* -------------------- просмотр файла внутри приложения -------------------- */

/* Раньше тап по файлу на телефоне сразу скачивал его: iOS открывал чужую
   программу (или страницу «Открыть в WeChat»), из которой не было выхода.
   Теперь файл открывается в своём окне с кнопкой «Закрыть»: PDF, картинки и
   текст показываем здесь же, а для Word/Excel/PowerPoint подсказываем
   бесплатные приложения и оставляем явную кнопку «Скачать». */

const PREVIEW_IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;
const PREVIEW_TEXT = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml|ini|conf|srt)$/i;
/* Документы Office показываем в своём окне. Внешние Word, Excel и PowerPoint
   больше не вызываются: именно они открывали системное окно «Microsoft
   Office» с вопросом, открывать ли файл из интернета. */
const OFFICE_DOC = /\.(docx?|docm|dotx?|dotm|rtf|odt|xlsx?|xlsm|xlsb|xltx?|ods|pptx?|pptm|ppsx?|potx?|odp)$/i;

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

/* Подсказка под документом: на телефоне — какие приложения поставить, на
   компьютере — что файл надо скачать и открыть в установленной программе.
   Текст про телефон на настольной версии сбивал с толку. */
function officeHintBody() {
  const wrap = el('div', 'file-hint');
  if (!isPhoneUi()) {
    wrap.appendChild(
      el(
        'p',
        '',
        'Здесь документ открыт только для чтения. Чтобы открыть и править его, нажмите «Скачать» — файл сохранится в «Загрузки» и откроется в Word, Excel или PowerPoint на компьютере.',
      ),
    );
    return wrap;
  }
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
    status.textContent = isPhoneUi()
      ? 'Не удалось показать PDF. Скачайте файл — он откроется в приложении для PDF на телефоне.'
      : 'Не удалось показать PDF. Скачайте файл — он откроется в программе для PDF на компьютере.';
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

/* ------------------------ строим документ для чтения ------------------------
   Сервер присылает структуру (заголовки, абзацы с выделением, списки, таблицы,
   листы книги, слайды), а не готовую разметку: здесь мы собираем её через DOM,
   поэтому текст файла никогда не становится исполняемым HTML. */

const PV_TONE = {
  docx: 'word', docm: 'word', doc: 'word', rtf: 'word', odt: 'word', dotx: 'word',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', xlsb: 'sheet', csv: 'sheet', tsv: 'sheet', ods: 'sheet',
  pptx: 'slide', pptm: 'slide', ppt: 'slide', ppsx: 'slide', odp: 'slide',
  pdf: 'pdf',
  html: 'web', htm: 'web',
  md: 'text', markdown: 'text', txt: 'text', log: 'text',
};

const PV_CODE = /^(json|js|mjs|cjs|ts|css|py|ps1|sh|sql|bat|xml|ya?ml|ini|conf|env|srt)$/i;

/* Вид файла задаёт пропорции окна просмотра. Таблице нужен размах по горизонту:
   в узком окне колонки сжимаются и цифры читаются по одной. Документу Word —
   наоборот: окно пошире, но строка текста остаётся удобной длины. Страница
   живёт почти как вкладка браузера. На телефоне окно и так занимает весь экран,
   поэтому там важнее не ширина, а прокрутка таблицы внутри окна. */
const PV_KIND = {
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', xlsb: 'sheet', ods: 'sheet', csv: 'sheet', tsv: 'sheet',
  docx: 'word', docm: 'word', doc: 'word', rtf: 'word', odt: 'word', dotx: 'word', dotm: 'word',
  pptx: 'slide', pptm: 'slide', ppt: 'slide', ppsx: 'slide', odp: 'slide',
  pdf: 'pdf',
  html: 'web', htm: 'web',
};

function previewKindOf(name) {
  const ext = fileExtOf(name);
  if (PV_KIND[ext]) return PV_KIND[ext];
  return PREVIEW_IMAGE.test(name) ? 'image' : 'text';
}

function fileExtOf(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

function pvBadge(name) {
  const ext = fileExtOf(name);
  const tone = PV_TONE[ext] || (PV_CODE.test(ext) ? 'code' : 'plain');
  return el('span', `pv-badge pv-${tone}`, (ext.length > 4 ? ext.slice(0, 4) : ext).toUpperCase() || 'ФАЙЛ');
}

function pvSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  if (size >= 1024) return `${Math.max(1, Math.round(size / 1024))} КБ`;
  return `${size} байт`;
}

function pvKindLabel(name) {
  const ext = fileExtOf(name);
  const map = {
    docx: 'Документ Word', docm: 'Документ Word', doc: 'Документ Word', rtf: 'Документ RTF', odt: 'Документ OpenDocument',
    xlsx: 'Таблица Excel', xlsm: 'Таблица Excel', xls: 'Таблица Excel', csv: 'Таблица CSV', tsv: 'Таблица TSV', ods: 'Таблица OpenDocument',
    pptx: 'Презентация', pptm: 'Презентация', ppt: 'Презентация', odp: 'Презентация',
    pdf: 'Документ PDF',
    html: 'Веб-страница', htm: 'Веб-страница',
    md: 'Текст Markdown', markdown: 'Текст Markdown', txt: 'Текст', log: 'Журнал',
    json: 'Данные JSON',
    png: 'Изображение', jpg: 'Изображение', jpeg: 'Изображение', webp: 'Изображение', gif: 'Изображение', svg: 'Изображение',
    zip: 'Архив',
  };
  return map[ext] || (PV_CODE.test(ext) ? 'Код' : 'Файл');
}

function pvSummary(item) {
  return [pvKindLabel(item.name), pvSize(item.size)].filter(Boolean).join(' · ');
}

function pvRunNode(run) {
  let node = document.createTextNode(run.text);
  if (run.underline) {
    const tag = document.createElement('u');
    tag.appendChild(node);
    node = tag;
  }
  if (run.italic) {
    const tag = document.createElement('em');
    tag.appendChild(node);
    node = tag;
  }
  if (run.bold || run.strike) {
    const tag = document.createElement(run.strike ? 's' : 'strong');
    tag.appendChild(node);
    node = tag;
  }
  return node;
}

function pvAppendRuns(node, runs) {
  for (const run of runs || []) {
    if (!run || !run.text) continue;
    const parts = String(run.text).split('\n');
    parts.forEach((part, index) => {
      if (index) node.appendChild(document.createElement('br'));
      if (part) node.appendChild(pvRunNode({ ...run, text: part }));
    });
  }
}

function pvParagraph(runs, align) {
  const node = el('p', 'pv-p');
  if (align) node.classList.add(`pv-${align}`);
  pvAppendRuns(node, runs);
  return node;
}

function pvCell(container, cell) {
  const td = el('div', 'pv-td');
  if (Array.isArray(cell)) {
    cell.forEach((line, index) => {
      if (index) td.appendChild(el('div', 'pv-td-gap'));
      const lineNode = el('span', 'pv-td-line');
      pvAppendRuns(lineNode, line);
      td.appendChild(lineNode);
    });
  } else {
    const text = String(cell ?? '');
    td.textContent = text;
    if (/^[-+]?[\d\s]+(?:[.,]\d+)?\s*(?:%|₽|\$|€|руб\.?)?$/.test(text.trim())) td.classList.add('pv-num');
  }
  container.appendChild(td);
}

/* Текст ячейки без разметки: нужен, чтобы отличить объединённую строку
   (заголовок листа, примечание) от обычной строки с данными. */
function pvCellText(cell) {
  if (Array.isArray(cell)) {
    return cell.map((line) => (line || []).map((run) => (run && run.text) || '').join('')).join(' ');
  }
  return String(cell ?? '');
}

/* Таблица листа и таблица документа выглядят одинаково: сетка, подписи в
   первой строке, числа по правому краю. */
function pvGrid(rows, { header = false, span = false } = {}) {
  const box = el('div', 'pv-table-box');
  const list = (rows || []).filter((row) => Array.isArray(row) && row.length);
  const width = list.reduce((max, row) => Math.max(max, row.length), 0);
  /* У широкой таблицы (больше пяти колонок) на телефоне строку не переносим:
     её читают прокруткой в сторону, как лист Excel. Две-три колонки наоборот
     переносим — так на экране сразу видны и подпись, и значение. */
  if (width > 5) box.classList.add('pv-many-cols');
  /* Ячейка, объединённая по всей ширине листа (название таблицы, примечание),
     приходит одной непустой ячейкой в первой колонке. В узкой колонке такой
     текст раздувает её на пол-экрана, поэтому такую строку выводим отдельно —
     она идёт поперёк всей таблицы, как в Excel. */
  const spanText = (row) =>
    span &&
    row.length === width &&
    width > 1 &&
    pvCellText(row[0]).trim() !== '' &&
    row.slice(1).every((cell) => pvCellText(cell).trim() === '')
      ? pvCellText(row[0])
      : null;
  const table = el('table', 'pv-table');
  const tbody = document.createElement('tbody');
  const addSpanRow = (text) => {
    const tr = document.createElement('tr');
    tr.className = 'pv-row-span';
    const td = document.createElement('td');
    td.colSpan = width;
    td.textContent = text;
    tr.appendChild(td);
    tbody.appendChild(tr);
  };
  let rest = list.slice();
  let headPart = header && rest.length ? rest[0] : null;
  if (headPart) rest = rest.slice(1);
  /* Если объединённое название листа попало в шапку, оно становится подписью
     над таблицей, а шапкой — следующая за ним настоящая строка заголовков. */
  const banner = headPart && spanText(headPart);
  if (banner && rest.length) {
    const caption = document.createElement('caption');
    caption.className = 'pv-table-title';
    caption.textContent = banner;
    table.appendChild(caption);
    headPart = rest[0];
    rest = rest.slice(1);
  }
  if (headPart) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const cell of headPart) {
      const th = document.createElement('th');
      th.textContent = pvCellText(cell);
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
  }
  for (const row of rest) {
    const span = spanText(row);
    if (span !== null) {
      addSpanRow(span);
      continue;
    }
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      pvCell(td, cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
  return box;
}

function pvNotice(text) {
  return el('p', 'pv-notice', text);
}

function pvDocument(data) {
  const wrap = el('div', 'pv-doc');
  for (const block of data.blocks || []) {
    if (block.type === 'heading') {
      const level = Math.min(Math.max(Number(block.level) || 1, 1), 6);
      const heading = el('div', `pv-h pv-h${level}`);
      pvAppendRuns(heading, block.runs);
      wrap.appendChild(heading);
    } else if (block.type === 'list') {
      const list = document.createElement(block.ordered ? 'ol' : 'ul');
      list.className = 'pv-list';
      if (block.level) list.classList.add(`pv-list-${Math.min(block.level + 1, 3)}`);
      for (const item of block.items || []) {
        const li = document.createElement('li');
        pvAppendRuns(li, item.runs);
        list.appendChild(li);
      }
      wrap.appendChild(list);
    } else if (block.type === 'table') {
      wrap.appendChild(pvGrid(block.rows || [], { header: Boolean(block.header) }));
    } else {
      wrap.appendChild(pvParagraph(block.runs, block.align));
    }
  }
  if (!wrap.childElementCount) wrap.appendChild(pvNotice('В документе нет текста для чтения — скачайте файл.'));
  for (const extra of data.extras || []) {
    if (!extra || !extra.text) continue;
    wrap.appendChild(pvNotice(`${extra.title}: ${extra.text}`));
  }
  for (const warning of data.warnings || []) wrap.appendChild(pvNotice(warning));
  return wrap;
}

function pvSheets(sheets) {
  const wrap = el('div', 'pv-sheets');
  const tabs = el('div', 'pv-sheet-tabs');
  const body = el('div', 'pv-sheet-body');
  wrap.append(tabs, body);
  const paint = (index) => {
    const sheet = sheets[index];
    body.innerHTML = '';
    body.appendChild(pvGrid(sheet.rows || [], { header: true, span: true }));
    if (sheet.truncated) body.appendChild(pvNotice('Показаны первые строки листа — остальные видны в скачанном файле.'));
    [...tabs.children].forEach((tab, tabIndex) => tab.classList.toggle('is-active', tabIndex === index));
  };
  sheets.forEach((sheet, index) => {
    const tab = el('button', 'pv-sheet-tab', sheet.name || `Лист ${index + 1}`);
    tab.type = 'button';
    tab.addEventListener('click', () => paint(index));
    tabs.appendChild(tab);
  });
  if (sheets.length > 1) tabs.classList.remove('hidden');
  else tabs.classList.add('hidden');
  paint(0);
  return wrap;
}

function pvSlides(slides) {
  const wrap = el('div', 'pv-slides');
  for (const slide of slides) {
    const card = el('article', 'pv-slide');
    card.appendChild(el('div', 'pv-slide-no', `Слайд ${slide.number}`));
    const title = el('div', 'pv-slide-title');
    title.textContent = slide.title;
    card.appendChild(title);
    if (slide.lines && slide.lines.length) {
      const list = document.createElement('ul');
      list.className = 'pv-list';
      for (const line of slide.lines) {
        const li = document.createElement('li');
        li.textContent = line;
        list.appendChild(li);
      }
      card.appendChild(list);
    }
    wrap.appendChild(card);
  }
  return wrap;
}

function pvCodeBlock(text) {
  return el('pre', 'preview-text', String(text || '').slice(0, 200000));
}

/* HTML-страница открывается как страница — в рамке, ровно как ссылка в ответе
   ассистента, только без перехода в новую вкладку. Страница живёт в песочнице:
   у неё нет доступа к сессии сервиса и к нашему окну. */
function mountHtmlPreview(container, item) {
  const status = el('div', 'preview-status', 'Открываем страницу…');
  container.appendChild(status);
  const frame = document.createElement('iframe');
  frame.className = 'preview-frame';
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms allow-modals');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = item.name;
  frame.addEventListener('load', () => {
    status.remove();
    frame.classList.add('is-ready');
  });
  frame.src = `/api/projects/${filesProjectId()}/file-page?path=${encodeURIComponent(item.path)}`;
  container.appendChild(frame);
}

async function mountDocPreview(container, item) {
  const status = el('div', 'preview-status', 'Читаем документ…');
  container.appendChild(status);
  let data;
  try {
    data = await api(`/api/projects/${filesProjectId()}/file-preview?path=${encodeURIComponent(item.path)}`);
  } catch (error) {
    status.remove();
    /* Ошибка чаще всего значит, что файл уже удалён или переименован. Текст
       подсказывает, куда он попадёт после «Скачать», — так же, как ниже. */
    container.appendChild(
      pvNotice(
        isPhoneUi()
          ? `${error.message}. Скачайте файл — он откроется в приложении на телефоне.`
          : `${error.message}. Скачайте файл — он откроется в программе на компьютере.`,
      ),
    );
    container.appendChild(officeHintBody());
    return;
  }
  status.remove();
  const format = String(data.format || 'other');
  const text = String(data.text || '');
  const truncated = text.length > 200000;

  if (format === 'docx' && Array.isArray(data.blocks)) {
    container.appendChild(pvDocument(data));
    return;
  }
  if (format === 'xlsx' && Array.isArray(data.sheets) && data.sheets.length) {
    container.appendChild(pvSheets(data.sheets));
    return;
  }
  if (format === 'pptx' && Array.isArray(data.slides) && data.slides.length) {
    container.appendChild(pvSlides(data.slides));
    return;
  }
  if (format === 'table' && Array.isArray(data.rows) && data.rows.length) {
    container.appendChild(pvGrid(data.rows, { header: true, span: true }));
    if (data.truncated) container.appendChild(pvNotice('Показаны первые строки таблицы.'));
    return;
  }
  if (format === 'markdown' && text.trim()) {
    const node = el('div', 'md md-preview');
    node.innerHTML = renderMarkdown(text);
    container.appendChild(node);
    if (truncated) container.appendChild(pvNotice('Показано начало файла.'));
    return;
  }
  if (text.trim()) {
    container.appendChild(pvCodeBlock(text));
    for (const warning of data.warnings || []) container.appendChild(pvNotice(warning));
    return;
  }
  container.appendChild(
    pvNotice(
      isPhoneUi()
        ? 'Из этого файла не удалось прочитать содержимое — скачайте его, чтобы открыть в приложении на телефоне.'
        : 'Из этого файла не удалось прочитать содержимое — скачайте его, чтобы открыть в программе на компьютере.',
    ),
  );
  for (const warning of data.warnings || []) container.appendChild(pvNotice(warning));
  container.appendChild(officeHintBody());
}

function openFilePreview(item) {
  /* Та же защита от двойного тапа, что и у скачивания. */
  const key = `${filesProjectId()}:${item.path}`;
  const now = Date.now();
  if (key === openFilePreview.lastKey && now - openFilePreview.lastAt < 600) return;
  openFilePreview.lastKey = key;
  openFilePreview.lastAt = now;

  const url = fileUrl(item.path, false);
  const body = el('div', 'file-preview');
  const ext = fileExtOf(item.name);
  const kind = previewKindOf(item.name);

  /* Документ Office читается здесь же — без Word и без окна безопасности.
     Для правки человеку нужен сам файл, поэтому подсказываем кнопку «Скачать». */
  if (OFFICE_DOC.test(item.name)) {
    body.appendChild(
      el(
        'p',
        'pv-hint',
        'Документ открыт в просмотре сервиса. Чтобы править его, скачайте файл кнопкой «Скачать» — он откроется в Word, Excel или PowerPoint на вашем ' +
          onPhoneWord() + '.',
      ),
    );
  }

  if (PREVIEW_IMAGE.test(item.name)) {
    const img = el('img', 'preview-img');
    img.src = url;
    img.alt = item.name;
    body.appendChild(img);
  } else if (ext === 'pdf') {
    const holder = el('div', 'pdf-box');
    body.appendChild(holder);
    mountPdfPreview(holder, url);
  } else if (ext === 'html' || ext === 'htm') {
    mountHtmlPreview(body, item);
  } else {
    mountDocPreview(body, item);
  }

  /* Окно открывается поверх панели файлов, а не вместо неё: после «Закрыть»
     человек остаётся там же, где выбирал файл. */
  const reopenDrawer = Boolean(state.filesDrawerOpen) && filesNarrow();
  openModal({
    title: item.name,
    headLead: pvBadge(item.name),
    subtitle: pvSummary(item),
    body,
    wide: true,
    /* Ширина и высота окна — по виду файла: таблица разворачивается по
       горизонту, документ Word держит удобную строку, страница идёт во всю
       высоту экрана без нижней полосы кнопок (закрыть можно крестиком в шапке,
       клавишей Esc или тапом мимо окна). */
    className: `file-preview-modal pv-kind-${kind}`,
    rootClass: 'preview-open',
    actions:
      kind === 'web'
        ? []
        : [
            {
              label: 'Скачать',
              onClick: () => {
                openFileViewer(item);
              },
            },
            { label: 'Закрыть', kind: 'primary' },
          ],
    onClose: () => {
      if (reopenDrawer && !state.filesDrawerOpen) {
        state.filesDrawerOpen = true;
        syncFilesPanel();
      }
    },
  });
}


/* Загрузка файлов в проект. dir — папка внутри проекта ('.' — корень):
   файл попадает туда, где пользователь сейчас находится в «Файлах проекта». */
async function uploadToProject(fileList, dir = state.filesPath) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const projectId = filesProjectId();
  if (!projectId) {
    filesNote('Сначала выберите проект — файл добавится в его папку.');
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
        const response = await fetch(`/api/projects/${projectId}/upload?path=${encodeURIComponent(rel)}`, {
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
        filesNote(error.message);
      }
    }
  } finally {
    if (button) button.disabled = false;
    if (label) label.textContent = previousLabel;
  }
  if (added) {
    /* Успех виден по самому списку: файл уже в панели. Всплывающее окно здесь
       только мешало — оно закрывало поле ввода снизу экрана. */
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

function openContextMenu(anchor, items, head = null) {
  /* Повторное нажатие на ту же кнопку сворачивает её список: меню ведёт себя
     как обычный переключатель, а не открывается заново поверх себя. */
  if (menuAnchor === anchor && $$('.menu').length) {
    closeMenus();
    return;
  }
  closeMenus();
  menuAnchor = anchor;
  const menu = el('div', 'menu');
  if (head) menu.appendChild(head);
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
  /* Меню сворачивается от любого действия вне его: нажатие мышью, касание
     пальцем, прокрутка ленты или панели. pointerdown закрывает меню и на
     телефоне — раньше слушали только mousedown, а на сенсорном экране его
     может не быть вовсе (жест уходит в прокрутку), и меню оставалось висеть. */
  setTimeout(() => {
    if (menuAnchor !== anchor) return;
    const closer = (event) => {
      if (menu.contains(event.target)) return;
      /* Кнопка, из которой открыт список, закрывает его своим обработчиком:
         иначе нажатие на неё сначала гасило меню, а потом открывало заново. */
      if (anchor.contains(event.target)) return;
      closeMenus();
    };
    const cleaner = () => {
      closeMenus();
    };
    document.addEventListener('pointerdown', closer, true);
    document.addEventListener('touchstart', closer, { capture: true, passive: true });
    document.addEventListener('mousedown', closer, true);
    document.addEventListener('scroll', cleaner, true);
    window.addEventListener('wheel', cleaner, { passive: true });
    window.addEventListener('touchmove', cleaner, { passive: true });
    /* Снимаем слушатели сразу после закрытия меню — чистим за собой вручную,
       потому что меню может исчезнуть и от выбора пункта, и от смены экрана. */
    const watch = setInterval(() => {
      if (menu.isConnected) return;
      clearInterval(watch);
      document.removeEventListener('pointerdown', closer, true);
      document.removeEventListener('touchstart', closer, true);
      document.removeEventListener('mousedown', closer, true);
      document.removeEventListener('scroll', cleaner, true);
      window.removeEventListener('wheel', cleaner);
      window.removeEventListener('touchmove', cleaner);
    }, 400);
  }, 0);
}

function openModal({ title, subtitle, headLead, body, actions = [], wide = false, className = '', rootClass = '', onMount, onClose }) {
  const root = $('#modalRoot');
  root.innerHTML = '';
  root.className = `modal-root${rootClass ? ` ${rootClass}` : ''}`;
  const modal = el('div', `modal${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`);
  const head = el('div', 'modal-head');
  if (headLead) head.appendChild(headLead);
  const headText = el('div', 'modal-head-text');
  const titleNode = el('div', 'modal-title', title);
  titleNode.title = title;
  headText.appendChild(titleNode);
  if (subtitle) headText.appendChild(el('div', 'modal-sub', subtitle));
  head.appendChild(headText);
  const close = el('button', 'btn btn-ghost btn-icon modal-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрыть');
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
  /* Нет кнопок — нет и нижней полосы: у окна просмотра HTML-страницы остаётся
     одна шапка с крестиком, а сама страница занимает всю высоту. */
  if (actions.length) modal.appendChild(foot);
  root.appendChild(modal);
  modalCloseHook = typeof onClose === 'function' ? onClose : null;

  root.onmousedown = (event) => {
    if (event.target === root) closeModal();
  };
  document.onkeydown = (event) => {
    if (event.key === 'Escape') {
      closeModal();
    }
  };
  if (onMount) onMount(bodyNode, modal, apiActions);
  return modal;
}

let modalCloseHook = null;

function closeModal() {
  const root = $('#modalRoot');
  if (!root || root.classList.contains('hidden')) {
    const hook = modalCloseHook;
    modalCloseHook = null;
    if (hook) hook();
    return;
  }
  root.classList.add('hidden');
  root.className = 'modal-root hidden';
  root.innerHTML = '';
  root.onmousedown = null;
  document.onkeydown = null;
  const hook = modalCloseHook;
  modalCloseHook = null;
  if (hook) hook();
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

/* Строка учётной записи в начале меню профиля. В шапке ник теперь виден только
   на широком экране, а на телефоне и в приложении-ярлыке убран из ряда значков
   (иначе кнопка профиля шире соседей и промежутки между значками разные) — там
   имя показывается здесь. На широком экране строку прячет CSS: ник и так виден
   в шапке. */
function userMenuHead() {
  const head = el('div', 'menu-account');
  const main = el('div', 'menu-account-main');
  main.innerHTML =
    '<svg class="account-glyph" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3.2"/><path d="M4.5 16.2c.9-2.7 3-4.2 5.5-4.2s4.6 1.5 5.5 4.2"/></svg>';
  const text = el('div', 'menu-account-text');
  const name = state.user?.displayName || state.user?.username || '';
  text.appendChild(el('div', 'menu-account-name', name));
  if (state.user?.role === 'admin') text.appendChild(el('div', 'menu-account-role', 'Администратор'));
  main.appendChild(text);
  head.appendChild(main);
  head.appendChild(el('div', 'sep'));
  return head;
}

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
  openContextMenu(event.currentTarget, items, userMenuHead());
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
        /* Удалили проект, чьи файлы показывала панель, — переходим к живому. */
        followActiveProject();
        state.filesPath = '.';
        if (state.filesOpen) loadFiles('.');
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
    /* Если проект был активным, панель уже перешла к живому; удаление чужого
       проекта на панель не влияет. */
    syncFilesProjectLabel();
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
    project.chats.push(created.chat);
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
      /* Проекты идут по времени создания — новый встаёт в конец списка. */
      state.projects.push(project);
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
      followActiveProject();
      state.filesPath = '.';
      if (state.filesOpen) loadFiles('.');
      /* Телефон: проект создаётся из ящика «Проекты», и ящик закрывается сам —
         иначе новый диалог оставался под ним: поля ввода не видно, сообщение
         отправить некуда. На широком экране эта строка ничего не меняет. */
      closeSidebar();
      $('#input').focus({ preventScroll: true });
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
  state.filesDrawerOpen = false;
  state.filesLoading = false;
  /* Запомненное состояние панели принадлежит прошлому аккаунту — не переносим. */
  try {
    sessionStorage.removeItem(FILES_UI_KEY);
  } catch {
    /* ignore */
  }
  state.expanded = new Set();
  state.collapsedWorkflows = new Set();
  state.lastTitle = '';
  /* Задания «Дашборда» принадлежат аккаунту: чужое расписание не показываем. */
  hideDashboard();
  state.dashboard = emptyDashboardState();
  state.dragOut = false;
}

async function logout() {
  /* Сначала говорим серверу «ушёл»: после сброса состояния он уже не поймёт,
     чья это была вкладка. */
  sendPresence(false, { beacon: true });
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

/* --- рассылка уведомлений ---
   Администратор пишет объявление (например, о новой функции) и отправляет его
   всем или выбранным людям. Рядом видно не только тех, кому можно писать, но и
   тех, у кого уведомления выключены на самом устройстве: браузер запретил,
   разрешение ещё не спрашивали или приложение ни разу не открывали. */
const PUSH_STATUS = {
  on: { label: 'включены', cls: 'on' },
  off: { label: 'выключены', cls: 'off' },
  pending: { label: 'ждут разрешения', cls: 'pending' },
  'no-subscription': { label: 'нет подписки', cls: 'pending' },
  unsupported: { label: 'не поддерживаются', cls: 'muted' },
  unknown: { label: 'нет данных', cls: 'muted' },
};

function pushStatusInfo(item) {
  if (item.enabled > 0 && (item.disabled > 0 || item.pending > 0)) {
    return { label: 'включены не везде', cls: 'partial' };
  }
  if (item.enabled > 0) return PUSH_STATUS.on;
  if (item.disabled > 0) return PUSH_STATUS.off;
  if (item.noSub > 0) return PUSH_STATUS['no-subscription'];
  if (item.pending > 0) return PUSH_STATUS.pending;
  if (item.unsupported > 0) return PUSH_STATUS.unsupported;
  return PUSH_STATUS.unknown;
}

function pushSeenText(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/* --- резервные копии ---
   Копии состояния: переписки и структура проектов. Файлы проектов живут в томе
   отдельно и выгружаются кнопкой «Скачать архив», а вот случайно удалённый
   проект или испорченный индекс раньше восстановить было нечем. Здесь видно,
   когда сделана последняя копия, и можно снять её вручную перед рискованным
   действием. */
function backupWhen(item) {
  const iso = item.createdAt || `${item.id}T00:00:00`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return item.id;
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function renderBackups(container) {
  let data = null;
  try {
    data = await api('/api/admin/backups');
  } catch {
    return;
  }
  const wrap = el('div', 'backup-block');
  wrap.appendChild(el('div', 'admin-section-title', 'Резервные копии диалогов и файлов'));
  const last = data.backups?.[0];
  const schedule = data.automatic
    ? `Копии делаются автоматически раз в сутки, хранится до ${data.keep} штук.`
    : 'Автоматические копии выключены — снимайте их вручную.';
  const parts = last
    ? [
        `${last.chats} ${plural(last.chats, 'диалог', 'диалога', 'диалогов')}`,
        last.workspaces ? `${last.workspaces} ${plural(last.workspaces, 'проект', 'проекта', 'проектов')} с файлами` : '',
        fmtSize(last.bytes),
      ].filter(Boolean)
    : [];
  const summary = last
    ? `Последняя копия: ${backupWhen(last)} · ${parts.join(' · ')}.`
    : 'Копий ещё нет: первая появится в течение минуты после запуска сервиса.';
  wrap.appendChild(el('div', 'backup-hint', `${schedule} ${summary}`));

  const actions = el('div', 'backup-actions');
  const makeBtn = el('button', 'btn', 'Сделать копию сейчас');
  makeBtn.type = 'button';
  makeBtn.addEventListener('click', async () => {
    makeBtn.disabled = true;
    try {
      await api('/api/admin/backups', { method: 'POST' });
      toast('Резервная копия готова', 'ok');
      await renderBackups(container);
    } catch (error) {
      toast(error.message);
      makeBtn.disabled = false;
    }
  });
  actions.appendChild(makeBtn);
  wrap.appendChild(actions);

  if (data.backups?.length) {
    const list = el('div', 'backup-list');
    for (const item of data.backups.slice(0, 5)) {
      const row = el('div', 'backup-row');
      row.appendChild(el('div', 'backup-date', backupWhen(item)));
      const line = [`${item.chats} ${plural(item.chats, 'диалог', 'диалога', 'диалогов')}`];
      if (item.workspaces) line.push(`${item.workspaces} ${plural(item.workspaces, 'проект', 'проекта', 'проектов')}`);
      line.push(fmtSize(item.bytes));
      row.appendChild(el('div', 'backup-sub', line.join(' · ')));
      const link = el('a', 'btn', 'Скачать');
      link.href = `/api/admin/backups/download?id=${encodeURIComponent(item.id)}`;
      link.setAttribute('download', '');
      row.appendChild(link);
      list.appendChild(row);
    }
    wrap.appendChild(list);
  }
  /* Место в панели забронировано заранее — меняем только содержимое. */
  container.replaceChildren(wrap);
}

function renderPushBroadcast(body, users) {
  body.appendChild(el('div', 'admin-section-title', 'Рассылка уведомлений'));
  const card = el('div', 'push-broadcast');
  const hint = el('p', 'push-broadcast-hint', 'Смотрим, у кого включены уведомления…');
  const summary = el('div', 'push-summary');
  summary.hidden = true;

  const form = el('form', 'push-form');
  const titleField = el('label', 'field');
  titleField.appendChild(el('span', 'field-label', 'Заголовок'));
  const titleInput = el('input');
  titleInput.placeholder = 'Например: «Новая функция — напоминания»';
  titleInput.maxLength = 80;
  titleField.appendChild(titleInput);
  form.appendChild(titleField);

  const textField = el('label', 'field');
  textField.appendChild(el('span', 'field-label', 'Текст'));
  const textInput = el('textarea');
  textInput.rows = 3;
  textInput.maxLength = 300;
  textInput.placeholder = 'Коротко: что появилось и как этим пользоваться';
  textField.appendChild(textInput);
  form.appendChild(textField);

  const audienceField = el('label', 'field');
  audienceField.appendChild(el('span', 'field-label', 'Кому'));
  const audience = el('select');
  for (const [value, label] of [
    ['all', 'Всем, у кого включены уведомления'],
    ['some', 'Только отмеченным'],
  ]) {
    const option = el('option', '', label);
    option.value = value;
    audience.appendChild(option);
  }
  audienceField.appendChild(audience);
  form.appendChild(audienceField);

  const pickerHead = el('div', 'push-picker-head');
  pickerHead.appendChild(el('span', 'push-picker-title', 'Получатели'));
  const pickerNote = el('span', 'push-picker-note', 'Отметить можно только устройства с включёнными уведомлениями');
  pickerHead.appendChild(pickerNote);
  form.appendChild(pickerHead);

  const picker = el('div', 'push-picker');
  form.appendChild(picker);

  const actions = el('div', 'push-actions');
  const sendBtn = el('button', 'btn btn-primary', 'Отправить уведомление');
  sendBtn.type = 'submit';
  actions.appendChild(sendBtn);

  /* Проверка — отдельным действием и только на свои устройства. Так админ
     видит, что уведомление доходит, и не будит весь сервис словом «Тест». */
  const testBtn = el('button', 'btn btn-quiet', 'Проверить на себе');
  testBtn.type = 'button';
  testBtn.title = 'Проверка уходит только на ваши устройства';
  actions.appendChild(testBtn);
  form.appendChild(actions);

  const testHint = el('p', 'push-broadcast-hint', 'Проверка уходит только на ваши устройства — остальные пользователи её не получат.');
  form.appendChild(testHint);

  const note = el('p', 'field-error');
  form.appendChild(note);
  const resultLine = el('p', 'push-broadcast-hint');
  resultLine.hidden = true;
  form.appendChild(resultLine);
  card.appendChild(hint);
  card.appendChild(summary);
  card.appendChild(form);
  body.appendChild(card);

  let entries = [];
  let boxes = [];

  const syncAudience = () => {
    const all = audience.value === 'all';
    for (const box of boxes) {
      const available = box.dataset.available === '1';
      box.disabled = !available || all;
      box.checked = available && all;
      box.closest('.push-pick')?.classList.toggle('on', box.checked);
      box.closest('.push-pick')?.classList.toggle('available', available);
    }
  };

  const renderPicker = () => {
    picker.innerHTML = '';
    boxes = [];
    if (!entries.length) {
      picker.appendChild(el('p', 'push-broadcast-hint', 'Пользователей пока нет.'));
      return;
    }
    for (const item of entries) {
      const available = item.enabled > 0;
      const row = el('label', 'push-pick');
      row.dataset.available = available ? '1' : '0';
      row.classList.toggle('available', available);

      const box = el('input');
      box.type = 'checkbox';
      box.value = item.userId;
      box.dataset.available = available ? '1' : '0';
      box.addEventListener('change', () => row.classList.toggle('on', box.checked));
      row.appendChild(box);

      const avatar = el('span', 'push-pick-avatar', (item.displayName || item.username || '?').charAt(0));
      row.appendChild(avatar);

      const main = el('span', 'push-pick-main');
      const nameLine = el('span', 'push-pick-name');
      nameLine.textContent = item.displayName || item.username || 'Без имени';
      if (item.role === 'admin') nameLine.appendChild(el('span', 'badge', 'админ'));
      main.appendChild(nameLine);

      const login = item.username ? `@${item.username}` : '';
      const seen = pushSeenText(item.lastLoginAt);
      const meta = [login, seen ? `заходил ${seen}` : 'ещё не входил'].filter(Boolean).join(' · ');
      main.appendChild(el('span', 'push-pick-meta', meta));

      /* Устройства показываем по одному: администратору важно видеть, что
         именно на телефоне уведомления выключены, а на ноутбуке — включены. */
      const deviceLine = el('span', 'push-devices');
      const deviceList = Array.isArray(item.deviceList) ? item.deviceList : [];
      for (const device of deviceList.slice(0, 3)) {
        const status = PUSH_STATUS[device.status] || PUSH_STATUS.unknown;
        const chip = el('span', `push-device ${status.cls}`);
        chip.appendChild(el('span', 'push-device-dot'));
        const label = `${device.device || 'Устройство'}${device.app ? ' · приложение' : ''} · ${status.label}`;
        chip.appendChild(document.createTextNode(label));
        const seenDevice = pushSeenText(device.lastSeenAt);
        chip.title = seenDevice ? `Последний раз: ${seenDevice}` : label;
        deviceLine.appendChild(chip);
      }
      if (deviceList.length > 3) deviceLine.appendChild(el('span', 'push-device more', `+${deviceList.length - 3}`));
      if (!deviceList.length) deviceLine.appendChild(el('span', 'push-device muted', 'нет данных с устройства'));
      main.appendChild(deviceLine);
      row.appendChild(main);

      const status = pushStatusInfo(item);
      const chip = el('span', `push-status ${status.cls}`, status.label);
      if (item.enabled > 0 && deviceList.length > 1 && item.enabled < deviceList.length) {
        chip.textContent = `${status.label} · ${item.enabled} из ${deviceList.length}`;
      }
      row.appendChild(chip);
      picker.appendChild(row);
      boxes.push(box);
    }
    syncAudience();
  };

  api('/api/admin/push')
    .then((data) => {
      entries = Array.isArray(data.users) ? data.users : [];
      const counts = data.summary || {};
      const totalPeople = Number(counts.users) || entries.length;
      const enabledPeople = Number(counts.withEnabled) || 0;
      const enabledDevices = Number(counts.devicesEnabled) || 0;
      if (enabledDevices) {
        hint.textContent =
          `Уведомления включены у ${enabledPeople} из ${totalPeople} ${plural(totalPeople, 'человека', 'человек', 'человек')} — ` +
          `сообщение получат ${enabledDevices} ${plural(enabledDevices, 'устройство', 'устройства', 'устройств')}. ` +
          'Остальные видны ниже с причиной.';
      } else {
        hint.textContent =
          'Пока ни у кого не включены уведомления. Ниже видно, на каком устройстве что мешает — отправлять пока некому.';
      }
      const mkStat = (value, label, cls) => {
        const chip = el('span', `push-stat ${cls || ''}`);
        chip.appendChild(el('span', 'push-stat-value', String(value)));
        chip.appendChild(el('span', 'push-stat-label', label));
        return chip;
      };
      summary.innerHTML = '';
      summary.append(
        mkStat(enabledPeople, 'включены', 'on'),
        mkStat(Number(counts.offOnly) || 0, 'выключены', 'off'),
        mkStat(Number(counts.noSubOnly) || 0, 'нет подписки', 'pending'),
        mkStat(Number(counts.pendingOnly) || 0, 'ждут разрешения', 'pending'),
        mkStat(Number(counts.noData) || 0, 'без данных', 'muted'),
      );
      summary.hidden = false;
      renderPicker();
    })
    .catch(() => {
      hint.textContent = 'Не удалось получить состояние устройств. Список получателей пока недоступен.';
    });

  audience.addEventListener('change', syncAudience);

  testBtn.addEventListener('click', async () => {
    note.textContent = '';
    resultLine.hidden = true;
    const title = titleInput.value.trim() || 'DSH Open — проверка уведомлений';
    const text =
      textInput.value.trim() || 'Уведомления работают: так придёт сообщение о готовой задаче.';
    testBtn.disabled = true;
    const caption = testBtn.textContent;
    testBtn.textContent = 'Отправляем…';
    try {
      const result = await api('/api/admin/push', {
        method: 'POST',
        body: { test: true, title, text },
      });
      if (result.sent) {
        toast(
          `Проверка ушла на ${result.sent} ${plural(result.sent, 'устройство', 'устройства', 'устройств')} — только вам`,
          'ok',
        );
      } else {
        toast('Ваше устройство не приняло проверочное уведомление', 'error');
      }
    } catch (error) {
      note.textContent = error.message;
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = caption;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    note.textContent = '';
    resultLine.hidden = true;
    const title = titleInput.value.trim();
    const text = textInput.value.trim();
    if (!title) {
      note.textContent = 'Заполните заголовок';
      titleInput.focus();
      return;
    }
    if (!text) {
      note.textContent = 'Заполните текст';
      textInput.focus();
      return;
    }
    const selected = audience.value === 'some';
    const userIds = boxes.filter((box) => box.checked).map((box) => box.value);
    if (selected && !userIds.length) {
      note.textContent = 'Отметьте хотя бы одного получателя с включёнными уведомлениями';
      return;
    }
    sendBtn.disabled = true;
    const caption = sendBtn.textContent;
    sendBtn.textContent = 'Отправляем…';
    try {
      const result = await api('/api/admin/push', {
        method: 'POST',
        body: { all: !selected, userIds, title, text },
      });
      if (result.sent) {
        toast(
          `Уведомление ушло на ${result.sent} ${plural(result.sent, 'устройство', 'устройства', 'устройств')}`,
          'ok',
        );
        titleInput.value = '';
        textInput.value = '';
        for (const box of boxes) {
          box.checked = false;
          box.closest('.push-pick')?.classList.remove('on');
        }
        syncAudience();
      } else {
        toast('Ни одно устройство не приняло уведомление', 'error');
      }
      if (result.skipped) {
        resultLine.textContent = `Не дойдёт: ${result.skipped} ${plural(result.skipped, 'человеку', 'людям', 'людям')} — у них уведомления выключены или устройства ещё не подключены.`;
        resultLine.hidden = false;
      }
    } catch (error) {
      note.textContent = error.message;
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = caption;
    }
  });
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

  renderPushBroadcast(body, users);

  /* Место под копии бронируем сразу, а заполняем после ответа сервера. */
  const backupHolder = el('div');
  body.appendChild(backupHolder);
  void renderBackups(backupHolder);

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

/* Сколько места может занять поле ввода. На телефоне считаем от видимой
   области, а не от полного окна: с открытой клавиатурой прежний предел
   (42% окна) занимал почти весь экран, и каждая новая строка сдвигала ленту. */
function composerMaxHeight() {
  if (window.matchMedia('(max-width: 860px)').matches) {
    const visible = Math.round(window.visualViewport?.height || window.innerHeight);
    return Math.max(96, Math.min(200, Math.round(visible * 0.3)));
  }
  return Math.max(180, Math.min(420, Math.round(window.innerHeight * 0.42)));
}

let lastComposerLength = -1;

function autoResize(force = false) {
  const input = $('#input');
  if (!input) return;
  /* Если лента была у последнего сообщения, после роста поля оставляем её там:
     иначе при сжатии ленты scrollTop обрезался и сообщения «прыгали» вниз. */
  const stick = nearBottom();
  // Пустое поле — всегда одна строка: иначе подсказка в тесной строке ввода
  // переносится и раздувает её до двух-трёх строк ещё до начала набора.
  if (!input.value.trim()) {
    input.style.height = '';
    input.style.overflowY = 'hidden';
    lastComposerLength = 0;
    if (stick) scrollToBottom(true);
    return;
  }
  const max = composerMaxHeight();
  const current = parseFloat(input.style.height) || 0;
  /* Высоту схлопываем только когда текст стал короче (или по просьбе).
     На каждый символ это вызывало пересчёт всей ленты и дёргало экран. */
  const shrink = force || !current || input.value.length < lastComposerLength || current > max + 1;
  if (shrink) {
    input.style.height = 'auto';
  }
  lastComposerLength = input.value.length;
  /* scrollHeight текстового поля никогда не меньше его текущей высоты —
     он включает clientHeight. Прибавлять к нему +3 на каждом символе нельзя:
     поле росло на 3 px за нажатие, пока не упиралось в предел, и «скакало».
     Поэтому, если текст ещё помещается, высоту не трогаем; растём только
     когда scrollHeight действительно стал больше clientHeight. */
  const needed = input.scrollHeight;
  const fits = !shrink && needed <= input.clientHeight + 1;
  const next = fits ? current : Math.min(needed, max);
  if (Math.abs(next - current) > 0.5) {
    input.style.height = `${next}px`;
  }
  input.style.overflowY = needed > max ? 'auto' : 'hidden';
  /* Курсор в конце длинного текста: после смены высоты браузер иногда
     оставляет поле прокрученным вверх, и последняя строка не видна. */
  const caret = input.selectionStart ?? input.value.length;
  if (needed > max && caret >= input.value.length) input.scrollTop = input.scrollHeight;
  if (stick) scrollToBottom(true);
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
  syncThemeChrome(light);
}

/* Верхняя полоса телефона: непрозрачный fixed/sticky-элемент у верхнего края
   (шапка) и theme-color — для iOS до 26 и Android. Сэмплеру Safari 26 и
   приложения-ярлыка нужен новый цвет сразу после переключения, иначе полоса
   остаётся старой до следующей перерисовки. */
function syncThemeChrome(light) {
  const bg = light ? '#ffffff' : '#151517';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
  /* Полоса состояния приложения-ярлыка следует за темой: у тёмной темы страница
     сама закрашивает полосу (black-translucent), у светлой — системная белая
     (default). Подробности — в theme.js. */
  syncStatusBarStyle(light);
  const root = document.documentElement;
  root.style.backgroundColor = bg;
  if (document.body) document.body.style.backgroundColor = bg;
  const app = document.getElementById('app');
  if (app) app.style.backgroundColor = bg;
  const tint = document.querySelector('.status-tint');
  if (tint) tint.style.backgroundColor = bg;
  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.style.backgroundColor = bg;
  /* Принудительный кадр: Safari забирает цвет у fixed-слоя при отрисовке. */
  void root.offsetHeight;
}

/* Смена режима полосы состояния на ходу: iOS перерисовывает полосу сразу, но
   env(safe-area-inset-top) не пересчитывает — в тёмной теме страница уезжает под
   часы, кнопки шапки обрезаются (так и было, пока полосу держали на default).
   Поэтому в приложении-ярлыке после смены режима перезапускаем страницу: тема
   сохранена в localStorage, theme.js при загрузке выставит режим до отрисовки, и
   раскладка сразу получит правильный отступ. Цикла нет: после перезапуска
   значение уже нужное и повторный перезапуск не срабатывает. */
function syncStatusBarStyle(light) {
  const meta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (!meta) return;
  const want = light ? 'default' : 'black-translucent';
  if (meta.getAttribute('content') === want) return;
  meta.setAttribute('content', want);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) location.reload();
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

/* ------------------------------- дашборд -------------------------------
   Шесть постоянных заданий: что нового в законах, налоги и отчётность, деньги
   компании, кадры и охрана труда, тендеры и закупки, рынок и конкуренты.
   Время считает сервер (см. src/dashboard.mjs), а экран показывает карточки,
   даёт включить нужное, поправить день, час, проект и текст задания и
   запустить отчёт руками — не дожидаясь расписания. */

const DASH_ICON_BY_BLOCK = {
  law: 'scale',
  taxes: 'receipt',
  finance: 'chart',
  people: 'users',
  tenders: 'lot',
  market: 'globe',
};
const DASH_CADENCES = [
  ['weekly', 'Каждую неделю'],
  ['monthly', 'Каждый месяц'],
  ['quarterly', 'Раз в квартал'],
];
const DASH_WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const DASH_STATUS = {
  running: 'выполняется',
  done: 'готово',
  error: 'ошибка',
  skipped: 'пропущено',
  stopped: 'остановлено',
};

function dashboardOpen() {
  const view = $('#dashboardView');
  return Boolean(view) && !view.classList.contains('hidden');
}

/* Расписание человеческими словами. Считаем от настроек, а не от ответа
   сервера: в окне настроек человек меняет день и час, и подпись должна
   меняться сразу, до сохранения. */
function dashboardScheduleLabel({ cadence, dayOfMonth, dayOfWeek, hour }) {
  const time = `${String(hour).padStart(2, '0')}:00`;
  if (cadence === 'weekly') return `${DASH_WEEKDAYS[Math.min(7, Math.max(1, dayOfWeek)) - 1]}, ${time}`;
  if (cadence === 'quarterly') return `раз в квартал, ${dayOfMonth}-го числа, ${time}`;
  return `каждый месяц, ${dayOfMonth}-го числа, ${time}`;
}

function dashboardWhen(iso) {
  if (!iso) return '';
  const tz = state.dashboard.tz || 'Europe/Minsk';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      timeZone: tz,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

async function showDashboard() {
  const view = $('#dashboardView');
  if (!view) return;
  closePopover();
  closeModal();
  closeSidebar();
  closeFilesDrawer();
  view.classList.remove('hidden');
  $('#app').classList.add('dash-open');
  $('#dashboardBtn').classList.add('active');
  $('#dashboardBtn').setAttribute('aria-pressed', 'true');
  const crumb = $('#crumbChat');
  crumb.textContent = 'Дашборд';
  crumb.title = 'Дашборд';
  crumb.classList.remove('hidden');
  document.title = 'Дашборд — DSH Open';
  /* Данные держим в памяти: экран открывается мгновенно, а свежесть
     подтягиваем в фоне. */
  if (state.dashboard.loaded) renderDashboard();
  await loadDashboard();
}

function hideDashboard() {
  const view = $('#dashboardView');
  if (!view || view.classList.contains('hidden')) return;
  view.classList.add('hidden');
  $('#app').classList.remove('dash-open');
  $('#dashboardBtn').classList.remove('active');
  $('#dashboardBtn').setAttribute('aria-pressed', 'false');
  updateCrumbs();
  /* Вернулись из дашборда: лента снова видима, пересчитываем её середину. */
  syncScrollJump();
}

async function loadDashboard() {
  const grid = $('#dashGrid');
  if (!state.dashboard.loaded && grid) {
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = '';
    for (let index = 0; index < 6; index += 1) grid.appendChild(el('div', 'dash-card dash-card-ghost'));
  }
  try {
    const data = await api('/api/dashboard');
    state.dashboard.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    state.dashboard.tz = data.tz || state.dashboard.tz;
    state.dashboard.nextRunAt = data.nextRunAt || null;
    state.dashboard.canAutoRun = Boolean(data.canAutoRun);
    state.dashboard.balanceUsd = Number(data.balanceUsd || 0);
    state.dashboard.loaded = true;
    renderDashboard();
  } catch (error) {
    if (error.unauthorized) return;
    if (!grid) return;
    grid.setAttribute('aria-busy', 'false');
    grid.innerHTML = '';
    grid.appendChild(el('p', 'dash-error', error.message || 'Не удалось загрузить задания'));
  }
}

function renderDashboard() {
  const grid = $('#dashGrid');
  if (!grid) return;
  grid.setAttribute('aria-busy', 'false');
  grid.innerHTML = '';
  for (const task of state.dashboard.tasks) grid.appendChild(dashboardCard(task));
  if (!state.dashboard.tasks.length) {
    grid.appendChild(el('p', 'dash-error', 'Заданий нет — обновите экран, сервер создаст их заново.'));
  }

  const enabled = state.dashboard.tasks.filter((task) => task.enabled);
  const allButton = $('#dashEnableAll');
  if (allButton) {
    allButton.textContent = enabled.length === state.dashboard.tasks.length ? 'Выключить всё' : 'Включить всё';
    allButton.disabled = !state.dashboard.tasks.length;
  }

  const notice = $('#dashNotice');
  if (!notice) return;
  let text = '';
  let kind = 'note';
  if (!state.dashboard.canAutoRun) {
    text = 'На балансе нет средств: по расписанию задания не запустятся. Пополните баланс — или запускайте отчёты вручную, сразу после пополнения.';
    kind = 'warn';
  } else if (!enabled.length) {
    text = 'Все задания выключены. Включите нужные переключателем или нажмите «Включить всё» — дальше отчёты будут появляться сами.';
  }
  notice.className = `dash-notice${text ? ` ${kind}` : ' hidden'}`;
  notice.textContent = text;
}

function dashIconFor(blockId) {
  const icon = el('span', `dash-ico block-${blockId}`);
  icon.innerHTML = ICONS[DASH_ICON_BY_BLOCK[blockId] || 'chart'] || ICONS.chart;
  return icon;
}

function dashboardCard(task) {
  const card = el('article', `dash-card${task.enabled ? ' on' : ''}`);
  card.dataset.task = task.id;

  const top = el('div', 'dash-card-top');
  top.appendChild(dashIconFor(task.blockId));

  const heading = el('div', 'dash-card-heading');
  heading.appendChild(el('h2', 'dash-card-title', task.title));
  heading.appendChild(el('p', 'dash-card-short', task.short || ''));
  top.appendChild(heading);

  /* Переключатель — кнопка с role="switch": так он одинаково понятен мышью,
     пальцем и экранным диктором, и не тянет за собой форму. */
  const toggle = el('button', 'dash-toggle');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(Boolean(task.enabled)));
  toggle.setAttribute('aria-label', task.enabled ? `Выключить «${task.title}»` : `Включить «${task.title}»`);
  toggle.title = task.enabled ? 'Выключить задание' : 'Включить задание';
  toggle.appendChild(el('span', 'dash-toggle-thumb'));
  toggle.addEventListener('click', () => toggleDashboardTask(task, toggle));
  top.appendChild(toggle);
  card.appendChild(top);

  card.appendChild(el('p', 'dash-card-desc', task.description || ''));

  /* Строка состояния: когда сработает и как прошёл прошлый раз. */
  const status = el('div', 'dash-card-status');
  status.appendChild(el('span', `dash-dot${task.enabled ? '' : ' off'}${task.lastStatus ? ` is-${task.lastStatus}` : ''}`));
  const statusText = el('span', 'dash-status-text');
  if (!task.enabled) statusText.textContent = `Выключено · ${task.schedule || dashboardScheduleLabel(task)}`;
  else if (task.nextRunAt) statusText.textContent = `${task.schedule || dashboardScheduleLabel(task)} · следующий ${dashboardWhen(task.nextRunAt)}`;
  else statusText.textContent = task.schedule || dashboardScheduleLabel(task);
  status.appendChild(statusText);
  card.appendChild(status);

  const meta = el('div', 'dash-card-meta');
  const project = el('span', 'dash-chip-badge');
  project.textContent = task.projectName ? `проект: ${task.projectName}` : 'проект: по умолчанию';
  project.title = 'Отчёты создаются в этом проекте';
  meta.appendChild(project);
  if (Array.isArray(task.files) && task.files.length) {
    const docs = el('span', 'dash-chip-badge');
    docs.textContent = `документов: ${task.files.length}`;
    docs.title = 'Агент прочитает эти документы перед каждым отчётом';
    meta.appendChild(docs);
  }
  if (task.lastChatId) {
    const last = el('a', 'dash-last');
    last.href = '#';
    last.textContent = `последний: ${DASH_STATUS[task.lastStatus] || 'отчёт'}`;
    last.title = task.lastRunAt ? `Открыть диалог от ${dashboardWhen(task.lastRunAt)}` : 'Открыть последний отчёт';
    last.addEventListener('click', (event) => {
      event.preventDefault();
      openChat(task.lastChatId);
    });
    meta.appendChild(last);
  }
  card.appendChild(meta);

  const actions = el('div', 'dash-card-actions');
  const run = el('button', 'btn btn-quiet dash-run');
  run.type = 'button';
  run.innerHTML = `${ICONS.play}<span>Запустить</span>`;
  run.title = task.enabled ? 'Сделать отчёт сейчас' : 'Разовый запуск: задание останется выключенным';
  run.addEventListener('click', () => runDashboardTask(task, run));
  actions.appendChild(run);
  const setup = el('button', 'btn btn-ghost dash-setup');
  setup.type = 'button';
  setup.title = 'Изменить проект, частоту, день, час и текст задания';
  setup.innerHTML = `${ICONS.sliders}<span>Настроить</span>`;
  setup.addEventListener('click', () => openDashboardTaskModal(task));
  actions.appendChild(setup);
  card.appendChild(actions);

  return card;
}

async function toggleDashboardTask(task, control) {
  const next = !task.enabled;
  if (control) control.disabled = true;
  try {
    const data = await api(`/api/dashboard/tasks/${task.id}`, { method: 'PATCH', body: { enabled: next } });
    const index = state.dashboard.tasks.findIndex((item) => item.id === task.id);
    if (index >= 0) state.dashboard.tasks[index] = data.task;
    renderDashboard();
    toast(next ? 'Задание включено — отчёт придёт по расписанию' : 'Задание выключено', 'ok');
  } catch (error) {
    if (!error.unauthorized) toast(error.message || 'Не удалось сохранить настройку');
    if (control) control.disabled = false;
  }
}

async function toggleAllDashboardTasks() {
  const button = $('#dashEnableAll');
  const tasks = state.dashboard.tasks;
  if (!tasks.length) return;
  const next = tasks.some((task) => !task.enabled);
  if (button) button.disabled = true;
  try {
    /* По одному запросу на задание: сервер пересчитывает ближайший запуск
       для каждого, а не для всех сразу. */
    for (const task of tasks) {
      if (task.enabled === next) continue;
      const data = await api(`/api/dashboard/tasks/${task.id}`, { method: 'PATCH', body: { enabled: next } });
      const index = state.dashboard.tasks.findIndex((item) => item.id === task.id);
      if (index >= 0) state.dashboard.tasks[index] = data.task;
    }
    renderDashboard();
    toast(next ? 'Все задания включены' : 'Все задания выключены', 'ok');
  } catch (error) {
    if (!error.unauthorized) toast(error.message || 'Не удалось сохранить настройку');
    renderDashboard();
  }
}

async function runDashboardTask(task, button) {
  if (button) button.disabled = true;
  try {
    const data = await api(`/api/dashboard/tasks/${task.id}/run`, { method: 'POST', body: {} });
    toast('Отчёт готовится — открываю диалог', 'ok');
    if (data.chatId) await openChat(data.chatId);
    else if (button) button.disabled = false;
  } catch (error) {
    if (!error.unauthorized) toast(error.message || 'Не удалось запустить задание');
    if (button) button.disabled = false;
  }
}

/* Поля окна: подпись связана с полем через for/id, а не обёрткой — иначе
   диктор читает в названии поля ещё и подсказку под ним. */
let dashFieldSeq = 0;

function dashField(labelText, control, hint) {
  const field = el('div', 'field');
  dashFieldSeq += 1;
  const id = `dashField${dashFieldSeq}`;
  control.id = id;
  const label = el('label', 'field-label', labelText);
  label.htmlFor = id;
  field.appendChild(label);
  field.appendChild(control);
  if (hint) field.appendChild(el('p', 'form-hint', hint));
  return field;
}

function dashSelect(options, value) {
  const select = el('select');
  for (const [key, text] of options) {
    const option = el('option', '', text);
    option.value = String(key);
    select.appendChild(option);
  }
  select.value = String(value);
  return select;
}

/* Настройки задания: проект, частота, день, час и текст задания. Окно не
   сохраняет ничего само — сервер пересчитывает ближайший запуск и возвращает
   готовую карточку. */
function openDashboardTaskModal(task) {
  const draft = {
    projectId: task.projectId || '',
    cadence: task.cadence || 'monthly',
    dayOfMonth: task.dayOfMonth || 1,
    dayOfWeek: task.dayOfWeek || 1,
    hour: task.hour ?? 9,
    prompt: task.prompt || '',
  };
  const body = el('div', 'dash-form');

  const projectOptions = [
    ['', state.projects.length ? `Первый проект (${state.projects[0].name})` : 'Создать проект «Дашборд»'],
  ];
  for (const project of state.projects) projectOptions.push([project.id, project.name]);
  const projectSelect = dashSelect(projectOptions, draft.projectId);
  projectSelect.addEventListener('change', () => {
    draft.projectId = projectSelect.value;
  });
  body.appendChild(dashField('Проект для отчётов', projectSelect, 'Диалог и файлы отчёта появятся в этом проекте.'));

  const cadenceSelect = dashSelect(DASH_CADENCES, draft.cadence);
  body.appendChild(dashField('Как часто', cadenceSelect));

  const daySlot = el('div', 'dash-form-day');
  const note = el('p', 'dash-form-note');
  const refreshNote = () => {
    note.textContent = `Запуск: ${dashboardScheduleLabel(draft)} по времени Минска`;
  };
  const renderDay = () => {
    daySlot.innerHTML = '';
    if (draft.cadence === 'weekly') {
      const days = DASH_WEEKDAYS.map((name, index) => [index + 1, name]);
      const select = dashSelect(days, draft.dayOfWeek);
      select.addEventListener('change', () => {
        draft.dayOfWeek = Number(select.value);
        refreshNote();
      });
      daySlot.appendChild(dashField('День недели', select));
    } else {
      const days = [];
      for (let day = 1; day <= 28; day += 1) days.push([day, `${day}-е число`]);
      const select = dashSelect(days, draft.dayOfMonth);
      select.addEventListener('change', () => {
        draft.dayOfMonth = Number(select.value);
        refreshNote();
      });
      daySlot.appendChild(dashField('День месяца', select, 'С 1-го по 28-е: так задание не пропускает февраль.'));
    }
  };
  cadenceSelect.addEventListener('change', () => {
    draft.cadence = cadenceSelect.value;
    renderDay();
    refreshNote();
  });
  body.appendChild(daySlot);

  const hours = [];
  for (let hour = 0; hour < 24; hour += 1) hours.push([hour, `${String(hour).padStart(2, '0')}:00`]);
  const hourSelect = dashSelect(hours, draft.hour);
  hourSelect.addEventListener('change', () => {
    draft.hour = Number(hourSelect.value);
    refreshNote();
  });
  body.appendChild(
    dashField('Во сколько', hourSelect, 'Время минское (Europe/Minsk): часовой пояс сервера не важен.'),
  );

  /* Поле невысокое и растягивается мышью: текст задания длинный, но окно
     должно целиком влезать в экран телефона — прокручивается само поле. */
  const prompt = el('textarea', 'dash-prompt');
  prompt.rows = 4;
  prompt.maxLength = 2000;
  prompt.value = draft.prompt;
  prompt.addEventListener('input', () => {
    draft.prompt = prompt.value;
  });
  body.appendChild(
    dashField(
      'Что должен сделать агент',
      prompt,
      'Текст задания. Уточните отрасль, город и формат — отчёт будет точнее.',
    ),
  );

  /* Документы задания. Любой формат: агент получает их к каждому запуску и
     строит отчёт по реальным бумагам, а не по общим данным. Загрузка идёт
     сразу на сервер — окно ничего не держит у себя, закрытие не потеряет файл. */
  let files = Array.isArray(task.files) ? task.files.slice() : [];
  const docsBox = el('div', 'field dash-files');
  docsBox.appendChild(el('span', 'field-label', 'Документы для задания'));

  const docsList = el('ul', 'dash-files-list');
  const docsEmpty = el('p', 'form-hint', 'Пока документов нет.');
  const docsInput = el('input');
  docsInput.type = 'file';
  docsInput.multiple = true;
  docsInput.hidden = true;

  const docsButton = el('button', 'btn btn-quiet dash-files-add');
  docsButton.type = 'button';
  docsButton.innerHTML = `${ICONS.upload}<span>Приложить документы</span>`;
  docsButton.title = 'Любой формат: Word, Excel, PDF, сканы, фото, CSV, TXT';

  const applyTaskUpdate = (next) => {
    const index = state.dashboard.tasks.findIndex((item) => item.id === task.id);
    if (index >= 0) state.dashboard.tasks[index] = next;
    files = Array.isArray(next.files) ? next.files.slice() : [];
    renderDocs();
  };

  function renderDocs() {
    docsList.innerHTML = '';
    for (const file of files) {
      const item = el('li', 'dash-files-item');
      const name = fileNameEl(file.name, 'dash-files-name');
      name.title = file.name;
      item.appendChild(name);
      item.appendChild(el('span', 'dash-files-size', file.uploading ? 'загрузка…' : fmtSize(file.size)));

      if (file.uploading) {
        item.appendChild(el('span', 'dash-files-wait', 'идёт загрузка'));
        docsList.appendChild(item);
        continue;
      }

      const open = el('a', 'dash-files-open');
      open.href = `/api/dashboard/tasks/${task.id}/files/${file.id}`;
      open.setAttribute('download', file.name);
      open.title = 'Скачать документ';
      open.innerHTML = `${ICONS.download}<span>Скачать</span>`;
      item.appendChild(open);

      const remove = el('button', 'dash-files-remove');
      remove.type = 'button';
      remove.title = 'Убрать документ из задания';
      remove.setAttribute('aria-label', `Убрать «${file.name}»`);
      remove.innerHTML = ICONS.trash;
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          const data = await api(`/api/dashboard/tasks/${task.id}/files/${file.id}`, { method: 'DELETE' });
          applyTaskUpdate(data.task);
          toast('Документ убран', 'ok');
        } catch (error) {
          remove.disabled = false;
          if (!error.unauthorized) toast(error.message || 'Не удалось убрать документ');
        }
      });
      item.appendChild(remove);
      docsList.appendChild(item);
    }
    docsList.classList.toggle('hidden', !files.length);
    docsEmpty.classList.toggle('hidden', files.length > 0);
    docsButton.disabled = files.filter((file) => !file.uploading).length >= 10;
  }

  docsButton.addEventListener('click', () => docsInput.click());
  docsInput.addEventListener('change', async (event) => {
    const picked = Array.from(event.target.files || []);
    event.target.value = '';
    for (const file of picked) {
      if (files.filter((item) => !item.uploading).length >= 10) {
        toast('К заданию можно приложить не больше 10 документов');
        break;
      }
      const pending = { id: '', name: file.name, size: file.size, uploading: true };
      files = [...files, pending];
      renderDocs();
      try {
        const response = await fetch(`/api/dashboard/tasks/${task.id}/files`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-Filename': encodeURIComponent(file.name),
          },
          body: file,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Не удалось загрузить документ');
        applyTaskUpdate(data.task);
      } catch (error) {
        files = files.filter((item) => item !== pending);
        renderDocs();
        if (!error.unauthorized) toast(error.message || 'Не удалось загрузить документ');
      }
    }
  });

  /* Кнопка стоит сразу под подписью: список документов растёт вниз, и при
     нескольких файлах «приложить» иначе уезжает за край окна. */
  docsBox.appendChild(docsButton);
  docsBox.appendChild(docsList);
  docsBox.appendChild(docsEmpty);
  docsBox.appendChild(docsInput);
  docsBox.appendChild(
    el('p', 'form-hint', 'Любой формат: Word, Excel, PDF, сканы и фото, выгрузки 1С и банка. Агент прочитает документы перед каждым отчётом.'),
  );
  renderDocs();
  body.appendChild(docsBox);

  body.appendChild(note);
  renderDay();
  refreshNote();

  const reset = el('button', 'dash-reset');
  reset.type = 'button';
  reset.textContent = 'Вернуть текст по умолчанию';
  reset.addEventListener('click', () => {
    draft.prompt = task.defaults?.prompt || '';
    prompt.value = draft.prompt;
    toast('Текст задания сброшен — нажмите «Сохранить»', 'ok');
  });
  body.appendChild(reset);

  openModal({
    title: task.title,
    subtitle: 'Постоянное задание',
    headLead: dashIconFor(task.blockId),
    className: 'dash-modal',
    body,
    actions: [
      {
        label: 'Сохранить',
        kind: 'primary',
        onClick: async () => {
          try {
            const data = await api(`/api/dashboard/tasks/${task.id}`, {
              method: 'PATCH',
              body: {
                projectId: draft.projectId,
                cadence: draft.cadence,
                dayOfMonth: draft.dayOfMonth,
                dayOfWeek: draft.dayOfWeek,
                hour: draft.hour,
                prompt: draft.prompt,
              },
            });
            const index = state.dashboard.tasks.findIndex((item) => item.id === task.id);
            if (index >= 0) state.dashboard.tasks[index] = data.task;
            renderDashboard();
            toast('Настройки сохранены', 'ok');
          } catch (error) {
            if (!error.unauthorized) toast(error.message || 'Не удалось сохранить настройки');
            return false;
          }
          return true;
        },
      },
      { label: 'Отмена', kind: 'quiet' },
    ],
  });
}

/* ------------------------------ wiring ------------------------------ */
/* Кнопка «Дашборд» в шапке: открывает и закрывает экран постоянных заданий. */
$('#dashboardBtn').addEventListener('click', () => {
  if (dashboardOpen()) hideDashboard();
  else showDashboard();
});
$('#dashRefresh').addEventListener('click', () => loadDashboard());
$('#dashEnableAll').addEventListener('click', toggleAllDashboardTasks);

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
$('#sidebarToggle').addEventListener('click', () => {
  toggleSidebarDrawer();
});
$('#backdrop').addEventListener('click', () => {
  $('#app').classList.remove('sidebar-open');
  closeFilesDrawer();
});

/* --------------------------- свайпы боковых ящиков ---------------------------
   На телефоне два привычных жеста: смахнул вправо — выехали «Проекты» слева,
   смахнул влево — выехали «Файлы проекта» справа. Тот же жест в обратную
   сторону закрывает уже открытый ящик.

   Жест не должен мешать тому, что тоже листается вбок: код и таблицы в ответе,
   просмотр документа, ползунки. Поэтому касание внутри горизонтально
   прокручиваемого блока жест не начинает, а сам жест распознаётся только после
   явного перевеса по горизонтали — вертикальная прокрутка ленты остаётся
   нетронутой. На планшете проекты и так видны постоянно, поэтому свайп вправо
   там ничего не делает; файлы открываются до 1100 px, как и кнопкой-папкой. */
function initDrawerSwipes() {
  const app = $('#app');
  if (!app) return;
  const projectsAreDrawer = () => window.matchMedia('(max-width: 860px)').matches;
  /* Порог, после которого жест считается горизонтальным, и путь, который
     нужно пройти, чтобы ящик открылся. 56 px — примерно треть большого пальца
     по экрану: случайное касание при прокрутке ящик не выдвинет. */
  const SIDE_SLOP = 12;
  const OPEN_DISTANCE = 56;
  /* Долгое удержание — это выделение текста или вызов меню, а не свайп. */
  const LOCK_WINDOW = 600;
  let gesture = null;

  /* Ищем ближайший блок, который реально прокручивается вбок: у него свайп
     должен листать содержимое, а не открывать ящик. */
  function horizontalScroller(node) {
    for (let parent = node; parent && parent !== app; parent = parent.parentElement) {
      if (!(parent instanceof HTMLElement)) continue;
      const overflowX = getComputedStyle(parent).overflowX;
      if ((overflowX === 'auto' || overflowX === 'scroll') && parent.scrollWidth > parent.clientWidth + 2) {
        return parent;
      }
    }
    return null;
  }

  function startBlocked(target) {
    if (!(target instanceof Element)) return true;
    if (target.closest('#modalRoot, .modal-root, input, textarea, select, [contenteditable="true"], .resizer, .pdf-box')) {
      return true;
    }
    return Boolean(horizontalScroller(target));
  }

  /* Что сделает жест в эту сторону — или ничего. Пока ни один ящик не открыт,
     вправо открывает проекты, влево файлы. Открытый ящик закрывается только
     обратным движением: «Проекты» уезжают влево, «Файлы» — вправо. */
  function actionFor(dx) {
    if (app.classList.contains('sidebar-open')) return dx < 0 ? 'close-projects' : null;
    if (app.classList.contains('files-open')) return dx > 0 ? 'close-files' : null;
    if (dx > 0) return projectsAreDrawer() ? 'open-projects' : null;
    return filesNarrow() ? 'open-files' : null;
  }

  app.addEventListener('touchstart', (event) => {
    gesture = null;
    if (event.touches.length !== 1) return;
    if (startBlocked(event.target)) return;
    const touch = event.touches[0];
    gesture = { x: touch.clientX, y: touch.clientY, time: performance.now(), action: null };
  }, { passive: true });

  app.addEventListener('touchmove', (event) => {
    if (!gesture) return;
    if (event.touches.length !== 1) {
      gesture = null;
      return;
    }
    const touch = event.touches[0];
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (!gesture.action) {
      if (Math.abs(dx) < SIDE_SLOP) return;
      if (Math.abs(dx) <= Math.abs(dy) * 1.4) return;
      if (performance.now() - gesture.time > LOCK_WINDOW) {
        gesture = null;
        return;
      }
      gesture.action = actionFor(dx);
      if (!gesture.action) {
        gesture = null;
        return;
      }
    }
    /* Горизонталь забрали себе — страница вбок не поедет и «назад» в Safari
       не сработает. Вертикальную прокрутку этот вызов не трогает: до неё
       жест либо не дошёл, либо уже распознан как вертикальный. */
    if (event.cancelable) event.preventDefault();
  }, { passive: false });

  function finish(event) {
    const current = gesture;
    gesture = null;
    if (!current || !current.action) return;
    const touch = event.changedTouches && event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - current.x;
    if (Math.abs(dx) < OPEN_DISTANCE) return;
    /* Направление должно совпасть с тем, что решили при захвате жеста:
       «Проекты» открываются вправо и закрываются влево, «Файлы» — наоборот.
       Разворот в последний момент не должен запускать противоположное действие. */
    const rightward = current.action === 'open-projects' || current.action === 'close-files';
    if (rightward ? dx <= 0 : dx >= 0) return;
    switch (current.action) {
      case 'open-projects':
        openSidebarDrawer();
        break;
      case 'close-projects':
        closeSidebar();
        break;
      case 'open-files':
        openFilesDrawer();
        break;
      case 'close-files':
        closeFilesDrawer();
        break;
      default:
        break;
    }
  }

  app.addEventListener('touchend', finish, { passive: true });
  app.addEventListener('touchcancel', () => {
    gesture = null;
  }, { passive: true });
}
initDrawerSwipes();
/* Заголовок панели «Файлы проекта» — подпись, а не кнопка: проект выбирается
   слева, и файлы всегда принадлежат ему. */
/* ------------------------------ panel resize ------------------------------ */
/* Полная версия: ширину панели проектов и панели файлов можно тянуть мышью
   за разделитель, ширины запоминаются. На телефоне панели — выезжающие ящики,
   там ширина задана экраном, поэтому ручки скрыты. */

const LAYOUT_KEY = 'dshow-layout-v3';
/* Боковые панели одинаковые по ширине: слева «Проекты», справа «Файлы проекта»,
   по умолчанию 292 px у обеих, каждая тянется в пределах 264…420 px, диалогу
   всегда остаётся минимум 400 px. Пока правую панель не тянули, она повторяет
   ширину левой — блоки симметричны, и это видно на любой ширине окна.
   292 px вместо 280 — запас под чуть увеличенный кегль: названия проектов,
   которые помещались целиком, не должны обрезаться из-за полупикселя. */
const PANEL_RULES = {
  sidebar: { min: 264, max: () => 420, def: () => 292 },
  files: { min: 264, max: () => 420, def: () => 292 },
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
     а левую — к обычным 292 px. */
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

/* Не передаём событие в autoResize: первый аргумент — «пересчитать с нуля»,
   а объект события всегда истинный. Иначе на каждом символе поле схлопывалось
   до height:auto и вся лента пересчитывалась — это и выглядело как прыжки. */
$('#input').addEventListener('input', () => autoResize());
/* Ширина экрана меняется не только при повороте телефона: её меняет клавиатура
   и перезагрузка страницы. Поэтому ящик закрываем только при переходе с
   широкого экрана на узкий, иначе открытая «Файлы проекта» захлопывалась. */
let wasNarrow = filesNarrow();
window.addEventListener('resize', () => {
  syncInputPlaceholder();
  autoResize();
  markWideBlocks();
  const narrowNow = filesNarrow();
  if (narrowNow && !wasNarrow && state.filesDrawerOpen) state.filesDrawerOpen = false;
  wasNarrow = narrowNow;
  syncFilesPanel();
});
window.addEventListener('orientationchange', () => setTimeout(autoResize, 120));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(autoResize).catch(() => {});

/* Клавиатура телефона: окно держим по видимой области, иначе поле ввода
   уезжает под клавиатуру или страница прыгает при фокусе. */
const KB_VIEW = { base: 0, open: false, h: -1, pan: -1 };

function isEditableElement(element) {
  return (
    element instanceof HTMLElement &&
    (element.matches('input, textarea, select') || element.isContentEditable)
  );
}

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
  const viewH = Math.round(vv.height);
  const pan = Math.max(0, Math.round(vv.offsetTop || 0));
  /* Масштаб больше 1 — это зум страницы (двойной тап, пинч, авто-увеличение
     поля), а не клавиатура: видимая область у него тоже меньше окна. Пока
     масштаб не вернули, окно не трогаем, иначе вёрстка сжималась бы под зум. */
  const zoomed = Number(vv.scale) > 1.01;
  if (zoomed) return;
  if (!KB_VIEW.base) KB_VIEW.base = Math.round(window.innerHeight || viewH);
  const active = document.activeElement;
  const editing = isEditableElement(active);
  const authVisible = !document.getElementById('auth')?.classList.contains('hidden');
  const compactAuth = authVisible && viewH < 560;
  /* Норму запоминаем только когда ничего не редактируется. Иначе высота с
     открытой клавиатурой запомнилась бы как «полная», и окно осталось бы
     урезанным после её закрытия. */
  if (!KB_VIEW.open && !editing && !authVisible) {
    const full = Math.round(window.innerHeight || viewH);
    if (full > 0) KB_VIEW.base = full;
  }
  /* Никакого порога в 140 px: раньше первые ~120 px выезда клавиатуры окно
     не замечало, поле оказывалось под ней, а потом всё прыгало вверх на
     высоту порога. Следим с первого же пикселя. */
  const shrunk = viewH < KB_VIEW.base - 1;
  const shouldOpen = shrunk || compactAuth;
  if (shouldOpen) {
    if (!KB_VIEW.open) {
      root.classList.add('kb-open');
      KB_VIEW.open = true;
      /* Длинный черновик не должен занимать пол-экрана после выезда
         клавиатуры: пересчитываем предел уже по видимой области. */
      requestAnimationFrame(() => autoResize(true));
    }
    if (KB_VIEW.h !== viewH) {
      root.style.setProperty('--app-h', `${viewH}px`);
      KB_VIEW.h = viewH;
    }
    if (KB_VIEW.pan !== pan) {
      root.style.setProperty('--kb-pan', `${pan}px`);
      KB_VIEW.pan = pan;
    }
  } else if (KB_VIEW.open) {
    root.classList.remove('kb-open');
    root.style.removeProperty('--app-h');
    root.style.removeProperty('--kb-pan');
    KB_VIEW.open = false;
    KB_VIEW.h = KB_VIEW.pan = -1;
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
  /* Пересчитываем сразу, не откладывая до requestAnimationFrame: на телефоне
     resize и scroll приходят на каждом кадре анимации клавиатуры, а очередь
     кадров при наборе может отставать — тогда подвал снова оказывался под
     клавиатурой. Записи в CSS кэшированы, лишней работы нет. */
  const schedule = () => syncKeyboardViewport();
  syncKeyboardViewport();
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  /* После поворота «нормальная» высота другая: пересчитываем её от окна,
     иначе закрытая клавиатура в горизонтальной ориентации считалась бы
     открытой (видимая область меньше портретной). */
  window.addEventListener('orientationchange', () =>
    setTimeout(() => {
      KB_VIEW.base = Math.round(window.innerHeight || 0);
      syncKeyboardViewport();
    }, 250),
  );
})();

/* Клавиатура выезжает с анимацией 250–350 мс, на медленных телефонах дольше.
   События visualViewport приходят не на каждом кадре, поэтому дополнительно
   пересчитываем несколько раз — лишних записей в CSS не будет, значения
   кэшированы в KB_VIEW. */
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
      target.scrollIntoView({ block: 'center' });
      return;
    }
    if (popoverNode && popoverHost) {
      placeInPanel(popoverNode, popoverAnchor, popoverHost);
    }
    target.scrollIntoView({ block: 'center' });
  }, 320);
});

/* Стрелки прокрутки диалога: зависят от реальной высоты ленты, поэтому
   подключаются один раз после отрисовки каркаса. */
initScrollJump();

// На телефоне фокус в поле ввода поднимает клавиатуру: если лента была у
// последнего сообщения, оставляем её там. Если человек читал середину
// переписки и просто коснулся поля — не выдёргиваем его вниз.
$('#input').addEventListener('focus', () => {
  if (!window.matchMedia('(max-width: 860px)').matches) return;
  settleKeyboardViewport();
  const scroll = $('#scroll');
  if (!scroll) return;
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180;
  if (!nearBottom) return;
  const toBottom = () => {
    if (scroll.isConnected) scroll.scrollTop = scroll.scrollHeight;
  };
  /* Ленту подтягиваем к последнему сообщению сразу и после того, как
     клавиатура доехала — но без плавной анимации, она и давала «скачки». */
  requestAnimationFrame(toBottom);
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

/* Файл проекта, названный ассистентом в ответе, открывается в окне просмотра
   сервиса. Слушаем на всём документе: такие же ссылки бывают в просмотре
   markdown-файла. Ctrl/Shift/средняя кнопка — обычное поведение браузера:
   ссылка открывается новой вкладкой, файл отдаётся как есть. */
document.addEventListener('click', (event) => {
  const fileLink = event.target.closest('[data-file-path]');
  if (!fileLink) return;
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const relPath = fileLink.dataset.filePath || '';
  if (!relPath) return;
  event.preventDefault();
  if (!filesProjectId()) {
    toast('Сначала выберите проект слева');
    return;
  }
  fileLink.setAttribute('href', projectFileHref(relPath));
  openFilePreview({ path: relPath, name: relPath.split('/').pop() });
});

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
  /* Выезжающий ящик файлов закрывается и с клавиатуры: крестика в шапке панели
     больше нет. */
  else closeFilesDrawer();
});

/* drag and drop + paste */

/* Файл с компьютера можно отпустить где угодно в области ответа: и над полем
   ввода, и в любом месте переписки. Раньше зоной был только сам <form
   id="composer">, поэтому бросок в список сообщений ничего не делал.
   Обработчики живут на <main>: поле ввода — его часть, так что оба случая
   проходят через один обработчик и файл никогда не уходит дважды. */
const mainArea = document.querySelector('main.main') || $('#scroll')?.closest('main');

function dragCarriesFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

/* Перетаскивание файлов с компьютера в панель «Файлы проекта»: файл сразу
   сохраняется в проект (в ту папку, которая открыта), а не прикрепляется к сообщению. */
const filesPanel = $('#filesPanel');

function markDropZone(active) {
  if (!mainArea) return;
  mainArea.classList.toggle('dragover', active);
}

if (mainArea) {
  ['dragenter', 'dragover'].forEach((type) => {
    mainArea.addEventListener(type, (event) => {
      if (!dragCarriesFiles(event)) return;
      /* Новый drag с файлами сбрасывает след от перетаскивания файла из панели. */
      state.dragOut = false;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      markDropZone(true);
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    mainArea.addEventListener(type, (event) => {
      if (type === 'dragleave' && mainArea.contains(event.relatedTarget)) return;
      markDropZone(false);
    });
  });
  mainArea.addEventListener('drop', (event) => {
    const files = event.dataTransfer?.files;
    if (!files || !files.length) return;
    event.preventDefault();
    markDropZone(false);
    /* Файл вытащили из панели проекта и бросили в диалог — это не загрузка. */
    if (state.dragOut) return;
    uploadFiles(files);
  });
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

/* ------------------------- уведомления ------------------------- */

/* Уведомления работают у всех и всегда: человек их не включает и не выключает.
   Браузер выдаёт разрешение только по действию человека, поэтому первый тап по
   экрану открывает его родной запрос — один раз, дальше браузер помнит ответ
   сам. Включение идёт не мгновенно (браузер регистрируется в своей push-службе),
   поэтому повторный вызов ждёт тот же результат, а не заводит вторую подписку. */
let pushEnabling = null;
/* Разрешение спрашиваем ровно из первого действия человека. */
let pushPermissionArmed = false;
/* В этом открытии приложения браузер уже спрашивали — второй раз не просим. */
let pushAsked = false;
/* Переход из уведомления и бейдж подключаем один раз на вкладку. */
let pushListenersReady = false;
/* Endpoint подписки, уже отправленный серверу в текущем входе. Сравниваем
   адрес, а не флаг: браузер может пересоздать подписку, и её нужно прислать
   заново, даже если раньше уже отправляли. */
let pushRegistered = '';
/* Стабильный ключ устройства: по нему сервер отличает телефон от ноутбука,
   даже когда браузер пересоздаёт push-подписку. Ключ не секретный. */
const PUSH_DEVICE_KEY = 'dshow-push-device-v1';
let pushFallbackDeviceKey = '';
let pushReportedSignature = '';
let pushReportedAt = 0;
let pushReporting = null;

function pushDeviceKey() {
  const make = () =>
    globalThis.crypto?.randomUUID?.().replace(/-/g, '') ||
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  try {
    const saved = localStorage.getItem(PUSH_DEVICE_KEY);
    if (saved && /^[A-Za-z0-9_-]{8,80}$/.test(saved)) return saved;
    const value = make();
    localStorage.setItem(PUSH_DEVICE_KEY, value);
    return value;
  } catch {
    /* Приватный режим без хранилища: ключ живёт до закрытия вкладки. */
    if (!pushFallbackDeviceKey) pushFallbackDeviceKey = make();
    return pushFallbackDeviceKey;
  }
}

/* Рассказываем серверу, что происходит на этом устройстве. Отправляем и при
   запрете: администратор должен видеть, что человек выключил уведомления, а не
   что устройство пропало. */
async function reportPushState({ force = false } = {}) {
  if (!state.user) return;
  if (pushReporting) return pushReporting;
  pushReporting = (async () => {
    const supported = pushSupported();
    let subscribed = false;
    if (supported) {
      const registration = await pushRegistration();
      if (registration) {
        const subscription = await registration.pushManager.getSubscription().catch(() => null);
        subscribed = Boolean(subscription);
      }
    }
    const payload = {
      deviceId: pushDeviceKey(),
      permission: supported ? Notification.permission || 'default' : 'unsupported',
      subscribed,
      app: openedAsApp(),
    };
    const signature = JSON.stringify(payload);
    if (payload.permission !== 'granted') pushRegistered = '';
    if (!force && signature === pushReportedSignature && Date.now() - pushReportedAt < 300000) return;
    try {
      await api('/api/push/report', { method: 'POST', body: payload });
      pushReportedSignature = signature;
      pushReportedAt = Date.now();
    } catch {
      /* Нет сети или сервер ещё старый — повторим при следующем открытии. */
    }
  })().finally(() => {
    pushReporting = null;
  });
  return pushReporting;
}

function pushSupported() {
  return Boolean(
    typeof Notification !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      window.isSecureContext,
  );
}

/* Ключ VAPID приходит с сервера в base64url — браузеру нужен массив байт. */
function urlBase64ToBytes(base64) {
  const normal = String(base64 || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normal + '='.repeat((4 - (normal.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/* Готовый воркер: ждём активации не дольше восьми секунд, иначе включение
   уведомлений висело бы на телефоне в ожидании, которого не будет. */
function serviceWorkerReady(timeoutMs = 8000) {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]).catch(() => null);
}

async function pushRegistration() {
  if (!pushSupported()) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) || null;
  } catch {
    return null;
  }
}

/* Браузер иногда думает над подпиской долго: у него своя регистрация в
   push-службе. Ждём не бесконечно, но и не обрываем на полуслове. */
function withPushTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(message);
      error.timeout = true;
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function enablePush() {
  if (pushEnabling) return pushEnabling;
  pushEnabling = enablePushOnce().finally(() => {
    pushEnabling = null;
  });
  return pushEnabling;
}

async function enablePushOnce() {
  /* Разрешение спрашивает только armPushPermission — из действия человека.
     Здесь лишь молчаливая подписка уже разрешённого устройства. */
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  let registration = await pushRegistration();
  if (!registration) {
    try {
      await navigator.serviceWorker.register('/sw.js');
      registration = await serviceWorkerReady();
    } catch {
      registration = null;
    }
  }
  if (!registration) return false;
  const server = await api('/api/push/state');
  if (!server.publicKey) return false;
  let subscription = await registration.pushManager.getSubscription().catch(() => null);
  if (!subscription) {
    /* Таймаут не отменяет запрос: браузер может ответить позже, и тогда
       следующая попытка найдёт готовую подписку и дошлёт её серверу. */
    subscription = await withPushTimeout(
      registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(server.publicKey),
      }),
      60000,
      'Браузер не ответил за минуту',
    );
  }
  if (pushRegistered !== subscription.endpoint) {
    await api('/api/push/subscribe', {
      method: 'POST',
      body: { subscription: subscription.toJSON(), deviceId: pushDeviceKey(), app: openedAsApp() },
    });
    pushRegistered = subscription.endpoint;
  }
  return true;
}

/* Первое действие человека (тап, клик, клавиша) — единственный законный повод
   для родного запроса разрешения. Спрашиваем один раз: отказ браузера уважаем,
   второй раз он всё равно не спросит без настроек. */
function armPushPermission() {
  if (!pushSupported() || pushPermissionArmed || pushAsked || Notification.permission !== 'default') return;
  pushPermissionArmed = true;
  const events = ['pointerdown', 'touchstart', 'keydown'];
  const ask = async () => {
    for (const type of events) window.removeEventListener(type, ask, true);
    pushPermissionArmed = false;
    if (!pushSupported()) return;
    if (Notification.permission === 'default') {
      pushAsked = true;
      let granted = false;
      try {
        granted = (await Notification.requestPermission()) === 'granted';
      } catch {
        granted = false;
      }
      if (!granted) {
        void reportPushState({ force: true });
        return;
      }
    }
    if (Notification.permission !== 'granted') {
      void reportPushState({ force: true });
      return;
    }
    try {
      await enablePush();
    } catch {
      /* Сеть или push-служба подвели — повторим при следующем открытии. */
    }
    void reportPushState({ force: true });
  };
  for (const type of events) window.addEventListener(type, ask, { capture: true });
}

/* Бейдж на иконке приложения — как у обычных мессенджеров: цифра «есть новое».
   Снимаем, когда человек вернулся в приложение. */
function clearAppBadge() {
  try {
    navigator.clearAppBadge?.();
  } catch {
    /* API нет — нечего снимать */
  }
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'dsh-clear-badge' });
  } catch {
    /* ignore */
  }
}

/* Клик по уведомлению: воркер передаёт окну, какой диалог открыть. */
function onServiceWorkerMessage(event) {
  const data = event?.data || {};
  if (data.type !== 'dsh-open') return;
  clearAppBadge();
  const chatId = String(data.chatId || '');
  if (chatId) {
    openChat(chatId);
    return;
  }
  try {
    const chat = new URLSearchParams(String(data.url || '').split('?')[1] || '').get('chat');
    if (chat) openChat(chat);
  } catch {
    /* ссылка не разобралась — остаёмся в текущем диалоге */
  }
}

/* Открытие по ссылке из уведомления при закрытом приложении: /?chat=<id>. */
function openChatFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const chatId = params.get('chat');
    if (!chatId || !state.user) return;
    params.delete('chat');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    openChat(chatId);
  } catch {
    /* адресная строка недоступна — ничего страшного */
  }
}

/* Включение уведомлений запускается после входа и при каждом открытии
   приложения: подписку нужно подтверждать серверу, а после чистки браузера —
   оформлять заново. Параллельные вызовы ждут один и тот же результат. */
let pushRun = null;

function ensurePush() {
  if (!state.user) return Promise.resolve();
  if (pushRun) return pushRun;
  pushRun = initPush().finally(() => {
    pushRun = null;
  });
  return pushRun;
}

async function initPush() {
  if (!pushSupported()) {
    void reportPushState();
    return;
  }
  const registration = await serviceWorkerReady();
  if (!registration) {
    void reportPushState();
    return;
  }
  if (!pushListenersReady) {
    pushListenersReady = true;
    navigator.serviceWorker.addEventListener('message', onServiceWorkerMessage);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      clearAppBadge();
      /* Разрешение могли выдать в настройках браузера или в другой вкладке. */
      if (Notification.permission === 'granted') {
        void enablePush()
          .catch(() => {})
          .finally(() => void reportPushState({ force: true }));
      } else {
        armPushPermission();
        void reportPushState({ force: true });
      }
    });
    window.addEventListener('focus', clearAppBadge);
  }
  if (Notification.permission === 'granted') {
    try {
      await enablePush();
    } catch {
      /* Сеть или push-служба подвели — повторим при следующем открытии. */
    }
    void reportPushState();
    return;
  }
  armPushPermission();
  void reportPushState();
}

/* ------------------------- присутствие ------------------------- */

/* Пока вкладка на экране, раз в 15 секунд говорим серверу «я здесь». Сервер
   считает человека активным на любом устройстве и не шлёт пуш о готовой
   задаче — ни сюда, ни на телефон, который лежит в кармане. Свернули или
   закрыли — сразу отправляем «ушёл»; если сигнал не дойдёт, отметка устареет
   сама за 40 секунд. */
const PRESENCE_BEAT_MS = 15000;
let presenceStarted = false;
let presenceClientId = '';

function presenceId() {
  if (presenceClientId) return presenceClientId;
  try {
    presenceClientId = crypto.randomUUID().replace(/-/g, '');
  } catch {
    presenceClientId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
  return presenceClientId;
}

function presencePayload(visible) {
  return {
    clientId: presenceId(),
    visible: Boolean(visible),
    focused: Boolean(document.hasFocus?.()),
    deviceId: pushDeviceKey(),
  };
}

/* sendBeacon переживает закрытие вкладки, обычный fetch — нет. Для «ушёл»
   сначала пробуем его, а если браузер отказал — шлём keepalive-запрос. */
function sendPresence(visible = !document.hidden, { beacon = false } = {}) {
  if (!state.user) return;
  const payload = presencePayload(visible);
  if (beacon && navigator.sendBeacon) {
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      if (navigator.sendBeacon('/api/presence', blob)) return;
    } catch {
      /* старый браузер или запрет — ниже обычный запрос */
    }
  }
  try {
    void fetch('/api/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
      keepalive: !visible,
    }).catch(() => {});
  } catch {
    /* нет сети — отметка просто устареет */
  }
}

function startPresence() {
  if (!state.user) return;
  if (!presenceStarted) {
    presenceStarted = true;
    setInterval(() => {
      if (state.user && !document.hidden) sendPresence(true);
    }, PRESENCE_BEAT_MS);
    document.addEventListener('visibilitychange', () => {
      if (!state.user) return;
      if (document.hidden) {
        sendPresence(false, { beacon: true });
        return;
      }
      sendPresence(true);
    });
    /* Вернулись в окно из другого приложения — подтверждаем, что всё ещё здесь. */
    window.addEventListener('focus', () => {
      if (state.user && !document.hidden) sendPresence(true);
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted && state.user && !document.hidden) sendPresence(true);
    });
    /* Закрытие вкладки или ярлыка-приложения. */
    window.addEventListener('pagehide', () => sendPresence(false, { beacon: true }));
  }
  sendPresence(!document.hidden);
}

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

/* Воркер нужен ради установки ярлыка как приложения (см. /sw.js) и
   push-уведомлений: кэша в нём нет, обновления подхватываются сразу. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  /* https — боевой адрес; localhost считается защищённым, поэтому там воркер
     тоже можно проверять при разработке. */
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (location.protocol !== 'https:' && !local) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    /* Без воркера сайт работает как раньше: ярлык просто станет закладкой. */
  });
}

/* ------------------------------ boot ------------------------------ */

/* Первый запрос при открытии. Сервис может не ответить в трёх случаях: короткий
   перезапуск контейнера после обновления, мигающая сеть на телефоне и вход
   действительно закончился. Показывать форму входа в первых двух случаях нельзя:
   человек с ярлыком-приложением решит, что его выбросило, и пойдёт искать ник и
   пароль, хотя вход цел. Поэтому сначала несколько тихих повторов, и только
   потом — объяснение с кнопкой «Повторить». Форма входа остаётся только для
   настоящего 401. */
const BOOT_RETRY_DELAYS = [800, 1600, 3200, 5000];
let bootPending = false;
let bootRunning = false;

function bootWaitState(visible, text) {
  const note = $('#bootNote');
  if (!note) return;
  const label = $('#bootNoteText');
  if (visible && text && label) label.textContent = text;
  note.classList.toggle('hidden', !visible);
}

async function bootAttempt() {
  try {
    const payload = await api('/api/me');
    await startApp(payload);
    $('#boot').classList.add('hidden');
    return true;
  } catch (error) {
    /* 401 и «сеанс закрыт» уже показали экран входа — повторять нечего. */
    if (error.unauthorized) {
      $('#boot').classList.add('hidden');
      return true;
    }
    return false;
  }
}

async function bootStart() {
  if (bootRunning) return;
  bootRunning = true;
  bootPending = false;
  bootWaitState(false);
  let opened = false;
  for (let attempt = 0; attempt <= BOOT_RETRY_DELAYS.length; attempt += 1) {
    opened = await bootAttempt();
    if (opened) break;
    if (attempt === BOOT_RETRY_DELAYS.length) break;
    await sleep(BOOT_RETRY_DELAYS[attempt]);
  }
  bootRunning = false;
  if (opened) return;
  bootPending = true;
  bootWaitState(
    true,
    navigator.onLine === false
      ? 'Нет связи с интернетом. Вход сохранён — как только сеть вернётся, всё откроется само.'
      : 'Сервис не отвечает: вероятно, обновление или короткий перезапуск. Вход сохранён — повторять его не нужно.',
  );
}

(async function boot() {
  $('#bootRetry')?.addEventListener('click', () => bootStart());
  await bootStart();
  syncSignupAvailability();
  registerServiceWorker();
  /* Приложение открыли по ссылке из уведомления — сразу нужный диалог. */
  openChatFromUrl();
  /* Уведомления и бейдж: подписка этого устройства и переход из уведомления. */
  void ensurePush();
  clearAppBadge();
  /* Телефон вернулся из сна, вкладку открыли снова, сеть восстановилась —
     догоняем задачи, которые всё это время шли на сервере, и заодно
     подтягиваем свежие проекты, диалоги и файлы. */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      /* Свернули или закрыли приложение — запоминаем проект на случай, если
         вкладка не успеет дожить до pagehide. */
      rememberProject(state.activeProjectId);
      return;
    }
    if (bootPending) {
      bootStart();
      return;
    }
    resumeLiveRuns();
    syncFromServer();
    checkAppVersion();
  });
  window.addEventListener('online', () => {
    if (bootPending) {
      bootStart();
      return;
    }
    resumeLiveRuns();
    syncFromServer();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      resumeLiveRuns();
      syncFromServer();
    }
  });
  /* Закрытие ярлыка-приложения: последний проект должен пережить закрытие. */
  window.addEventListener('pagehide', () => rememberProject(state.activeProjectId));
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

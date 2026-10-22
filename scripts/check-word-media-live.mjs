// Живая проверка картинок и диаграмм в Word (create_word) на развёрнутом сервисе.
//
//   P1_BASE=https://dshopen-vladimir00177.msk1.amvera.tech P1_PASS=... node scripts/check-word-media-live.mjs
//
// Что проверяется:
//   1. файл-картинка загружается в проект и модель о ней знает;
//   2. модель вызывает create_word и получает строку «Проверка файла»;
//   3. в скачанном .docx реально есть диаграмма (часть chartN.xml + связь + книга данных)
//      и картинка (часть word/media + ссылка a:blip), а маркер [[CHART:n]] не остался текстом.
// Секретов не печатает: пароль берётся из P1_PASS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

const BASE = (process.env.P1_BASE || 'https://dshopen-vladimir00177.msk1.amvera.tech').replace(/\/+$/, '');
const USER = process.env.P1_USER || 'DSH';
const PASS = process.env.P1_PASS || '';
const TIMEOUT_MS = Number(process.env.P1_TIMEOUT_MS || 240000);

if (!PASS) {
  console.error('нет P1_PASS — пароль в переменной окружения, в файл не пишем');
  process.exit(2);
}

const jar = new Map();
const cookieHeader = () => [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');

function rememberCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const [pair] = raw.split(';');
    const [name, ...rest] = pair.split('=');
    if (name && rest.length) jar.set(name.trim(), rest.join('=').trim());
  }
}

async function api(pathname, { method = 'GET', body, headers = {}, raw, stream = false } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(body && !raw ? { 'content-type': 'application/json' } : {}),
      cookie: cookieHeader(),
      ...headers,
    },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  rememberCookies(res);
  return res;
}

async function json(pathname, options) {
  const res = await api(pathname, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathname} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function drain(res) {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of res.body) text += decoder.decode(chunk, { stream: true });
  return text;
}

async function readRun(chatId) {
  const res = await api(`/api/chats/${chatId}/messages`, { method: 'POST', body: { text: PROMPT } });
  if (!res.ok) throw new Error(`сообщение → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = JSON.parse(await res.text());
    const follow = await api(`/api/runs/${data.run?.id || data.id}/stream`, { stream: true });
    return await drain(follow);
  }
  return await drain(res);
}

const PROMPT = [
  'Сделай один Word-файл «Диаграмма.docx» вызовом create_word. Ровно один вызов, все данные ниже.',
  'Раздел 1, heading «Динамика»: paragraphs ["Выручка растёт три квартала подряд."],',
  'chart {type:"column", title:"Выручка по кварталам", categories:["Q1","Q2","Q3"], series:[{name:"2025",values:[86.4,92.1,98.7]},{name:"2026",values:[104.2,112.8,121.5]}]},',
  'images [{path:"assets/logo.png", caption:"Логотип проекта"}].',
  'В конце одной строкой напиши, что показала строка «Проверка файла», и какие диаграмма и картинка попали в файл.',
].join(' ');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const health = await json('/api/health');
check('health отвечает', health.ok === true);

await json('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
const created = await json('/api/projects', { method: 'POST', body: { name: 'Проверка картинок' } });
const projectId = created.project.id;
const chat = await json(`/api/projects/${projectId}/chats`, { method: 'POST', body: { title: 'Медиа' } });
const chatId = chat.chat?.id || chat.id;

const imageBytes = fs.readFileSync(new URL('../public/icons/icon-192.png', import.meta.url));
const uploaded = await json(`/api/projects/${projectId}/upload?path=${encodeURIComponent('assets/logo.png')}`, {
  method: 'POST',
  raw: imageBytes,
  headers: { 'x-filename': encodeURIComponent('logo.png'), 'content-type': 'image/png' },
});
check('картинка загружена в проект', uploaded.size === imageBytes.length, `${uploaded.path} (${uploaded.size} Б)`);

const stream = await readRun(chatId);
check('модель ответила', stream.length > 200, `${stream.length} байт событий`);

const deltaText = stream
  .split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => {
    try {
      return JSON.parse(line.slice(6));
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .map((event) => (event.type === 'delta' ? event.text || '' : ''))
  .join('');

const toolNames = [...stream.matchAll(/"name"\s*:\s*"([a-z_]+)"/g)].map((match) => match[1]);
check('модель вызвала create_word', toolNames.includes('create_word'), toolNames.join(','));
check(
  'модель получила отчёт «Проверка файла»',
  /Проверка файла/.test(deltaText) && /(OK|замечания|ОШИБКИ)/.test(deltaText),
  (deltaText.match(/Проверка файла[^\n]*/) || [''])[0].slice(0, 160),
);

const tree = await json(`/api/projects/${projectId}/files?depth=6`);
const flatten = (items) => items.flatMap((item) => [item, ...(Array.isArray(item.children) ? flatten(item.children) : [])]);
const docx = flatten(tree.items || []).find((entry) => /\.docx$/i.test(entry.name || entry.path || ''));
check('файл лежит в проекте', Boolean(docx), docx?.path || '');

if (docx) {
  const res = await api(`/api/projects/${projectId}/file?path=${encodeURIComponent(docx.path || docx.name)}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const saved = path.join(os.tmpdir(), 'word-media-live.docx');
  fs.writeFileSync(saved, buffer);
  console.log(`\nСкачанный файл: ${saved} (${(buffer.length / 1024).toFixed(1)} КБ)`);
  check('файл скачался', res.ok && buffer.length > 5000, `${buffer.length} Б`);

  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  const chartPart = names.find((name) => /^word\/charts\/chart\d+\.xml$/.test(name));
  const chartRels = names.find((name) => /^word\/charts\/_rels\/chart\d+\.xml\.rels$/.test(name));
  const chartBook = names.find((name) => /^word\/embeddings\/chart\d+\.xlsx$/.test(name));
  const media = names.find((name) => /^word\/media\/./.test(name) && !name.endsWith('/'));
  check('в пакете есть часть диаграммы', Boolean(chartPart), chartPart || '');
  check('в пакете есть книга данных диаграммы', Boolean(chartBook), chartBook || '');
  check('в пакете есть связи диаграммы', Boolean(chartRels), chartRels || '');
  check('в пакете есть файл картинки', Boolean(media), media || '');

  const documentXml = await zip.file('word/document.xml').async('string');
  check('в тексте есть объект-диаграмма', /<c:chart\b/.test(documentXml));
  check('в тексте есть картинка', /<a:blip r:embed="rId\d+"/.test(documentXml));
  check('маркер [[CHART:n]] не остался текстом', !documentXml.includes('[[CHART:'));
  check('есть подпись под картинкой', /Логотип проекта/.test(documentXml));

  if (chartPart) {
    const chartXml = await zip.file(chartPart).async('string');
    check('диаграмма — столбцы', /<c:barChart>/.test(chartXml));
    check('диаграмма ссылается на книгу данных', /<c:externalData/.test(chartXml));
    check('в диаграмме два ряда', (chartXml.match(/<c:ser>/g) || []).length === 2);
  }
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  check('тип содержимого для диаграммы объявлен', /drawingml\.chart\+xml/.test(contentTypes));
}

await json(`/api/projects/${projectId}`, { method: 'DELETE' }).catch(() => {});

const failed = results.filter((result) => !result.ok);
console.log(`\nИтог: ${results.length - failed.length} из ${results.length}`);
if (failed.length) {
  console.log('\nПоследние события задачи:\n' + stream.slice(-3000));
  process.exit(1);
}

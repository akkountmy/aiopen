// Живая проверка окна просмотра на работающем сервисе (без модели, без токенов):
// вход, временный проект, загрузка Word/Excel/HTML, разбор ответов file-preview
// и file-page, удаление проекта.
//
// Запуск:
//   $env:DSHOW_USER='...'; $env:DSHOW_PASS='...'
//   node scripts/check-preview-live.mjs
// Адрес по умолчанию — боевой сервис; свой можно задать через DSHOW_BASE.
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import ExcelJS from 'exceljs';

const BASE = process.env.DSHOW_BASE || 'https://dshopen-vladimir00177.msk1.amvera.tech';
const LOGIN = process.env.DSHOW_USER;
const PASS = process.env.DSHOW_PASS;
if (!LOGIN || !PASS) throw new Error('нужны DSHOW_USER и DSHOW_PASS');

let cookie = '';
async function call(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { ...options, headers, redirect: 'manual' });
  const set = res.headers.getSetCookie?.() || [];
  if (set.length) cookie = set.map((line) => line.split(';')[0]).join('; ');
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, body };
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + JSON.stringify(detail)}`);
};

const login = await call('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: LOGIN, password: PASS }),
});
check('вход по логину', login.status === 200, login.body);

const created = await call('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Проверка окна просмотра' }),
});
const projectId = created.body?.project?.id || created.body?.id;
check('временный проект создан', created.status === 200 && !!projectId, created.body);

const doc = new Document({
  sections: [
    {
      children: [
        new Paragraph({ text: 'Договор проверки', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun({ text: 'Сумма ' }), new TextRun({ text: '1 000 ₽', bold: true })] }),
        new Paragraph({ text: 'Первый пункт', bullet: { level: 0 } }),
        new Paragraph({ text: 'Второй пункт', bullet: { level: 0 } }),
      ],
    },
  ],
});
const docxBuf = await Packer.toBuffer(doc);

const wb = new ExcelJS.Workbook();
const sheet = wb.addWorksheet('Март');
sheet.addRow(['Модель', 'Количество', 'Сумма']);
sheet.addRow(['Solaris', 7, 1245000]);
const xlsxBuf = Buffer.from(await wb.xlsx.writeBuffer());
const html = '<!doctype html><html><head><meta charset="utf-8"><title>Страница</title></head><body><h1>Проверка HTML</h1><p>Абзац</p></body></html>';

async function upload(name, buf) {
  const res = await call(`/api/projects/${projectId}/upload?path=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' },
    body: buf,
  });
  return res;
}

const files = [
  ['проверка.docx', docxBuf],
  ['проверка.xlsx', xlsxBuf],
  ['проверка.html', Buffer.from(html, 'utf8')],
];
for (const [name, buf] of files) {
  const up = await upload(name, buf);
  check(`загружен ${name}`, up.status === 200, up.body);
}

const docxPreview = await call(`/api/projects/${projectId}/file-preview?path=${encodeURIComponent('проверка.docx')}`);
const docxBlocks = (docxPreview.body?.blocks || []).map((block) => block.type);
check('Word разобран в блоки', docxPreview.body?.format === 'docx' && docxBlocks.join(',') === 'heading,para,list', {
  format: docxPreview.body?.format,
  docxBlocks,
});
check('жирный фрагмент пришёл как run', JSON.stringify(docxPreview.body?.blocks || []).includes('"bold":true'), docxPreview.body?.blocks?.[1]);

const xlsxPreview = await call(`/api/projects/${projectId}/file-preview?path=${encodeURIComponent('проверка.xlsx')}`);
check('Excel разобран в листы', xlsxPreview.body?.format === 'xlsx' && xlsxPreview.body?.sheets?.[0]?.name === 'Март', {
  format: xlsxPreview.body?.format,
  sheets: (xlsxPreview.body?.sheets || []).map((s) => s.name),
});

const htmlPreview = await call(`/api/projects/${projectId}/file-preview?path=${encodeURIComponent('проверка.html')}`);
check('HTML распознан как страница', htmlPreview.body?.format === 'html', htmlPreview.body?.format);

const page = await call(`/api/projects/${projectId}/file-page?path=${encodeURIComponent('проверка.html')}`);
const csp = page.headers.get('content-security-policy') || '';
check(
  'страница отдана как HTML в песочнице',
  page.status === 200 && (page.headers.get('content-type') || '').includes('text/html') && csp.includes('sandbox') && !page.headers.get('x-frame-options'),
  { status: page.status, csp, xfo: page.headers.get('x-frame-options') },
);
check('страница содержит свой текст', String(page.body).includes('Проверка HTML'), String(page.body).slice(0, 80));

const deleted = await call(`/api/projects/${projectId}`, { method: 'DELETE' });
check('временный проект удалён', deleted.status === 200, deleted.body);

const failed = results.filter((r) => !r.ok);
console.log(`\nИтог: ${results.length - failed.length} ok, ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);

/**
 * Живой тест склейки частей озвучки через HTTP: маршрут `/tts-join` и план одной
 * части в `/tts-plan?single=1`. Проверяем то, на чём ломался прошлый подход:
 * склейка НЕ переозвучивает книгу и не правит текст — она берёт готовые части,
 * складывает их и убирает части в скрытый архив.
 *
 * Требует запущенный сервер и учётные данные администратора:
 *   $env:DSHOW_USER='...'; $env:DSHOW_PASS='...'; node test/narration-join-http.mjs
 * Опционально: $env:DSHOW_BASE='http://127.0.0.1:3123'
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.DSHOW_BASE || 'http://127.0.0.1:3123').replace(/\/$/, '');
const USERNAME = process.env.DSHOW_USER || '';
const PASSWORD = process.env.DSHOW_PASS || '';

let cookie = '';
let passed = 0;
const failures = [];
const ok = (name, details = '') => {
  passed += 1;
  console.log(`  ok  ${name}${details ? ` — ${details}` : ''}`);
};
const fail = (name, error) => {
  failures.push(`${name}: ${error}`);
  console.log(`  FAIL ${name} — ${error}`);
};
async function test(name, fn) {
  try {
    await fn();
  } catch (error) {
    fail(name, error.message || String(error));
  }
}
const check = (name, condition, details = '') => (condition ? ok(name, details) : fail(name, details || 'условие не выполнено'));

async function call(pathname, { method = 'GET', body, headers = {}, expect = 200 } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${pathname}`, init);
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (setCookies.length) cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (expect !== null && response.status !== expect) {
    throw new Error(`${method} ${pathname} → ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { status: response.status, data };
}

/* Настоящий MPEG-1 Layer III кадр: 128 кбит/с, 44,1 кГц, стерео. */
function mpeg(count) {
  const one = Buffer.concat([Buffer.from([0xff, 0xfb, 0x40, 0x40]), Buffer.alloc(413, 0)]);
  return Buffer.concat(Array.from({ length: count }, () => one));
}

const BOOK = 'Тест склейки озвучки';
const TEXT = [
  'ГЛАВА ПЕРВАЯ. ТЕОРИЯ ИГР',
  '',
  'Теория игр изучает выбор стратегии в условиях, когда результат зависит не только от собственных действий, но и от решений других участников. '.repeat(6),
  '',
  'ГЛАВА ВТОРАЯ. РАВНОВЕСИЕ',
  '',
  'Равновесие Нэша — это набор стратегий, при котором ни один игрок не выигрывает, изменив свою стратегию в одиночку. '.repeat(6),
].join('\n');

async function main() {
  console.log(`Склейка через HTTP: ${BASE}\n`);
  if (!USERNAME || !PASSWORD) {
    console.error('Задайте DSHOW_USER и DSHOW_PASS в окружении.');
    process.exit(2);
  }
  await call('/api/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD }, expect: 200 });

  const created = await call('/api/projects', { method: 'POST', body: { name: BOOK } });
  const projectId = created.data?.project?.id;
  check('проект создан', Boolean(projectId), projectId || JSON.stringify(created.data).slice(0, 200));

  const documentPath = `${BOOK}.txt`;
  await call(`/api/projects/${projectId}/upload?path=${encodeURIComponent(documentPath)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Filename': encodeURIComponent(`${BOOK}.txt`) },
    body: TEXT,
  });
  ok('документ загружен', documentPath);

  /* Раскладка папки проекта — как её видит сервер: files/<путь>. */
  let workspace = '';
  const files = await call(`/api/projects/${projectId}/files`);
  const listed = JSON.stringify(files.data);
  check('файл виден в папке проекта', listed.includes(BOOK), listed.slice(0, 200));

  const stamp = Date.now();
  const probe = path.join(os.tmpdir(), `narration-join-probe-${stamp}.txt`);
  fs.writeFileSync(probe, 'x');
  fs.rmSync(probe, { force: true });

  /* Части озвучки кладём прямо в папку проекта — так он выглядит после озвучки. */
  const dirs = [];
  const root = path.join(process.env.DSHOW_DATA_DIR || path.resolve('data'), 'workspaces', projectId);
  if (fs.existsSync(root)) dirs.push(root, path.join(root, 'files'));

  await test('план одной части по просьбе человека', async () => {
    const plan = await call(`/api/projects/${projectId}/tts-plan?path=${encodeURIComponent(documentPath)}&single=1`);
    check('план посчитан', plan.data?.ok === true, JSON.stringify(plan.data).slice(0, 200));
    if (plan.data?.ok) {
      check('одна часть, а не несколько', plan.data.parts.length === 1, `частей: ${plan.data.parts.length}`);
      check('минуты не обрезаны', Number(plan.data.minutes) > 1, `${plan.data.minutes} мин`);
    }
  });

  await test('склейка частей через маршрут', async () => {
    const target = dirs.find((dir) => fs.existsSync(path.join(dir, documentPath)));
    if (!target) {
      fail('части некуда положить', `не нашёл папку проекта среди ${dirs.join(', ')}`);
      return;
    }
    const folder = path.dirname(path.join(target, documentPath));
    for (const index of [1, 2]) {
      fs.writeFileSync(path.join(folder, `${BOOK} — часть ${index} из 2.mp3`), mpeg(30 * index));
    }
    const res = await call(`/api/projects/${projectId}/tts-join`, {
      method: 'POST',
      body: { path: documentPath },
    });
    check('ответ ok', res.data?.ok === true, JSON.stringify(res.data).slice(0, 300));
    check('получился один файл', res.data?.file?.name === `${BOOK}.mp3`, res.data?.file?.name);
    check('длительность посчитана', Number(res.data?.file?.seconds) > 0, `${res.data?.file?.seconds} с`);
    check('части убраны', Array.isArray(res.data?.archived) && res.data.archived.length === 2, JSON.stringify(res.data?.archived));
    check('файл на диске', fs.existsSync(path.join(folder, `${BOOK}.mp3`)), '');
    check('части из папки ушли', !fs.existsSync(path.join(folder, `${BOOK} — часть 1 из 2.mp3`)), '');

    const again = await call(`/api/projects/${projectId}/tts-join`, { method: 'POST', body: { path: documentPath } });
    check('повторная склейка не ломает файл', again.data?.already === true, JSON.stringify(again.data).slice(0, 200));
  });

  await test('склейка несуществующего файла — 404', async () => {
    const res = await call(`/api/projects/${projectId}/tts-join`, {
      method: 'POST',
      body: { path: 'нет такого файла.pdf' },
      expect: 404,
    });
    check('404 с причиной', res.status === 404 && Boolean(res.data?.error), res.data?.error || '');
  });

  console.log(`\nИтого: ${passed} ok, ${failures.length} fail`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error('Сценарий не прошёл:', error.message);
  process.exit(1);
});

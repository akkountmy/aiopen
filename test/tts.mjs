/**
 * Живой тест озвучки: документ проекта → MP3.
 * Требует запущенный сервер и учётные данные администратора:
 *   $env:DSHOW_USER='...'; $env:DSHOW_PASS='...'; node test/tts.mjs
 * Опционально: $env:DSHOW_BASE='http://127.0.0.1:3123'
 *
 * Проверяем то, что видит человек: голоса в списке, отказ на пустом файле,
 * прогресс задания, готовый звук с поддержкой перемотки и появление MP3 среди
 * файлов проекта. Плюс чистые функции (нарезка текста, длительность) — они не
 * требуют сервера, но ломаются первыми при правках.
 */
const BASE = (process.env.DSHOW_BASE || 'http://127.0.0.1:3123').replace(/\/$/, '');
const USERNAME = process.env.DSHOW_USER || '';
const PASSWORD = process.env.DSHOW_PASS || '';

let cookie = '';
let passed = 0;
const failures = [];

function ok(name, details = '') {
  passed += 1;
  console.log(`  ok  ${name}${details ? ` — ${details}` : ''}`);
}

function fail(name, error) {
  failures.push(`${name}: ${error}`);
  console.log(`  FAIL ${name} — ${error}`);
}

async function test(name, fn) {
  try {
    await fn();
  } catch (error) {
    fail(name, error.message);
  }
}

async function call(path, { method = 'GET', body, headers = {}, expect = 200 } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${path}`, init);
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (setCookies.length) cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (expect !== null && response.status !== expect) {
    throw new Error(`${method} ${path} → ${response.status} (ожидался ${expect}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { status: response.status, data, headers: response.headers };
}

/* Отрывок книги: абзацы, сокращение «т. д.», длинное предложение — так видно,
   что нарезка не рвёт фразу и не спотыкается на точках внутри сокращений. */
const FRAGMENT = `Глава первая. Тишина перед сделкой.

Лизинг начинается не с подписания договора, а с разговора о деньгах. Предприятие
платит ровно столько, сколько выдерживает его денежный поток, и это важнее ставки.

Второй абзац проверяет длинное предложение с перечислением: аванс, срок, график,
выкупная стоимость, страховка, обслуживание, налоги и т. д. — всё это должно
читаться без спотыканий и без обрыва на середине фразы.`;

async function main() {
  console.log(`Озвучка: ${BASE}\n`);
  if (!USERNAME || !PASSWORD) {
    console.error('Задайте DSHOW_USER и DSHOW_PASS в окружении.');
    process.exit(2);
  }

  /* Чистые функции: работают без сервера. */
  await test('нарезка текста', async () => {
    const { chunkText, normalizeText } = await import('../src/tts.mjs');
    const chunks = chunkText(FRAGMENT, 200);
    if (chunks.length < 2) throw new Error(`ожидалось несколько кусков, получено ${chunks.length}`);
    const longest = Math.max(...chunks.map((item) => item.length));
    if (longest > 200) throw new Error(`кусок длиннее лимита: ${longest}`);
    if (!normalizeText(FRAGMENT).includes('т. д.')) throw new Error('сокращение потерялось');
    ok('нарезка текста', `${chunks.length} кусков, максимум ${longest} знак`);
  });

  await test('длительность MP3', async () => {
    const { mp3Duration } = await import('../src/tts.mjs');
    /* Кадр MPEG-2 Layer III, 48 кбит/с, 24 кГц: 72 * 48000 / 24000 = 144 байта,
       в кадре 576 отсчётов — это 24 мс. Сто кадров = 2,4 с. */
    const frame = Buffer.alloc(144);
    frame[0] = 0xff;
    frame[1] = 0xf3;
    frame[2] = 0x64;
    frame[3] = 0xc4;
    const audio = Buffer.concat(Array.from({ length: 100 }, () => frame));
    const seconds = mp3Duration(audio);
    if (Math.abs(seconds - 2.4) > 0.05) throw new Error(`ожидалось 2,4 с, получено ${seconds}`);
    ok('длительность MP3', `${seconds} с на 100 кадрах`);
  });

  await test('вход', async () => {
    const { data } = await call('/api/login', { method: 'POST', body: { username: USERNAME, password: PASSWORD } });
    if (!data?.user) throw new Error('нет пользователя в ответе');
    ok('вход', data.user.username);
  });

  let projectId = null;

/* Файл в проект кладётся сырым телом запроса, имя приходит заголовком. */
async function upload(name, content) {
  const response = await fetch(`${BASE}/api/projects/${projectId}/upload?path=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { cookie, 'x-filename': encodeURIComponent(name), 'content-type': 'text/plain; charset=utf-8' },
    body: content,
  });
  if (!response.ok) throw new Error(`загрузка ${name} → ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}
  await test('проект', async () => {
    const name = `Озвучка ${Date.now().toString().slice(-5)}`;
    const { data } = await call('/api/projects', { method: 'POST', body: { name } });
    projectId = data.project?.id || data.id;
    if (!projectId) throw new Error('проект не создался');
    ok('проект', projectId);
  });

  await test('голоса', async () => {
    const { data } = await call('/api/tts/voices');
    if (!Array.isArray(data.voices) || !data.voices.length) throw new Error('пустой список голосов');
    if (!data.defaults?.voice) throw new Error('нет голоса по умолчанию');
    const ru = data.available?.filter((name) => name.startsWith('ru-')) || [];
    ok('голоса', `${data.voices.length} на выбор, доступно ru: ${ru.length}`);
  });

  await test('загрузка отрывка', async () => {
    await upload('Глава первая.txt', FRAGMENT);
    ok('загрузка отрывка');
  });

  await test('длину части задаёт книга, а не человек', async () => {
    /* Три главы примерно по 25 минут звука. Окно длину не спрашивает: сервер
       берёт её из глав — такая глава идёт целиком, значит частей три. План
       считается без синтеза, поэтому проверка быстрая. */
    const chapter = (number) => `\n\nГлава ${number}\n\n${'Предложение про рынок лизинга и его участников. '.repeat(440)}`;
    const book = [chapter('первая'), chapter('вторая'), chapter('третья')].join('\n');
    await upload('Книга из глав.txt', book);
    const { data } = await call(`/api/projects/${projectId}/tts-plan?path=${encodeURIComponent('Книга из глав.txt')}`);
    if (!data.ok) throw new Error(`план не построен: ${data.reason || 'без причины'}`);
    if (!(data.partMinutes >= 20 && data.partMinutes <= 45)) {
      throw new Error(`длина части выбрана мимо глав: ${data.partMinutes} мин`);
    }
    if (data.parts.length !== 3) throw new Error(`ожидалось 3 части по главам, получилось ${data.parts.length}`);
    if (!data.names.every((name) => name.startsWith('Книга из глав — часть '))) {
      throw new Error(`имена частей: ${data.names.join(' | ')}`);
    }
    ok('длину части задаёт книга, а не человек', `${data.partMinutes} мин, частей ${data.parts.length}`);
  });

  await test('явная длина части ещё работает', async () => {
    /* Модель в чате и скрипты могут задать длину сами — сервер обязан её принять. */
    const { data } = await call(
      `/api/projects/${projectId}/tts-plan?path=${encodeURIComponent('Книга из глав.txt')}&minutes=15`,
    );
    if (data.partMinutes !== 15) throw new Error(`ожидалось 15 мин, получено ${data.partMinutes}`);
    if (data.parts.length < 3) throw new Error(`на 15-минутные части текст не разбился: ${data.parts.length}`);
    ok('явная длина части ещё работает', `${data.partMinutes} мин, частей ${data.parts.length}`);
  });

  await test('отказ на пустом тексте', async () => {
    await upload('пусто.txt', '   \n\n  ');
    const { data } = await call(`/api/projects/${projectId}/tts`, {
      method: 'POST',
      body: { path: 'пусто.txt', voice: 'ru-RU-SvetlanaNeural', rate: '1' },
      expect: 400,
    });
    if (!data.error) throw new Error('нет текста ошибки');
    ok('отказ на пустом тексте', data.error);
  });

  let job = null;
  await test('запуск озвучки', async () => {
    const { data } = await call(`/api/projects/${projectId}/tts`, {
      method: 'POST',
      body: { path: 'Глава первая.txt', voice: 'ru-RU-SvetlanaNeural', rate: '1' },
    });
    job = data.job;
    if (!job?.id) throw new Error('задание не создалось');
    ok('запуск озвучки', job.id);
  });

  await test('синтез до готовности', async () => {
    if (!job?.id) throw new Error('задание не создано');
    const started = Date.now();
    let last = null;
    for (let i = 0; i < 120; i += 1) {
      const { data } = await call(`/api/tts/jobs/${job.id}`);
      last = data.job;
      if (last.status === 'done') break;
      if (last.status === 'failed') throw new Error(last.error || 'синтез упал');
      if (Date.now() - started > 180000) throw new Error('синтез не уложился в 3 минуты');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (last?.status !== 'done') throw new Error(`задание осталось в состоянии ${last?.status}`);
    if (!(last.file?.size > 5000)) throw new Error(`подозрительно маленький файл: ${last.file?.size} байт`);
    if (!(last.seconds > 1)) throw new Error(`длительность не определилась: ${last.seconds}`);
    job = last;
    ok('синтез до готовности', `${Math.round(last.file.size / 1024)} КБ, ${last.file.duration}, голос ${last.voice}`);
  });

  await test('звук отдаётся целиком', async () => {
    if (!job?.id) throw new Error('задание не создано');
    const response = await fetch(`${BASE}/api/tts/jobs/${job.id}/audio`, { headers: { cookie } });
    if (!response.ok) throw new Error(`audio → ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (!type.includes('audio')) throw new Error(`неверный тип: ${type}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length !== job.file.size) throw new Error(`размер ${buffer.length} ≠ ${job.file.size}`);
    const head = buffer.subarray(0, 2).toString('latin1');
    if (head !== '\u00ff\u00f3' && buffer.subarray(0, 3).toString('latin1') !== 'ID3') {
      throw new Error('это не MP3: первые байты ' + buffer.subarray(0, 4).toString('hex'));
    }
    ok('звук отдаётся целиком', `${Math.round(buffer.length / 1024)} КБ, ${type}`);
  });

  await test('перемотка через Range', async () => {
    if (!job?.id) throw new Error('задание не создано');
    /* С телефона перемотка работает только на 206: без него iOS не играет. */
    const response = await fetch(`${BASE}/api/tts/jobs/${job.id}/audio`, {
      headers: { cookie, range: 'bytes=1000-1999' },
    });
    if (response.status !== 206) throw new Error(`ожидался 206, получен ${response.status}`);
    const contentRange = response.headers.get('content-range') || '';
    if (!/^bytes 1000-1999\//.test(contentRange)) throw new Error(`неверный Content-Range: ${contentRange}`);
    const part = Buffer.from(await response.arrayBuffer());
    if (part.length !== 1000) throw new Error(`ожидалось 1000 байт, получено ${part.length}`);
    ok('перемотка через Range', contentRange);
  });

  await test('MP3 в файлах проекта', async () => {
    const { data } = await call(`/api/projects/${projectId}/files?path=&depth=2`);
    const names = JSON.stringify(data.nodes || data.files || data);
    if (!/\.mp3/.test(names)) throw new Error('озвучка не видна среди файлов проекта');
    ok('MP3 в файлах проекта');
  });

  await test('отмена задания', async () => {
    if (!job?.id) throw new Error('задание не создано');
    const { data } = await call(`/api/tts/jobs/${job.id}`, { method: 'DELETE' });
    if (!data.job) throw new Error('нет задания в ответе');
    ok('отмена задания', data.job.status);
  });

  await test('чужое задание не видно', async () => {
    const response = await fetch(`${BASE}/api/tts/jobs/${job?.id || 'нет'}`, { headers: { cookie: '' } });
    if (response.status !== 401) throw new Error(`без входа ответ ${response.status}`);
    ok('чужое задание не видно');
  });

  console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
  if (failures.length) {
    for (const item of failures) console.log(`  - ${item}`);
    process.exit(1);
  }
}

await main();

// Проверка сжатия вложений (задача #16): файлы больше 0,7 МБ уходят в модель
// сжатыми. Часть проверок — чистая математика (порог, план попыток, масштаб),
// часть — настоящий Chrome: он и создаёт исходник, и сжимает его, потому что
// кодирование в WebP/JPEG умеет только браузер, а не node.
//
//   node test/attach-shrink.mjs
//
// Если Chrome/Edge не найден, браузерная часть пропускается с честной пометкой
// «--», а не выдаётся за пройденную.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHRINK = path.join(ROOT, 'public', 'attach-shrink.js');

let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`  !!  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ---------------------------- чистая часть ---------------------------- */
const moduleUrl = pathToFileURL(SHRINK).href;
await import(moduleUrl);
const S = globalThis.AttachShrink;
ok('attach-shrink.js загружается', Boolean(S));
if (!S) {
  console.log('\nПРОВЕРКА ПРОВАЛЕНА');
  process.exit(1);
}

ok('порог 0,7 МБ', S.LIMIT_BYTES === 700 * 1024, String(S.LIMIT_BYTES));
ok('маленький файл не сжимается', S.shouldShrink({ size: 500 * 1024, type: 'image/jpeg' }) === false);
ok('большой файл сжимается', S.shouldShrink({ size: 3 * 1024 * 1024, type: 'image/jpeg' }) === true);
ok('граница ровно 0,7 МБ не сжимается', S.shouldShrink({ size: 700 * 1024, type: 'image/png' }) === false);
ok('pdf не сжимается', S.shouldShrink({ size: 5 * 1024 * 1024, type: 'application/pdf' }) === false);
ok('gif не сжимается (потерялась бы анимация)', S.shouldShrink({ size: 5 * 1024 * 1024, type: 'image/gif' }) === false);
ok('svg не сжимается (это вектор)', S.shouldShrink({ size: 5 * 1024 * 1024, type: 'image/svg+xml' }) === false);
ok('heic не сжимается (браузер не декодирует)', S.shouldShrink({ size: 5 * 1024 * 1024, type: 'image/heic' }) === false);

const plan = S.planAttempts(4000, 3000);
ok('план начинается с лучшего качества', plan[0].quality === Math.max(...S.QUALITIES), JSON.stringify(plan[0]));
ok('план не длиннее, чем нужно', plan.length > 0 && plan.length <= S.QUALITIES.length * 5);
ok('в плане нет повторов', new Set(plan.map((s) => `${s.side}:${s.quality}`)).size === plan.length);
ok('план заканчивается худшим качеством', plan.at(-1).quality === Math.min(...S.QUALITIES));
ok('большая сторона не больше 1600', Math.max(...plan.map((s) => s.side)) <= S.MAX_SIDE);
ok('ниже 640 не опускаемся', Math.min(...plan.map((s) => s.side)) >= S.MIN_SIDE);

const scaled = S.scaledSize(4000, 3000, 1600);
ok('масштаб сохраняет пропорции', scaled.width === 1600 && scaled.height === 1200, JSON.stringify(scaled));
const noUpscale = S.scaledSize(300, 200, 1600);
ok('маленькую картинку не растягиваем', noUpscale.width === 300 && noUpscale.height === 200, JSON.stringify(noUpscale));
const portrait = S.scaledSize(1200, 4800, 1600);
ok('портрет масштабируется по длинной стороне', portrait.width === 400 && portrait.height === 1600, JSON.stringify(portrait));
ok('нулевой размер не ломает масштаб', S.scaledSize(0, 0, 1600).width === 1);

ok('подпись экономии читаемая', S.formatNote(3.4 * 1024 * 1024, 0.4 * 1024 * 1024).includes('−88'), S.formatNote(3.4 * 1024 * 1024, 0.4 * 1024 * 1024));
ok('переименование меняет расширение', S.renameTo('Фото 2026.PNG', '.webp') === 'Фото 2026.webp', S.renameTo('Фото 2026.PNG', '.webp'));
ok('имя без расширения не ломается', S.renameTo('снимок', '.webp') === 'снимок.webp', S.renameTo('снимок', '.webp'));

/* --------------------- подключение к интерфейсу --------------------- */
/* Сжатие бесполезно, если его забыли позвать в одном из путей прикрепления.
   Проверяем статикой по app.js: все три пути (вложение сообщения, файл проекта,
   документ задания) идут через общий shrinkBeforeUpload, и ни один не отправляет
   исходный файл напрямую. */
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
ok('attach-shrink.js подключён в index.html', indexHtml.includes('src="/attach-shrink.js'));
ok('скрипт подключён раньше app.js', indexHtml.indexOf('/attach-shrink.js') < indexHtml.indexOf('/app.js'));
ok('путей прикрепления ровно три', (appJs.match(/await shrinkBeforeUpload\(file\)/g) || []).length === 3,
  String((appJs.match(/await shrinkBeforeUpload\(file\)/g) || []).length));
ok('порог описан в интерфейсе', appJs.includes('0,7 МБ'));

/* Каждая отправка файла идёт телом outgoing.file — то есть сжатым — и рядом с
   каждой стоит вызов сжатия. Исходный файл в теле запроса не встречается. */
const bodies = [];
for (let at = appJs.indexOf('body: outgoing.file'); at >= 0; at = appJs.indexOf('body: outgoing.file', at + 1)) {
  bodies.push(at);
}
ok('сжатое тело отправляется трижды', bodies.length === 3, String(bodies.length));
ok('исходный файл в тело запроса не попадает', !/\bbody: file,/.test(appJs));
bodies.forEach((at, index) => {
  const before = appJs.slice(Math.max(0, at - 1600), at);
  ok(`отправка №${index + 1} идёт после сжатия`, before.includes('shrinkBeforeUpload'), 'нет вызова сжатия рядом');
});

/* ---------------------------- живой Chrome ---------------------------- */
function findChrome() {
  const candidates = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.log('  --  Chrome/Edge не найден, сжатие в браузере не проверялось');
} else {
  let puppeteer = null;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch {
    console.log('  --  puppeteer-core не установлен, сжатие в браузере не проверялось');
  }
  if (puppeteer) {
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'],
    });
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      await page.addScriptTag({ path: SHRINK });

      const result = await page.evaluate(async () => {
        const api = globalThis.AttachShrink;
        /* Исходник: большая «фотография» с шумом и текстом — так файл заведомо
           больше 0,7 МБ, и видно, что текст после сжатия не превратился в кашу. */
        async function makePhoto(width, height, quality = 0.95) {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          const gradient = ctx.createLinearGradient(0, 0, width, height);
          gradient.addColorStop(0, '#2b4a7a');
          gradient.addColorStop(1, '#e9e4d8');
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, width, height);
          /* Шум: без него PNG сжимается слишком хорошо и порог не проверить. */
          const noise = ctx.getImageData(0, 0, width, height);
          for (let i = 0; i < noise.data.length; i += 4) {
            const shift = (Math.random() - 0.5) * 60;
            noise.data[i] += shift;
            noise.data[i + 1] += shift;
            noise.data[i + 2] += shift;
          }
          ctx.putImageData(noise, 0, 0);
          ctx.fillStyle = '#fff';
          ctx.font = '48px sans-serif';
          ctx.fillText('Договор № 42 от 02.11.2026', 60, 120);
          ctx.fillText('Сумма: 1 250 000 ₽', 60, 200);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
          return { blob, width, height };
        }

        const out = {};
        const big = await makePhoto(2400, 1600);
        const bigFile = new File([big.blob], 'Договор 42.png', { type: 'image/png' });
        out.before = bigFile.size;
        const shrunk = await api.shrink(bigFile);
        out.changed = shrunk.changed;
        out.after = shrunk.to;
        out.note = shrunk.note;
        out.name = shrunk.file.name;
        out.type = shrunk.file.type;
        out.sizeMatches = shrunk.file.size === shrunk.to;
        out.bytes = Array.from(new Uint8Array(await shrunk.file.arrayBuffer())).slice(0, 0);
        /* Размер после сжатия и в самом деле такой: читаем blob через Image. */
        const decoded = await new Promise((resolve, reject) => {
          const url = URL.createObjectURL(shrunk.file);
          const img = new Image();
          img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('не декодируется')); };
          img.src = url;
        });
        out.decodedW = decoded.w;
        out.decodedH = decoded.h;

        /* Маленький файл: не трогаем вовсе. */
        const small = await makePhoto(200, 150, 0.6);
        const smallFile = new File([small.blob], 'маленький.png', { type: 'image/png' });
        const kept = await api.shrink(smallFile);
        out.smallSize = smallFile.size;
        out.smallChanged = kept.changed;
        out.smallSame = kept.file === smallFile;

        /* PDF: не сжимаем, отдаём как есть. */
        const pdfFile = new File([new Uint8Array(2 * 1024 * 1024)], 'документ.pdf', { type: 'application/pdf' });
        const pdfOut = await api.shrink(pdfFile);
        out.pdfChanged = pdfOut.changed;
        out.pdfSame = pdfOut.file === pdfFile;
        return out;
      });

      ok('большой PNG действительно больше 0,7 МБ', result.before > 700 * 1024, String(result.before));
      ok('большой PNG сжат', result.changed === true);
      ok('после сжатия файл укладывается в 0,7 МБ', result.after <= 700 * 1024, `${result.after} Б`);
      ok('сжатие заметное (меньше исходника втрое)', result.after < result.before / 3, `${result.before} → ${result.after}`);
      ok('подпись экономии заполнена', typeof result.note === 'string' && result.note.includes('%'), result.note);
      ok('имя переименовано под новый формат', /\.(webp|jpg)$/i.test(result.name), result.name);
      ok('тип соответствует формату', /^image\/(webp|jpeg)$/.test(result.type), result.type);
      ok('размер в записи совпадает с реальным', result.sizeMatches === true);
      ok('сжатый файл декодируется', result.decodedW > 0 && result.decodedH > 0, `${result.decodedW}×${result.decodedH}`);
      ok('длинная сторона не больше 1600', Math.max(result.decodedW, result.decodedH) <= 1600, `${result.decodedW}×${result.decodedH}`);
      ok('пропорции сохранены', Math.abs(result.decodedW / result.decodedH - 1.5) < 0.05, `${result.decodedW}×${result.decodedH}`);
      ok('маленький файл не тронут', result.smallChanged === false && result.smallSame === true);
      ok('pdf не сжат и не испорчен', result.pdfChanged === false && result.pdfSame === true);
    } finally {
      await browser.close();
    }
  }
}

console.log(`\nпройдено ${passed}, провалено ${failed}`);
if (failed) {
  console.log('ПРОВЕРКА ПРОВАЛЕНА');
  process.exit(1);
}
console.log('ПРОВЕРКА ПРОЙДЕНА');

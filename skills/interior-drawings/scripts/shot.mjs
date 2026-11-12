#!/usr/bin/env node
/**
 * Скриншот HTML-страницы (3D-сцена, визуализация).
 *
 * Сначала пробуем общий движок сервиса (src/browser.mjs): он знает про
 * встроенный @sparticuz/chromium, который распаковывается в /tmp в облачной
 * node-сборке Amvera. Именно этого не хватало визуализации: здесь раньше
 * искались только браузер Playwright и Edge, а на сервере нет ни того, ни
 * другого, хотя остальные листы собирались.
 *
 * Дальше — локальный Playwright Chromium, потом Edge. WebGL снимаем с
 * SwiftShader: headless Edge на машинах без GPU отдаёт пустой кадр.
 *
 *   node shot.mjs page.html out.png [--width 1600 --height 1000 --dpi 2]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { htmlToPng as edgePng } from './render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/* Общий выбор браузера лежит в сервисе. Если навык запускают отдельно от
   DSH.OPEN.WEB, модуля нет — остаются локальные ступени ниже. */
function serviceRoot() {
  const candidates = [
    path.resolve(HERE, '..', '..', '..'),
    process.env.DSH_OPEN_WEB || '',
  ].filter(Boolean);
  for (const root of candidates) {
    const file = path.join(root, 'src', 'browser.mjs');
    if (fs.existsSync(file)) return file;
  }
  return '';
}

let shared = null;
const sharedError = [];
const sharedFile = serviceRoot();
if (sharedFile) {
  try {
    shared = await import(pathToFileURL(sharedFile).href);
  } catch (error) {
    sharedError.push(`общий движок не загрузился: ${String(error?.message || error).slice(0, 200)}`);
  }
}

function pw() {
  const roots = [
    process.env.PLAYWRIGHT_CORE,
    path.join(process.cwd(), 'node_modules', 'playwright-core'),
    'D:\\DSHarness-0.1\\DSH.OPEN.WEB\\node_modules\\playwright-core',
    process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'node_modules', 'playwright-core') : null,
    path.join(os.homedir(), '.dsh', 'node_modules', 'playwright-core'),
  ].filter(Boolean);
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    try {
      return require(r);
    } catch {
      /* пробуем следующий */
    }
  }
  return null;
}

function chromiumExe() {
  const bases = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright'),
    '/ms-playwright',
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter(Boolean);
  for (const base of [...new Set(bases)]) {
    if (!fs.existsSync(base)) continue;
    const dirs = fs
      .readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
    for (const d of dirs.reverse()) {
      for (const exe of [
        'chrome-win64/chrome.exe',
        'chrome-win/chrome.exe',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const p = path.join(base, d, exe);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

function shortError(error) {
  return String(error?.message || error || 'сбой').split('\n')[0].slice(0, 240);
}

export async function htmlShot(htmlPath, pngPath, o = {}) {
  const width = o.width || 1600;
  const height = o.height || 1000;
  const dpi = o.dpi || 2;
  const out = path.resolve(pngPath);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const errors = [];

  /* 1. Движок сервиса: Playwright / @sparticuz / системный Chrome. */
  if (shared?.shotHtml) {
    try {
      const result = await shared.shotHtml({
        file: htmlPath,
        pngPath: out,
        width,
        height,
        dpr: dpi,
        query: o.query || '',
        timeoutMs: o.timeoutMs || 90000,
        readyTimeout: o.readyTimeout || 30000,
        settleMs: o.settleMs ?? 700,
        minBytes: 1000,
      });
      return { ...result, errors: [...new Set([...(result.errors || []), ...errors])].slice(0, 5) };
    } catch (error) {
      errors.push(`движок сервиса: ${shortError(error)}`);
    }
  } else if (sharedError.length) {
    errors.push(...sharedError);
  }

  /* 2. Локальный Playwright Chromium — путь разработчика. */
  const lib = pw();
  if (lib?.chromium) {
    let browser = null;
    try {
      const exe = chromiumExe();
      browser = await lib.chromium.launch({
        executablePath: exe || undefined,
        timeout: 20000,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
          '--allow-file-access-from-files',
        ],
      });
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpi });
      page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 300)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text().slice(0, 300));
      });
      const url = pathToFileURL(path.resolve(htmlPath)).href + (o.query || '');
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page
        .waitForFunction(
          () => document.body && (document.body.dataset.ready === '1' || window.__designReady === true),
          null,
          { timeout: o.readyTimeout || 30000 },
        )
        .catch(() => errors.push('сцена не отметила готовность (data-ready)'));
      await page.waitForTimeout(o.settleMs || 700);
      await page.screenshot({ path: out });
      const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
      return { png: out, bytes, engine: 'playwright-chromium', errors: [...new Set(errors)].slice(0, 5) };
    } catch (error) {
      errors.push(`Playwright: ${shortError(error)}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  /* 3. Последняя ступень — Edge/Chrome командной строкой. */
  try {
    const res = edgePng(htmlPath, out, { width, height, waitMs: o.waitMs || 6000, query: o.query });
    return {
      ...res,
      engine: 'edge-headless',
      errors: [...new Set([...errors, 'Edge без WebGL: кадр может быть пустым'])].slice(0, 5),
    };
  } catch (error) {
    throw new Error([...errors, `Edge: ${shortError(error)}`].join('; '));
  }
}

if (process.argv[1] && process.argv[1].endsWith('shot.mjs')) {
  const [file, outArg] = process.argv.slice(2);
  if (!file) {
    console.error('Использование: node shot.mjs page.html out.png [--width 1600 --height 1000 --dpi 2]');
    process.exit(2);
  }
  const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? Number(process.argv[i + 1]) : def;
  };
  const out = path.resolve(outArg || file.replace(/\.html?$/i, '.png'));
  htmlShot(file, out, { width: arg('--width', 1600), height: arg('--height', 1000), dpi: arg('--dpi', 2) })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error('Не удалось снять скриншот:', e.message);
      process.exit(1);
    });
}

#!/usr/bin/env node
/**
 * Скриншот HTML-страницы (3D-сцена, визуализация) через Playwright Chromium.
 * Нужен для WebGL: headless Edge на части машин отдаёт пустой кадр, а Chromium
 * с SwiftShader рисует стабильно. Если Playwright нет — падаем на Edge.
 *
 *   node shot.mjs page.html out.png [--width 1600 --height 1000 --dpi 2]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { htmlToPng as edgePng } from './render.mjs';

const require = createRequire(import.meta.url);

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
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
  for (const d of dirs.reverse()) {
    for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(base, d, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export async function htmlShot(htmlPath, pngPath, o = {}) {
  const width = o.width || 1600;
  const height = o.height || 1000;
  const dpi = o.dpi || 2;
  fs.mkdirSync(path.dirname(path.resolve(pngPath)), { recursive: true });
  const errors = [];
  const lib = pw();
  if (lib && lib.chromium) {
    const exe = chromiumExe();
    const browser = await lib.chromium.launch({
      executablePath: exe || undefined,
      timeout: 20000,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files'],
    });
    try {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpi });
      page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 300)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text().slice(0, 300));
      });
      const url = pathToFileURL(path.resolve(htmlPath)).href + (o.query || '');
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page
        .waitForFunction(() => document.body && document.body.dataset.ready === '1', { timeout: o.readyTimeout || 15000 })
        .catch(() => errors.push('сцена не отметила готовность (data-ready)'));
      await page.waitForTimeout(o.settleMs || 700);
      await page.screenshot({ path: path.resolve(pngPath) });
      return { png: path.resolve(pngPath), bytes: fs.statSync(pngPath).size, engine: 'playwright-chromium', errors: [...new Set(errors)].slice(0, 5) };
    } finally {
      await browser.close();
    }
  }
  // запасной путь без Playwright
  const res = edgePng(htmlPath, pngPath, { width, height, waitMs: o.waitMs || 6000, query: o.query });
  return { ...res, engine: 'edge-headless', errors: ['Playwright не найден — кадр может быть пустым, если нет WebGL'] };
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

/**
 * Один вход в проверку сервиса: `npm test`.
 *
 * Запускает по одному файлу из test/, печатает строку на файл и честную сводку,
 * код выхода 1, если хоть одна проверка упала. Без новых зависимостей.
 *
 *   node scripts/check.mjs              — оффлайн-набор (по умолчанию, бесплатно)
 *   node scripts/check.mjs --live       — вместе с теми, кому нужен сервис на :3131,
 *                                        браузер, камера или живая модель
 *   node scripts/check.mjs --json       — машиночитаемый итог (JSON в stdout, статус в stderr)
 *   node scripts/check.mjs --only docs  — только файлы, в имени которых есть подстрока
 *   node scripts/check.mjs --list       — что входит в набор, ничего не запуская
 *   node scripts/check.mjs --timeout 60 — предел на файл, секунды
 *
 * Почему не встроенный `node --test test`: 85 файлов — это смесь своего мини-раннера
 * (`ok`/`FAIL`), node:test и живых сценариев с браузером. Единый список с явными
 * причинами пропуска читается лучше, чем молчание упавших по ECONNREFUSED.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');

/** Русское склонение: plural(3, ['файл', 'файла', 'файлов']) → 'файла'. */
const plural = (n, forms) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
};

// Проверки, которые без живого окружения падают не из-за кода, а из-за его отсутствия.
// Значение — короткая причина, она печатается в --list и в сводке.
const LIVE = {
  'live.mjs': 'живая модель, тратит токены',
  'landing.mjs': 'живая модель',
  'vision.mjs': 'живая модель, картинка аргументом',
  'cloud.mjs': 'внешний сервис',
  'pdf-live.mjs': 'работающий сервис на :3131',
  'smoke.mjs': 'работающий сервис на :3131',
  'dashboard.mjs': 'работающий сервис на :3131',
  'status-bar.mjs': 'работающий сервис на :3131',
  'status-bar-live.mjs': 'работающий сервис на :3131',
  'theme-reload.mjs': 'работающий сервис на :3131',
  'device-guard.mjs': 'работающий сервис на :3131',
  'device-wording.mjs': 'работающий сервис на :3131',
  'two-devices.mjs': 'работающий сервис на :3131',
  'backup.mjs': 'работающий сервис на :3131',
  'docpreview.mjs': 'работающий сервис на :3131',
  'push-auto.mjs': 'работающий сервис и подписка на пуш',
  'push-broadcast.mjs': 'работающий сервис и подписка на пуш',
  'push-sw.mjs': 'работающий сервис и подписка на пуш',
  'chat-links.mjs': 'браузер и работающий сервис',
  'ui-attach.mjs': 'браузер и виртуальная камера',
  'ui-dnd.mjs': 'браузер',
  'ui-files-audio.mjs': 'браузер',
  'ui-flows.mjs': 'браузер',
  'ui-keyboard.mjs': 'браузер',
  'ui-keyboard-typing.mjs': 'браузер',
  'ui-mobile.mjs': 'браузер',
  'ui-modal-sheet.mjs': 'браузер',
  'ui-panels.mjs': 'браузер',
  'ui-runs.mjs': 'браузер',
  'ui-sections.mjs': 'браузер',
  'ui-scroll.mjs': 'браузер',
  'ui-swipe.mjs': 'браузер',
  'ui-version.mjs': 'браузер',
  'ui-code-editor.mjs': 'браузер и проект с design.json',
  'typo-visual.mjs': 'браузер и эталон типографики'
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : fallback;
};

const asJson = flag('--json');
const withLive = flag('--live');
const only = value('--only', '');
const timeoutSec = Number(value('--timeout', '300')) || 300;

// В режиме --json всё человеческое уходит в stderr, чтобы stdout оставался одним JSON.
const say = asJson ? (line) => process.stderr.write(line + '\n') : (line) => console.log(line);
const fail = (error, code, hints = []) => {
  if (asJson) console.log(JSON.stringify({ error, code, hints }, null, 2));
  else say(`ошибка: ${error}`);
  process.exit(2);
};

if (!fs.existsSync(testDir)) fail('нет каталога test', 'NO_TESTS_DIR', ['запускайте из корня проекта: node scripts/check.mjs']);

const all = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.mjs'))
  .sort();

const files = all.filter((name) => (only ? name.includes(only) : true));
if (files.length === 0) fail(`под фильтр "${only}" ничего не подошло`, 'NO_TESTS', ['--list покажет полный набор']);

/* Половину «живых» проверок не надо перечислять руками: если файл ходит на
   :3131 и не поднимает сервер сам — ему нужен запущенный сервис. Угадывание по
   содержимому не даёт списку устареть, когда добавляется новая проверка. */
function liveReason(name) {
  if (LIVE[name]) return LIVE[name];
  try {
    const text = fs.readFileSync(path.join(testDir, name), 'utf8');
    const wantsPort = /:3131/.test(text);
    const ownsServer = /createServer\s*\(|\.listen\s*\(/.test(text);
    return wantsPort && !ownsServer ? 'работающий сервис на :3131' : '';
  } catch {
    return '';
  }
}

const live = files.filter((name) => Boolean(liveReason(name)));
const liveNames = new Set(live);
const offline = files.filter((name) => !liveNames.has(name));
const plan = withLive ? files : offline;

if (flag('--list')) {
  for (const name of offline) say(`  ${name}`);
  if (live.length) {
    say('  (нужно живое окружение, включается --live)');
    for (const name of live) say(`  ${name} — ${liveReason(name)}`);
  }
  say(`итого: ${plan.length} в прогоне, ${offline.length} оффлайн, ${live.length} с живым окружением`);
  process.exit(0);
}

/** Отвечает ли кто-нибудь на 127.0.0.1:3131 — чтобы сказать «подними сервис», а не показывать стек. */
function serviceAlive(port = 3131) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Запуск одного файла: код выхода, счётчик провалов, последняя содержательная строка. */
function runOne(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join('test', name)], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let out = '';
    const keep = (chunk) => {
      out += chunk;
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSec * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ name, exit: -1, fails: 1, failLines: [error.message], tail: error.message, ms: Date.now() - started, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).filter((line) => line.trim());
      const failLines = lines.filter((line) => /^\s*(FAIL|not ok)/.test(line)).map((line) => line.trim().slice(0, 160));
      const tail = lines.length ? lines[lines.length - 1].trim().slice(0, 160) : '';
      const portBusy = /EADDRINUSE/.test(out);
      const serviceDown = /ECONNREFUSED/.test(out);
      resolve({ name, exit: code ?? -1, fails: failLines.length, failLines, tail, ms: Date.now() - started, timedOut, portBusy, serviceDown });
    });
  });
}

say(`проверка: ${plan.length} ${plural(plan.length, ['файл', 'файла', 'файлов'])}, предел ${timeoutSec} с на файл${asJson ? '' : `\n`}`);

const warnings = [];
const needsService = plan.some((name) => liveReason(name).includes(':3131'));
if (needsService && !(await serviceAlive())) {
  warnings.push('на 127.0.0.1:3131 никто не отвечает — такие проверки упадут на ECONNREFUSED, поднимите сервис (npm start) и повторите');
  say(`подсказка: ${warnings[warnings.length - 1]}`);
  if (!asJson) say('');
}

const results = [];
for (const name of plan) {
  const result = await runOne(name);
  const ok = result.exit === 0 && !result.timedOut;
  /* Порт :3131 — самый частый источник «красного по средам»: то сервис не поднят,
     то его уже держит другой процесс. Такие провалы называем словами, а не стеком. */
  const reason = ok
    ? ''
    : result.timedOut
      ? `дольше ${timeoutSec} с`
      : result.portBusy
        ? 'порт :3131 уже занят другим процессом'
        : result.serviceDown
          ? 'сервис на :3131 не отвечает — поднимите npm start'
          : result.failLines && result.failLines.length
            ? result.failLines[0]
            : liveReason(name) || result.tail;
  results.push({ ...result, ok, reason });
  if (asJson) continue;
  const mark = ok ? 'ok  ' : 'FAIL';
  const time = `${(result.ms / 1000).toFixed(1)}s`.padStart(7);
  say(`${mark} ${name.padEnd(24)} ${time}  ${ok ? '' : reason}`);
}

const failed = results.filter((r) => !r.ok);
const skipped = withLive ? [] : live;
const summary = {
  ok: failed.length === 0,
  total: plan.length,
  passed: plan.length - failed.length,
  failed: failed.length,
  skipped: skipped.length,
  warnings,
  ms: results.reduce((sum, r) => sum + r.ms, 0),
  failedTests: failed.map((r) => ({ file: r.name, exit: r.exit, fails: r.fails, reason: r.reason, failLines: r.failLines || [], tail: r.tail })),
  skippedTests: skipped.map((name) => ({ file: name, reason: liveReason(name) }))
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  say('');
  say(`итог: ${summary.passed} из ${summary.total} прошли, ${summary.failed} упали, ${summary.skipped} не входят без --live`);
  if (failed.length) {
    say('упали:');
    for (const item of summary.failedTests) say(`  ${item.file} — ${item.reason || item.tail}`);
  }
}

process.exit(failed.length === 0 ? 0 : 1);

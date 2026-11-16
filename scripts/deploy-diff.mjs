#!/usr/bin/env node
/* Что ещё не выложено на Amvera. Сравниваем побайтово: «задеплоил всё?» должно
   отвечаться фактом, а не памятью. Код — ноль, если расхождений нет.
     node scripts/deploy-diff.mjs            только отчёт
     node scripts/deploy-diff.mjs --exit-1   код 1, когда есть невыложенное (для гейта)

   Проверяем два источника, иначе гейт врёт: (1) грязь в рабочей копии и (2) то,
   что уже закоммичено после последней подтверждённой сборки. Раньше смотрели
   только рабочую копию — на чистом дереве гейт отвечал «не выложено: 0», хотя
   коммиты могли ни разу не уехать. Отметку последней сборки пишет
   deploy-amvera.mjs wait → tmp/deploy-state.json. */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getFile } from './amvera-api.mjs';

const SLUG = process.env.DSHOW_AMVERA_SLUG || 'dshopen';
const root = path.resolve(import.meta.dirname, '..');
const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
const skip = (file) => ['tmp/', 'exports/', 'data/', '.dsh/', 'node_modules/'].some((prefix) => file.startsWith(prefix));
/* Файлы для работы агента и локальных проверок: на сервисе не нужны, поэтому их
   отсутствие на Amvera — не «не выложено», а так и задумано. */
const DEV_ONLY = new Set([
  'AGENTS.md',
  'scripts/check-deck-live.mjs',
  'scripts/deploy-diff.mjs',
  'scripts/pdf2png.py',
]);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const clean = (line) => line.slice(3).trim();
const dirty = git('status', '--porcelain')
  .split('\n')
  .filter(Boolean)
  .map(clean)
  .map((line) => (line.includes(' -> ') ? line.split(' -> ')[1] : line))
  .filter((file) => !skip(file) && !file.startsWith('.tmp-') && !file.endsWith('.log'));

/* Отметка деплоя: без неё честно говорим «закоммиченное не сверял», а не «всё выложено». */
const stateFile = path.join(root, 'tmp', 'deploy-state.json');
let committed = [];
let marker = null;
if (fs.existsSync(stateFile)) {
  try {
    marker = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    committed = git('diff', '--name-only', `${marker.commit}..HEAD`)
      .split('\n')
      .filter(Boolean)
      .filter((file) => !skip(file));
  } catch (error) {
    console.log(`отметка деплоя не читается (${String(error.message).slice(0, 60)}) — сверяю только рабочую копию`);
    marker = null;
  }
} else {
  console.log('отметки деплоя нет (tmp/deploy-state.json) — закоммиченное после последней сборки не сверяю');
}
if (marker) console.log(`закоммичено после сборки ${String(marker.commit).slice(0, 8)}: ${committed.length}`);

const files = [...new Set([...dirty, ...committed])];
console.log(`файлов к сверке: ${files.length} (рабочая копия ${dirty.length}, коммиты ${committed.length})`);
let missing = 0;
for (const file of files) {
  if (DEV_ONLY.has(file)) {
    console.log(`локальный файл   ${file} (на сервис не выкладывается)`);
    continue;
  }
  const local = path.join(root, file);
  if (!fs.existsSync(local) || fs.statSync(local).isDirectory()) {
    console.log(`удалён локально   ${file}`);
    continue;
  }
  const localBuf = fs.readFileSync(local);
  try {
    const remote = await getFile(SLUG, file);
    const remoteBuf = Buffer.isBuffer(remote) ? remote : Buffer.from(String(remote?.content ?? remote ?? ''), 'utf8');
    if (hash(localBuf) === hash(remoteBuf)) {
      console.log(`совпадает        ${file}`);
      continue;
    }
    missing += 1;
    console.log(`РАСХОДИТСЯ       ${file} (локально ${localBuf.length} б, на сервере ${remoteBuf.length} б)`);
  } catch (error) {
    missing += 1;
    console.log(`нет на сервере   ${file} (${String(error.message).slice(0, 60)})`);
  }
}
console.log(`\nне выложено: ${missing}`);
if (!marker) {
  console.log('оговорка: commit-диапазон не проверен. Выложи пачку, дождись wait — появится отметка.');
}
if (missing && process.argv.includes('--exit-1')) process.exitCode = 1;

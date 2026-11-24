// Развёртывание dsh-open-web в Amvera (регион msk1) — прямым REST, без MCP.
//
//   node scripts/deploy-amvera.mjs status          — карточка проекта, файлы, коммиты
//   node scripts/deploy-amvera.mjs files           — залить весь проект (батчами)
//   node scripts/deploy-amvera.mjs push <путь> …   — залить только указанные файлы
//   node scripts/deploy-amvera.mjs build           — запустить пересборку
//   node scripts/deploy-amvera.mjs wait            — ждать окончания сборки
//   node scripts/deploy-amvera.mjs deploy          — files + build + wait
//   node scripts/deploy-amvera.mjs env             — показать, что нужно переменным (не пишет)
//   node scripts/deploy-amvera.mjs domain          — адрес и статус домена
//
// Секреты берутся из хранилища DSH и в журнал не печатаются. Токен Amvera
// кешируется в %TEMP%\amvera-token.json и обновляется сам.
//
// Удалять файлы на сервере нельзя: API Amvera отвечает 405 на DELETE /git/…/file,
// а полная заливка лишние файлы не убирает. Поэтому удаление файла в репозитории
// не удаляет его на сервере — вместо этого оставляй на месте заглушку, которую
// код перестаёт учитывать (например, SKILL.md с пустым телом навыки не грузят).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  getProject,
  listFiles,
  gitLog,
  uploadFiles,
  rebuildProject,
  restartProject,
} from './amvera-api.mjs';

const SLUG = 'dshopen';
const ROOT = path.resolve(import.meta.dirname, '..');
/* Батч: и крупные vendor-файлы проходят, и запрос не растягивается на минуты. */
const MAX_BATCH_BYTES = 6 * 1024 * 1024;
const MAX_BATCH_FILES = 40;

const mode = process.argv[2] || 'status';

/** Все файлы каталога рекурсивно — в src/public есть подпапки. */
function walk(dir, prefix) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(`${dir}/${entry.name}`, rel));
    else out.push(rel);
  }
  return out;
}

/** Что именно выкладываем: код, статика, навыки, тесты и документы. */
function projectFiles() {
  return [
    'server.mjs',
    'amvera.yaml',
    'package.json',
    'package-lock.json',
    'README.md',
    ...walk('src', 'src'),
    ...walk('public', 'public'),
    ...walk('skills', 'skills'),
    ...walk('assets', 'assets'),
    /* Тесты, проверочные скрипты и документы — тоже часть проекта: без них в
       облаке нельзя ни прогнать проверки, ни прочитать, почему предел выставлен
       именно так. */
    ...walk('test', 'test'),
    ...walk('scripts', 'scripts'),
    ...walk('docs', 'docs'),
  ].filter((rel) => fs.statSync(path.join(ROOT, rel)).isFile());
}

/** Режем список на батчи по размеру и количеству файлов. */
function batches(files) {
  const out = [];
  let current = [];
  let size = 0;
  for (const rel of files) {
    const bytes = fs.statSync(path.join(ROOT, rel)).size;
    if (current.length && (size + bytes > MAX_BATCH_BYTES || current.length >= MAX_BATCH_FILES)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push({ path: rel, full: path.join(ROOT, rel) });
    size += bytes;
  }
  if (current.length) out.push(current);
  return out;
}

/** Заливка набора файлов батчами с печатью прогресса. */
async function upload(rels, label) {
  const fileList = rels.map((rel) => rel.replace(/\\/g, '/'));
  const totalBytes = fileList.reduce((sum, rel) => sum + fs.statSync(path.join(ROOT, rel)).size, 0);
  console.log(`Файлов: ${fileList.length}, ${(totalBytes / 1024 / 1024).toFixed(1)} МБ, батчей: ${batches(fileList).length}`);

  let done = 0;
  for (const [index, batch] of batches(fileList).entries()) {
    const bytes = batch.reduce((sum, file) => sum + fs.statSync(file.full).size, 0);
    const answer = await uploadFiles(SLUG, batch, {
      commitMessage: `${label} (${index + 1}/${batches(fileList).length}, ${batch.length} файлов)`,
      timeout: 300_000,
    });
    done += bytes;
    const names = batch.map((file) => file.path);
    console.log(
      `  батч ${index + 1}: ${batch.length} файлов, ${(bytes / 1024 / 1024).toFixed(1)} МБ → ${String(answer).slice(0, 120)}`,
    );
    /* Первый и последний файл батча печатаем: видно, что ушло именно то. */
    console.log(`    ${names[0]}${names.length > 1 ? ' … ' + names[names.length - 1] : ''}; всего ${(done / 1024 / 1024).toFixed(1)} МБ`);
  }
}

/** Отметка «что реально уехало»: HEAD на момент подтверждённой сборки.
 *  Без неё deploy-diff.mjs по чистому дереву не видит, что коммиты не выложены, —
 *  ровно та дырка, из-за которой «выложил всё?» отвечалось «да» при пустом дереве. */
function recordDeployed() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const out = path.join(ROOT, 'tmp', 'deploy-state.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ commit, at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    console.log(`отметка деплоя: ${commit.slice(0, 8)} → tmp/deploy-state.json`);
  } catch {
    /* git может быть недоступен: отметка полезна, но не обязательна для сборки. */
  }
}

/** Ждём, пока платформа соберёт и поднимет проект.
 *  По тайм-ауту НЕ бросаем: двенадцать минут ожидания плюс падение — это ещё
 *  столько же разбирательств. Возвращаем {ok:false}: деплой подтверждается
 *  фактом (/api/health, маркер, ?v=), а не сообщением сборки. */
async function waitBuild(limitMinutes = 12) {
  const started = Date.now();
  /* Сборку отдаёт buildStatus/buildStatusTime: status у проекта остаётся
     RUNNING и во время пересборки, а statusMessage чаще всего пустой — по
     прежней проверке скрипт «не дожидался» уже готовой сборки. */
  const startedAtSeconds = started / 1000;
  let previous = '';
  while (Date.now() - started < limitMinutes * 60_000) {
    const project = await getProject(SLUG);
    const line = `${project.status}/${project.buildStatus || '?'} — ${project.statusMessage || project.buildStatusMessage || ''}`;
    if (line !== previous) {
      const seconds = Math.round((Date.now() - started) / 1000);
      console.log(`[${String(seconds).padStart(3)} с] ${line}`);
      previous = line;
    }
    const buildTime = Number(project.buildStatusTime || 0);
    if (
      project.status === 'RUNNING'
      && Date.now() - started > 20_000
      && (project.buildStatus === 'SUCCEEDED' ? buildTime >= startedAtSeconds - 60 : /success|deployed|успеш/i.test(project.statusMessage || ''))
    ) {
      recordDeployed();
      return { ok: true, project };
    }
    if (/ERROR|FAILED|BUILD_FAILED/i.test(project.status) || /ERROR|FAILED/i.test(project.buildStatus || '')) {
      throw new Error('сборка завершилась ошибкой: ' + line);
    }
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }
  console.log(`\nСборка не подтвердилась за ${limitMinutes} мин (последнее состояние: ${previous}).`);
  console.log('Это не приговор: проверь https://dshopen-vladimir00177.msk1.amvera.tech/api/health и маркер ?v=.');
  return { ok: false, project: await getProject(SLUG).catch(() => null) };
}

if (mode === 'status') {
  const project = await getProject(SLUG);
  console.log('==== Проект ====');
  for (const key of ['name', 'slug', 'status', 'statusMessage', 'buildStatus', 'buildStatusMessage', 'instances', 'namespace']) {
    console.log(`  ${key}: ${project[key]}`);
  }
  const builtAt = Number(project.buildStatusTime || 0);
  if (builtAt) console.log(`  buildStatusTime: ${new Date(builtAt * 1000).toISOString()}`);
  console.log('\n==== Файлы в корне ====');
  const root = await listFiles(SLUG, '/');
  console.log('  ' + root.map((entry) => entry.name + (entry.isFolder ? '/' : '')).join(' '));
  console.log('\n==== Последние коммиты ====');
  for (const commit of await gitLog(SLUG, { size: 5 })) {
    console.log(`  ${commit.hash.slice(0, 8)} ${commit.date}: ${commit.message}`);
  }
} else if (mode === 'files' || mode === 'push' || mode === 'deploy') {
  const targets = mode === 'push' ? process.argv.slice(3) : [];
  const files = targets.length ? targets : projectFiles();
  await upload(files, targets.length ? 'dsh-open-web: правка' : 'dsh-open-web: обновление проекта');
  if (mode === 'deploy') {
    console.log('\n==== Пересборка ====');
    console.log(JSON.stringify(await rebuildProject(SLUG)).slice(0, 300));
    const result = await waitBuild();
    console.log(result.ok ? '\nГотово: проект собран и запущен.' : '\nГотово с оговоркой: сборка не подтвердилась, проверь health и маркеры.');
  }
} else if (mode === 'build') {
  console.log('Запускаю пересборку: ' + JSON.stringify(await rebuildProject(SLUG)).slice(0, 300));
} else if (mode === 'restart') {
  console.log('Перезапуск без сборки: ' + JSON.stringify(await restartProject(SLUG)).slice(0, 300));
} else if (mode === 'wait') {
  const result = await waitBuild();
  if (result.ok) {
    console.log('\nИтог: ' + result.project.status + ' — ' + result.project.statusMessage);
  } else {
    console.log('\nИтог: сборка не подтверждена. Дальше факт: /api/health → 200, маркер в /styles.css, ?v= в /index.html.');
  }
} else if (mode === 'env') {
  /* Переменные уже настроены в кабинете; REST-путь для них не подтверждён,
     поэтому режим только напоминает состав и ничего не меняет. */
  console.log('Переменные окружения задаются в кабинете Amvera:');
  console.log('  https://cloud.amvera.ru/projects/applications/vladimir00177/~/vladimir00177/dshopen/env-variables');
  console.log('Ожидаемый состав: DSHOW_HOST, DSHOW_PORT, DSHOW_DATA_DIR, DSHOW_TRUST_PROXY,');
  console.log('  DSHOW_ADMIN_USER, DSHOW_ADMIN_PASSWORD, DSHOW_DEEPSEEK_KEY, OPENROUTER_API_KEY,');
  console.log('  DSHOW_MAX_ATTACHMENT_MB, DSHOW_MAX_PARSE_MB, DSHOW_MIN_FREE_MB, DSHOW_TG_TOKEN, DSHOW_TG_CHAT');
} else if (mode === 'domain') {
  console.log('Домен проекта: https://dshopen-vladimir00177.msk1.amvera.tech');
} else {
  console.log('Неизвестный режим: ' + mode);
  console.log('Режимы: status | files | push <путь…> | build | wait | deploy | restart | env | domain');
  process.exitCode = 1;
}

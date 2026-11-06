/**
 * Резервные копии состояния сервиса.
 *
 * Что копируем: `index.json` (пользователи, проекты, диалоги, вложения, задания),
 * папку `chats/` с полными переписками и папку `workspaces/` с файлами проектов,
 * включая срезы истории (`.history/`). Именно это человек боится потерять:
 * переписку, вложения проектов и документы, которые он туда загрузил.
 *
 * Как копируем: раз в сутки в `data/backups/<дата>/`, затем ротация — держим
 * последние 7 копий и общий потолок объёма. Копия делается в временную папку и
 * переименовывается, поэтому внезапная остановка не оставит половину архива.
 * Переписки и индекс копируются всегда; файлы проектов — пока влезают в бюджет
 * одной копии, начиная с самых свежих.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CHATS_DIR, DATA_DIR, WORKSPACES_DIR } from './config.mjs';

/** Отдать очередь событий: следующая порция работы стартует после того, как
 *  сервис успел ответить на запросы, ждущие в цикле событий. */
function breathe() {
  return new Promise((resolve) => setImmediate(resolve));
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const BACKUP_DEFAULTS = {
  /* Сколько суточных копий хранить. */
  keep: 7,
  /* Общий потолок объёма копий: при росте переписок старые копии уходят раньше. */
  maxBytes: 400 * 1024 * 1024,
  /* Ниже двух копий не опускаемся никогда: одна свежая, одна предыдущая. */
  minKeep: 2,
  /* Сколько файлов проектов копировать за один раз: переписки важнее любых файлов. */
  maxSnapshotBytes: 120 * 1024 * 1024,
};

export function backupsDir() {
  return path.join(DATA_DIR, 'backups');
}

export function workspacesDir() {
  return WORKSPACES_DIR;
}

function dayStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dirSize(dir) {
  let total = 0;
  let count = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { total, count };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        const inner = dirSize(full);
        total += inner.total;
        count += inner.count;
      } else {
        total += stat.size;
        count += 1;
      }
    } catch {
      /* файл исчез — не считаем */
    }
  }
  return { total, count };
}

/** Список копий от новых к старым: id (дата), объём, число файлов. */
export function listBackups({ keep = BACKUP_DEFAULTS.keep, maxBytes = BACKUP_DEFAULTS.maxBytes, minKeep = BACKUP_DEFAULTS.minKeep } = {}) {
  let names = [];
  try {
    names = fs
      .readdirSync(backupsDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
  return names.map((id) => {
    const dir = path.join(backupsDir(), id);
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      manifest = null;
    }
    /* Объём и число файлов берём из манифеста: обход всей копии ради цифры в
       списке держал очередь событий секундами (на живом сервисе это видели как
       «очередь событий стояла 3395 мс»). Обход остаётся только там, где
       манифеста нет — например, копия от старой версии. */
    const counted =
      manifest && Number.isFinite(manifest.bytes)
        ? { total: manifest.bytes, count: (manifest.files || 0) + (manifest.chats || 0) }
        : dirSize(dir);
    return {
      id,
      bytes: counted.total,
      files: counted.count,
      createdAt: manifest?.createdAt || null,
      chats: manifest?.chats || 0,
      workspaces: manifest?.workspaces || 0,
      skippedFiles: manifest?.skippedFiles || 0,
    };
  });
}

/** Удаляет лишние копии: сначала по количеству, затем по суммарному объёму. */
export async function rotateBackups({ keep = BACKUP_DEFAULTS.keep, maxBytes = BACKUP_DEFAULTS.maxBytes, minKeep = BACKUP_DEFAULTS.minKeep } = {}) {
  const items = listBackups();
  const removed = [];
  let total = items.reduce((sum, item) => sum + item.bytes, 0);
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    const left = items.length - removed.length;
    const tooMany = left > keep;
    const tooHeavy = maxBytes > 0 && total > maxBytes;
    if ((!tooMany && !tooHeavy) || left <= minKeep) continue;
    try {
      /* Удаление старой копии — тоже работа на живом сервисе: сотни мегабайт
         не должны держать очередь событий. */
      await fsp.rm(path.join(backupsDir(), item.id), { recursive: true, force: true });
      total -= item.bytes;
      removed.push(item.id);
    } catch {
      /* не смогли удалить — попробуем в следующий раз */
    }
    await breathe();
  }
  return removed;
}

/** Все файлы папки рекурсивно, свежие сверху: при жёстком бюджете успевает главное. */
async function listAllFiles(dir, rel = '', depth = 0) {
  const out = [];
  if (depth > 12) return out;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  let sinceYield = 0;
  for (const entry of entries) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listAllFiles(full, name, depth + 1)));
      continue;
    }
    try {
      const stat = await fsp.stat(full);
      if (stat.isFile()) out.push({ rel: name, full, size: stat.size, mtime: stat.mtimeMs });
    } catch {
      /* файл исчез между листингом и копированием */
    }
    /* Обход дерева тоже отдаёт очередь: в проектах бывают тысячи файлов. */
    sinceYield += 1;
    if (sinceYield >= 100) {
      sinceYield = 0;
      await breathe();
    }
  }
  return out;
}

/** Копирует файлы проектов в копию, пока влезают в бюджет. Возвращает счётчики. */
async function copyWorkspaces(staging, budget, yieldEvery = 20) {
  const from = workspacesDir();
  const files = (await listAllFiles(from)).sort((a, b) => b.mtime - a.mtime);
  let copied = 0;
  let skipped = 0;
  let bytes = 0;
  let workspaces = 0;
  let sinceYield = 0;
  const seen = new Set();
  for (const file of files) {
    const project = file.rel.split('/')[0];
    if (Number.isFinite(budget) && bytes + file.size > budget) {
      skipped += 1;
      continue;
    }
    const target = path.join(staging, 'workspaces', file.rel);
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(file.full, target);
    } catch {
      skipped += 1;
      continue;
    }
    bytes += file.size;
    copied += 1;
    if (!seen.has(project)) {
      seen.add(project);
      workspaces += 1;
    }
    /* Копия делается на живом сервисе: раз в двадцать файлов отдаём очередь
       событий, иначе люди ждут ответа, пока копируются сотни мегабайт. */
    sinceYield += 1;
    if (sinceYield >= yieldEvery) {
      sinceYield = 0;
      await breathe();
    }
  }
  return { workspaces, files: copied, bytes, skipped };
}

/**
 * Снимает копию состояния. Возвращает { id, dir, chats, workspaces, bytes }.
 * Повторный вызов в тот же день перезаписывает копию этого дня.
 */
export async function snapshotState({
  now = new Date(),
  keep = BACKUP_DEFAULTS.keep,
  maxSnapshotBytes = BACKUP_DEFAULTS.maxSnapshotBytes,
} = {}) {
  const id = dayStamp(now);
  const base = backupsDir();
  await fsp.mkdir(base, { recursive: true });
  const target = path.join(base, id);
  const staging = path.join(base, `.tmp-${id}-${process.pid}`);
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(path.join(staging, 'chats'), { recursive: true });

  let chats = 0;
  let bytes = 0;
  const indexFile = path.join(DATA_DIR, 'index.json');
  if (fs.existsSync(indexFile)) {
    const size = fs.statSync(indexFile).size;
    await fsp.copyFile(indexFile, path.join(staging, 'index.json'));
    bytes += size;
  }
  let names = [];
  try {
    names = await fsp.readdir(CHATS_DIR);
    names = names.filter((name) => name.endsWith('.json'));
  } catch {
    names = [];
  }
  let sinceYield = 0;
  for (const name of names) {
    const from = path.join(CHATS_DIR, name);
    try {
      const size = fs.statSync(from).size;
      await fsp.copyFile(from, path.join(staging, 'chats', name));
      bytes += size;
      chats += 1;
    } catch {
      /* файл диалога исчез между листингом и копированием */
    }
    sinceYield += 1;
    if (sinceYield >= 20) {
      sinceYield = 0;
      await breathe();
    }
  }
  /* Файлы проектов идемпотентно: если бюджета не хватило, копия всё равно целая
     по перепискам, а в манифесте видно, сколько файлов не поместилось.
     `maxSnapshotBytes: null` — без ограничения. */
  const limit =
    maxSnapshotBytes === null || maxSnapshotBytes === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, maxSnapshotBytes - bytes);
  const docs = await copyWorkspaces(staging, limit);
  await fsp.writeFile(
    path.join(staging, 'manifest.json'),
    JSON.stringify(
      {
        createdAt: now.toISOString(),
        chats,
        workspaces: docs.workspaces,
        files: docs.files,
        skippedFiles: docs.skipped,
        bytes: bytes + docs.bytes,
        index: fs.existsSync(indexFile),
      },
      null,
      2,
    ),
    'utf8',
  );
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.rename(staging, target);
  const removed = await rotateBackups({ keep });
  return {
    id,
    dir: path.relative(DATA_DIR, target),
    chats,
    workspaces: docs.workspaces,
    files: docs.files,
    skippedFiles: docs.skipped,
    bytes: bytes + docs.bytes,
    removed,
  };
}

/**
 * Автоматические копии: первая через минуту после старта (чтобы не тормозить
 * запуск) и далее раз в сутки. Таймер не держит процесс: сервис может
 * останавливаться штатно.
 */
export function startAutoBackup({
  intervalMs = DAY_MS,
  initialDelayMs = 60 * 1000,
  keep = BACKUP_DEFAULTS.keep,
  maxSnapshotBytes = BACKUP_DEFAULTS.maxSnapshotBytes,
} = {}) {
  const run = async (reason) => {
    try {
      const result = await snapshotState({ keep, maxSnapshotBytes });
      console.log(
        `[backup] ${reason}: ${result.id}, диалогов ${result.chats}, проектов ${result.workspaces}, ` +
          `файлов ${result.files}, ${Math.round(result.bytes / 1024)} КБ` +
          (result.skippedFiles ? `, не поместилось файлов ${result.skippedFiles}` : ''),
      );
      if (result.removed?.length) console.log(`[backup] удалены старые копии: ${result.removed.join(', ')}`);
    } catch (error) {
      console.error('[backup]', error?.message || error);
    }
  };
  const first = setTimeout(() => void run('старт'), initialDelayMs);
  first.unref?.();
  const timer = setInterval(() => void run('сутки'), intervalMs);
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

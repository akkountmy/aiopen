/**
 * Резервные копии состояния сервиса.
 *
 * Что копируем: `index.json` (пользователи, проекты, диалоги, вложения, задания)
 * и папку `chats/` с полными переписками. Именно эти файлы содержат контекст:
 * файлы проектов лежат отдельно и выгружаются кнопкой «Скачать архив», а вот
 * случайно удалённый проект или испорченный индекс раньше было не восстановить.
 *
 * Как копируем: раз в сутки в `data/backups/<дата>/`, затем ротация — держим
 * последние 7 копий и общий потолок объёма. Копия делается в временную папку и
 * переименовывается, поэтому внезапная остановка не оставит половину архива.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CHATS_DIR, DATA_DIR } from './config.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
export const BACKUP_DEFAULTS = {
  /* Сколько суточных копий хранить. */
  keep: 7,
  /* Общий потолок объёма копий: при росте переписок старые копии уходят раньше. */
  maxBytes: 400 * 1024 * 1024,
  /* Ниже двух копий не опускаемся никогда: одна свежая, одна предыдущая. */
  minKeep: 2,
};

export function backupsDir() {
  return path.join(DATA_DIR, 'backups');
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
    const size = dirSize(dir);
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      manifest = null;
    }
    return { id, bytes: size.total, files: size.count, createdAt: manifest?.createdAt || null, chats: manifest?.chats || 0 };
  });
}

/** Удаляет лишние копии: сначала по количеству, затем по суммарному объёму. */
export function rotateBackups({ keep = BACKUP_DEFAULTS.keep, maxBytes = BACKUP_DEFAULTS.maxBytes, minKeep = BACKUP_DEFAULTS.minKeep } = {}) {
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
      fs.rmSync(path.join(backupsDir(), item.id), { recursive: true, force: true });
      total -= item.bytes;
      removed.push(item.id);
    } catch {
      /* не смогли удалить — попробуем в следующий раз */
    }
  }
  return removed;
}

/**
 * Снимает копию состояния. Возвращает { id, dir, chats, bytes }.
 * Повторный вызов в тот же день перезаписывает копию этого дня.
 */
export function snapshotState({ now = new Date(), keep = BACKUP_DEFAULTS.keep } = {}) {
  const id = dayStamp(now);
  const base = backupsDir();
  fs.mkdirSync(base, { recursive: true });
  const target = path.join(base, id);
  const staging = path.join(base, `.tmp-${id}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'chats'), { recursive: true });

  let chats = 0;
  let bytes = 0;
  const indexFile = path.join(DATA_DIR, 'index.json');
  if (fs.existsSync(indexFile)) {
    const size = fs.statSync(indexFile).size;
    fs.copyFileSync(indexFile, path.join(staging, 'index.json'));
    bytes += size;
  }
  let names = [];
  try {
    names = fs.readdirSync(CHATS_DIR).filter((name) => name.endsWith('.json'));
  } catch {
    names = [];
  }
  for (const name of names) {
    const from = path.join(CHATS_DIR, name);
    try {
      const size = fs.statSync(from).size;
      fs.copyFileSync(from, path.join(staging, 'chats', name));
      bytes += size;
      chats += 1;
    } catch {
      /* файл диалога исчез между листингом и копированием */
    }
  }
  fs.writeFileSync(
    path.join(staging, 'manifest.json'),
    JSON.stringify({ createdAt: now.toISOString(), chats, bytes, index: fs.existsSync(indexFile) }, null, 2),
    'utf8',
  );
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  const removed = rotateBackups({ keep });
  return { id, dir: path.relative(DATA_DIR, target), chats, bytes, removed };
}

/**
 * Автоматические копии: первая через минуту после старта (чтобы не тормозить
 * запуск) и далее раз в сутки. Таймер не держит процесс: сервис может
 * останавливаться штатно.
 */
export function startAutoBackup({ intervalMs = DAY_MS, initialDelayMs = 60 * 1000, keep = BACKUP_DEFAULTS.keep } = {}) {
  const run = (reason) => {
    try {
      const result = snapshotState({ keep });
      console.log(`[backup] ${reason}: ${result.id}, диалогов ${result.chats}, ${Math.round(result.bytes / 1024)} КБ`);
      if (result.removed?.length) console.log(`[backup] удалены старые копии: ${result.removed.join(', ')}`);
    } catch (error) {
      console.error('[backup]', error?.message || error);
    }
  };
  const first = setTimeout(() => run('старт'), initialDelayMs);
  first.unref?.();
  const timer = setInterval(() => run('сутки'), intervalMs);
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

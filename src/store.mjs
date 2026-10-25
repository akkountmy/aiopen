import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backupsDir } from './backup.mjs';
import {
  BILLING,
  CHATS_DIR,
  DASHBOARD_FILES_DIR,
  DATA_DIR,
  DEVICE,
  DEVICE_KINDS,
  INDEX_FILE,
  WORKSPACES_DIR,
  sessionLimit,
} from './config.mjs';
import {
  DASHBOARD_BLOCKS,
  DASHBOARD_LIMITS,
  applyDashboardPatch,
  dashboardBlock,
  defaultDashboardTask,
  nextRunAt,
  withoutCompanySize,
} from './dashboard.mjs';
import { MEMORY_LIMITS, normalizeFact } from './memory.mjs';
import { hashPassword, sessionKind, verifyPassword } from './security.mjs';
import { atomicWrite, nowIso, readJson, uid, uniqueFileName } from './util.mjs';

/* Насколько перекрытие слов должно быть большим, чтобы новый факт считался
   уточнением старого (тогда старый заменяется, а не добавляется рядом). */
const REPLACE_OVERLAP = 0.6;

/* Когда в сеансе последний раз что-то делали: свежая отметка, а если её ещё нет
   (сеансы, созданные до появления поля), — момент входа. По этой величине
   решается, какой сеанс закрыть, когда места на аккаунте закончились. */
function lastActiveAt(session) {
  const seen = Number(session?.lastSeen) || 0;
  if (seen) return seen;
  const created = Date.parse(String(session?.createdAt || ''));
  return Number.isFinite(created) ? created : 0;
}

function factWords(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[ё]/g, 'е')
      .split(/[^a-zа-я0-9]+/i)
      .filter((word) => word.length > 2),
  );
}

function overlap(a, b) {
  const left = factWords(a);
  const right = factWords(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size);
}

const SEED_FILE = path.join(DATA_DIR, 'admin-seed.json');

/* Чтение индекса с защитой от затирания. Раньше повреждённый или недописанный
   `index.json` (обрыв питания, остановка контейнера ровно во время записи) молча
   превращался в пустое состояние: сервис заводил нового администратора и первым
   же сохранением стирал пользователей, проекты и переписки. Теперь испорченный
   файл откладывается рядом, состояние поднимается из последней суточной копии,
   а если копии нет — сервис останавливается, не трогая данные. */
function newestBackupIndex() {
  let names = [];
  try {
    names = fs
      .readdirSync(backupsDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    const file = path.join(backupsDir(), name, 'index.json');
    const parsed = readJson(file, null);
    if (parsed && Array.isArray(parsed.users) && parsed.users.length) {
      return { name, file, parsed };
    }
  }
  return null;
}

function loadIndexOrRecover() {
  let raw;
  try {
    raw = fs.readFileSync(INDEX_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const finish = (state) => state;
  let problem = '';
  if (!raw.trim()) {
    problem = 'файл пустой';
  } else {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.users)) return finish(parsed);
      problem = 'в файле нет списка пользователей';
    } catch (error) {
      problem = error.message;
    }
  }
  const stamp = nowIso().replace(/[:.]/g, '-');
  const aside = `${INDEX_FILE}.corrupt-${stamp}`;
  try {
    fs.writeFileSync(aside, raw, 'utf8');
  } catch {
    /* даже если копию не удалось отложить, ниже решаем, что делать */
  }
  const backup = newestBackupIndex();
  if (backup) {
    fs.copyFileSync(backup.file, INDEX_FILE);
    console.error(
      `[store] index.json повреждён (${problem}). Файл сохранён как ${path.basename(aside)}, ` +
        `состояние восстановлено из резервной копии ${backup.name}.`,
    );
    return finish(backup.parsed);
  }
  console.error(
    `[store] index.json повреждён (${problem}), резервных копий с пользователями нет. ` +
      `Сервис не запускается, чтобы не затереть данные. Исправьте файл вручную; ` +
      `исходное содержимое лежит в ${aside}.`,
  );
  throw Object.assign(new Error('index.json повреждён: нужен ручной разбор'), {
    code: 'EINDEXCORRUPT',
  });
}

/* Заводские ники администратора прошлых версий. Совсем короткий ник (DSH)
   занял место длинного, и учётные записи, созданные раньше, надо перенести,
   а не заводить заново: иначе пропали бы пароль, баланс, проекты и диалоги. */
const LEGACY_ADMIN_NAMES = new Set(['dshopenweb']);

function emptyState() {
  return {
    version: 2,
    createdAt: nowIso(),
    users: [],
    sessions: {},
    /* Сеансы, закрытые новым входом: по метке старый браузер понимает,
       что его «выбили», и показывает объяснение вместо пустого экрана. */
    kicked: {},
    /* История входов по аккаунтам: устройства, адреса, время. Нужна, чтобы
       заметить передачу логина и пароля другому человеку. */
    loginAudit: {},
    loginAuditVersion: 2,
    projects: [],
    workflows: [],
    chats: [],
    attachments: {},
    usage: {},
    approvals: [],
    /* Постоянные задания «Дашборда»: шесть блоков на каждый аккаунт. */
    dashboard: [],
    settings: {
      registrationOpen: false,
      visionEnabled: true,
    },
  };
}

function money(value) {
  return Number((Number(value) || 0).toFixed(6));
}

/* Русское склонение: 1 устройство, 2 устройства, 5 устройств. */
function plural(count, one, few, many) {
  const n = Math.abs(Number(count) || 0);
  const tail = n % 100;
  if (tail >= 11 && tail <= 14) return many;
  const last = n % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    createdAt: user.createdAt,
    disabled: Boolean(user.disabled),
    lastLoginAt: user.lastLoginAt || null,
    /* Баланс в долларах. Из этой суммы уже вычтено всё, что пользователь потратил. */
    balanceUsd: money(user.creditUsd),
    spentUsd: money(user.spentUsd),
  };
}

class Store {
  constructor() {
    this.state = emptyState();
    this.loaded = false;
  }

  init({ adminUsername, adminPassword }) {
    fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    const existing = loadIndexOrRecover();
    if (existing && Array.isArray(existing.users)) {
      this.state = { ...emptyState(), ...existing };
    }
    this.loaded = true;
    this.pruneSessions();
    this.migrate();
    this.migrateUploadsIntoRoot();
    /* Ник администратора задаётся настройкой; в данных мог остаться прежний
       заводской — переносим его, пока не завели посторонних записей. */
    this.renameLegacyAdmin(adminUsername);

    if (this.state.users.length === 0) {
      let record = null;
      if (adminPassword) {
        record = hashPassword(adminPassword);
      } else {
        const seed = readJson(SEED_FILE, null);
        if (seed && seed.password && seed.username) {
          record = seed.password;
          adminUsername = seed.username;
        }
      }
      if (!record) {
        /* Никакого пароля по умолчанию: генерируем случайный и печатаем один раз.
           Генератор криптостойкий — этот пароль виден в журнале контейнера. */
        const generated = `dshow-${crypto.randomBytes(12).toString('base64url')}`;
        record = hashPassword(generated);
        console.log(`[admin] Создан администратор. Логин: ${adminUsername} Пароль: ${generated}`);
        console.log('[admin] Смените пароль в панели администратора.');
      }
      this.state.users.push({
        id: uid('u_'),
        username: adminUsername,
        usernameLower: String(adminUsername).toLowerCase(),
        displayName: String(adminUsername),
        role: 'admin',
        password: record,
        createdAt: nowIso(),
        disabled: false,
        lastLoginAt: null,
        creditUsd: 0,
        spentUsd: 0,
        grantedUsd: 0,
      });
      this.save();
    }

    /* Если аккаунт в системе один, владелец наследства известен сразу. */
    if (this.state.users.length === 1) this.claimOrphans(this.state.users[0].id);
  }

  /**
   * Заводской ник администратора сменился. Если в данных лежит прежний, просто
   * переименовываем ту же запись: пароль, баланс, проекты и диалоги остаются на
   * месте, ник в следующий вход — новый. Ник, выбранный человеком вручную, не
   * трогаем: переименование идёт только из списка прежних заводских имён.
   * Подпись в шапке (displayName) тоже могла остаться прежней: её ставили при
   * создании записи, и без переноса человек продолжает видеть длинное имя.
   */
  renameLegacyAdmin(adminUsername) {
    if (!adminUsername) return false;
    const target = String(adminUsername);
    const lower = target.toLowerCase();
    const isLegacy = (value) => LEGACY_ADMIN_NAMES.has(String(value || '').toLowerCase());

    /* Запись уже переименована, а подпись от прошлой версии осталась. */
    const renamed = this.state.users.find((user) => user.usernameLower === lower && isLegacy(user.displayName));
    if (renamed) {
      renamed.displayName = target;
      this.save();
      console.log(`[admin] Подпись администратора перенесена: ${target}`);
      return true;
    }

    const clash = this.state.users.find((user) => user.usernameLower === lower);
    if (clash) return false;
    const legacy = this.state.users.find(
      (user) => user.role === 'admin' && isLegacy(user.usernameLower),
    );
    if (!legacy) return false;
    const previous = legacy.username;
    legacy.username = target;
    legacy.usernameLower = lower;
    if (isLegacy(legacy.displayName)) legacy.displayName = target;
    this.save();
    console.log(`[admin] Ник администратора перенесён: ${previous} → ${target}`);
    return true;
  }

  /**
   * Прежние версии писали проекты, папки, диалоги и вложения без владельца.
   * Теперь каждый список фильтруется по ownerId, и такие записи иначе стали бы
   * невидны никому — то есть выглядели бы как потеря данных. Отдаём их тому,
   * кто первым вошёл: в личной установке это и есть хозяин рабочего места.
   * Повторный вызов ничего не меняет — у записей уже есть владелец.
   */
  claimOrphans(ownerId) {
    const owner = this.state.users.find((user) => user.id === ownerId);
    if (!owner) return 0;
    let claimed = 0;
    for (const project of this.state.projects) {
      if (!project.ownerId) {
        project.ownerId = owner.id;
        claimed += 1;
      }
    }
    for (const workflow of this.state.workflows) {
      if (!workflow.ownerId) {
        workflow.ownerId = owner.id;
        claimed += 1;
      }
    }
    for (const chat of this.state.chats) {
      if (!chat.ownerId) {
        const project = this.state.projects.find((item) => item.id === chat.projectId);
        chat.ownerId = (project && project.ownerId) || owner.id;
        claimed += 1;
      }
    }
    for (const attachment of Object.values(this.state.attachments || {})) {
      if (attachment && !attachment.ownerId) {
        attachment.ownerId = owner.id;
        claimed += 1;
      }
    }
    if (claimed) {
      this.save();
      console.log(`[store] записей без владельца передано ${owner.username}: ${claimed}`);
    }
    return claimed;
  }

  /* Приведение старого файла данных к текущей схеме: у проектов появляется
     «папка» (workflow), сами папки живут в отдельном списке. Ничего не теряем. */
  migrate() {
    let changed = false;
    if (!Array.isArray(this.state.workflows)) {
      this.state.workflows = [];
      changed = true;
    }
    if (!Array.isArray(this.state.approvals)) {
      this.state.approvals = [];
      changed = true;
    }
    if (!Array.isArray(this.state.dashboard)) {
      this.state.dashboard = [];
      changed = true;
    }
    if (!this.state.kicked || typeof this.state.kicked !== 'object') {
      this.state.kicked = {};
      changed = true;
    }
    if (!this.state.loginAudit || typeof this.state.loginAudit !== 'object') {
      this.state.loginAudit = {};
      changed = true;
    }
    /* Правило «одна машина» появилось вместе с меткой устройства. Старые записи
       истории входов ничего не знают об устройствах и дали бы ложную тревогу,
       поэтому один раз начинаем историю заново. */
    if (this.state.loginAuditVersion !== 2) {
      this.state.loginAudit = {};
      this.state.loginAuditVersion = 2;
      changed = true;
    }
    for (const project of this.state.projects) {
      if (project.workflowId === undefined) {
        project.workflowId = null;
        changed = true;
      }
      if (project.spentUsd === undefined) {
        project.spentUsd = 0;
        changed = true;
      }
    }
    const known = new Set(this.state.workflows.map((w) => w.id));
    for (const project of this.state.projects) {
      if (project.workflowId && !known.has(project.workflowId)) {
        project.workflowId = null;
        changed = true;
      }
    }
    /* Счётчик в долларах появился позже самих аккаунтов: старым пользователям
       выдаём стартовый баланс, чтобы в день обновления они не остались без работы. */
    for (const user of this.state.users) {
      if (!Number.isFinite(Number(user.creditUsd))) {
        user.creditUsd = money(BILLING.migrationCreditUsd);
        user.grantedUsd = user.creditUsd;
        changed = true;
      }
      if (!Number.isFinite(Number(user.spentUsd))) {
        user.spentUsd = 0;
        changed = true;
      }
    }
    if (this.state.version !== 2) {
      this.state.version = 2;
      changed = true;
    }
    if (changed) this.save();
  }

  save() {
    if (!this.loaded) return;
    atomicWrite(INDEX_FILE, JSON.stringify(this.state, null, 2));
  }

  /* Когда-то вложения из диалогов складывались в подпапку uploads — из-за неё
     в «Файлах проекта» появлялась отдельная папка, и файлы проекта лежали в
     двух местах. Теперь у проекта одна общая папка: старые файлы переносим
     наверх под их настоящими именами (ничего не затирая), записи вложений
     направляем на новое место, пустую папку убираем. */
  migrateUploadsIntoRoot() {
    let moved = 0;
    let changed = false;
    for (const project of this.state.projects) {
      const dir = this.workspaceDir(project.id);
      const legacy = path.join(dir, 'uploads');
      let entries = [];
      try {
        if (!fs.statSync(legacy).isDirectory()) continue;
        entries = fs.readdirSync(legacy, { withFileTypes: true });
      } catch {
        continue;
      }
      /* Имя из вложения точнее, чем имя файла на диске: там был служебный
         префикс вроде «4f21c9_». */
      const byPath = new Map();
      for (const attachment of Object.values(this.state.attachments || {})) {
        if (!attachment || attachment.projectId !== project.id) continue;
        if (attachment.relPath) byPath.set(attachment.relPath, attachment);
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const legacyRel = `uploads/${entry.name}`;
        const attachment = byPath.get(legacyRel);
        const name = uniqueFileName(dir, (attachment && attachment.name) || entry.name);
        try {
          fs.renameSync(path.join(legacy, entry.name), path.join(dir, name));
        } catch {
          continue;
        }
        moved += 1;
        if (attachment) {
          attachment.relPath = name;
          changed = true;
        }
      }
      try {
        if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy);
      } catch {
        /* папка занята или уже удалена — не повод падать */
      }
    }
    if (changed) this.save();
    if (moved) console.log(`[store] файлов из папки uploads перенесено в общую папку проектов: ${moved}`);
  }

  pruneSessions() {
    const now = Date.now();
    let changed = false;
    for (const [key, session] of Object.entries(this.state.sessions)) {
      if (!session || session.exp <= now) {
        delete this.state.sessions[key];
        changed = true;
      }
    }
    for (const [key, mark] of Object.entries(this.state.kicked || {})) {
      if (!mark || now - Number(mark.at || 0) > DEVICE.kickedTtlMs) {
        delete this.state.kicked[key];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /* ---------------- users ---------------- */

  users() {
    return this.state.users.map(publicUser);
  }

  getUser(id) {
    return this.state.users.find((u) => u.id === id) || null;
  }

  publicUser(id) {
    return publicUser(this.getUser(id));
  }

  getUserByUsername(username) {
    const name = String(username || '').trim().toLowerCase();
    if (!name) return null;
    return this.state.users.find((u) => u.usernameLower === name) || null;
  }

  checkPassword(user, password) {
    return verifyPassword(password, user?.password);
  }

  /* startCreditUsd — стартовый баланс. Администратор, создавая аккаунт, сразу
     даёт на нём рабочую сумму; самостоятельная регистрация начинается с нуля. */
  createUser({ username, password, displayName, role = 'user', startCreditUsd = 0 }) {
    const name = String(username).trim();
    if (this.getUserByUsername(name)) {
      const err = new Error('Такой логин уже занят');
      err.status = 409;
      throw err;
    }
    const start = money(startCreditUsd);
    const user = {
      id: uid('u_'),
      username: name,
      usernameLower: name.toLowerCase(),
      displayName: displayName || name,
      role: role === 'admin' ? 'admin' : 'user',
      password: hashPassword(password),
      createdAt: nowIso(),
      disabled: false,
      lastLoginAt: null,
      creditUsd: start,
      spentUsd: 0,
      grantedUsd: Math.max(0, start),
    };
    this.state.users.push(user);
    this.save();
    return publicUser(user);
  }

  /* Личное пространство пользователя: при первом входе заводим его собственный
     проект и пустой диалог. История и проекты у каждого аккаунта свои, поэтому
     «Мой проект» создаётся только для этого владельца и один раз — если человек
     потом сам удалит проекты, навязчиво возвращать их не будем. */
  ensurePersonalProject(ownerId) {
    const user = this.getUser(ownerId);
    if (!user) return null;
    if (user.personalProjectSeeded) return null;
    if (this.state.projects.some((p) => p.ownerId === ownerId)) {
      user.personalProjectSeeded = true;
      this.save();
      return null;
    }
    user.personalProjectSeeded = true;
    const project = this.createProject({ ownerId, name: 'Мой проект' });
    this.createChat({ projectId: project.id, ownerId, title: 'Новый диалог' });
    this.save();
    return project;
  }

  /** Списать с баланса пользователя сумму в долларах. */
  chargeUser(id, usd) {
    const user = this.getUser(id);
    if (!user) return null;
    const amount = money(usd);
    if (!amount) return publicUser(user);
    user.creditUsd = money(Number(user.creditUsd || 0) - amount);
    user.spentUsd = money(Number(user.spentUsd || 0) + amount);
    this.save();
    return publicUser(user);
  }

  /** Начислить кредиты (отрицательное значение — списать вручную). */
  grantCredit(id, usd) {
    const user = this.getUser(id);
    if (!user) return null;
    const amount = money(usd);
    user.creditUsd = money(Number(user.creditUsd || 0) + amount);
    if (amount > 0) user.grantedUsd = money(Number(user.grantedUsd || 0) + amount);
    this.save();
    return publicUser(user);
  }

  /** Сколько пользователь уже потратил за всё время (в долларах). */
  userSpent(id) {
    const user = this.getUser(id);
    return money(user?.spentUsd);
  }

  updateUser(id, patch) {
    const user = this.getUser(id);
    if (!user) return null;
    if (patch.password) user.password = hashPassword(patch.password);
    if (patch.displayName !== undefined) user.displayName = String(patch.displayName).slice(0, 80);
    if (patch.role === 'admin' || patch.role === 'user') user.role = patch.role;
    if (patch.disabled !== undefined) {
      user.disabled = Boolean(patch.disabled);
      if (user.disabled) this.dropUserSessions(id);
    }
    this.save();
    return publicUser(user);
  }

  /* ---------------- постоянная память пользователя ---------------- */

  /* Факты живут на записи пользователя: переживают диалоги и проекты, чистятся
     только явным удалением. Это аналог pinned-предпочтений локального харнесса. */
  memoryFacts(userId) {
    const user = this.getUser(userId);
    return Array.isArray(user?.facts) ? user.facts.map((fact) => ({ ...fact })) : [];
  }

  /**
   * Запомнить факт. Возвращает, что произошло: добавлено, заменено или почему нет.
   * @param {string} userId
   * @param {string} text короткая фраза
   */
  addMemoryFact(userId, text) {
    const user = this.getUser(userId);
    if (!user) return { added: '', replaced: false, reason: 'пользователь не найден', total: 0 };
    if (!Array.isArray(user.facts)) user.facts = [];

    const fact = normalizeFact(text);
    if (!fact) return { added: '', replaced: false, reason: 'пустая формулировка', total: user.facts.length };
    if (user.facts.some((item) => normalizeFact(item.text).toLowerCase() === fact.toLowerCase())) {
      return { added: '', replaced: false, reason: 'это уже записано', total: user.facts.length };
    }

    /* Уточнение старого факта: похожие слова — значит речь о том же правиле. */
    let replaced = false;
    const similar = user.facts.findIndex((item) => overlap(item.text, fact) >= REPLACE_OVERLAP);
    if (similar >= 0) {
      user.facts[similar] = { ...user.facts[similar], text: fact, updatedAt: nowIso() };
      replaced = true;
    } else {
      user.facts.push({ id: uid('m_'), text: fact, createdAt: nowIso() });
      while (user.facts.length > MEMORY_LIMITS.maxFacts) user.facts.shift();
    }
    this.save();
    return { added: fact, replaced, total: user.facts.length };
  }

  removeMemoryFact(userId, id) {
    const user = this.getUser(userId);
    if (!user || !Array.isArray(user.facts)) return { removed: false, total: 0 };
    const before = user.facts.length;
    user.facts = user.facts.filter((fact) => fact.id !== id);
    if (user.facts.length !== before) this.save();
    return { removed: user.facts.length !== before, total: user.facts.length };
  }

  clearMemory(userId) {
    const user = this.getUser(userId);
    if (!user) return false;
    user.facts = [];
    this.save();
    return true;
  }

  /* ---------------- «Дашборд»: постоянные задания ---------------- */

  /* Шесть блоков — это не свободный список, а фиксированный набор на аккаунт:
     так у каждого пользователя есть полный набор, а порядок карточек всегда
     одинаковый. Настройки (расписание, проект, текст задания) — свои. */
  dashboardTasks(userId) {
    const list = Array.isArray(this.state.dashboard) ? this.state.dashboard : [];
    const order = new Map(DASHBOARD_BLOCKS.map((block, index) => [block.id, index]));
    return list
      .filter((task) => task.ownerId === userId)
      .map((task) => ({ ...task }))
      .sort((a, b) => (order.get(a.blockId) ?? 99) - (order.get(b.blockId) ?? 99));
  }

  /** Досоздаёт недостающие блоки (новый аккаунт, новый блок в релизе). */
  ensureDashboardTasks(userId) {
    if (!Array.isArray(this.state.dashboard)) this.state.dashboard = [];
    let changed = false;
    /* Задания, созданные раньше, несут старую формулировку про численность
       компании. Правим только её: всё, что человек написал сам, не трогаем. */
    for (const task of this.state.dashboard) {
      if (task.ownerId !== userId) continue;
      const fixed = withoutCompanySize(task.prompt);
      if (fixed !== task.prompt) {
        task.prompt = fixed;
        task.updatedAt = nowIso();
        changed = true;
      }
      if (!Array.isArray(task.files)) {
        task.files = [];
        changed = true;
      }
    }
    const present = new Set(this.state.dashboard.filter((task) => task.ownerId === userId).map((task) => task.blockId));
    for (const block of DASHBOARD_BLOCKS) {
      if (present.has(block.id)) continue;
      this.state.dashboard.push(defaultDashboardTask(block, userId));
      changed = true;
    }
    if (changed) this.save();
    return this.dashboardTasks(userId);
  }

  getDashboardTask(id, userId) {
    const list = Array.isArray(this.state.dashboard) ? this.state.dashboard : [];
    const task = list.find((item) => item.id === id && item.ownerId === userId);
    return task ? { ...task } : null;
  }

  /* Правка настроек. Время следующего запуска пересчитывается, если изменилось
     само расписание или если оно уже в прошлом: иначе задание «зависло» бы на
     старой дате после включения. Выключенное задание даты не держит. */
  updateDashboardTask(id, userId, patch) {
    const list = Array.isArray(this.state.dashboard) ? this.state.dashboard : [];
    const task = list.find((item) => item.id === id && item.ownerId === userId);
    if (!task) return null;
    const before = { enabled: task.enabled, cadence: task.cadence, dayOfMonth: task.dayOfMonth, dayOfWeek: task.dayOfWeek, hour: task.hour };
    const changed = applyDashboardPatch(task, patch);
    const scheduleChanged = ['enabled', 'cadence', 'dayOfMonth', 'dayOfWeek', 'hour'].some((key) => before[key] !== task[key]);
    if (!task.enabled) {
      task.nextRunAt = null;
    } else if (scheduleChanged || !task.nextRunAt || !(Date.parse(task.nextRunAt) > Date.now())) {
      task.nextRunAt = nextRunAt(task, Date.now());
    }
    if (changed.length) task.updatedAt = nowIso();
    this.save();
    return { ...task };
  }

  /** Вернуть блок к заводским настройкам (расписание и текст задания). */
  resetDashboardTask(id, userId) {
    const block = dashboardBlock(this.dashboardTaskBlockId(id, userId));
    if (!block) return null;
    return this.updateDashboardTask(id, userId, {
      cadence: block.cadence,
      dayOfMonth: block.dayOfMonth,
      dayOfWeek: block.dayOfWeek,
      hour: block.hour,
      prompt: block.prompt,
    });
  }

  dashboardTaskBlockId(id, userId) {
    const list = Array.isArray(this.state.dashboard) ? this.state.dashboard : [];
    const task = list.find((item) => item.id === id && item.ownerId === userId);
    return task ? task.blockId : '';
  }

  /* ---- документы задания ----
     Файлы лежат вне проектов: человек может сменить проект отчёта, а материалы
     должны остаться. В индекс попадают только метаданные. */
  dashboardFilesDir(taskId) {
    return path.join(DASHBOARD_FILES_DIR, String(taskId).replace(/[^a-z0-9_-]/gi, ''));
  }

  addDashboardFile(id, userId, file) {
    const list = Array.isArray(this.state.dashboard) ? this.state.dashboard : [];
    const task = list.find((item) => item.id === id && item.ownerId === userId);
    if (!task) return null;
    if (!Array.isArray(task.files)) task.files = [];
    if (task.files.length >= DASHBOARD_LIMITS.maxFiles) return null;
    task.files.push(file);
    task.updatedAt = nowIso();
    this.save();
    return { ...task };
  }

  deleteDashboardFile(id, userId, fileId) {
    const list = Array.isArray(this.state.dashboard) ? this.state.dashboard : [];
    const task = list.find((item) => item.id === id && item.ownerId === userId);
    if (!task || !Array.isArray(task.files)) return null;
    const index = task.files.findIndex((file) => file.id === fileId);
    if (index < 0) return null;
    const [removed] = task.files.splice(index, 1);
    task.updatedAt = nowIso();
    this.save();
    return removed;
  }

  /** Задания, которым пора запускаться. Один тик — один список. */
  dashboardDue(nowMs = Date.now()) {
    const list = Array.isArray(this.state.dashboard) ? this.state.dashboard : [];
    return list
      .filter((task) => task.enabled && task.nextRunAt && Date.parse(task.nextRunAt) <= nowMs)
      .map((task) => ({ ...task }));
  }

  /** Запуск состоялся: фиксируем время, диалог и сразу переносим дату вперёд.
      Запуск по кнопке («Запустить сейчас») дату не двигает: это дополнительный
      отчёт, а не вместо планового. */
  markDashboardStarted(id, { chatId, at = Date.now(), advance = true } = {}) {
    const list = Array.isArray(this.state.dashboard) ? this.state.dashboard : [];
    const task = list.find((item) => item.id === id);
    if (!task) return null;
    task.lastRunAt = new Date(at).toISOString();
    task.lastStatus = 'running';
    task.lastChatId = chatId || '';
    task.lastError = '';
    if (advance) task.nextRunAt = nextRunAt(task, Date.now());
    this.save();
    return { ...task };
  }

  /** Запуск не состоялся (нет денег, нет доступа, сервис лежал) — не теряем,
      а записываем причину и переносим дату. */
  markDashboardSkipped(id, { reason = '', at = Date.now(), disable = false } = {}) {
    const list = Array.isArray(this.state.dashboard) ? this.state.dashboard : [];
    const task = list.find((item) => item.id === id);
    if (!task) return null;
    task.lastStatus = 'skipped';
    task.lastError = String(reason || '').slice(0, 300);
    task.lastSkippedAt = new Date(at).toISOString();
    if (disable) task.enabled = false;
    task.nextRunAt = task.enabled ? nextRunAt(task, Date.now()) : null;
    this.save();
    return { ...task };
  }

  markDashboardFinished(id, status) {
    const list = Array.isArray(this.state.dashboard) ? this.state.dashboard : [];
    const task = list.find((item) => item.id === id);
    if (!task) return null;
    task.lastStatus = status === 'done' ? 'done' : status === 'stopped' ? 'stopped' : 'error';
    if (task.lastStatus === 'error') task.lastError = 'задание завершилось с ошибкой — подробности в диалоге';
    this.save();
    return { ...task };
  }

  /** Перенос запуска на несколько минут вперёд: агент занят, ждём. */
  postponeDashboardTask(id, minutes = 10) {
    const list = Array.isArray(this.state.dashboard) ? this.state.dashboard : [];
    const task = list.find((item) => item.id === id);
    if (!task) return null;
    task.nextRunAt = new Date(Date.now() + Math.max(1, minutes) * 60 * 1000).toISOString();
    this.save();
    return { ...task };
  }

  /** Только для проверок: сделать запуск «уже пора», не дожидаясь месяца. */
  forceDashboardDue(id) {
    const list = Array.isArray(this.state.dashboard) ? this.state.dashboard : [];
    const task = list.find((item) => item.id === id);
    if (!task) return null;
    task.nextRunAt = new Date(Date.now() - 1000).toISOString();
    this.save();
    return { ...task };
  }

  deleteUser(id) {
    const user = this.getUser(id);
    if (!user) return false;
    this.dropUserSessions(id);
    this.state.users = this.state.users.filter((u) => u.id !== id);
    this.state.dashboard = (this.state.dashboard || []).filter((task) => task.ownerId !== id);
    for (const project of this.state.projects.filter((p) => p.ownerId === id)) {
      this.deleteProject(project.id);
    }
    this.state.workflows = this.state.workflows.filter((w) => w.ownerId !== id);
    this.state.approvals = this.state.approvals.filter((a) => a.userId !== id);
    for (const [attId, att] of Object.entries(this.state.attachments)) {
      if (att.ownerId === id) delete this.state.attachments[attId];
    }
    delete this.state.usage[id];
    this.save();
    return true;
  }

  touchLogin(id) {
    const user = this.getUser(id);
    if (!user) return;
    user.lastLoginAt = nowIso();
    this.save();
  }

  dropUserSessions(userId) {
    let changed = false;
    for (const [key, session] of Object.entries(this.state.sessions)) {
      if (session.userId === userId) {
        delete this.state.sessions[key];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /* ---------------- sessions ---------------- */

  sessionUser(key) {
    const session = this.state.sessions[key];
    if (!session) return null;
    if (session.exp <= Date.now()) {
      delete this.state.sessions[key];
      this.save();
      return null;
    }
    const user = this.getUser(session.userId);
    if (!user || user.disabled) return null;
    /* Отметка «здесь только что работали»: по ней видно, какой сеанс закрывать,
       если мест на аккаунте больше нет. Пишется только в памяти — сохранится
       вместе со следующим изменением состояния, без диска на каждый запрос. */
    session.lastSeen = Date.now();
    return user;
  }

  renewSession(key, ttlMs) {
    const session = this.state.sessions[key];
    if (!session) return;
    session.exp = Date.now() + ttlMs;
    session.lastSeen = Date.now();
    this.save();
  }

  dropSession(key) {
    if (this.state.sessions[key]) {
      delete this.state.sessions[key];
      this.save();
    }
  }

  /* Освобождает место под новый вход. По умолчанию мест не считаем вовсе
     (`sessionLimit()` = Infinity): сколько бы устройств и вкладок ни работало
     на одном нике, никто никого не выбивает. Заменяется только прежний сеанс
     этой же машины — иначе в старых вкладках оставалась бы своя копия сессии.
     Ограничение работает лишь при явном DSHOW_SESSIONS_MAX: тогда, когда мест
     больше нет, уступает самый давно не использованный сеанс.
     Возвращает список выбитых сеансов: их адреса и время входа показывают,
     что аккаунтом, похоже, пользуется кто-то ещё. */
  dropOtherSessions(userId, keepKey, meta = {}) {
    const limit = sessionLimit();
    const kind = String(meta.kind || 'desktop');
    const device = String(meta.device || '');
    const dropped = [];
    const now = Date.now();
    if (!this.state.kicked) this.state.kicked = {};
    const sameUser = Object.entries(this.state.sessions).filter(
      ([key, session]) => session && !session.service && session.userId === userId && key !== keepKey,
    );
    /* Повторный вход с той же машины (тот же dshow_device) — это не «ещё одно
       устройство»: прежний сеанс этой машины просто уступает, без тревожной
       пометки «вас выбили» и без траты места на аккаунте. */
    const sameDevice = sameUser.filter(([, session]) => device && String(session.device || '') === device);
    for (const [key, session] of sameDevice) {
      delete this.state.sessions[key];
      dropped.push({
        ip: session.ip || '',
        ua: session.ua || '',
        device: session.device || '',
        kind: sessionKind(session),
        createdAt: session.createdAt || null,
        sameDevice: true,
      });
    }
    /* Остальные сеансы: при явном лимите уступает самый давно не
       использованный, при неограниченном числе мест — не уступает никто. */
    const others = Number.isFinite(limit)
      ? sameUser
          .filter(([key]) => this.state.sessions[key])
          .sort((a, b) => lastActiveAt(b[1]) - lastActiveAt(a[1]))
          .slice(Math.max(0, limit - 1))
      : [];
    for (const [key, session] of others) {
      dropped.push({
        ip: session.ip || '',
        ua: session.ua || '',
        device: session.device || '',
        kind: sessionKind(session),
        createdAt: session.createdAt || null,
      });
      delete this.state.sessions[key];
      this.state.kicked[key] = {
        at: now,
        byIp: String(meta.ip || '').slice(0, 60),
        byUa: String(meta.ua || '').slice(0, 200),
        kind,
      };
    }
    if (dropped.length) this.save();
    return dropped;
  }

  /* Пометка «этот сеанс закрыт новым входом», если она ещё свежая. */
  kickedInfo(key) {
    const mark = this.state.kicked?.[key];
    if (!mark) return null;
    if (Date.now() - Number(mark.at || 0) > DEVICE.kickedTtlMs) {
      delete this.state.kicked[key];
      this.save();
      return null;
    }
    return { at: new Date(Number(mark.at)).toISOString(), byIp: mark.byIp || '', byUa: mark.byUa || '' };
  }

  /* Записывает вход и решает, пора ли предупредить администратора:
     слишком много разных устройств, адресов или постоянные «выбивания»
     активного сеанса выглядят как передача пароля другому человеку. */
  recordLogin(userId, entry = {}) {
    const now = Date.now();
    if (!this.state.loginAudit) this.state.loginAudit = {};
    const audit = this.state.loginAudit[userId] || { events: [], alertAt: null };
    this.state.loginAudit[userId] = audit;
    audit.events.push({
      at: new Date(now).toISOString(),
      ip: String(entry.ip || '').slice(0, 60),
      ua: String(entry.ua || '').slice(0, 160),
      device: String(entry.device || '').slice(0, 80),
      kind: DEVICE_KINDS.includes(String(entry.kind)) ? String(entry.kind) : 'desktop',
      displaced: Number(entry.displaced || 0),
    });
    const keepFrom = now - DEVICE.keepMs;
    audit.events = audit.events
      .filter((item) => Number.isFinite(Date.parse(item.at)) && Date.parse(item.at) >= keepFrom)
      .slice(-DEVICE.maxEvents);

    const windowFrom = now - DEVICE.windowMs;
    const recent = audit.events.filter((item) => Date.parse(item.at) >= windowFrom);
    const ips = [...new Set(recent.map((item) => item.ip).filter(Boolean))];
    const devices = [...new Set(recent.map((item) => item.device).filter(Boolean))];
    const displaced = recent.reduce((sum, item) => sum + (item.displaced || 0), 0);
    const windowHours = Math.max(1, Math.round(DEVICE.windowMs / 3600000));

    const reasons = [];
    if (devices.length >= DEVICE.alertDevices) {
      reasons.push(`${devices.length} ${plural(devices.length, 'разное устройство', 'разных устройства', 'разных устройств')} за ${windowHours} ч`);
    }
    if (ips.length >= DEVICE.alertIps) {
      reasons.push(`${ips.length} ${plural(ips.length, 'разный IP-адрес', 'разных IP-адреса', 'разных IP-адресов')} за ${windowHours} ч`);
    }
    if (displaced >= DEVICE.alertDisplaced) {
      reasons.push(`${displaced} ${plural(displaced, 'вход', 'входа', 'входов')} с выбиванием активного сеанса за ${windowHours} ч`);
    }

    const suspicious = reasons.length > 0;
    const lastAlertAt = audit.alertAt ? Date.parse(audit.alertAt) : 0;
    const cooling = now - lastAlertAt < DEVICE.cooldownMs;
    const alert = suspicious && !cooling;
    if (alert) audit.alertAt = new Date(now).toISOString();
    this.save();

    return {
      suspicious,
      alert,
      reasons,
      ips,
      devices,
      displaced,
      windowHours,
      recent: recent.slice(-10),
    };
  }

  /* История входов аккаунта для панели администратора. */
  loginAuditFor(userId) {
    const audit = this.state.loginAudit?.[userId];
    if (!audit) return { events: [], alertAt: null };
    const now = Date.now();
    return {
      events: (audit.events || []).filter((item) => Date.parse(item.at) >= now - DEVICE.windowMs).slice(-20),
      alertAt: audit.alertAt || null,
    };
  }

  /* ---------------- projects ---------------- */

  projectsFor(userId) {
    /* Порядок — по времени создания, а не по последнему диалогу: папки слева не
       должны переставляться после каждого разговора. Для записей без createdAt
       (старые данные) берём updatedAt, чтобы список не прыгал. */
    return this.state.projects
      .filter((p) => p.ownerId === userId)
      .sort((a, b) => String(a.createdAt || a.updatedAt || '').localeCompare(String(b.createdAt || b.updatedAt || '')));
  }

  getProject(id, ownerId) {
    const project = this.state.projects.find((p) => p.id === id);
    if (!project) return null;
    if (ownerId && project.ownerId !== ownerId) return null;
    return project;
  }

  createProject({ ownerId, name, workflowId = null }) {
    let folder = null;
    if (workflowId) {
      folder = this.getWorkflow(workflowId, ownerId);
      if (!folder) {
        const error = new Error('Папка проектов не найдена');
        error.status = 404;
        throw error;
      }
    }
    const project = {
      id: uid('p_'),
      ownerId,
      workflowId: folder ? folder.id : null,
      name: String(name || 'Новый проект').slice(0, 80),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      spentUsd: 0,
    };
    fs.mkdirSync(path.join(WORKSPACES_DIR, project.id), { recursive: true });
    this.state.projects.push(project);
    this.save();
    return project;
  }

  renameProject(id, name) {
    const project = this.getProject(id);
    if (!project) return null;
    project.name = String(name || project.name).slice(0, 80);
    project.updatedAt = nowIso();
    this.save();
    return project;
  }

  setProjectWorkflow(id, workflowId, ownerId) {
    const project = this.getProject(id, ownerId);
    if (!project) return null;
    if (workflowId) {
      const folder = this.getWorkflow(workflowId, ownerId);
      if (!folder) {
        const error = new Error('Папка проектов не найдена');
        error.status = 404;
        throw error;
      }
      project.workflowId = folder.id;
    } else {
      project.workflowId = null;
    }
    project.updatedAt = nowIso();
    this.save();
    return project;
  }

  deleteProject(id) {
    const project = this.getProject(id);
    if (!project) return false;
    for (const chat of this.state.chats.filter((c) => c.projectId === id)) {
      this.deleteChat(chat.id);
    }
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    this.state.approvals = this.state.approvals.filter((a) => a.projectId !== id);
    try {
      fs.rmSync(path.join(WORKSPACES_DIR, id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    this.save();
    return true;
  }

  workspaceDir(projectId) {
    return path.join(WORKSPACES_DIR, projectId);
  }

  /* ---------------- workflows: папки проектов ---------------- */

  workflowsFor(userId) {
    return this.state.workflows
      .filter((w) => w.ownerId === userId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  getWorkflow(id, ownerId) {
    const workflow = this.state.workflows.find((w) => w.id === id);
    if (!workflow) return null;
    if (ownerId && workflow.ownerId !== ownerId) return null;
    return workflow;
  }

  createWorkflow({ ownerId, name }) {
    const workflow = {
      id: uid('w_'),
      ownerId,
      name: String(name || '').trim().slice(0, 80) || 'Новая папка',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.state.workflows.push(workflow);
    this.save();
    return workflow;
  }

  renameWorkflow(id, name, ownerId) {
    const workflow = this.getWorkflow(id, ownerId);
    if (!workflow) return null;
    const next = String(name || '').trim();
    if (next) workflow.name = next.slice(0, 80);
    workflow.updatedAt = nowIso();
    this.save();
    return workflow;
  }

  deleteWorkflow(id, ownerId) {
    const workflow = this.getWorkflow(id, ownerId);
    if (!workflow) return false;
    // Сами проекты не удаляем: они возвращаются в общий список.
    for (const project of this.state.projects) {
      if (project.workflowId === id) project.workflowId = null;
    }
    this.state.workflows = this.state.workflows.filter((w) => w.id !== id);
    this.save();
    return true;
  }

  /* ---------------- chats ---------------- */

  chatsFor(projectId) {
    /* Диалоги, как и проекты, идут по времени создания: новый разговор встаёт в
       конец списка и не переставляет соседей наверх. */
    return this.state.chats
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => String(a.createdAt || a.updatedAt || '').localeCompare(String(b.createdAt || b.updatedAt || '')));
  }

  getChatMeta(id) {
    return this.state.chats.find((c) => c.id === id) || null;
  }

  getChat(id, ownerId) {
    const meta = this.getChatMeta(id);
    if (!meta) return null;
    if (ownerId && meta.ownerId !== ownerId) return null;
    const file = path.join(CHATS_DIR, `${id}.json`);
    const data = readJson(file, null);
    return {
      ...meta,
      messages: data?.messages || [],
      history: data?.history || [],
      memory: data?.memory || '',
      /* Карточка длинной задачи: что сделано, что осталось, какие файлы готовы.
         Переживает перезапуск процесса и подставляется в следующий ход. */
      task: data?.task || null,
    };
  }

  createChat({ projectId, ownerId, title }) {
    const chat = {
      id: uid('c_'),
      projectId,
      ownerId,
      title: String(title || 'Новый диалог').slice(0, 120),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messageCount: 0,
    };
    this.state.chats.push(chat);
    this.save();
    this.writeChat(chat.id, { messages: [], history: [], memory: '', task: null });
    const project = this.getProject(projectId);
    if (project) {
      project.updatedAt = nowIso();
      this.save();
    }
    return chat;
  }

  writeChat(id, data) {
    atomicWrite(path.join(CHATS_DIR, `${id}.json`), JSON.stringify(data));
  }

  saveChat(id, data) {
    this.writeChat(id, data);
    const meta = this.getChatMeta(id);
    if (meta) {
      meta.updatedAt = nowIso();
      meta.messageCount = data.messages?.length || 0;
      this.save();
    }
  }

  renameChat(id, title) {
    const meta = this.getChatMeta(id);
    if (!meta) return null;
    meta.title = String(title || meta.title).slice(0, 120);
    meta.updatedAt = nowIso();
    this.save();
    return meta;
  }

  /* Метка «в диалоге идёт работа». Живёт рядом с диалогом, в метаданных: по ней
     видно, что задача шла, даже если процесс перезапустился и самой задачи уже
     нет. Запись null снимает метку. */
  setChatRunning(id, info) {
    const meta = this.getChatMeta(id);
    if (!meta) return null;
    if (info) meta.running = { runId: String(info.runId || ''), startedAt: info.startedAt || nowIso() };
    else delete meta.running;
    this.save();
    return meta;
  }

  deleteChat(id) {
    this.state.chats = this.state.chats.filter((c) => c.id !== id);
    for (const [attId, att] of Object.entries(this.state.attachments)) {
      if (att.chatId === id) delete this.state.attachments[attId];
    }
    try {
      fs.unlinkSync(path.join(CHATS_DIR, `${id}.json`));
    } catch {
      /* ignore */
    }
    this.save();
    return true;
  }

  /* ---------------- attachments ---------------- */

  createAttachment(att) {
    this.state.attachments[att.id] = att;
    this.save();
    return att;
  }

  getAttachment(id) {
    return this.state.attachments[id] || null;
  }

  updateAttachment(id, patch) {
    const att = this.getAttachment(id);
    if (!att) return null;
    Object.assign(att, patch);
    this.save();
    return att;
  }

  deleteAttachment(id) {
    const att = this.getAttachment(id);
    if (!att) return false;
    delete this.state.attachments[id];
    this.save();
    return true;
  }

  /* ---------------- расход и подтверждения тяжёлых задач ---------------- */

  addProjectSpend(projectId, usd) {
    const project = this.getProject(projectId);
    if (!project) return null;
    const total = Number(project.spentUsd || 0) + (Number(usd) || 0);
    project.spentUsd = Number(total.toFixed(6));
    project.lastSpendAt = nowIso();
    this.save();
    return project.spentUsd;
  }

  setProjectBudget(projectId, usd) {
    const project = this.getProject(projectId);
    if (!project) return null;
    project.budgetUsd = Number((Number(usd) || 0).toFixed(6));
    this.save();
    return project.budgetUsd;
  }

  createApproval({ userId, username, projectId, projectName, chatId = null, chatTitle = '', spentUsd = 0, limitUsd = 0 }) {
    const approval = {
      id: uid('ap_'),
      userId,
      username,
      projectId,
      projectName,
      chatId,
      chatTitle,
      spentUsd: Number(Number(spentUsd).toFixed(4)),
      limitUsd: Number(Number(limitUsd).toFixed(4)),
      status: 'pending',
      createdAt: nowIso(),
      decidedAt: null,
    };
    this.state.approvals.push(approval);
    this.save();
    return approval;
  }

  getApproval(id) {
    return this.state.approvals.find((a) => a.id === id) || null;
  }

  pendingApprovalFor(projectId) {
    return this.state.approvals.find((a) => a.projectId === projectId && a.status === 'pending') || null;
  }

  latestApprovalFor(projectId) {
    const list = this.state.approvals.filter((a) => a.projectId === projectId);
    return list.length ? list[list.length - 1] : null;
  }

  approvals({ status = null, limit = 100 } = {}) {
    return this.state.approvals
      .filter((a) => (status ? a.status === status : true))
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  decideApproval(id, status, { by = null, budgetUsd = null } = {}) {
    const approval = this.getApproval(id);
    if (!approval) return null;
    approval.status = status;
    approval.decidedAt = nowIso();
    approval.decidedBy = by;
    if (status === 'approved' && budgetUsd !== null) this.setProjectBudget(approval.projectId, budgetUsd);
    this.save();
    return approval;
  }

  /* ---------------- usage ---------------- */

  addUsage(userId, { tokensIn = 0, tokensOut = 0, messages = 1, usd = 0 } = {}) {
    const day = nowIso().slice(0, 10);
    this.state.usage[userId] ||= {};
    this.state.usage[userId][day] ||= { tokensIn: 0, tokensOut: 0, messages: 0, usd: 0 };
    const entry = this.state.usage[userId][day];
    entry.tokensIn += tokensIn;
    entry.tokensOut += tokensOut;
    entry.messages += messages;
    entry.usd = Number((Number(entry.usd || 0) + Number(usd || 0)).toFixed(6));
    this.save();
  }

  usageSummary(userId) {
    const days = this.state.usage[userId] || {};
    return Object.entries(days)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 30)
      .map(([day, value]) => ({ day, ...value }));
  }

  totals() {
    const totals = { tokensIn: 0, tokensOut: 0, messages: 0, usd: 0 };
    for (const days of Object.values(this.state.usage)) {
      for (const value of Object.values(days)) {
        totals.tokensIn += value.tokensIn || 0;
        totals.tokensOut += value.tokensOut || 0;
        totals.messages += value.messages || 0;
        totals.usd += value.usd || 0;
      }
    }
    totals.usd = Number(totals.usd.toFixed(6));
    return totals;
  }

  overview() {
    return {
      users: this.state.users.length,
      admins: this.state.users.filter((u) => u.role === 'admin').length,
      projects: this.state.projects.length,
      chats: this.state.chats.length,
      total: this.totals(),
    };
  }
}

export const store = new Store();
export { publicUser };

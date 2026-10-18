import fs from 'node:fs';
import path from 'node:path';
import {
  BILLING,
  CHATS_DIR,
  DATA_DIR,
  INDEX_FILE,
  WORKSPACES_DIR,
} from './config.mjs';
import { hashPassword, verifyPassword } from './security.mjs';
import { atomicWrite, nowIso, readJson, uid } from './util.mjs';

const SEED_FILE = path.join(DATA_DIR, 'admin-seed.json');

function emptyState() {
  return {
    version: 2,
    createdAt: nowIso(),
    users: [],
    sessions: {},
    projects: [],
    workflows: [],
    chats: [],
    attachments: {},
    usage: {},
    approvals: [],
    settings: {
      registrationOpen: false,
      visionEnabled: true,
    },
  };
}

function money(value) {
  return Number((Number(value) || 0).toFixed(6));
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
    const existing = readJson(INDEX_FILE, null);
    if (existing && Array.isArray(existing.users)) {
      this.state = { ...emptyState(), ...existing };
    }
    this.loaded = true;
    this.pruneSessions();
    this.migrate();

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
        // Никакого пароля по умолчанию: генерируем случайный и печатаем один раз.
        const generated = `dshow-${Math.random().toString(36).slice(2, 10)}`;
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

  pruneSessions() {
    const now = Date.now();
    let changed = false;
    for (const [key, session] of Object.entries(this.state.sessions)) {
      if (!session || session.exp <= now) {
        delete this.state.sessions[key];
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

  deleteUser(id) {
    const user = this.getUser(id);
    if (!user) return false;
    this.dropUserSessions(id);
    this.state.users = this.state.users.filter((u) => u.id !== id);
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
    return user;
  }

  renewSession(key, ttlMs) {
    const session = this.state.sessions[key];
    if (!session) return;
    session.exp = Date.now() + ttlMs;
    this.save();
  }

  dropSession(key) {
    if (this.state.sessions[key]) {
      delete this.state.sessions[key];
      this.save();
    }
  }

  /* ---------------- projects ---------------- */

  projectsFor(userId) {
    return this.state.projects
      .filter((p) => p.ownerId === userId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
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
    return this.state.chats
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
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
    this.writeChat(chat.id, { messages: [], history: [], memory: '' });
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

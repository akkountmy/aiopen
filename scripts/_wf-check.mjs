/* Временная проверка API workflow: создание папки, проект внутри, перемещение, удаление папки. */
const BASE = process.env.DSHOW_BASE || 'http://127.0.0.1:3123';
const USER = process.env.DSHOW_USER || 'uicheck';
const PASS = process.env.DSHOW_PASS || 'ui-check-2026';

const jar = new Map();
async function call(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: {
      'content-type': 'application/json',
      cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  for (const entry of res.headers.getSetCookie?.() || []) {
    const [pair] = entry.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

const lines = [];
const check = (name, ok, extra = '') => lines.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

const login = await call('/api/login', { method: 'POST', body: { username: USER, password: PASS } });
check('вход', login.status === 200, `${login.status}`);
check('workflows в /api/me', Array.isArray(login.data?.workflows), `${(login.data?.workflows || []).length}`);

const folder = await call('/api/workflows', { method: 'POST', body: { name: 'Тестовая папка' } });
check('создание workflow', folder.status === 200 && !!folder.data?.workflow?.id, folder.data?.workflow?.name);
const flowId = folder.data?.workflow?.id;

const emptyName = await call('/api/workflows', { method: 'POST', body: { name: '   ' } });
check('пустое имя отклонено', emptyName.status === 400, String(emptyName.status));

const project = await call('/api/projects', { method: 'POST', body: { name: 'Проект в папке', workflowId: flowId } });
check('проект внутри папки', project.status === 200 && project.data?.project?.workflowId === flowId);
const projectId = project.data?.project?.id;

const bad = await call('/api/projects', { method: 'POST', body: { name: 'Без папки', workflowId: 'w_missing' } });
check('чужой/несуществующий workflow отклонён', bad.status === 404, String(bad.status));

const renamed = await call(`/api/workflows/${flowId}`, { method: 'PATCH', body: { name: 'Папка 2026' } });
check('переименование workflow', renamed.data?.workflow?.name === 'Папка 2026', renamed.data?.workflow?.name);

const moved = await call(`/api/projects/${projectId}`, { method: 'PATCH', body: { workflowId: null } });
check('перемещение проекта в корень', moved.status === 200 && moved.data?.project?.workflowId === null);

const back = await call(`/api/projects/${projectId}`, { method: 'PATCH', body: { workflowId: flowId } });
check('перемещение обратно в папку', back.data?.project?.workflowId === flowId);

const me1 = await call('/api/me');
check('папка в списке', (me1.data?.workflows || []).some((w) => w.id === flowId));

const delFolder = await call(`/api/workflows/${flowId}`, { method: 'DELETE' });
check('удаление workflow', delFolder.status === 200 && delFolder.data?.movedProjects?.includes(projectId));

const me2 = await call('/api/me');
const survivor = (me2.data?.projects || []).find((p) => p.id === projectId);
check('проект остался после удаления папки', !!survivor && survivor.workflowId === null);
check('папки больше нет в списке', !(me2.data?.workflows || []).some((w) => w.id === flowId));

// Уборка: проект и папки, созданные проверкой.
if (projectId) await call(`/api/projects/${projectId}`, { method: 'DELETE' });

console.log(lines.join('\n'));
const failed = lines.filter((line) => line.startsWith('FAIL')).length;
console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВсё прошло');
process.exit(failed ? 1 : 0);

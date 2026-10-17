/* Временный скрипт проверки интерфейса: создаёт/удаляет тестовую учётку uicheck.
   Использование: node scripts/_ui-check-user.mjs create | delete */
import { store } from '../src/store.mjs';

const mode = process.argv[2] || 'create';
const USERNAME = 'uicheck';
const PASSWORD = 'ui-check-2026';

store.init({ adminUsername: 'admin', adminPassword: null });

if (mode === 'create') {
  const existing = store.getUserByUsername(USERNAME);
  if (existing) {
    store.updateUser(existing.id, { password: PASSWORD, disabled: false });
    console.log(`updated ${existing.id}`);
  } else {
    const user = store.createUser({ username: USERNAME, password: PASSWORD, displayName: 'UI Check', role: 'user' });
    console.log(`created ${user.id}`);
  }
  const me = store.getUserByUsername(USERNAME);
  const projects = store.state.projects.filter((p) => p.ownerId === me.id);
  console.log(`projects ${projects.length}`);
  for (const p of projects) console.log(`project ${p.id} ${p.name}`);
} else {
  const existing = store.getUserByUsername(USERNAME);
  if (existing) {
    store.deleteUser(existing.id);
    console.log(`deleted ${existing.id}`);
  } else {
    console.log('absent');
  }
}

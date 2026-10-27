/**
 * Общие предохранители для UI-проверок, которые пишут файлы в проект.
 *
 * По умолчанию такие проверки запускаются только на локальном сервере: на живом
 * они складывали тестовые файлы в проекты пользователя. Осознанный запуск на
 * живом разрешается переменной DSHOW_ALLOW_LIVE=1, но и тогда тест обязан
 * убрать за собой.
 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function skipOnLive(base, name) {
  let host = '';
  try {
    host = new URL(base).hostname;
  } catch {
    return;
  }
  if (LOCAL_HOSTS.has(host) || process.env.DSHOW_ALLOW_LIVE === '1') return;
  console.log(`  --  ${name}: это живой сервер, проверка не запускается без DSHOW_ALLOW_LIVE=1`);
  process.exit(0);
}

/** Удаляет тестовый файл из проекта через API, не оставляя мусора. */
export async function deleteTestFile(base, user, pass, projectId, fileName) {
  if (!projectId || !fileName) return false;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!login.ok) return false;
  const cookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [])
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await fetch(
    `${base}/api/projects/${projectId}/file?path=${encodeURIComponent(fileName)}`,
    { method: 'DELETE', headers: { cookie } },
  );
  return response.ok;
}

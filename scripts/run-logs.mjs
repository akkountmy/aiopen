/* Живые логи проекта Amvera: node scripts/run-logs.mjs [фильтр] */
import { callTool } from './amvera-mcp.mjs';

const SLUG = 'dshopen';
const query = process.argv[2] || '*';
const end = new Date();
const start = new Date(end.getTime() - 2 * 60 * 60 * 1000);
const r = await callTool('getRunLogs', {
  serviceName: SLUG,
  query,
  start: start.toISOString(),
  end: end.toISOString(),
  limit: 200,
});
if (r.isError) {
  console.log('ОШИБКА: ' + r.text.slice(0, 800));
} else {
  const lines = String(r.text).split('\n');
  console.log(lines.slice(-120).join('\n').slice(-6000));
}

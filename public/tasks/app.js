/**
 * Страница «Реестры задания» — только чтение.
 *
 * Реестр заводит и обновляет харнесс (агент разбирает постановку на пункты),
 * сюда он приходит зеркалом. Поэтому здесь нет кнопок «сделано» и «удалить»:
 * статус, поставленный в браузере, разошёлся бы с работой через один ход, и
 * человек видел бы красивую доску, за которой ничего не сделано.
 *
 * Чего здесь намеренно нет: своего расчёта вердикта. Вердикт и покрытие
 * считает сервер тем же движком, что и харнесс (src/taskbrief.mjs), и страница
 * их только показывает — иначе «на сайте зелёно» перестало бы значить «в
 * работе проверено».
 */

const VERDICT = {
  ready: { label: 'готово', cls: 'tb-pill-ok' },
  incomplete: { label: 'не завершено', cls: 'tb-pill-warn' },
  blocked: { label: 'есть ошибки', cls: 'tb-pill-bad' },
};

const POINT_STATUS = {
  todo: { label: 'к выполнению', cls: 'tb-pill-mute' },
  doing: { label: 'в работе', cls: 'tb-pill-warn' },
  done: { label: 'сделано', cls: 'tb-pill-ok' },
  blocked: { label: 'заблокировано', cls: 'tb-pill-bad' },
  dropped: { label: 'снято', cls: 'tb-pill-mute' },
};

const SOURCE = { harness: 'харнесс', site: 'сайт' };

const listEl = document.getElementById('list');
const detailEl = document.getElementById('detail');

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const pill = (text, cls) => `<span class="tb-pill ${cls}">${esc(text)}</span>`;

function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = Date.now();
  const diffMin = Math.round((now - date.getTime()) / 60000);
  if (diffMin >= 0 && diffMin < 1) return 'только что';
  if (diffMin >= 1 && diffMin < 60) return `${diffMin} мин назад`;
  if (diffMin >= 60 && diffMin < 60 * 24) return `${Math.round(diffMin / 60)} ч назад`;
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) +
    (date.getFullYear() === new Date().getFullYear() ? '' : ` ${date.getFullYear()}`);
}

async function api(url) {
  const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (response.status === 401) {
    detailEl.innerHTML =
      '<div class="tb-msg">Нужен вход в приложение. <a href="/">Войти</a> — и вернуться сюда.</div>';
    listEl.innerHTML = '';
    return { blocked: true };
  }
  if (response.status === 403) {
    detailEl.innerHTML =
      '<div class="tb-msg">Реестры задания — рабочий журнал оператора, раздел только для администратора.</div>';
    listEl.innerHTML = '';
    return { blocked: true };
  }
  if (!response.ok) {
    let message = `Ошибка ${response.status}`;
    try {
      const body = await response.json();
      if (body && body.error) message = body.error;
    } catch {
      /* тело ответа не обязательно json */
    }
    throw new Error(message);
  }
  return { data: await response.json() };
}

function summary(coverage) {
  if (!coverage || !coverage.total) return 'пунктов нет';
  return `${coverage.done} из ${coverage.total}${coverage.open ? `, открыто ${coverage.open}` : ''}`;
}

function renderCard(item, activeId) {
  const verdict = VERDICT[item.verdict] || VERDICT.incomplete;
  return `
    <button class="tb-card" type="button" data-id="${esc(item.id)}" aria-current="${item.id === activeId}">
      <span class="tb-card-title">${esc(item.title || item.goal || item.id)}</span>
      <span class="tb-card-meta">
        ${pill(verdict.label, verdict.cls)}
        <span>${esc(summary(item.coverage))}</span>
        <span>· ${esc(when(item.updatedAt || item.receivedAt))}</span>
      </span>
    </button>`;
}

function renderVariables(variables) {
  if (!variables.length) return '';
  const rows = variables
    .map((v) => {
      const status = v.status === 'set' ? null : pill(v.status === 'assumed' ? 'по умолчанию' : 'без значения', v.status === 'assumed' ? 'tb-pill-warn' : 'tb-pill-bad');
      return `<tr>
        <td class="tb-id tb-mono">${esc(v.id)}</td>
        <td>${esc(v.name)}${v.meaning ? `<div class="tb-mono">${esc(v.meaning)}</div>` : ''}</td>
        <td>${v.value ? `<strong>${esc(v.value)}</strong>${v.unit ? ` ${esc(v.unit)}` : ''}` : '<span class="tb-mono">—</span>'}</td>
        <td>${status || (v.source === 'user' ? pill('из постановки', 'tb-pill-mute') : '')}</td>
      </tr>`;
    })
    .join('');
  return `<h2 class="tb-h2">Переменные</h2>
    <div class="tb-table-wrap"><table class="tb-table">
      <thead><tr><th>ID</th><th>Что это</th><th>Значение</th><th>Источник</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function renderPoints(points) {
  if (!points.length) return `<h2 class="tb-h2">Пункты</h2><div class="tb-empty">Постановка не разобрана на пункты.</div>`;
  const rows = points
    .map((point) => {
      const status = POINT_STATUS[point.status] || POINT_STATUS.todo;
      const acceptance = (point.acceptance || [])
        .map((item) => {
          /* Критерий в каноне — {given, when, then}. В таблице главное — «тогда»:
             именно оно проверяемо, а «дано/когда» только объясняют условия. */
          const lead = [item.given, item.when].filter(Boolean).join(' → ');
          const then = item.then || '';
          if (!lead && !then) return '';
          return `<div>${lead ? `<span class="tb-mono">${esc(lead)} →</span> ` : ''}<strong>${esc(then)}</strong></div>`;
        })
        .join('');
      const evidence = (point.evidence || []).map((item) => `<div class="tb-mono">${esc(item)}</div>`).join('');
      const note = point.note ? `<div class="tb-mono">${esc(point.note)}</div>` : '';
      const refs = (point.refs || []).length ? `<div class="tb-mono">${esc(point.refs.join(', '))}</div>` : '';
      return `<tr class="${point.status === 'done' ? 'tb-done' : ''}">
        <td class="tb-id tb-mono">${esc(point.id)}${refs}</td>
        <td class="tb-ptext">${esc(point.text)}${point.source ? `<div class="tb-mono">дословно: ${esc(point.source)}</div>` : ''}</td>
        <td>${pill(status.label, status.cls)}</td>
        <td>${acceptance || '<span class="tb-mono">—</span>'}</td>
        <td>${evidence || note || '<span class="tb-mono">—</span>'}</td>
      </tr>`;
    })
    .join('');
  return `<h2 class="tb-h2">Пункты</h2>
    <div class="tb-table-wrap"><table class="tb-table">
      <thead><tr><th>ID</th><th>Что сделать</th><th>Статус</th><th>Критерий приёмки</th><th>Доказательство</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function renderIssues(issues) {
  if (!issues.length) {
    return `<h2 class="tb-h2">Проверка</h2><div class="tb-empty">Замечаний нет: пункты закрыты и у каждого есть доказательство.</div>`;
  }
  const rows = issues
    .map((issue) => {
      const cls = issue.severity === 'error' ? 'tb-pill-bad' : issue.severity === 'warn' ? 'tb-pill-warn' : 'tb-pill-mute';
      return `<div class="tb-issue">
        ${pill(issue.severity === 'error' ? 'ошибка' : 'внимание', cls)}
        <span class="tb-issue-code">${esc(issue.code)}</span>
        <span>${esc(issue.message)}</span>
      </div>`;
    })
    .join('');
  return `<h2 class="tb-h2">Проверка (${issues.length})</h2><div>${rows}</div>`;
}

function renderDetail(detail) {
  const brief = detail.brief || {};
  const verdict = VERDICT[detail.verdict] || VERDICT.incomplete;
  const coverage = detail.coverage || {};
  const percent = Number(coverage.donePercent || 0);
  const dod = (brief.definitionOfDone || []).map((item) => `<li>${esc(item)}</li>`).join('');
  const nonGoals = (brief.nonGoals || []).map((item) => `<li>${esc(item)}</li>`).join('');
  const questions = (brief.openQuestions || [])
    .map((q) => `<li>${esc(q.text)}${q.answer ? ` — <strong>${esc(q.answer)}</strong>` : ''}</li>`)
    .join('');
  const checks = (brief.checks || [])
    .map((c) => `<li>${c.done ? '☑' : '☐'} ${esc(c.text)}${c.evidence ? ` <span class="tb-mono">${esc(c.evidence)}</span>` : ''}</li>`)
    .join('');

  return `
    <h1 class="tb-h1">${esc(brief.title || 'Без названия')}</h1>
    <div class="tb-row">
      ${pill(verdict.label, verdict.cls)}
      <span class="tb-mono">${esc(brief.id)}</span>
      <span class="tb-mono">${esc(SOURCE[brief.source] || brief.source || '')}</span>
      <span class="tb-mono">обновлён ${esc(when(brief.updatedAt))}</span>
    </div>
    <div class="tb-progress" title="закрыто ${percent}%"><i style="width:${Math.max(0, Math.min(100, percent))}%"></i></div>
    <p class="tb-mono" style="margin:2px 0 0">${esc(summary(coverage))} · закрыто ${percent}%</p>
    ${brief.goal ? `<h2 class="tb-h2">Цель</h2><p class="tb-text">${esc(brief.goal)}</p>` : ''}
    ${dod ? `<h2 class="tb-h2">Определение готовности</h2><ul class="tb-list-plain">${dod}</ul>` : ''}
    ${renderVariables(brief.variables || [])}
    ${renderPoints(brief.points || [])}
    ${questions ? `<h2 class="tb-h2">Открытые вопросы</h2><ul class="tb-list-plain">${questions}</ul>` : ''}
    ${checks ? `<h2 class="tb-h2">Проверки</h2><ul class="tb-list-plain">${checks}</ul>` : ''}
    ${nonGoals ? `<h2 class="tb-h2">Что не входит в задачу</h2><ul class="tb-list-plain">${nonGoals}</ul>` : ''}
    ${brief.workspace ? `<h2 class="tb-h2">Папка работы</h2><p class="tb-mono">${esc(brief.workspace)}</p>` : ''}
    ${renderIssues(detail.issues || [])}`;
}

function selectCard(id) {
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  [...listEl.querySelectorAll('.tb-card')].forEach((card) => {
    card.setAttribute('aria-current', String(card.dataset.id === id));
  });
}

async function openBrief(id) {
  selectCard(id);
  detailEl.innerHTML = '<div class="tb-card-skeleton" style="height:180px"></div>';
  try {
    const { data, blocked } = await api(`/api/tasks/briefs/${encodeURIComponent(id)}`);
    if (blocked) return;
    detailEl.innerHTML = renderDetail(data);
  } catch (error) {
    detailEl.innerHTML = `<div class="tb-msg">Не удалось открыть реестр: ${esc(error.message)}</div>`;
  }
}

async function boot() {
  try {
    const { data, blocked } = await api('/api/tasks/briefs');
    if (blocked) return;
    const briefs = Array.isArray(data.briefs) ? data.briefs : [];
    if (!briefs.length) {
      listEl.innerHTML = '';
      detailEl.innerHTML =
        '<div class="tb-empty">Реестров пока нет. Реестр появляется, когда агент разбирает постановку из многих пунктов.</div>';
      return;
    }
    const wanted = decodeURIComponent(location.hash.slice(1) || '');
    const active = briefs.some((item) => item.id === wanted) ? wanted : briefs[0].id;
    listEl.innerHTML = briefs.map((item) => renderCard(item, active)).join('');
    listEl.addEventListener('click', (event) => {
      const card = event.target.closest('.tb-card');
      if (card && card.dataset.id) openBrief(card.dataset.id);
    });
    openBrief(active);
  } catch (error) {
    listEl.innerHTML = '';
    detailEl.innerHTML = `<div class="tb-msg">Не удалось получить список: ${esc(error.message)}</div>`;
  }
}

boot();

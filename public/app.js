'use strict';

// ---------- helpers ----------------------------------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n, { cents = false, sign = false } = {}) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  if (v < 0) return `−${s}`;
  return sign && v > 0 ? `+${s}` : s;
};
const compact = (n) => (Math.abs(n) >= 10000 ? `$${Math.round(n / 1000)}K` : money(n));
const monthName = (m, short = false) => new Date(`${m}-15T12:00:00`).toLocaleDateString('en-US', { month: short ? 'short' : 'long', year: short ? undefined : 'numeric' });
const dateLabel = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const addMonths = (m, n) => {
  const [y, mo] = m.split('-').map(Number);
  const i = y * 12 + mo - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string') {
      init.headers['content-type'] = 'text/csv';
      init.body = opts.body;
    } else {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.signedOut) {
    location.replace('/login');
    throw new Error('Signed out');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
const fail = (err) => toast(err.message || String(err));

// Status icons travel with a text label so state never relies on colour alone.
const ICONS = {
  over: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="var(--critical)"/><path d="M8 4.2v4.6M8 11.2v.4" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
  warn: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="var(--warning)"/><path d="M8 6v3.6M8 11.6v.3" stroke="#0b0b0b" stroke-width="1.8" stroke-linecap="round"/></svg>',
  good: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="var(--good)"/><path d="m4.8 8.2 2.2 2.2 4.2-4.4" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const statusTag = (kind, text) => `<span class="status ${kind}">${ICONS[kind]}${esc(text)}</span>`;

// tooltip
const tip = $('#tooltip');
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14;
  let top = y + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}
const hideTip = () => (tip.hidden = true);

// ---------- state ------------------------------------------------------------
const state = { status: null, categories: [], month: null, accounts: [], tab: 'overview' };

// ---------- tabs ---------------------------------------------------------------
function showTab(name) {
  state.tab = name;
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of $$('.tab')) s.hidden = s.id !== `tab-${name}`;
  try { localStorage.setItem('tab', name); } catch {}
  render[name]?.().catch(fail);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- overview ---------------------------------------------------------
async function renderOverview() {
  $('#monthLabel').textContent = monthName(state.month);
  $('#nextMonth').disabled = state.month >= state.status.today.slice(0, 7);
  const s = await api(`/api/summary?month=${state.month}`);

  const prev = s.trend[s.trend.length - 2];
  const vs = (cur, old, upIsGood) => {
    if (!old) return '';
    const d = cur - old;
    if (Math.abs(d) < 1) return 'Same as last month';
    const good = upIsGood ? d > 0 : d < 0;
    return `<span class="${good ? 'pos' : 'neg'}">${d > 0 ? '▲' : '▼'} ${money(Math.abs(d))}</span> vs ${monthName(prev.month, true)}`;
  };
  const left = s.income - s.spending;
  $('#tiles').innerHTML = [
    tile('Income', money(s.income), vs(s.income, prev?.income, true)),
    tile('Spending', money(s.spending), vs(s.spending, prev?.spending, false)),
    tile(s.isCurrentMonth ? 'Left over so far' : 'Left over', `<span class="${left < 0 ? 'neg' : ''}">${money(left)}</span>`,
      s.income > 0 ? `${Math.round((left / s.income) * 100)}% of income saved` : ''),
    tile('Budgeted', s.budgetTotal ? money(s.budgetTotal) : '—',
      s.budgetTotal ? `${money(budgetedSpent(s))} spent in budgeted categories` : '<a href="#" data-goto="budgets">Set budgets</a>'),
  ].join('');

  // Category list: budget meter when a budget exists, otherwise share of the biggest category.
  const cats = s.categories.filter((c) => c.spent > 0.5 || c.budget);
  const max = Math.max(1, ...cats.map((c) => c.spent));
  $('#catHint').textContent = s.typical.months.length ? `typical = avg of ${s.typical.months.length} prior mo` : '';
  $('#categoryList').innerHTML = cats.length
    ? cats.map((c) => {
        let meter;
        let sub;
        if (c.budget) {
          const pct = c.spent / c.budget;
          const cls = pct > 1 ? 'over' : pct >= 0.9 ? 'warn' : '';
          meter = `<div class="meter"><div class="${cls}" style="width:${Math.min(100, pct * 100)}%"></div></div>`;
          const tag = pct > 1
            ? statusTag('over', `Over by ${money(c.spent - c.budget)}`)
            : pct >= 0.9
              ? statusTag('warn', `${money(c.budget - c.spent)} left`)
              : `<span>${money(c.budget - c.spent)} left of ${money(c.budget)}</span>`;
          sub = `${tag}<span>typical ${money(c.typical)}</span>`;
        } else {
          meter = `<div class="meter plain"><div style="width:${(c.spent / max) * 100}%"></div></div>`;
          sub = `<span>No budget</span><span>typical ${money(c.typical)}</span>`;
        }
        return `<div class="cat-row">
          <div class="top"><span class="name">${esc(c.category)} <span class="kind-tag">${c.kind === 'essential' ? 'need' : 'want'}</span></span>
          <a class="amount" href="#" data-cat="${esc(c.category)}" title="See transactions">${money(c.spent)}</a></div>
          ${meter}<div class="sub">${sub}</div></div>`;
      }).join('')
    : emptyState('No spending this month', 'Connect a bank, import a CSV, or load demo data from the Accounts tab.');

  drawTrend(s.trend);
  $('#merchants').innerHTML = s.topMerchants.length
    ? `<table><tbody>${s.topMerchants.map((m) => `<tr><td>${esc(m.merchant)}<div class="muted small">${esc(m.category)} · ${m.count} ${m.count === 1 ? 'purchase' : 'purchases'}</div></td><td class="num">${money(m.total, { cents: true })}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted small">Nothing yet.</p>';
}
const budgetedSpent = (s) => s.categories.filter((c) => c.budget).reduce((a, c) => a + c.spent, 0);
const tile = (label, value, delta = '') => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="delta">${delta}</div></div>`;
const emptyState = (title, body) => `<div class="empty"><h2>${esc(title)}</h2><p>${esc(body)}</p></div>`;

$('#prevMonth').addEventListener('click', () => { state.month = addMonths(state.month, -1); renderOverview().catch(fail); });
$('#nextMonth').addEventListener('click', () => { state.month = addMonths(state.month, 1); renderOverview().catch(fail); });
document.addEventListener('click', (e) => {
  const cat = e.target.closest('[data-cat]');
  if (cat) {
    e.preventDefault();
    $('#txMonth').value = state.month;
    $('#txCategory').value = cat.dataset.cat;
    showTab('transactions');
  }
  const go = e.target.closest('[data-goto]');
  if (go) {
    e.preventDefault();
    showTab(go.dataset.goto);
  }
});

// Grouped columns: income vs spending, six months. One y-axis, two series, legend + table view.
const SERIES = [
  { key: 'income', label: 'Income', color: 'var(--series-3)' },
  { key: 'spending', label: 'Spending', color: 'var(--series-2)' },
];
function drawTrend(trend) {
  $('#trendLegend').innerHTML = SERIES.map((s) => `<span><i class="swatch" style="background:${s.color}"></i>${s.label}</span>`).join('');
  const W = 520, H = 220, L = 46, R = 8, T = 10, B = 26;
  const maxV = Math.max(1, ...trend.flatMap((t) => [t.income, t.spending]));
  const step = niceStep(maxV / 4);
  const top = Math.ceil(maxV / step) * step;
  const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / top);
  const band = (W - L - R) / trend.length;
  const bw = Math.min(24, (band - 18) / 2);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Income and spending by month">`;
  for (let v = 0; v <= top + 0.1; v += step) {
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? 'var(--axis)' : 'var(--grid)'}" stroke-width="1"/>`;
    svg += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  trend.forEach((t, i) => {
    const cx = L + band * i + band / 2;
    SERIES.forEach((s, j) => {
      const x = cx - bw - 1 + j * (bw + 2);
      const h = Math.max(0, y(0) - y(t[s.key]));
      if (h > 0) svg += `<path d="${roundedTop(x, y(0), bw, h, 4)}" fill="${s.color}"/>`;
    });
    svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${monthName(t.month, true)}</text>`;
    svg += `<rect x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}" fill="transparent" data-i="${i}" class="hit"/>`;
  });
  svg += '</svg>';
  const el = $('#trendChart');
  el.innerHTML = svg;
  for (const r of $$('.hit', el)) {
    const t = trend[+r.dataset.i];
    const html = `<div class="tt-title">${monthName(t.month)}</div>${SERIES.map((s) => `<div class="tt-row"><span><i class="swatch" style="background:${s.color}"></i> ${s.label}</span><span>${money(t[s.key])}</span></div>`).join('')}<div class="tt-row"><span>Left over</span><span>${money(t.income - t.spending)}</span></div>`;
    r.addEventListener('mousemove', (e) => { r.setAttribute('fill', 'rgba(127,127,127,0.07)'); showTip(html, e.clientX, e.clientY); });
    r.addEventListener('mouseleave', () => { r.setAttribute('fill', 'transparent'); hideTip(); });
  }
  $('#trendTable').innerHTML = `<table><thead><tr><th>Month</th><th class="num">Income</th><th class="num">Spending</th><th class="num">Left over</th></tr></thead><tbody>${trend.map((t) => `<tr><td>${monthName(t.month)}</td><td class="num">${money(t.income)}</td><td class="num">${money(t.spending)}</td><td class="num">${money(t.income - t.spending)}</td></tr>`).join('')}</tbody></table>`;
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
// Column with a 4px rounded data-end and a square baseline.
function roundedTop(x, base, w, h, r) {
  r = Math.min(r, h, w / 2);
  const top = base - h;
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}
$('#trendTableToggle').addEventListener('click', (e) => {
  const tbl = $('#trendTable');
  tbl.hidden = !tbl.hidden;
  $('#trendChart').hidden = !tbl.hidden;
  $('#trendLegend').hidden = !tbl.hidden;
  e.target.textContent = tbl.hidden ? 'Show table' : 'Show chart';
});

// ---------- plan -------------------------------------------------------------
let goalsCache = [];
async function renderPlan() {
  const [plan, goals] = await Promise.all([api('/api/plan'), api('/api/goals')]);
  goalsCache = goals;
  $('#planBasis').textContent = plan.baselineMonths.length
    ? `Based on your average over ${plan.baselineMonths.map((m) => monthName(m, true)).join(', ')}.`
    : '';

  // Money map: one whole (income) split into where it goes.
  const goalsFunded = plan.goals.reduce((a, g) => a + g.allocated, 0);
  const spare = Math.max(0, plan.income - plan.spending - goalsFunded);
  const parts = [
    { label: 'Needs', value: plan.essential, color: 'var(--series-1)' },
    { label: 'Wants', value: plan.discretionary, color: 'var(--series-2)' },
    { label: 'Savings goals', value: goalsFunded, color: 'var(--series-3)' },
    { label: 'Unassigned', value: spare, color: 'var(--series-4)', dark: true },
  ];
  const whole = Math.max(plan.income, plan.spending + goalsFunded, 1);
  const pct = (v) => Math.round((v / whole) * 100);
  $('#moneyMap').innerHTML = plan.income || plan.spending
    ? `<div class="seg-bar" role="img" aria-label="${parts.map((p) => `${p.label} ${money(p.value)}`).join(', ')}">
        ${parts.filter((p) => p.value > 0.5).map((p) => {
          const w = (p.value / whole) * 100;
          return `<div style="flex:${w} 1 0;background:${p.color}" class="${p.dark ? 'dark-ink' : ''}" data-tip="${esc(p.label)}|${money(p.value)}|${pct(p.value)}%">${w > 9 ? `${pct(p.value)}%` : ''}</div>`;
        }).join('')}
      </div>
      <div class="seg-legend">
        <div><span class="muted">Income</span><span class="v">${money(plan.income)}/mo</span></div>
        ${parts.map((p) => `<div><i class="swatch" style="background:${p.color}"></i><span>${p.label}</span><span class="v">${money(p.value)}</span></div>`).join('')}
        ${plan.shortfall > 0 ? `<div>${statusTag('over', 'Goal gap')}<span class="v neg">${money(plan.shortfall)}</span></div>` : ''}
      </div>`
    : emptyState('No data to plan with yet', 'Connect an account or import a CSV first.');
  for (const seg of $$('[data-tip]', $('#moneyMap'))) {
    const [l, v, p] = seg.dataset.tip.split('|');
    seg.addEventListener('mousemove', (e) => showTip(`<div class="tt-title">${l}</div><div class="tt-row"><span>${v}/mo</span><span>${p} of income</span></div>`, e.clientX, e.clientY));
    seg.addEventListener('mouseleave', hideTip);
  }
  $('#planNotes').innerHTML = plan.notes.map((n) => `<li>${esc(n)}</li>`).join('');

  // Goal cards.
  $('#goalCards').innerHTML = plan.goals.length
    ? plan.goals.map(goalCard).join('')
    : `<div class="card empty" style="grid-column:1/-1"><h2>No savings goals yet</h2><p>Add a goal (emergency fund, trip, down payment…) and the plan will tell you how much to set aside each month.</p><button class="btn primary" data-new-goal>+ New goal</button></div>`;
  for (const c of $$('[data-goal]')) {
    c.addEventListener('click', () => openGoal(+c.dataset.goal));
    c.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openGoal(+c.dataset.goal)));
  }
  $('[data-new-goal]')?.addEventListener('click', () => openGoal());

  // Trims.
  $('#trimsCard').hidden = !plan.trims.length;
  $('#trims').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Typical</th><th class="num">Aim for</th><th class="num">Frees up</th><th></th></tr></thead><tbody>
    ${plan.trims.map((t) => `<tr><td>${esc(t.category)}</td><td class="num">${money(t.typical)}</td><td class="num">${money(t.suggested)}</td><td class="num pos">+${money(t.saves)}</td>
      <td class="num">${t.budget != null && t.budget <= t.suggested ? '<span class="muted small">Budget already set</span>' : `<button class="btn" data-trim="${esc(t.category)}" data-amt="${Math.floor(t.suggested)}">Set budget</button>`}</td></tr>`).join('')}
    <tr><td><strong>Total</strong></td><td></td><td></td><td class="num pos"><strong>+${money(plan.trims.reduce((a, t) => a + t.saves, 0))}</strong></td><td></td></tr></tbody></table></div>`;
  for (const b of $$('[data-trim]')) {
    b.addEventListener('click', async () => {
      await api('/api/budgets', { method: 'PUT', body: { [b.dataset.trim]: Number(b.dataset.amt) } }).catch(fail);
      toast(`${b.dataset.trim} budget set to ${money(b.dataset.amt)}/mo`);
      renderPlan().catch(fail);
    });
  }
}

function goalCard(g) {
  const statusMap = {
    complete: statusTag('good', 'Reached'),
    'on-track': statusTag('good', 'On track'),
    behind: statusTag('warn', 'Behind'),
    unfunded: statusTag('over', 'Not funded'),
  };
  const linked = g.accountId && state.accounts.find((a) => a.id === g.accountId);
  const finish = g.complete ? 'Done' : g.projectedDate ? dateLabel(g.projectedDate) : 'Never at this pace';
  return `<div class="card" data-goal="${g.id}" tabindex="0" role="button" aria-label="Edit ${esc(g.name)}">
    <div class="goal-head"><div><h2 style="margin:0">${esc(g.name)}</h2>
      <div class="muted small">${linked ? `Tracking ${esc(linked.name)}` : 'Manual amount'} · priority ${g.priority + 1}</div></div>
      ${statusMap[g.status]}</div>
    <p class="goal-amount">${money(g.saved)} <small>of ${money(g.target)}</small></p>
    <div class="meter"><div style="width:${g.progress * 100}%"></div></div>
    <div class="goal-stats">
      <div><div class="k">Needed per month</div><div class="v">${g.complete ? '—' : money(g.requiredMonthly)}</div></div>
      <div><div class="k">Plan sets aside</div><div class="v">${g.complete ? '—' : money(g.allocated + (g.extra || 0))}</div></div>
      <div><div class="k">Target date</div><div class="v">${dateLabel(g.targetDate)}${g.overdue ? ' <span class="neg">(passed)</span>' : ''}</div></div>
      <div><div class="k">At this pace</div><div class="v">${finish}</div></div>
    </div></div>`;
}

// goal dialog
const dlg = $('#goalDialog');
let editingGoal = null;
function openGoal(id) {
  const g = id ? goalsCache.find((x) => x.id === id) : null;
  editingGoal = g;
  const f = $('#goalForm');
  f.reset();
  $('#goalDialogTitle').textContent = g ? 'Edit goal' : 'New goal';
  $('#deleteGoal').hidden = !g;
  f.account_id.innerHTML = '<option value="">An amount I enter</option>' + state.accounts
    .filter((a) => a.type === 'depository' || a.type === 'investment')
    .map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.mask ? ` ••${esc(a.mask)}` : ''} (${money(a.current_balance)})</option>`).join('');
  if (g) {
    f.name.value = g.name;
    f.target_amount.value = g.target_amount;
    f.target_date.value = g.target_date;
    f.account_id.value = g.account_id || '';
    f.current_amount.value = g.current_amount;
    f.priority.value = String(Math.min(4, g.priority));
  } else {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    f.target_date.value = d.toISOString().slice(0, 10);
    f.priority.value = String(Math.min(4, goalsCache.length));
  }
  $('#savedField').hidden = !!f.account_id.value;
  dlg.showModal();
}
$('#addGoalBtn').addEventListener('click', () => openGoal());
$('#goalForm').account_id.addEventListener('change', (e) => ($('#savedField').hidden = !!e.target.value));
$('#cancelGoal').addEventListener('click', () => dlg.close());
$('#goalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value,
    target_amount: f.target_amount.value,
    target_date: f.target_date.value,
    account_id: f.account_id.value || null,
    current_amount: f.account_id.value ? 0 : f.current_amount.value || 0,
    priority: f.priority.value,
  };
  try {
    await api(editingGoal ? `/api/goals/${editingGoal.id}` : '/api/goals', { method: editingGoal ? 'PUT' : 'POST', body });
    dlg.close();
    toast(editingGoal ? 'Goal updated' : 'Goal added');
    renderPlan().catch(fail);
  } catch (err) { fail(err); }
});
$('#deleteGoal').addEventListener('click', async () => {
  if (!editingGoal || !confirm(`Delete “${editingGoal.name}”?`)) return;
  await api(`/api/goals/${editingGoal.id}`, { method: 'DELETE' }).catch(fail);
  dlg.close();
  renderPlan().catch(fail);
});

// ---------- transactions -----------------------------------------------------
const catOptions = (selected) => state.categories.map((c) => `<option ${c.name === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
async function renderTransactions() {
  if (!$('#txMonth').value) $('#txMonth').value = state.month;
  const params = new URLSearchParams({ month: $('#txMonth').value, category: $('#txCategory').value, account: $('#txAccount').value, q: $('#txSearch').value.trim() });
  for (const [k, v] of [...params]) if (!v) params.delete(k);
  const rows = await api(`/api/transactions?${params}`);
  $('#txBody').innerHTML = rows.length
    ? rows.map((t) => `<tr data-id="${esc(t.id)}">
        <td class="num" style="text-align:left">${dateLabel(t.date)}</td>
        <td><div class="desc">${esc(t.merchant || t.name)}${t.pending ? '<span class="pending">pending</span>' : ''}</div>${t.merchant && t.merchant !== t.name ? `<div class="desc-sub">${esc(t.name)}</div>` : ''}</td>
        <td class="muted small">${esc(t.account_name)}${t.account_mask ? ` ••${esc(t.account_mask)}` : ''}</td>
        <td><select aria-label="Category">${catOptions(t.effective_category)}</select></td>
        <td class="num ${t.amount > 0 ? 'pos' : ''}">${money(t.amount, { cents: true, sign: true })}</td></tr>`).join('')
    : `<tr><td colspan="5">${emptyState('No transactions match', 'Try another month or clear the filters.')}</td></tr>`;
  const spent = rows.filter((t) => t.amount < 0 && !['Transfer', 'Income'].includes(t.effective_category)).reduce((a, t) => a - t.amount, 0);
  $('#txCount').textContent = rows.length ? `${rows.length} transactions · ${money(spent, { cents: true })} spent (excluding transfers)` : '';
  for (const sel of $$('#txBody select')) {
    sel.addEventListener('change', async () => {
      const tr = sel.closest('tr');
      const name = $('.desc', tr).firstChild.textContent;
      const similar = confirm(`Also file every other “${name}” transaction (past and future) under ${sel.value}?\n\nOK = all of them · Cancel = just this one`);
      try {
        const r = await api(`/api/transactions/${encodeURIComponent(tr.dataset.id)}`, { method: 'PATCH', body: { category: sel.value, applyToSimilar: similar } });
        toast(similar ? `Rule saved — ${r.recategorized} transactions updated` : 'Category updated');
        if (similar) renderTransactions().catch(fail);
        renderRules().catch(fail);
      } catch (err) { fail(err); }
    });
  }
  renderRules().catch(fail);
}
let txTimer;
for (const id of ['#txMonth', '#txCategory', '#txAccount']) $(id).addEventListener('change', () => renderTransactions().catch(fail));
$('#txSearch').addEventListener('input', () => { clearTimeout(txTimer); txTimer = setTimeout(() => renderTransactions().catch(fail), 250); });

async function renderRules() {
  const rules = await api('/api/rules');
  $('#rules').innerHTML = rules.length
    ? `<table><tbody>${rules.map((r) => `<tr><td>Contains “${esc(r.pattern)}”</td><td>→ ${esc(r.category)}</td><td class="num"><button class="link-btn small" data-rule="${r.id}">Remove</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted small">No custom rules yet.</p>';
  for (const b of $$('[data-rule]')) b.addEventListener('click', async () => {
    await api(`/api/rules/${b.dataset.rule}`, { method: 'DELETE' }).catch(fail);
    renderRules().catch(fail);
  });
}
$('#ruleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api('/api/rules', { method: 'POST', body: { pattern: f.pattern.value, category: f.category.value } });
    toast(`Rule added — ${r.recategorized} transactions updated`);
    f.pattern.value = '';
    renderTransactions().catch(fail);
  } catch (err) { fail(err); }
});

// ---------- budgets ----------------------------------------------------------
async function renderBudgets() {
  const s = await api(`/api/summary?month=${state.status.today.slice(0, 7)}`);
  const byCat = Object.fromEntries(s.categories.map((c) => [c.category, c]));
  const typicalOf = (name) => byCat[name]?.typical ?? 0;
  const rows = state.categories.filter((c) => c.kind === 'essential' || c.kind === 'discretionary');
  $('#budgetBody').innerHTML = rows.map((c) => {
    const cur = byCat[c.name];
    return `<tr><td>${esc(c.name)}</td><td><span class="kind-tag">${c.kind === 'essential' ? 'need' : 'want'}</span></td>
      <td class="num">${money(typicalOf(c.name))}</td><td class="num">${money(cur?.spent || 0)}</td>
      <td class="num"><input type="number" min="0" step="1" data-budget="${esc(c.name)}" value="${cur?.budget ?? ''}" placeholder="—" aria-label="${esc(c.name)} budget" /></td></tr>`;
  }).join('');
}
$('#saveBudgets').addEventListener('click', async () => {
  const body = Object.fromEntries($$('[data-budget]').map((i) => [i.dataset.budget, i.value === '' ? null : Number(i.value)]));
  try {
    await api('/api/budgets', { method: 'PUT', body });
    toast('Budgets saved');
  } catch (err) { fail(err); }
});

// ---------- accounts ---------------------------------------------------------
async function loadAccounts() {
  const r = await api('/api/accounts');
  state.accounts = r.accounts;
  $('#txAccount').innerHTML = '<option value="">All accounts</option>' + r.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  return r;
}
async function renderAccounts() {
  await refreshStatus(); // connection counts can change between visits
  const [r, conns] = await Promise.all([loadAccounts(), api('/api/connections')]);
  const plaidOn = state.status.plaidConfigured;
  $('#plaidSetup').hidden = plaidOn;
  $('#connectBtn').hidden = !plaidOn;
  $('#sandboxBtn').hidden = !(plaidOn && state.status.plaidEnv === 'sandbox');
  const { plaidItemLimit: limit, plaidItemsUsed: used } = state.status;
  $('#plaidQuota').hidden = !(plaidOn && limit);
  if (limit) {
    $('#plaidQuota').innerHTML = `${used >= limit ? statusTag('over', 'No free connections left') + ' · ' : ''}Bank connections used on Plaid's free plan: <strong>${used} of ${limit}</strong>. Disconnecting a bank doesn't give a connection back, so use <em>Reconnect</em> to repair one.`;
  }
  $('#netWorth').innerHTML = r.accounts.length
    ? tile('Cash &amp; investments', money(r.assets)) + tile('Card &amp; loan balances', money(r.debts)) + tile('Net worth', money(r.netWorth))
    : '';
  $('#connections').innerHTML = conns.map((c) => `<div class="card conn">
      <div class="grow"><strong>${esc(c.institution_name || 'Bank connection')}</strong>
      <div class="muted small">${c.last_synced_at ? `Last synced ${new Date(c.last_synced_at + 'Z').toLocaleString()}` : 'Not synced yet'}</div>
      ${c.error ? `<div class="small">${statusTag('over', c.error)}</div>` : ''}</div>
      ${c.error ? `<button class="btn" data-reconnect="${esc(c.id)}">Reconnect</button>` : ''}
      <button class="btn danger-ghost" data-disconnect="${esc(c.id)}">Disconnect</button></div>`).join('');
  $('#accountBody').innerHTML = r.accounts.length
    ? r.accounts.map((a) => `<tr><td><strong>${esc(a.name)}</strong>${a.mask ? ` <span class="muted">••${esc(a.mask)}</span>` : ''}</td>
        <td class="muted">${esc(a.institution_name || '')}${a.source === 'demo' ? ' (demo)' : ''}</td>
        <td class="muted">${esc(a.subtype || a.type || '')}</td>
        <td class="num">${a.current_balance == null ? '—' : money(a.current_balance, { cents: true })}</td>
        <td class="num">${a.source === 'csv' ? `<button class="link-btn small" data-balance="${esc(a.id)}">Set balance</button> · <button class="link-btn small" data-delacct="${esc(a.id)}">Remove</button>` : ''}</td></tr>`).join('')
    : `<tr><td colspan="5">${emptyState('No accounts yet', plaidOn ? 'Connect a bank to get started.' : 'Import a CSV or load demo data below.')}</td></tr>`;

  for (const b of $$('[data-disconnect]')) b.addEventListener('click', async () => {
    const slotNote = state.status.plaidItemLimit ? '\n\nOn Plaid\'s free plan this does NOT give you a connection back.' : '';
    if (!confirm(`Disconnect this bank? Its accounts and transactions will be removed from this app.${slotNote}`)) return;
    await api(`/api/connections/${encodeURIComponent(b.dataset.disconnect)}`, { method: 'DELETE' }).catch(fail);
    await refreshStatus();
    renderAccounts().catch(fail);
  });
  for (const b of $$('[data-reconnect]')) b.addEventListener('click', () => openPlaidLink(b.dataset.reconnect).catch(fail));
  for (const b of $$('[data-balance]')) b.addEventListener('click', async () => {
    const v = prompt('Current balance for this account (used for net worth and goals):');
    if (v == null || v.trim() === '') return;
    await api(`/api/accounts/${encodeURIComponent(b.dataset.balance)}`, { method: 'PATCH', body: { current_balance: Number(v.replace(/[$,]/g, '')) } }).catch(fail);
    renderAccounts().catch(fail);
  });
  for (const b of $$('[data-delacct]')) b.addEventListener('click', async () => {
    if (!confirm('Remove this account and all its imported transactions?')) return;
    await api(`/api/accounts/${encodeURIComponent(b.dataset.delacct)}`, { method: 'DELETE' }).catch(fail);
    await refreshStatus();
    renderAccounts().catch(fail);
  });
}

$('#csvForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const file = f.file.files[0];
  if (!file) return;
  const params = new URLSearchParams({ account: f.account.value, type: f.type.value, spendingIsPositive: String(f.spendingIsPositive.checked) });
  try {
    const r = await api(`/api/import/csv?${params}`, { method: 'POST', body: await file.text() });
    toast(`Imported ${r.added} new transactions${r.skippedRows.length ? ` (${r.skippedRows.length} rows skipped)` : ''}`);
    f.reset();
    await refreshStatus();
    renderAccounts().catch(fail);
  } catch (err) { fail(err); }
});
$('#loadDemo').addEventListener('click', async () => {
  await api('/api/demo', { method: 'POST' }).catch(fail);
  toast('Demo data loaded');
  await refreshStatus();
  showTab('overview');
});
$('#clearDemo').addEventListener('click', async () => {
  if (!confirm('Remove all demo accounts, transactions and goals?')) return;
  await api('/api/demo', { method: 'DELETE' }).catch(fail);
  toast('Demo data removed');
  await refreshStatus();
  renderAccounts().catch(fail);
});

// Plaid Link -----------------------------------------------------------------
function loadPlaidScript() {
  if (window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Plaid Link — check your internet connection.'));
    document.head.appendChild(s);
  });
}
async function openPlaidLink(itemId, receivedRedirectUri) {
  await loadPlaidScript();
  let token;
  if (receivedRedirectUri) {
    try { token = localStorage.getItem('plaid_link_token'); } catch {}
  }
  if (!token) {
    token = (await api('/api/plaid/link-token', { method: 'POST', body: itemId ? { itemId } : {} })).link_token;
    try { localStorage.setItem('plaid_link_token', token); } catch {}
  }
  const handler = window.Plaid.create({
    token,
    receivedRedirectUri,
    onSuccess: async (public_token, metadata) => {
      try {
        if (itemId) {
          toast('Reconnected — syncing…');
          await api('/api/sync', { method: 'POST' });
        } else {
          toast(`Connecting ${metadata.institution?.name || 'your bank'}… this can take a moment`);
          await api('/api/plaid/exchange', { method: 'POST', body: { public_token, institution: metadata.institution } });
          toast(`${metadata.institution?.name || 'Bank'} connected. Transactions can take a few minutes to arrive — click "Sync now" if they're not there yet.`);
        }
        await refreshStatus();
        renderAccounts().catch(fail);
      } catch (err) { fail(err); }
    },
    onExit: (err) => { if (err) toast(err.display_message || err.error_message || 'Bank connection was cancelled'); },
  });
  handler.open();
}
$('#connectBtn').addEventListener('click', async () => {
  await refreshStatus().catch(() => {});
  const { plaidItemLimit: limit, plaidItemsUsed: used } = state.status;
  if (limit && used >= limit) return toast(`You've used all ${limit} free bank connections. Use Reconnect to repair an existing one.`);
  const conns = await api('/api/connections').catch(() => []);
  if (limit && conns.length) {
    const names = conns.map((c) => c.institution_name || 'a bank').join(', ');
    const ok = confirm(`Already connected: ${names}.\n\nConnecting the same bank again uses another of your ${limit - used} remaining free connections. If a connection stopped working, press Cancel and use "Reconnect" instead.\n\nConnect a new bank?`);
    if (!ok) return;
  }
  openPlaidLink().catch(fail);
});
$('#sandboxBtn').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    toast('Creating a sandbox bank connection…');
    await api('/api/plaid/sandbox-connect', { method: 'POST' });
    toast('Sandbox bank connected');
    await refreshStatus();
    renderAccounts().catch(fail);
  } catch (err) { fail(err); } finally { e.target.disabled = false; }
});
$('#syncBtn').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Syncing…';
  try {
    const { results } = await api('/api/sync', { method: 'POST' });
    const errs = results.filter((r) => r.error);
    const added = results.reduce((a, r) => a + (r.added || 0), 0);
    toast(errs.length ? `Sync problem: ${errs[0].error}` : `Synced — ${added} new transactions`);
    render[state.tab]?.().catch(fail);
  } catch (err) { fail(err); } finally {
    e.target.disabled = false;
    e.target.textContent = 'Sync now';
  }
});

// ---------- boot ---------------------------------------------------------------
const render = { overview: renderOverview, plan: renderPlan, transactions: renderTransactions, budgets: renderBudgets, accounts: renderAccounts };

async function refreshStatus() {
  state.status = await api('/api/status');
  $('#syncBtn').hidden = !state.status.plaidConfigured;
  const b = $('#banner');
  if (!state.status.transactions && !state.status.accounts) {
    b.hidden = false;
    b.innerHTML = `<strong>Welcome!</strong><span>${state.status.plaidConfigured ? 'Connect a bank account' : 'Import a CSV statement'} to start tracking, or explore with demo data first.</span>
      <span class="spacer"></span><button class="btn" data-goto="accounts">${state.status.plaidConfigured ? 'Connect a bank' : 'Add accounts'}</button><button class="btn primary" id="bannerDemo">Load demo data</button>`;
    $('#bannerDemo').addEventListener('click', () => $('#loadDemo').click());
  } else if (state.status.demoLoaded) {
    b.hidden = false;
    b.innerHTML = '<span>You’re looking at <strong>demo data</strong>. Remove it from the Accounts tab once your real accounts are in.</span>';
  } else {
    b.hidden = true;
  }
  await loadAccounts();
}

// ---------- account menu ------------------------------------------------------
async function loadUser() {
  const { user } = await api('/api/auth/state');
  if (!user) return location.replace('/login');
  const initials = user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  $('#userInitials').textContent = initials;
  $('#userName').textContent = user.name.split(/\s+/)[0];
  $('#menuName').textContent = user.name;
  $('#menuEmail').textContent = user.email;
}
const menu = $('#userMenu');
const setMenu = (open) => {
  menu.hidden = !open;
  $('#userBtn').setAttribute('aria-expanded', String(open));
};
$('#userBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  setMenu(menu.hidden);
});
document.addEventListener('click', (e) => !menu.contains(e.target) && setMenu(false));
document.addEventListener('keydown', (e) => e.key === 'Escape' && setMenu(false));
$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login');
});
const pwDlg = $('#pwDialog');
$('#changePwBtn').addEventListener('click', () => {
  setMenu(false);
  $('#pwForm').reset();
  $('#pwError').hidden = true;
  pwDlg.showModal();
});
$('#cancelPw').addEventListener('click', () => pwDlg.close());
$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#pwError');
  if (f.next.value !== f.confirm.value) {
    err.textContent = 'The new passwords don’t match.';
    err.hidden = false;
    return;
  }
  try {
    await api('/api/auth/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
    pwDlg.close();
    toast('Password updated. Other devices have been signed out.');
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

(async function boot() {
  try {
    const [, cats] = await Promise.all([refreshStatus(), api('/api/categories'), loadUser()]);
    state.categories = cats;
    state.month = state.status.today.slice(0, 7);
    $('#txCategory').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c.name)}</option>`).join('');
    $('.cat-select').innerHTML = catOptions('Groceries');
    // Returning from a bank's OAuth page during Plaid Link.
    if (new URLSearchParams(location.search).has('oauth_state_id')) {
      openPlaidLink(undefined, location.href).catch(fail);
      history.replaceState(null, '', location.pathname);
    }
    let tab = 'overview';
    try { tab = localStorage.getItem('tab') || tab; } catch {}
    showTab(render[tab] ? tab : 'overview');
  } catch (err) { fail(err); }
})();

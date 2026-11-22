'use strict';

// "Where is my money going?" — pure functions over transaction rows.
// Rows: { date, amount (negative = outflow), category (effective), name, merchant, pending }

const { kindOf } = require('./categories');
const { monthOf, addMonths, monthRange } = require('./dates');

const round2 = (n) => Math.round(n * 100) / 100;

function emptyMonth(month) {
  return { month, income: 0, spending: 0, essential: 0, discretionary: 0, byCategory: {} };
}

/** Aggregate transactions into per-month totals. Spending is a positive number. */
function monthlyTotals(txs) {
  const months = new Map();
  for (const t of txs) {
    const key = monthOf(t.date);
    if (!months.has(key)) months.set(key, emptyMonth(key));
    const m = months.get(key);
    const kind = kindOf(t.category);
    if (kind === 'transfer') continue;
    if (kind === 'income') {
      m.income += t.amount;
      continue;
    }
    const spent = -t.amount; // refunds (positive amounts) reduce spending
    m.spending += spent;
    m[kind] += spent;
    m.byCategory[t.category] = (m.byCategory[t.category] || 0) + spent;
  }
  for (const m of months.values()) {
    for (const k of ['income', 'spending', 'essential', 'discretionary']) m[k] = round2(m[k]);
    for (const c of Object.keys(m.byCategory)) m.byCategory[c] = round2(m.byCategory[c]);
  }
  return months;
}

/**
 * Typical month, averaged over the most recent complete months that have data
 * (up to `n`). Falls back to the current partial month if that's all there is.
 */
function baseline(txs, today, n = 3) {
  const totals = monthlyTotals(txs);
  const current = monthOf(today);
  const complete = [...totals.keys()].filter((k) => k < current).sort().slice(-n);
  const used = complete.length ? complete : totals.has(current) ? [current] : [];
  const out = { months: used, partial: !complete.length && used.length > 0, ...emptyMonth(null) };
  delete out.month;
  if (!used.length) return out;
  for (const key of used) {
    const m = totals.get(key);
    for (const k of ['income', 'spending', 'essential', 'discretionary']) out[k] += m[k];
    for (const [c, v] of Object.entries(m.byCategory)) out.byCategory[c] = (out.byCategory[c] || 0) + v;
  }
  for (const k of ['income', 'spending', 'essential', 'discretionary']) out[k] = round2(out[k] / used.length);
  for (const c of Object.keys(out.byCategory)) out.byCategory[c] = round2(out.byCategory[c] / used.length);
  out.surplus = round2(out.income - out.spending);
  return out;
}

/** Full picture for one month: categories vs budget vs typical, trend, top merchants. */
function monthSummary(txs, { month, today, budgets = {}, trendMonths = 6 }) {
  const totals = monthlyTotals(txs);
  const cur = totals.get(month) || emptyMonth(month);
  const typical = baseline(txs.filter((t) => monthOf(t.date) < month), `${month}-01`);

  const cats = new Set([...Object.keys(cur.byCategory), ...Object.keys(budgets), ...Object.keys(typical.byCategory)]);
  const categories = [...cats]
    .map((c) => ({
      category: c,
      kind: kindOf(c),
      spent: cur.byCategory[c] || 0,
      budget: budgets[c] ?? null,
      typical: typical.byCategory[c] || 0,
    }))
    .filter((c) => c.kind !== 'income' && c.kind !== 'transfer')
    .sort((a, b) => b.spent - a.spent || (b.budget || 0) - (a.budget || 0));

  const merchants = new Map();
  for (const t of txs) {
    if (monthOf(t.date) !== month || t.amount >= 0) continue;
    const kind = kindOf(t.category);
    if (kind === 'transfer' || kind === 'income') continue;
    const key = t.merchant || t.name;
    const m = merchants.get(key) || { merchant: key, category: t.category, total: 0, count: 0 };
    m.total = round2(m.total - t.amount);
    m.count += 1;
    merchants.set(key, m);
  }

  const trend = monthRange(addMonths(month, -(trendMonths - 1)), month).map((k) => {
    const m = totals.get(k) || emptyMonth(k);
    return { month: k, income: m.income, spending: m.spending, essential: m.essential, discretionary: m.discretionary };
  });

  const budgetTotal = Object.values(budgets).reduce((a, b) => a + b, 0);
  return {
    month,
    isCurrentMonth: month === monthOf(today),
    income: cur.income,
    spending: cur.spending,
    essential: cur.essential,
    discretionary: cur.discretionary,
    net: round2(cur.income - cur.spending),
    budgetTotal: round2(budgetTotal),
    categories,
    topMerchants: [...merchants.values()].sort((a, b) => b.total - a.total).slice(0, 8),
    trend,
    typical: { income: typical.income, spending: typical.spending, months: typical.months },
  };
}

module.exports = { monthlyTotals, baseline, monthSummary, round2 };

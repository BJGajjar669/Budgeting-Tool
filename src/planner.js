'use strict';

// "Where does my money need to go?" — turns a typical month + savings goals into a plan.
//
// 1. Each goal needs (target - saved) / months-left per month to land on time.
// 2. Your typical monthly surplus (income - spending) is assigned to goals in
//    priority order (then nearest deadline first).
// 3. If the surplus can't cover every goal, it suggests trims to discretionary
//    categories (never essentials), and tells you what's still missing and
//    when each goal would actually finish at the current pace.

const { kindOf } = require('./categories');
const { monthsBetween, addFractionalMonths } = require('./dates');

const round2 = (n) => Math.round(n * 100) / 100;
const MAX_CUT = 0.35; // never suggest trimming a category by more than 35%
const MIN_CATEGORY = 25; // ignore tiny categories when suggesting trims

function projectDate(today, remaining, perMonth) {
  if (remaining <= 0) return today;
  if (!(perMonth > 0)) return null;
  return addFractionalMonths(today, remaining / perMonth);
}

/**
 * @param {object} p
 * @param {{id,name,target_amount,current_amount,target_date,priority}[]} p.goals  current_amount already resolved
 * @param {{income,spending,essential,discretionary,byCategory,months}} p.baseline
 * @param {Record<string,number>} [p.budgets]
 * @param {string} p.today
 */
function buildPlan({ goals, baseline, budgets = {}, today }) {
  const surplus = round2(baseline.income - baseline.spending);
  let available = Math.max(0, surplus);

  const ordered = [...goals].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.target_date.localeCompare(b.target_date) || a.id - b.id,
  );

  const planned = ordered.map((g) => {
    const remaining = round2(Math.max(0, g.target_amount - g.current_amount));
    const rawMonths = monthsBetween(today, g.target_date);
    const overdue = rawMonths <= 0 && remaining > 0;
    const monthsLeft = Math.max(1, rawMonths);
    const required = remaining > 0 ? round2(remaining / monthsLeft) : 0;
    const allocated = round2(Math.min(required, available));
    available = round2(available - allocated);
    return {
      id: g.id,
      name: g.name,
      target: g.target_amount,
      saved: round2(g.current_amount),
      remaining,
      progress: g.target_amount > 0 ? Math.min(1, g.current_amount / g.target_amount) : 0,
      targetDate: g.target_date,
      monthsLeft: round2(Math.max(0, rawMonths)),
      requiredMonthly: required,
      allocated,
      complete: remaining <= 0,
      overdue,
      accountId: g.account_id ?? null,
      priority: g.priority ?? 0,
    };
  });

  const totalRequired = round2(planned.reduce((s, g) => s + g.requiredMonthly, 0));
  const shortfall = round2(Math.max(0, totalRequired - Math.max(0, surplus)));
  const unallocated = round2(available);

  // Spare money after funding everything speeds up the first unfinished goal.
  if (unallocated > 0) {
    const next = planned.find((g) => !g.complete);
    if (next) next.extra = unallocated;
  }
  for (const g of planned) {
    const pace = g.allocated + (g.extra || 0);
    g.projectedDate = g.complete ? today : projectDate(today, g.remaining, pace);
    g.status = g.complete
      ? 'complete'
      : g.allocated + 0.005 >= g.requiredMonthly
        ? 'on-track'
        : g.allocated > 0
          ? 'behind'
          : 'unfunded';
  }

  // Suggested trims to close the shortfall, biggest discretionary categories first.
  const trims = [];
  let remainingGap = shortfall;
  if (shortfall > 0) {
    const candidates = Object.entries(baseline.byCategory)
      .filter(([c, v]) => kindOf(c) === 'discretionary' && v >= MIN_CATEGORY)
      .sort((a, b) => b[1] - a[1]);
    const pool = candidates.reduce((s, [, v]) => s + v, 0);
    const fraction = pool > 0 ? Math.min(MAX_CUT, shortfall / pool) : 0;
    for (const [category, avg] of candidates) {
      const cut = Math.min(avg * MAX_CUT, Math.ceil((avg * fraction) / 5) * 5); // round to $5
      if (cut < 5) continue;
      trims.push({
        category,
        typical: round2(avg),
        suggested: round2(avg - cut),
        saves: round2(cut),
        budget: budgets[category] ?? null,
      });
    }
    remainingGap = round2(Math.max(0, shortfall - trims.reduce((s, t) => s + t.saves, 0)));
  }

  // Plain-language takeaways.
  const notes = [];
  if (!baseline.months?.length) {
    notes.push('No transaction history yet — connect an account or import a CSV so the plan can use your real numbers.');
  } else if (baseline.partial) {
    notes.push('Based on a partial month only; the plan gets more accurate after your first full month of data.');
  }
  if (surplus < 0) {
    notes.push(`You're spending about $${fmt(-surplus)} more than you earn in a typical month, so nothing is left for goals yet.`);
  }
  if (planned.length && shortfall === 0) {
    notes.push(
      unallocated > 0
        ? `Every goal is funded with $${fmt(unallocated)}/mo to spare — putting it toward "${planned.find((g) => !g.complete)?.name ?? 'savings'}" finishes it sooner.`
        : 'Every goal is funded, with nothing to spare. Any overspending will push a goal back.',
    );
  }
  if (shortfall > 0) {
    notes.push(`To hit every goal on time you need $${fmt(totalRequired)}/mo, but your typical surplus is $${fmt(Math.max(0, surplus))}/mo — a $${fmt(shortfall)}/mo gap.`);
    if (trims.length) {
      notes.push(
        remainingGap > 0
          ? `The trims below free up $${fmt(shortfall - remainingGap)}/mo; the remaining $${fmt(remainingGap)}/mo means pushing a target date back, lowering a target, or raising income.`
          : `The trims below close that gap without touching essentials.`,
      );
    }
  }
  for (const g of planned.filter((x) => x.overdue)) {
    notes.push(`"${g.name}" is past its target date — set a new date to get a realistic monthly amount.`);
  }

  return {
    today,
    baselineMonths: baseline.months || [],
    income: baseline.income,
    essential: baseline.essential,
    discretionary: baseline.discretionary,
    spending: baseline.spending,
    surplus,
    totalRequired,
    shortfall,
    unallocated,
    goals: planned,
    trims,
    remainingGap,
    notes,
  };
}

function fmt(n) {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Goals linked to an account draw their "saved" amount from its balance. When several
 * goals share one account, the balance fills them in priority order.
 */
function resolveGoalBalances(goals, accountsById) {
  const left = new Map();
  const sorted = [...goals].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.target_date.localeCompare(b.target_date) || a.id - b.id,
  );
  const out = new Map();
  for (const g of sorted) {
    const acct = g.account_id && accountsById.get(g.account_id);
    if (!acct) {
      out.set(g.id, { ...g });
      continue;
    }
    if (!left.has(acct.id)) left.set(acct.id, Math.max(0, acct.current_balance ?? 0));
    const take = Math.min(left.get(acct.id), g.target_amount);
    left.set(acct.id, left.get(acct.id) - take);
    out.set(g.id, { ...g, current_amount: round2(take) });
  }
  return goals.map((g) => out.get(g.id));
}

module.exports = { buildPlan, resolveGoalBalances };

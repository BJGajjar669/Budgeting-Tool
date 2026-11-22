'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { categorize } = require('../src/categories');
const { csvToTransactions, parseCsv, assignIds } = require('../src/csv');
const { baseline, monthSummary } = require('../src/analytics');
const { buildPlan, resolveGoalBalances } = require('../src/planner');
const { addMonths, monthsBetween, addFractionalMonths } = require('../src/dates');

test('categorize: keywords, Plaid categories and user rules', () => {
  assert.equal(categorize({ name: 'ACME PAYROLL DIRECT DEP', amount: 2000 }), 'Income');
  assert.equal(categorize({ name: 'Netflix.com', amount: -15 }), 'Subscriptions');
  assert.equal(categorize({ name: 'Uber Eats order', amount: -20 }), 'Dining Out');
  assert.equal(categorize({ name: 'Uber trip', amount: -20 }), 'Transportation');
  assert.equal(categorize({ name: 'Coffee House', amount: -5 }), 'Dining Out'); // not "fees"
  assert.equal(categorize({ name: 'Current Electric', amount: -60 }), 'Utilities'); // not "rent"
  assert.equal(categorize({ name: 'Mystery shop', amount: -5 }), 'Other');
  assert.equal(categorize({ name: 'Venmo from Sam', amount: 50 }), 'Income');
  // Plaid's category wins over generic guesses...
  assert.equal(categorize({ name: 'SQ *LOCAL', amount: -12, plaid: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' } }), 'Groceries');
  assert.equal(categorize({ name: 'CHASE CARD', amount: -500, plaid: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } }), 'Transfer');
  // ...but user rules beat everything.
  assert.equal(categorize({ name: 'Costco Wholesale', amount: -80 }, [{ pattern: 'costco', category: 'Shopping' }]), 'Shopping');
});

test('csv: quoted fields, US dates, single amount column', () => {
  const csv = 'Date,Description,Amount\n01/05/2026,"Trader Joe\'s, Inc",-54.20\n2026-01-06,"Pay ""day""",1500\n,missing date,3\n';
  const { transactions, skippedRows } = csvToTransactions(csv);
  assert.deepEqual(transactions, [
    { date: '2026-01-05', name: "Trader Joe's, Inc", amount: -54.2 },
    { date: '2026-01-06', name: 'Pay "day"', amount: 1500 },
  ]);
  assert.deepEqual(skippedRows, [4]);
});

test('csv: debit/credit columns and positive-is-spending cards', () => {
  const a = csvToTransactions('Posted Date,Payee,Debit,Credit\n2026-02-01,Rent,1200.00,\n2026-02-02,Refund,,"1,020.50"\n');
  assert.deepEqual(a.transactions.map((t) => t.amount), [-1200, 1020.5]);
  const b = csvToTransactions('Transaction Date,Description,Amount\n2026-02-01,Amazon,35.10\n2026-02-03,Payment,-500\n', { spendingIsPositive: true });
  assert.deepEqual(b.transactions.map((t) => t.amount), [-35.1, 500]);
  assert.throws(() => csvToTransactions('foo,bar\n1,2\n'), /date column/);
});

test('csv: ids are stable and keep identical same-day purchases distinct', () => {
  const rows = [
    { date: '2026-01-01', name: 'Coffee', amount: -4 },
    { date: '2026-01-01', name: 'Coffee', amount: -4 },
  ];
  const a = assignIds('acct', rows);
  const b = assignIds('acct', rows);
  assert.notEqual(a[0].id, a[1].id);
  assert.deepEqual(a.map((r) => r.id), b.map((r) => r.id));
  assert.equal(parseCsv('a,b\r\n1,2\r\n').length, 2);
});

const T = (date, amount, category, name = category) => ({ date, amount, category, name });

test('analytics: transfers excluded, refunds net out, baseline uses complete months', () => {
  const txs = [
    T('2026-08-01', 4000, 'Income'),
    T('2026-08-02', -1500, 'Housing'),
    T('2026-08-03', -300, 'Dining Out'),
    T('2026-08-04', -500, 'Transfer'),
    T('2026-09-01', 4000, 'Income'),
    T('2026-09-02', -1500, 'Housing'),
    T('2026-09-03', -500, 'Dining Out'),
    T('2026-09-10', 100, 'Dining Out'), // refund
    T('2026-10-01', 4000, 'Income'), // current (partial) month ignored by baseline
    T('2026-10-02', -9999, 'Shopping'),
  ];
  const b = baseline(txs, '2026-10-15');
  assert.deepEqual(b.months, ['2026-08', '2026-09']);
  assert.equal(b.income, 4000);
  assert.equal(b.essential, 1500);
  assert.equal(b.discretionary, 350);
  assert.equal(b.surplus, 2150);

  const s = monthSummary(txs, { month: '2026-09', today: '2026-10-15', budgets: { 'Dining Out': 300 } });
  assert.equal(s.spending, 1900);
  const dining = s.categories.find((c) => c.category === 'Dining Out');
  assert.deepEqual([dining.spent, dining.budget, dining.typical], [400, 300, 300]);
  assert.equal(s.trend.length, 6);
});

test('planner: funds goals in priority order and suggests discretionary trims', () => {
  const today = '2026-01-01';
  const plan = buildPlan({
    today,
    baseline: {
      months: ['2025-12'], income: 5000, spending: 4000, essential: 3000, discretionary: 1000,
      byCategory: { Housing: 2000, Groceries: 1000, 'Dining Out': 600, Shopping: 400 },
    },
    goals: [
      { id: 2, name: 'Trip', target_amount: 6000, current_amount: 0, target_date: '2027-01-01', priority: 1 },
      { id: 1, name: 'Emergency', target_amount: 10000, current_amount: 4000, target_date: '2027-01-01', priority: 0 },
    ],
  });
  assert.equal(plan.surplus, 1000);
  const [first, second] = plan.goals;
  assert.equal(first.name, 'Emergency');
  assert.equal(first.requiredMonthly, 500);
  assert.equal(first.status, 'on-track');
  assert.equal(second.requiredMonthly, 500);
  assert.equal(second.allocated, 500);
  assert.equal(plan.shortfall, 0);

  // Push the trip closer: now there's a gap, and only wants get trimmed.
  const tight = buildPlan({
    today,
    baseline: { months: ['2025-12'], income: 5000, spending: 4000, essential: 3000, discretionary: 1000, byCategory: { Housing: 2000, Groceries: 1000, 'Dining Out': 600, Shopping: 400 } },
    goals: [
      { id: 1, name: 'Emergency', target_amount: 10000, current_amount: 4000, target_date: '2027-01-01', priority: 0 },
      { id: 2, name: 'Trip', target_amount: 6000, current_amount: 0, target_date: addMonths('2026-01', 6) + '-01', priority: 1 },
    ],
  });
  assert.equal(tight.goals[1].status, 'behind');
  assert.ok(tight.shortfall > 0);
  assert.deepEqual(tight.trims.map((t) => t.category), ['Dining Out', 'Shopping']);
  for (const t of tight.trims) assert.ok(t.saves <= t.typical * 0.35 + 0.01);
  assert.ok(tight.notes.some((n) => n.includes('gap')));
  assert.ok(tight.goals[1].projectedDate > tight.goals[1].targetDate);
});

test('planner: overspending leaves goals unfunded; spare money goes to the next goal', () => {
  const over = buildPlan({
    today: '2026-01-01',
    baseline: { months: ['2025-12'], income: 3000, spending: 3200, essential: 3000, discretionary: 200, byCategory: { Housing: 3000, Shopping: 200 } },
    goals: [{ id: 1, name: 'Fund', target_amount: 1000, current_amount: 0, target_date: '2026-12-01', priority: 0 }],
  });
  assert.equal(over.goals[0].status, 'unfunded');
  assert.equal(over.goals[0].projectedDate, null);

  const spare = buildPlan({
    today: '2026-01-01',
    baseline: { months: ['2025-12'], income: 5000, spending: 3000, essential: 3000, discretionary: 0, byCategory: {} },
    goals: [{ id: 1, name: 'Fund', target_amount: 1200, current_amount: 0, target_date: '2027-01-01', priority: 0 }],
  });
  assert.equal(spare.goals[0].extra, spare.unallocated);
  assert.ok(spare.goals[0].projectedDate < '2026-02-01');
});

test('planner: goals sharing an account split its balance by priority', () => {
  const goals = resolveGoalBalances(
    [
      { id: 1, name: 'B', target_amount: 5000, target_date: '2027-01-01', priority: 1, account_id: 'sav' },
      { id: 2, name: 'A', target_amount: 3000, target_date: '2027-01-01', priority: 0, account_id: 'sav' },
      { id: 3, name: 'C', target_amount: 100, current_amount: 40, target_date: '2027-01-01', priority: 2 },
    ],
    new Map([['sav', { id: 'sav', current_balance: 4000 }]]),
  );
  assert.deepEqual(goals.map((g) => g.current_amount), [1000, 3000, 40]);
});

test('dates: calendar-aware month math round-trips', () => {
  assert.equal(monthsBetween('2026-01-01', '2027-01-01'), 12);
  assert.equal(monthsBetween('2026-01-31', '2026-02-28'), 1); // end of month -> end of month
  assert.equal(monthsBetween('2026-03-15', '2026-01-15'), -2);
  assert.equal(addFractionalMonths('2026-11-22', monthsBetween('2026-11-22', '2027-10-31')), '2027-10-31');
  assert.equal(addFractionalMonths('2026-01-31', 1), '2026-02-28');
});

test('startup hints explain why Plaid is not configured', () => {
  const { startupHints } = require('../src/server');
  const files = (...present) => (f) => present.some((p) => f.endsWith(p));
  const base = { plaid: null, dataDir: '/home/me/data', cwd: '/app', env: {} };
  assert.match(startupHints({ ...base, exists: files() })[0], /No \.env file in \/app/);
  assert.match(startupHints({ ...base, exists: files('.env.txt') })[0], /Rename it to "\.env"/);
  assert.match(startupHints({ ...base, exists: files('.env'), env: { PLAID_CLIENT_ID: 'x' } })[0], /PLAID_SECRET is empty/);
  assert.deepEqual(startupHints({ ...base, plaid: {}, exists: files('.env') }), []);
  const od = startupHints({ ...base, plaid: {}, dataDir: 'C:\\Users\\me\\OneDrive\\Documents\\Budgify\\data', exists: files('.env') });
  assert.match(od[0], /cloud-synced folder/);
});

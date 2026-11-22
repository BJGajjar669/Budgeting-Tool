'use strict';

// End-to-end through the HTTP API, with a fake Plaid client standing in for the bank.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

function fakePlaid() {
  const pages = {
    undefined: {
      added: [
        { transaction_id: 'p1', account_id: 'acc1', amount: 42.5, date: '2026-10-03', name: 'WHOLEFDS #123', merchant_name: 'Whole Foods', pending: false, personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' } },
        { transaction_id: 'p2', account_id: 'acc1', amount: -3000, date: '2026-10-01', name: 'EMPLOYER PAYROLL', merchant_name: null, pending: false, personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_WAGES' } },
      ],
      modified: [], removed: [], has_more: true, next_cursor: 'c1',
    },
    c1: {
      added: [{ transaction_id: 'p3', account_id: 'acc1', amount: 12, date: '2026-10-05', name: 'Spotify', merchant_name: 'Spotify', pending: false, personal_finance_category: { primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_MUSIC_AND_AUDIO' } }],
      modified: [], removed: [], has_more: false, next_cursor: 'c2',
    },
    c2: { added: [], modified: [{ transaction_id: 'p1', account_id: 'acc1', amount: 45, date: '2026-10-03', name: 'WHOLEFDS #123', merchant_name: 'Whole Foods', pending: false, personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' } }], removed: [{ transaction_id: 'p3' }], has_more: false, next_cursor: 'c3' },
  };
  const calls = [];
  return {
    calls,
    linkTokenCreate: async (req) => (calls.push(['link', req]), { data: { link_token: 'link-sandbox-123' } }),
    itemPublicTokenExchange: async () => ({ data: { item_id: 'item1', access_token: 'access-sandbox-secret' } }),
    accountsGet: async ({ access_token }) => {
      calls.push(['accounts', access_token]);
      return { data: { accounts: [{ account_id: 'acc1', name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '0000', balances: { current: 1234.56, available: 1200, iso_currency_code: 'USD' } }] } };
    },
    transactionsSync: async ({ cursor }) => ({ data: pages[cursor] }),
    itemRemove: async () => ({ data: {} }),
  };
}

async function setup({ env = 'sandbox' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
  const client = fakePlaid();
  const ctx = createApp({ dataDir: dir, today: '2026-11-10', plaidConfig: { client, env } });
  const server = ctx.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (method, p, body, type = 'application/json') => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': type }), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  const signup = await call('POST', '/api/auth/setup', { name: 'Test User', email: 'me@example.com', password: 'correct horse battery' });
  assert.equal(signup.status, 201);
  return { ...ctx, client, call, dir, close: () => server.close() };
}

test('bank connection: exchange, incremental sync, encrypted token', async (t) => {
  const s = await setup();
  t.after(s.close);

  const link = await s.call('POST', '/api/plaid/link-token', {});
  assert.equal(link.body.link_token, 'link-sandbox-123');
  assert.deepEqual(s.client.calls[0][1].products, ['transactions']);

  const ex = await s.call('POST', '/api/plaid/exchange', { public_token: 'public-x', institution: { institution_id: 'ins_1', name: 'Test Bank' } });
  assert.equal(ex.body.itemId, 'item1');

  // Token at rest is encrypted, but decrypts to the right value for API calls.
  const row = s.db.prepare('SELECT access_token_enc, cursor FROM items').get();
  assert.ok(!row.access_token_enc.includes('access-sandbox-secret'));
  assert.equal(s.client.calls.find((c) => c[0] === 'accounts')[1], 'access-sandbox-secret');
  assert.equal(row.cursor, 'c2');

  let txs = (await s.call('GET', '/api/transactions?month=2026-10')).body;
  const byId = Object.fromEntries(txs.map((x) => [x.id, x]));
  assert.equal(byId.p1.amount, -42.5); // sign flipped: spending is negative
  assert.equal(byId.p1.effective_category, 'Groceries');
  assert.equal(byId.p2.effective_category, 'Income');
  assert.equal(byId.p3.effective_category, 'Subscriptions');

  // Next sync applies modifications and removals.
  const sync = await s.call('POST', '/api/sync');
  assert.equal(sync.body.results[0].modified, 1);
  txs = (await s.call('GET', '/api/transactions?month=2026-10')).body;
  assert.deepEqual(txs.map((x) => x.id).sort(), ['p1', 'p2']);
  assert.equal(txs.find((x) => x.id === 'p1').amount, -45);

  const accts = (await s.call('GET', '/api/accounts')).body;
  assert.equal(accts.netWorth, 1234.56);
  const conns = (await s.call('GET', '/api/connections')).body;
  assert.equal(conns[0].institution_name, 'Test Bank');
  assert.ok(!('access_token_enc' in conns[0]));

  await s.call('DELETE', '/api/connections/item1');
  assert.equal((await s.call('GET', '/api/accounts')).body.accounts.length, 0);
});

test('CSV import, manual recategorization with rules, budgets, goals and plan', async (t) => {
  const s = await setup();
  t.after(s.close);
  const csv = [
    'Date,Description,Amount',
    '2026-10-01,PAYROLL ACME,4000',
    '2026-10-02,Maple Rent,-1500',
    '2026-10-05,Costco Wholesale,-200',
    '2026-10-12,Costco Wholesale,-150',
    '2026-10-20,Chipotle,-60',
  ].join('\n');
  const imp = await s.call('POST', '/api/import/csv?account=My%20Checking', csv, 'text/csv');
  assert.equal(imp.status, 200);
  assert.equal(imp.body.added, 5);
  const again = await s.call('POST', '/api/import/csv?account=My%20Checking', csv, 'text/csv');
  assert.equal(again.body.added, 0, 're-import must not duplicate');

  const bad = await s.call('POST', '/api/import/csv?account=x', 'nope\n1', 'text/csv');
  assert.equal(bad.status, 400);

  let txs = (await s.call('GET', '/api/transactions?q=costco')).body;
  assert.equal(txs[0].effective_category, 'Groceries');
  const patch = await s.call('PATCH', `/api/transactions/${txs[0].id}`, { category: 'Shopping', applyToSimilar: true });
  assert.equal(patch.status, 200);
  txs = (await s.call('GET', '/api/transactions?q=costco')).body;
  assert.ok(txs.every((x) => x.effective_category === 'Shopping'));
  assert.equal((await s.call('GET', '/api/rules')).body.length, 1);

  assert.equal((await s.call('PUT', '/api/budgets', { Shopping: 300, Nope: 1 })).status, 400);
  await s.call('PUT', '/api/budgets', { Shopping: 300 });

  const sum = (await s.call('GET', '/api/summary?month=2026-10')).body;
  assert.equal(sum.income, 4000);
  assert.equal(sum.spending, 1910);
  assert.equal(sum.categories.find((c) => c.category === 'Shopping').budget, 300);

  assert.equal((await s.call('POST', '/api/goals', { name: '', target_amount: 5, target_date: '2027-01-01' })).status, 400);
  const g = await s.call('POST', '/api/goals', { name: 'Vacation', target_amount: 2000, current_amount: 200, target_date: '2027-11-10' });
  assert.equal(g.status, 201);

  const plan = (await s.call('GET', '/api/plan')).body;
  assert.deepEqual(plan.baselineMonths, ['2026-10']);
  assert.equal(plan.surplus, 2090);
  assert.equal(plan.goals[0].status, 'on-track');
  assert.ok(Math.abs(plan.goals[0].requiredMonthly - 150) < 1);
});

test('demo data loads, plans, and clears', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.call('POST', '/api/demo');
  const st = (await s.call('GET', '/api/status')).body;
  assert.ok(st.demoLoaded && st.transactions > 200 && st.goals === 3);
  const plan = (await s.call('GET', '/api/plan')).body;
  assert.equal(plan.goals.length, 3);
  assert.ok(plan.income > 5000);
  const other = (await s.call('GET', '/api/transactions?category=Other')).body;
  assert.equal(other.length, 0, `uncategorized demo rows: ${other.map((x) => x.name)}`);
  await s.call('DELETE', '/api/demo');
  const after = (await s.call('GET', '/api/status')).body;
  assert.deepEqual([after.accounts, after.transactions, after.goals], [0, 0, 0]);
});

test("Plaid free Trial plan: connections are counted for good and capped", async (t) => {
  process.env.PLAID_ITEM_LIMIT = '1';
  const s = await setup({ env: 'production' });
  t.after(() => { delete process.env.PLAID_ITEM_LIMIT; s.close(); });

  let st = (await s.call('GET', '/api/status')).body;
  assert.deepEqual([st.plaidItemLimit, st.plaidItemsUsed], [1, 0]);
  assert.equal((await s.call('POST', '/api/plaid/link-token', {})).status, 200);
  await s.call('POST', '/api/plaid/exchange', { public_token: 'public-x', institution: { institution_id: 'ins_113805', name: "Georgia's Own Credit Union" } });
  assert.equal((await s.call('GET', '/api/status')).body.plaidItemsUsed, 1);

  // Limit reached: no new connections, but repairing the existing one still works.
  const blocked = await s.call('POST', '/api/plaid/link-token', {});
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Reconnect/);
  assert.equal((await s.call('POST', '/api/plaid/link-token', { itemId: 'item1' })).status, 200);

  // Disconnecting doesn't give the slot back (Plaid doesn't either).
  await s.call('DELETE', '/api/connections/item1');
  st = (await s.call('GET', '/api/status')).body;
  assert.equal(st.plaidItemsUsed, 1);
  assert.equal((await s.call('POST', '/api/plaid/link-token', {})).status, 409);
});

test('sandbox connections are not counted against the free plan', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.call('POST', '/api/plaid/exchange', { public_token: 'public-x' });
  const st = (await s.call('GET', '/api/status')).body;
  assert.equal(st.plaidItemLimit, 0);
  assert.equal((await s.call('POST', '/api/plaid/link-token', {})).status, 200);
});

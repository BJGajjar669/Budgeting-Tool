'use strict';

require('dotenv').config({ quiet: true });

const path = require('node:path');
const express = require('express');
const { openDb } = require('./db');
const { createStore } = require('./store');
const { loadKey, makeCipher } = require('./crypto');
const { createPlaid, describePlaidError } = require('./plaid');
const { CATEGORIES, isCategory } = require('./categories');
const { monthSummary, baseline } = require('./analytics');
const { buildPlan, resolveGoalBalances } = require('./planner');
const { csvToTransactions, assignIds } = require('./csv');
const { loadDemo } = require('./demo');
const { createAuth } = require('./auth');
const { todayStr, monthOf } = require('./dates');

function createApp({ dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data'), dbFile, plaidConfig, today } = {}) {
  const db = openDb(dbFile || path.join(dataDir, 'budget.db'));
  const store = createStore(db);
  const cipher = makeCipher(loadKey(dataDir));
  const now = () => today || todayStr();

  const plaid = createPlaid({
    clientId: process.env.PLAID_CLIENT_ID,
    secret: process.env.PLAID_SECRET,
    env: process.env.PLAID_ENV || 'sandbox',
    countryCodes: (process.env.PLAID_COUNTRY_CODES || 'US').split(',').map((s) => s.trim().toUpperCase()),
    redirectUri: process.env.PLAID_REDIRECT_URI || undefined,
    ...plaidConfig,
    store,
    cipher,
  });

  const app = express();
  const auth = createAuth(db, { secureCookies: process.env.COOKIE_SECURE === 'true', trustProxy: !!process.env.TRUST_PROXY });
  const publicDir = path.join(__dirname, '..', 'public');

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' https://cdn.plaid.com", // Plaid Link
        "frame-src https://cdn.plaid.com",
        "connect-src 'self' https://*.plaid.com",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ type: 'text/csv', limit: '10mb' }));
  app.use(auth.sameOrigin);

  // Pages: the dashboard needs a session; the sign-in page is for signed-out visitors.
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  app.get(['/', '/index.html'], (req, res) => {
    if (!auth.currentUser(req)) return res.redirect(302, '/login');
    noStore(res).sendFile(path.join(publicDir, 'index.html'));
  });
  app.get(['/login', '/login.html'], (req, res) => {
    if (auth.currentUser(req)) return res.redirect(302, '/');
    noStore(res).sendFile(path.join(publicDir, 'login.html'));
  });
  app.use(express.static(publicDir, { index: false }));

  // Sign-in endpoints are open; everything else under /api needs a session.
  auth.routes(app);
  app.use('/api', auth.requireUser);

  const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const isMonth = (s) => typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);
  const requirePlaid = (res) => (plaid ? true : (bad(res, 'Bank connections are not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to .env and restart.', 503), false));

  // ---- status --------------------------------------------------------------
  // Plaid's free Trial plan allows 10 Production connections in total (disconnecting doesn't
  // return a slot). PLAID_ITEM_LIMIT=0 turns the guard off, e.g. on a paid plan.
  const itemLimit = () => (plaid?.env === 'production' ? Number(process.env.PLAID_ITEM_LIMIT ?? 10) || 0 : 0);

  app.get('/api/status', (_req, res) => {
    res.json({
      today: now(),
      plaidConfigured: !!plaid,
      plaidEnv: plaid?.env ?? null,
      plaidItemLimit: itemLimit(),
      plaidItemsUsed: plaid ? store.plaidItemsUsed(plaid.env) : 0,
      demoLoaded: store.hasDemo(),
      ...store.counts(),
    });
  });

  app.get('/api/categories', (_req, res) => res.json(CATEGORIES));

  // ---- bank connections (Plaid) -------------------------------------------
  app.post('/api/plaid/link-token', async (req, res) => {
    if (!requirePlaid(res)) return;
    const itemId = req.body?.itemId;
    const limit = itemLimit();
    if (!itemId && limit && store.plaidItemsUsed(plaid.env) >= limit) {
      return bad(res, `You've used all ${limit} bank connections on Plaid's free plan. Use "Reconnect" to repair an existing one, or upgrade your Plaid plan (then set PLAID_ITEM_LIMIT to match).`, 409);
    }
    res.json({ link_token: await plaid.createLinkToken({ itemId }) });
  });

  app.post('/api/plaid/exchange', async (req, res) => {
    if (!requirePlaid(res)) return;
    const { public_token, institution } = req.body || {};
    if (!public_token) return bad(res, 'public_token is required');
    const itemId = await plaid.exchange(public_token, institution);
    res.json({ itemId });
  });

  app.post('/api/plaid/sandbox-connect', async (_req, res) => {
    if (!requirePlaid(res)) return;
    if (plaid.env !== 'sandbox') return bad(res, 'Only available when PLAID_ENV=sandbox');
    res.json({ itemId: await plaid.sandboxConnect() });
  });

  app.post('/api/sync', async (_req, res) => {
    if (!plaid) return res.json({ results: [] });
    res.json({ results: await plaid.syncAll() });
  });

  app.get('/api/connections', (_req, res) => {
    res.json(store.items().map(({ access_token_enc, cursor, ...i }) => i));
  });

  app.delete('/api/connections/:id', async (req, res) => {
    if (!requirePlaid(res)) return;
    await plaid.removeItem(req.params.id);
    res.json({ ok: true });
  });

  // ---- accounts ------------------------------------------------------------
  app.get('/api/accounts', (_req, res) => {
    const accounts = store.accounts();
    let assets = 0;
    let debts = 0;
    for (const a of accounts) {
      const bal = a.current_balance ?? 0;
      if (a.type === 'credit' || a.type === 'loan') debts += bal;
      else assets += bal;
    }
    res.json({ accounts, assets, debts, netWorth: assets - debts });
  });

  app.patch('/api/accounts/:id', (req, res) => {
    const acct = store.account(req.params.id);
    if (!acct) return bad(res, 'Account not found', 404);
    if (acct.source === 'plaid') return bad(res, 'Balances for connected accounts come from your bank');
    const balance = num(req.body?.current_balance);
    if (balance == null || Number.isNaN(balance)) return bad(res, 'current_balance must be a number');
    store.setAccountBalance(acct.id, balance);
    res.json(store.account(acct.id));
  });

  app.delete('/api/accounts/:id', (req, res) => {
    const acct = store.account(req.params.id);
    if (!acct) return bad(res, 'Account not found', 404);
    if (acct.source === 'plaid') return bad(res, 'Disconnect the bank connection instead');
    store.deleteAccount(acct.id);
    res.json({ ok: true });
  });

  // ---- CSV import ----------------------------------------------------------
  app.post('/api/import/csv', (req, res) => {
    const text = typeof req.body === 'string' ? req.body : req.body?.csv;
    const accountName = String(req.query.account || req.body?.account || '').trim();
    const accountType = req.query.type === 'credit' ? 'credit' : 'depository';
    if (!text) return bad(res, 'Send the CSV file contents');
    if (!accountName) return bad(res, 'Give the account a name');
    let parsed;
    try {
      parsed = csvToTransactions(text, { spendingIsPositive: req.query.spendingIsPositive === 'true' });
    } catch (err) {
      return bad(res, err.message);
    }
    const { transactions, skippedRows } = parsed;
    if (!transactions.length) return bad(res, 'No transactions could be read from that file.');
    const id = 'csv_' + accountName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (!store.account(id)) {
      store.upsertAccount({ id, source: 'csv', name: accountName, institution_name: 'Imported CSV', type: accountType });
    }
    const rows = assignIds(id, transactions).map((t) => ({ ...t, account_id: id, source: 'csv' }));
    const before = store.counts().transactions;
    store.upsertTransactions(rows);
    res.json({ accountId: id, rows: rows.length, added: store.counts().transactions - before, skippedRows });
  });

  // ---- transactions & categories ------------------------------------------
  app.get('/api/transactions', (req, res) => {
    const { month, category, q, account, limit } = req.query;
    res.json(store.listTransactions({ month, category, search: q, accountId: account, limit }));
  });

  app.patch('/api/transactions/:id', (req, res) => {
    const t = store.transaction(req.params.id);
    if (!t) return bad(res, 'Transaction not found', 404);
    const { category, applyToSimilar } = req.body || {};
    if (!isCategory(category)) return bad(res, 'Unknown category');
    store.setUserCategory(t.id, category);
    let recategorized = 0;
    if (applyToSimilar) {
      const pattern = (t.merchant || t.name).trim();
      store.addRule(pattern, category);
      recategorized = store.recategorizeAll();
    }
    res.json({ ok: true, recategorized });
  });

  app.get('/api/rules', (_req, res) => res.json(store.rules()));
  app.post('/api/rules', (req, res) => {
    const { pattern, category } = req.body || {};
    if (!pattern || String(pattern).trim().length < 2) return bad(res, 'Pattern must be at least 2 characters');
    if (!isCategory(category)) return bad(res, 'Unknown category');
    store.addRule(String(pattern).trim(), category);
    res.json({ ok: true, recategorized: store.recategorizeAll() });
  });
  app.delete('/api/rules/:id', (req, res) => {
    store.deleteRule(Number(req.params.id));
    res.json({ ok: true, recategorized: store.recategorizeAll() });
  });

  // ---- where the money is going -------------------------------------------
  app.get('/api/summary', (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : monthOf(now());
    res.json(monthSummary(store.allTransactions(), { month, today: now(), budgets: store.budgets() }));
  });

  // ---- budgets -------------------------------------------------------------
  app.get('/api/budgets', (_req, res) => res.json(store.budgets()));
  app.put('/api/budgets', (req, res) => {
    const body = req.body || {};
    for (const [cat, limit] of Object.entries(body)) {
      if (!isCategory(cat)) return bad(res, `Unknown category: ${cat}`);
      const n = num(limit);
      if (n != null && (Number.isNaN(n) || n < 0)) return bad(res, `Invalid amount for ${cat}`);
    }
    for (const [cat, limit] of Object.entries(body)) store.setBudget(cat, num(limit));
    res.json(store.budgets());
  });

  // ---- goals & plan --------------------------------------------------------
  function validateGoal(body) {
    const g = {
      name: String(body.name || '').trim(),
      target_amount: num(body.target_amount),
      current_amount: num(body.current_amount) ?? 0,
      target_date: body.target_date,
      account_id: body.account_id || null,
      priority: num(body.priority) ?? 0,
    };
    if (!g.name) return [null, 'Give the goal a name'];
    if (!(g.target_amount > 0)) return [null, 'Target amount must be more than 0'];
    if (Number.isNaN(g.current_amount) || g.current_amount < 0) return [null, 'Saved so far must be 0 or more'];
    if (!isDate(g.target_date)) return [null, 'Target date must be YYYY-MM-DD'];
    if (g.account_id && !store.account(g.account_id)) return [null, 'Linked account not found'];
    return [g, null];
  }

  app.get('/api/goals', (_req, res) => res.json(store.goals()));
  app.post('/api/goals', (req, res) => {
    const [g, err] = validateGoal(req.body || {});
    if (err) return bad(res, err);
    res.status(201).json(store.goal(store.addGoal(g)));
  });
  app.put('/api/goals/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!store.goal(id)) return bad(res, 'Goal not found', 404);
    const [g, err] = validateGoal(req.body || {});
    if (err) return bad(res, err);
    store.updateGoal(id, g);
    res.json(store.goal(id));
  });
  app.delete('/api/goals/:id', (req, res) => {
    store.deleteGoal(Number(req.params.id));
    res.json({ ok: true });
  });

  app.get('/api/plan', (_req, res) => {
    const today = now();
    const accountsById = new Map(store.accounts().map((a) => [a.id, a]));
    const goals = resolveGoalBalances(store.goals(), accountsById);
    const base = baseline(store.allTransactions(), today);
    res.json(buildPlan({ goals, baseline: base, budgets: store.budgets(), today }));
  });

  // ---- demo data -----------------------------------------------------------
  app.post('/api/demo', (_req, res) => {
    loadDemo(store, now());
    res.json({ ok: true });
  });
  app.delete('/api/demo', (_req, res) => {
    store.clearDemo();
    res.json({ ok: true });
  });

  // ---- errors --------------------------------------------------------------
  app.use('/api', (_req, res) => bad(res, 'Not found', 404));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const msg = err?.response?.data ? describePlaidError(err) : err.message || 'Something went wrong';
    if (!err?.response?.data && !err.status) console.error(err);
    res.status(err.status || 500).json({ error: msg });
  });

  return { app, store, plaid, db, auth, dataDir };
}

/** Plain-language pointers printed at startup when something needs the user's attention. */
function startupHints({ plaid, dataDir, cwd = process.cwd(), env = process.env, exists = require('node:fs').existsSync }) {
  const hints = [];
  const envFile = path.join(cwd, '.env');
  if (!plaid) {
    if (!exists(envFile) && exists(`${envFile}.txt`)) {
      hints.push(`Found ".env.txt" in ${cwd}. Rename it to ".env" (Windows added .txt), then restart.`);
    } else if (!exists(envFile)) {
      hints.push(`No .env file in ${cwd}. Create one from .env.example and add your Plaid keys (see README: "Connecting your bank accounts").`);
    } else {
      const missing = ['PLAID_CLIENT_ID', 'PLAID_SECRET'].filter((k) => !env[k]);
      hints.push(`.env found, but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} empty. Fill ${missing.length > 1 ? 'them' : 'it'} in, save, and restart.`);
    }
  }
  if (/onedrive|dropbox|google drive|icloud/i.test(dataDir)) {
    hints.push(`Your data folder (${dataDir}) is inside a cloud-synced folder, so your financial data is uploaded there and the database can be damaged by syncing. Set DATA_DIR in .env to a folder outside it.`);
  }
  return hints;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const { app, plaid, dataDir } = createApp();
  app.listen(port, host, () => {
    console.log(`Budgify running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(plaid ? `Plaid: ${plaid.env} environment` : 'Plaid: not configured (demo data and CSV import still work)');
    for (const hint of startupHints({ plaid, dataDir })) console.log(`  -> ${hint}`);
  });

  // Keep bank data fresh while the app is running.
  if (plaid) {
    const hours = Number(process.env.SYNC_INTERVAL_HOURS ?? 6);
    const run = () => plaid.syncAll().then(
      (r) => r.length && console.log(`Synced ${r.length} connection(s)`),
      (e) => console.error('Sync failed:', e.message),
    );
    run();
    if (hours > 0) setInterval(run, hours * 3600 * 1000).unref();
  }
}

module.exports = { createApp, startupHints };

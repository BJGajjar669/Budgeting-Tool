'use strict';

// Data-access layer over SQLite.

const { tx } = require('./db');
const { categorize } = require('./categories');

function createStore(db) {
  const q = (sql) => db.prepare(sql);

  const store = {
    db,

    // ---- rules -------------------------------------------------------------
    rules: () => q('SELECT * FROM rules ORDER BY length(pattern) DESC').all(),
    addRule(pattern, category) {
      q(`INSERT INTO rules (pattern, category) VALUES (?, ?)
         ON CONFLICT(pattern) DO UPDATE SET category = excluded.category`).run(pattern, category);
    },
    deleteRule: (id) => q('DELETE FROM rules WHERE id = ?').run(id),

    // ---- items / accounts --------------------------------------------------
    items: () => q('SELECT * FROM items ORDER BY created_at').all(),
    item: (id) => q('SELECT * FROM items WHERE id = ?').get(id),
    upsertItem(i) {
      q(`INSERT INTO items (id, access_token_enc, institution_id, institution_name)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET access_token_enc = excluded.access_token_enc,
           institution_name = COALESCE(excluded.institution_name, items.institution_name)`).run(
        i.id, i.access_token_enc, i.institution_id ?? null, i.institution_name ?? null,
      );
    },
    updateItemSync(id, { cursor, error }) {
      q(`UPDATE items SET cursor = COALESCE(?, cursor), error = ?, last_synced_at = datetime('now') WHERE id = ?`)
        .run(cursor ?? null, error ?? null, id);
    },
    deleteItem: (id) => q('DELETE FROM items WHERE id = ?').run(id),

    accounts: () => q('SELECT * FROM accounts ORDER BY source, institution_name, name').all(),
    account: (id) => q('SELECT * FROM accounts WHERE id = ?').get(id),
    upsertAccount(a) {
      q(`INSERT INTO accounts (id, item_id, source, institution_name, name, official_name, type, subtype, mask,
           current_balance, available_balance, currency, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, official_name = excluded.official_name,
           type = excluded.type, subtype = excluded.subtype, mask = excluded.mask,
           current_balance = COALESCE(excluded.current_balance, accounts.current_balance),
           available_balance = COALESCE(excluded.available_balance, accounts.available_balance),
           currency = excluded.currency, updated_at = datetime('now')`).run(
        a.id, a.item_id ?? null, a.source, a.institution_name ?? null, a.name, a.official_name ?? null,
        a.type ?? 'depository', a.subtype ?? null, a.mask ?? null, a.current_balance ?? null,
        a.available_balance ?? null, a.currency ?? 'USD',
      );
    },
    setAccountBalance(id, balance) {
      return q(`UPDATE accounts SET current_balance = ?, updated_at = datetime('now') WHERE id = ?`).run(balance, id);
    },
    deleteAccount: (id) => q('DELETE FROM accounts WHERE id = ?').run(id),

    // ---- transactions ------------------------------------------------------
    /** Insert or update; keeps any manual category the user set. */
    upsertTransactions(rows) {
      const rules = store.rules();
      const stmt = q(`INSERT INTO transactions (id, account_id, source, date, name, merchant, amount, category,
          provider_category, pending)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET date = excluded.date, name = excluded.name, merchant = excluded.merchant,
          amount = excluded.amount, category = excluded.category, provider_category = excluded.provider_category,
          pending = excluded.pending`);
      let added = 0;
      tx(db, () => {
        for (const r of rows) {
          const category = categorize(r, rules);
          const res = stmt.run(
            r.id, r.account_id, r.source, r.date, r.name, r.merchant ?? null, r.amount, category,
            r.plaid ? `${r.plaid.primary || ''}/${r.plaid.detailed || ''}` : null, r.pending ? 1 : 0,
          );
          added += res.changes;
        }
      });
      return added;
    },
    deleteTransactions(ids) {
      const stmt = q('DELETE FROM transactions WHERE id = ?');
      tx(db, () => ids.forEach((id) => stmt.run(id)));
    },

    /** All transactions with the effective category, for analytics. */
    allTransactions() {
      return q(`SELECT t.id, t.date, t.amount, t.name, t.merchant, t.pending,
                  COALESCE(t.user_category, t.category) AS category
                FROM transactions t ORDER BY t.date`).all();
    },

    listTransactions({ month, category, search, accountId, limit = 500 } = {}) {
      const where = [];
      const args = [];
      if (month) { where.push('t.date LIKE ?'); args.push(`${month}-%`); }
      if (category) { where.push('COALESCE(t.user_category, t.category) = ?'); args.push(category); }
      if (accountId) { where.push('t.account_id = ?'); args.push(accountId); }
      if (search) {
        where.push('(t.name LIKE ? OR t.merchant LIKE ?)');
        args.push(`%${search}%`, `%${search}%`);
      }
      args.push(Math.min(Number(limit) || 500, 5000));
      return q(`SELECT t.*, COALESCE(t.user_category, t.category) AS effective_category,
                  a.name AS account_name, a.mask AS account_mask
                FROM transactions t JOIN accounts a ON a.id = t.account_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY t.date DESC, t.rowid DESC LIMIT ?`).all(...args);
    },

    transaction: (id) => q('SELECT * FROM transactions WHERE id = ?').get(id),

    setUserCategory(id, category) {
      q('UPDATE transactions SET user_category = ? WHERE id = ?').run(category, id);
    },

    /** Re-run auto-categorization (after rules change). Manual overrides are untouched. */
    recategorizeAll() {
      const rules = store.rules();
      const rows = q('SELECT id, name, merchant, amount, provider_category FROM transactions').all();
      const stmt = q('UPDATE transactions SET category = ? WHERE id = ?');
      let changed = 0;
      tx(db, () => {
        for (const r of rows) {
          const [primary, detailed] = (r.provider_category || '').split('/');
          const plaid = r.provider_category ? { primary, detailed } : undefined;
          changed += stmt.run(categorize({ ...r, plaid }, rules), r.id).changes;
        }
      });
      return changed;
    },

    // ---- budgets -----------------------------------------------------------
    budgets() {
      return Object.fromEntries(q('SELECT category, monthly_limit FROM budgets').all().map((b) => [b.category, b.monthly_limit]));
    },
    setBudget(category, limit) {
      if (limit == null || limit <= 0) return q('DELETE FROM budgets WHERE category = ?').run(category);
      q(`INSERT INTO budgets (category, monthly_limit) VALUES (?, ?)
         ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit`).run(category, limit);
    },

    // ---- goals -------------------------------------------------------------
    goals: () => q('SELECT * FROM goals ORDER BY priority, target_date, id').all(),
    goal: (id) => q('SELECT * FROM goals WHERE id = ?').get(id),
    addGoal(g) {
      const r = q(`INSERT INTO goals (name, target_amount, current_amount, target_date, account_id, priority, demo)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        g.name, g.target_amount, g.current_amount ?? 0, g.target_date, g.account_id ?? null, g.priority ?? 0, g.demo ? 1 : 0,
      );
      return Number(r.lastInsertRowid);
    },
    updateGoal(id, g) {
      q(`UPDATE goals SET name = ?, target_amount = ?, current_amount = ?, target_date = ?, account_id = ?, priority = ?
         WHERE id = ?`).run(g.name, g.target_amount, g.current_amount ?? 0, g.target_date, g.account_id ?? null, g.priority ?? 0, id);
    },
    deleteGoal: (id) => q('DELETE FROM goals WHERE id = ?').run(id),

    // ---- demo --------------------------------------------------------------
    hasDemo: () => !!q(`SELECT 1 FROM accounts WHERE source = 'demo' LIMIT 1`).get(),
    clearDemo() {
      tx(db, () => {
        db.exec(`DELETE FROM goals WHERE demo = 1`);
        db.exec(`DELETE FROM accounts WHERE source = 'demo'`); // cascades to transactions
      });
    },
    counts() {
      return q(`SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
                       (SELECT COUNT(*) FROM transactions) AS transactions,
                       (SELECT COUNT(*) FROM goals) AS goals`).get();
    },
  };
  return store;
}

module.exports = { createStore };

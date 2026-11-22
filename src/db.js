'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id               TEXT PRIMARY KEY,           -- Plaid item_id
  access_token_enc TEXT NOT NULL,              -- AES-256-GCM encrypted access token
  institution_id   TEXT,
  institution_name TEXT,
  cursor           TEXT,                       -- /transactions/sync cursor
  last_synced_at   TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id                TEXT PRIMARY KEY,
  item_id           TEXT REFERENCES items(id) ON DELETE CASCADE,
  source            TEXT NOT NULL,             -- 'plaid' | 'csv' | 'demo'
  institution_name  TEXT,
  name              TEXT NOT NULL,
  official_name     TEXT,
  type              TEXT,                      -- depository | credit | loan | investment | other
  subtype           TEXT,
  mask              TEXT,
  current_balance   REAL,
  available_balance REAL,
  currency          TEXT DEFAULT 'USD',
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- amount convention: NEGATIVE = money leaving you (spending), POSITIVE = money coming in.
CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,
  date            TEXT NOT NULL,               -- YYYY-MM-DD
  name            TEXT NOT NULL,
  merchant        TEXT,
  amount          REAL NOT NULL,
  category        TEXT NOT NULL,               -- auto-assigned category
  user_category   TEXT,                        -- manual override (wins over category)
  provider_category TEXT,                      -- raw category from the bank feed
  pending         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);

CREATE TABLE IF NOT EXISTS rules (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern   TEXT NOT NULL UNIQUE,              -- case-insensitive substring of name/merchant
  category  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budgets (
  category      TEXT PRIMARY KEY,
  monthly_limit REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  target_amount  REAL NOT NULL,
  current_amount REAL NOT NULL DEFAULT 0,      -- used when no account is linked
  target_date    TEXT NOT NULL,                -- YYYY-MM-DD
  account_id     TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  priority       INTEGER NOT NULL DEFAULT 0,   -- lower = funded first
  demo           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; rolls back on throw. */
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, tx };

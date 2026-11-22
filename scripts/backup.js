'use strict';

// Snapshot the Budgify database (safe while the app is running) and keep the last N days.
//   npm run backup                 -> DATA_DIR/backups/budget-YYYY-MM-DD.db
//   BACKUP_KEEP=30 npm run backup  -> keep 30 snapshots (default 14)
//
// The encryption key for your bank connections (DATA_DIR/.secret_key) is copied alongside,
// because a restored database is useless without it. Keep backups somewhere private.

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { todayStr } = require('../src/dates');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'budget.db');
const dir = path.join(dataDir, 'backups');
const keep = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);

if (!fs.existsSync(dbFile)) {
  console.log(`Nothing to back up yet (${dbFile} doesn't exist).`);
  process.exit(0);
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const target = path.join(dir, `budget-${todayStr()}.db`);
fs.rmSync(target, { force: true }); // VACUUM INTO refuses to overwrite
const db = new DatabaseSync(dbFile);
db.prepare('VACUUM INTO ?').run(target); // consistent copy, even mid-write
db.close();
fs.chmodSync(target, 0o600);

const key = path.join(dataDir, '.secret_key');
if (fs.existsSync(key)) fs.copyFileSync(key, path.join(dir, '.secret_key'));

const snapshots = fs.readdirSync(dir).filter((f) => /^budget-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
for (const old of snapshots.slice(0, -keep)) fs.rmSync(path.join(dir, old));

console.log(`Backed up to ${target} (keeping ${Math.min(keep, snapshots.length)} of the latest snapshots).`);

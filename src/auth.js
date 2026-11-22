'use strict';

// Sign-in for Budgify. One account per install (the data in this app isn't split per user).
//
// - Passwords: scrypt with a random salt, compared in constant time.
// - Sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie; only its SHA-256
//   is stored, so a copied database can't be used to log in.
// - Brute force: 5 failed attempts per IP (or 20 overall) in 15 minutes locks sign-in for 15 minutes.
// - CSRF: SameSite=Strict cookies plus an Origin check on every state-changing request.

const crypto = require('node:crypto');

const COOKIE = 'budgify_session';
const SHORT_SESSION_MS = 12 * 3600 * 1000; // "remember me" unticked
const LONG_SESSION_MS = 30 * 24 * 3600 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 5;
const MAX_GLOBAL = 20;
const MIN_PASSWORD = 10;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

// Spend the same time on unknown emails as on wrong passwords.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return 'That password is too long.';
  if (/^(.)\1+$/.test(pw)) return 'Avoid a password made of one repeated character.';
  return null;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth(db, { now = () => Date.now(), secureCookies = false } = {}) {
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  const failures = new Map(); // ip -> [timestamps]
  let globalFailures = [];

  const prune = (list) => list.filter((t) => now() - t < WINDOW_MS);
  function lockedFor(ip) {
    const mine = prune(failures.get(ip) || []);
    globalFailures = prune(globalFailures);
    failures.set(ip, mine);
    // Locked until enough failures age out of the window to fall below the limit.
    const until = (list, max) => (list.length >= max ? list[list.length - max] + WINDOW_MS : 0);
    const unlockAt = Math.max(until(mine, MAX_PER_IP), until(globalFailures, MAX_GLOBAL));
    return unlockAt > now() ? Math.ceil((unlockAt - now()) / 60000) : 0;
  }
  function recordFailure(ip) {
    failures.set(ip, [...(failures.get(ip) || []), now()]);
    globalFailures.push(now());
  }

  const userCount = () => q('SELECT COUNT(*) AS n FROM users').get().n;
  const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email };

  function startSession(res, userId, remember, req) {
    const token = crypto.randomBytes(32).toString('base64url');
    const ttl = remember ? LONG_SESSION_MS : SHORT_SESSION_MS;
    q('DELETE FROM sessions WHERE expires_at < ?').run(now());
    q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, now() + ttl);
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (remember) parts.push(`Max-Age=${Math.floor(ttl / 1000)}`);
    if (secureCookies || req.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }

  function clearCookie(res) {
    res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now());
    return row || null;
  }

  /** Reject cross-site state-changing requests (defence in depth on top of SameSite). */
  function sameOrigin(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try { host = new URL(origin).host; } catch { host = null; }
      if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request blocked' });
    }
    next();
  }

  /** Attach req.user; 401 for API calls without a valid session. */
  function requireUser(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Please sign in', signedOut: true });
    req.user = user;
    next();
  }

  function routes(app) {
    const bad = (res, error, code = 400, extra = {}) => res.status(code).json({ error, ...extra });

    app.get('/api/auth/state', (req, res) => {
      res.json({ setupRequired: userCount() === 0, user: publicUser(currentUser(req)), minPassword: MIN_PASSWORD });
    });

    app.post('/api/auth/setup', (req, res) => {
      if (userCount() > 0) return bad(res, 'An account already exists. Sign in instead.', 409);
      const { name, email, password, remember } = req.body || {};
      const cleanName = String(name || '').trim();
      const cleanEmail = String(email || '').trim().toLowerCase();
      if (!cleanName) return bad(res, 'Enter your name.', 400, { field: 'name' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return bad(res, 'Enter a valid email address.', 400, { field: 'email' });
      const problem = passwordProblem(password);
      if (problem) return bad(res, problem, 400, { field: 'password' });
      const r = q('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(cleanEmail, cleanName, hashPassword(password));
      startSession(res, Number(r.lastInsertRowid), remember !== false, req);
      res.status(201).json({ user: publicUser({ id: Number(r.lastInsertRowid), name: cleanName, email: cleanEmail }) });
    });

    app.post('/api/auth/login', (req, res) => {
      const ip = req.ip || 'unknown';
      const wait = lockedFor(ip);
      if (wait) return bad(res, `Too many attempts. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`, 429);
      const { email, password, remember } = req.body || {};
      const user = q('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
      const ok = verifyPassword(String(password || ''), user ? user.password_hash : DUMMY_HASH) && !!user;
      if (!ok) {
        recordFailure(ip);
        const left = MAX_PER_IP - (failures.get(ip) || []).length;
        return bad(res, left > 0 && left <= 2
          ? `Email or password is incorrect. ${left} attempt${left === 1 ? '' : 's'} left before a 15-minute lock.`
          : 'Email or password is incorrect.', 401);
      }
      failures.delete(ip);
      startSession(res, user.id, !!remember, req);
      res.json({ user: publicUser(user) });
    });

    app.post('/api/auth/logout', (req, res) => {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
      clearCookie(res);
      res.json({ ok: true });
    });

    app.post('/api/auth/password', requireUser, (req, res) => {
      const { current, next } = req.body || {};
      if (!verifyPassword(String(current || ''), req.user.password_hash)) return bad(res, 'Your current password is incorrect.', 400, { field: 'current' });
      const problem = passwordProblem(next);
      if (problem) return bad(res, problem, 400, { field: 'next' });
      q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
      // Sign out every other device; keep this one signed in with a fresh session.
      q('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
      startSession(res, req.user.id, true, req);
      res.json({ ok: true });
    });
  }

  /** Used by `npm run reset-password`. */
  function resetPassword(email, password) {
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const r = email
      ? q('UPDATE users SET password_hash = ? WHERE email = ?').run(hashPassword(password), email)
      : q('UPDATE users SET password_hash = ?').run(hashPassword(password));
    if (!r.changes) throw new Error('No matching account.');
    q('DELETE FROM sessions').run();
  }

  return { routes, requireUser, sameOrigin, currentUser, resetPassword, userCount };
}

module.exports = { createAuth, hashPassword, verifyPassword, passwordProblem, MIN_PASSWORD };

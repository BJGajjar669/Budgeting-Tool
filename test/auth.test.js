'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { hashPassword, verifyPassword } = require('../src/auth');

function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budgify-auth-'));
  const ctx = createApp({ dataDir: dir, today: '2026-11-10' });
  const server = ctx.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  /** Each "browser" keeps its own cookie. */
  const browser = () => {
    let cookie = null;
    return async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, {
        method,
        redirect: 'manual',
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = /Max-Age=0/.test(set) ? null : set.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, body: json, headers: res.headers, setCookie: set, cookie: () => cookie };
    };
  };
  return { ...ctx, base, browser, close: () => server.close() };
}

const ACCOUNT = { name: 'Bhavin', email: 'Owner@Example.com', password: 'long enough password' };

test('passwords are salted scrypt hashes', () => {
  const a = hashPassword('hunter2hunter2');
  assert.notEqual(a, hashPassword('hunter2hunter2'));
  assert.ok(a.startsWith('scrypt$'));
  assert.ok(verifyPassword('hunter2hunter2', a));
  assert.ok(!verifyPassword('hunter2hunter3', a));
});

test('first run: pages and API are locked until the account is created', async (t) => {
  const s = start();
  t.after(s.close);
  const b = s.browser();

  assert.equal((await b('GET', '/')).headers.get('location'), '/login');
  assert.equal((await b('GET', '/index.html')).headers.get('location'), '/login');
  assert.equal((await b('GET', '/login')).status, 200);
  assert.equal((await b('GET', '/styles.css')).status, 200);
  assert.equal((await b('GET', '/brand/icon-192.png')).status, 200);
  assert.equal((await b('GET', '/api/summary')).status, 401);
  assert.equal((await b('POST', '/api/demo')).status, 401);
  assert.deepEqual((await b('GET', '/api/auth/state')).body, { setupRequired: true, user: null, minPassword: 10 });

  const weak = await b('POST', '/api/auth/setup', { ...ACCOUNT, password: 'short' });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.field, 'password');
  assert.equal((await b('POST', '/api/auth/setup', { ...ACCOUNT, email: 'nope' })).body.field, 'email');

  const ok = await b('POST', '/api/auth/setup', ACCOUNT);
  assert.equal(ok.status, 201);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Strict/);
  assert.equal((await b('GET', '/api/summary')).status, 200);
  assert.equal((await b('GET', '/login')).headers.get('location'), '/');
  assert.equal((await b('GET', '/')).status, 200);

  // Nobody else can claim the install afterwards.
  const other = s.browser();
  assert.equal((await other('POST', '/api/auth/setup', { ...ACCOUNT, email: 'x@y.z' })).status, 409);
  assert.equal((await other('GET', '/api/auth/state')).body.setupRequired, false);

  // Neither the password nor the session token is stored in the clear.
  const dump = JSON.stringify(s.db.prepare('SELECT * FROM users').all()) + JSON.stringify(s.db.prepare('SELECT * FROM sessions').all());
  assert.ok(!dump.includes(ACCOUNT.password));
  assert.ok(!dump.includes(ok.cookie().split('=')[1]));
});

test('sign in, sign out, and session cookies', async (t) => {
  const s = start();
  t.after(s.close);
  const owner = s.browser();
  await owner('POST', '/api/auth/setup', ACCOUNT);

  const b = s.browser();
  const wrong = await b('POST', '/api/auth/login', { email: ACCOUNT.email, password: 'not the password' });
  assert.equal(wrong.status, 401);
  assert.equal((await b('POST', '/api/auth/login', { email: 'nobody@example.com', password: ACCOUNT.password })).status, 401);

  const short = await b('POST', '/api/auth/login', { email: 'owner@example.com', password: ACCOUNT.password, remember: false });
  assert.equal(short.status, 200);
  assert.equal(short.body.user.name, 'Bhavin');
  assert.doesNotMatch(short.setCookie, /Max-Age/, 'unticked "remember me" gives a browser-session cookie');
  const long = await s.browser()('POST', '/api/auth/login', { email: ACCOUNT.email, password: ACCOUNT.password, remember: true });
  assert.match(long.setCookie, /Max-Age=2592000/);

  assert.equal((await b('GET', '/api/accounts')).status, 200);
  const stolen = short.cookie();
  await b('POST', '/api/auth/logout');
  assert.equal((await b('GET', '/api/accounts')).status, 401);
  // The old token is dead server-side, not just deleted in the browser.
  assert.equal((await s.browser()('GET', '/api/accounts', undefined, { cookie: stolen })).status, 401);
  // Other devices stay signed in.
  assert.equal((await owner('GET', '/api/accounts')).status, 200);
});

test('repeated wrong passwords lock sign-in', async (t) => {
  const s = start();
  t.after(s.close);
  await s.browser()('POST', '/api/auth/setup', ACCOUNT);
  const b = s.browser();
  let last;
  for (let i = 0; i < 5; i++) last = await b('POST', '/api/auth/login', { email: ACCOUNT.email, password: `guess ${i}` });
  assert.equal(last.status, 401);
  const locked = await b('POST', '/api/auth/login', { email: ACCOUNT.email, password: ACCOUNT.password });
  assert.equal(locked.status, 429);
  assert.match(locked.body.error, /Try again in 15 minutes/);
});

test('cross-site requests are refused', async (t) => {
  const s = start();
  t.after(s.close);
  const b = s.browser();
  await b('POST', '/api/auth/setup', ACCOUNT);
  const evil = await b('POST', '/api/demo', undefined, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal((await b('POST', '/api/demo', undefined, { origin: s.base })).status, 200);
  assert.equal((await b('POST', '/api/demo')).status, 200); // no Origin header (curl, scripts)
});

test('changing the password signs out other sessions', async (t) => {
  const s = start();
  t.after(s.close);
  const a = s.browser();
  await a('POST', '/api/auth/setup', ACCOUNT);
  const other = s.browser();
  await other('POST', '/api/auth/login', { email: ACCOUNT.email, password: ACCOUNT.password });

  assert.equal((await a('POST', '/api/auth/password', { current: 'wrong wrong wrong', next: 'a brand new password' })).status, 400);
  assert.equal((await a('POST', '/api/auth/password', { current: ACCOUNT.password, next: 'short' })).body.field, 'next');
  assert.equal((await a('POST', '/api/auth/password', { current: ACCOUNT.password, next: 'a brand new password' })).status, 200);

  assert.equal((await a('GET', '/api/accounts')).status, 200, 'this device stays signed in');
  assert.equal((await other('GET', '/api/accounts')).status, 401, 'other devices are signed out');
  assert.equal((await other('POST', '/api/auth/login', { email: ACCOUNT.email, password: ACCOUNT.password })).status, 401);
  assert.equal((await other('POST', '/api/auth/login', { email: ACCOUNT.email, password: 'a brand new password' })).status, 200);
});

test('reset-password helper and security headers', async (t) => {
  const s = start();
  t.after(s.close);
  const b = s.browser();
  const res = await b('POST', '/api/auth/setup', ACCOUNT);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.throws(() => s.auth.resetPassword(null, 'tiny'), /at least 10/);
  s.auth.resetPassword(null, 'reset via the terminal');
  assert.equal((await b('GET', '/api/accounts')).status, 401);
  assert.equal((await b('POST', '/api/auth/login', { email: ACCOUNT.email, password: 'reset via the terminal' })).status, 200);
});

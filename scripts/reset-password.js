'use strict';

// Forgot your Budgify password? Run:  npm run reset-password
// Sets a new password for the account and signs out every device.

require('dotenv').config({ quiet: true });
const path = require('node:path');
const readline = require('node:readline');
const { openDb } = require('../src/db');
const { createAuth, MIN_PASSWORD } = require('../src/auth');

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : s.replace(/[^\r\n]/g, '•'));
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const db = openDb(path.join(dataDir, 'budget.db'));
  const auth = createAuth(db);
  const users = db.prepare('SELECT email FROM users').all();
  if (!users.length) {
    console.log('No account exists yet. Start the app and create one at the sign-in screen.');
    return;
  }
  console.log(`Resetting the password for ${users.map((u) => u.email).join(', ')}`);
  const pw = await ask(`New password (at least ${MIN_PASSWORD} characters): `, true);
  const again = await ask('Type it again: ', true);
  if (pw !== again) {
    console.error('Passwords did not match. Nothing was changed.');
    process.exitCode = 1;
    return;
  }
  try {
    auth.resetPassword(null, pw);
    console.log('Password updated. All devices have been signed out.');
  } catch (err) {
    console.error(`${err.message} Nothing was changed.`);
    process.exitCode = 1;
  }
})();

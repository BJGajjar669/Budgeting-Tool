'use strict';

// Encrypts bank access tokens at rest (AES-256-GCM).
// Key comes from ENCRYPTION_KEY, or is generated once into data/.secret_key (mode 0600).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function loadKey(dataDir) {
  if (process.env.ENCRYPTION_KEY) {
    return crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest();
  }
  const keyFile = path.join(dataDir, '.secret_key');
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
}

function makeCipher(key) {
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
    },
    decrypt(blob) {
      const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    },
  };
}

module.exports = { loadKey, makeCipher };

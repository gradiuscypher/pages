import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openStore } from '../src/store.js';

const username = process.argv[2];
if (process.argv.length !== 3 || !/^[A-Za-z0-9_.-]{1,64}$/.test(username) || process.stdin.isTTY) {
  console.error('Usage: node scripts/create-user.js USERNAME < password-file (or pipe a password on stdin)');
  process.exit(1);
}
const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (!password.length || password.length > 1024 || /[\r\n]/.test(password)) throw new Error('Expected a single password of 1–1024 characters.');
const dir = resolve(process.env.DATA_DIR || './data');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const store = openStore(resolve(dir, 'pages.sqlite'));
try {
  if (!store.createUser(username, password)) throw new Error('Username already exists.');
  console.log(`Created account: ${username}`);
} finally {
  store.close();
}

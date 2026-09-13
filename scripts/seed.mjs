// Seeds the three known users with fresh random tokens and prints their URLs.
// Structurally idempotent: fixed ids + INSERT OR REPLACE, so re-running just
// rotates the tokens (old links stop working) without creating duplicate rows.
//
// Usage:
//   node scripts/seed.mjs                         # local D1 (default)
//   node scripts/seed.mjs --remote                # remote D1
//   node scripts/seed.mjs --remote --db countmein-staging   # a different D1
// Set COUNTMEIN_BASE_URL to control the printed URL origin.

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Load COUNTMEIN_BASE_URL (and anything else) from an optional .env file.
try {
  process.loadEnvFile();
} catch {
  // no .env; fall back to the process environment or the default
}

const dbFlag = process.argv.indexOf('--db');
const DB =
  dbFlag !== -1 ? process.argv[dbFlag + 1] : (process.env.COUNTMEIN_DB ?? 'countmein');
const remote = process.argv.includes('--remote');
const target = remote ? '--remote' : '--local';

const USERS = [
  { id: 1, name: 'Alice', is_admin: 1 },
  { id: 2, name: 'Bob', is_admin: 0 },
  { id: 3, name: 'Carol', is_admin: 0 },
].map((u) => ({ ...u, pickup_label: `@${u.name}` }));

const newToken = () => randomBytes(24).toString('base64url'); // 32-char base64url

const now = new Date().toISOString();
const users = USERS.map((u) => ({ ...u, token: newToken() }));

const values = users
  .map((u) => `(${u.id}, '${u.name}', ${u.is_admin}, '${u.pickup_label}', '${u.token}', '${now}')`)
  .join(',\n  ');
const sql = `INSERT OR REPLACE INTO users (id, name, is_admin, pickup_label, token, created_at) VALUES\n  ${values};\n`;

// Write to the OS temp dir (not the repo) and delete right after: the file holds
// live tokens and must never be committed or left lying around.
const file = join(tmpdir(), `countmein-seed-${Date.now()}.sql`);
writeFileSync(file, sql, 'utf8');
try {
  execSync(`npx wrangler d1 execute ${DB} ${target} --file "${file}"`, { stdio: 'inherit' });
} finally {
  unlinkSync(file);
}

const base =
  process.env.COUNTMEIN_BASE_URL ?? (remote ? 'https://<your-worker-url>' : 'http://localhost:5173');

console.log(`\nCount me in URLs (${target}):`);
for (const u of users) {
  console.log(`  ${u.name.padEnd(8)} ${base}/?t=${u.token}`);
}

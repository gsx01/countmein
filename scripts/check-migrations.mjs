// Exits 0 only when the given D1 has no unapplied migrations, so a deploy can
// refuse to ship code ahead of its schema. Any other answer, including a failed
// check (not logged in, no network), exits 1: unknown is not "clean".
//
// Usage:
//   node scripts/check-migrations.mjs <database> [wrangler args...]
//   node scripts/check-migrations.mjs countmein --remote --env=""

import { spawnSync } from 'node:child_process';

const NOTHING_PENDING = 'No migrations to apply';

const MIGRATE = {
  countmein: 'npm run migrate',
  'countmein-staging': 'npm run migrate:staging',
};

const [db, ...args] = process.argv.slice(2);
if (!db) {
  console.error('usage: node scripts/check-migrations.mjs <database> [wrangler args...]');
  process.exit(1);
}

const quote = (a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a);
const command = ['npx', 'wrangler', 'd1', 'migrations', 'list', db, ...args].map(quote).join(' ');
const res = spawnSync(command, { shell: true, encoding: 'utf8' });
const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

if (res.status === 0 && output.includes(NOTHING_PENDING)) {
  console.log(`No pending migrations on ${db}.`);
  process.exit(0);
}

console.error(output.trim());
console.error(
  res.status === 0
    ? `\nPending migrations on ${db}. Apply them before deploying: ${MIGRATE[db] ?? `npx wrangler d1 migrations apply ${db} ${args.join(' ')}`}`
    : `\nCould not check the migrations on ${db} (wrangler exited ${res.status}). Not deploying.`,
);
process.exit(1);

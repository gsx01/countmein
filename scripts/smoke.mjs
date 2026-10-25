// Smoke-checks the deployed staging Worker at STAGING_URL (from .env): the
// static shell, the auth gate, and a real state read with an enabled user's
// token. The token is read from the staging D1 and never printed. One line per
// check; exits 1 on any failure.
//
// Usage: node scripts/smoke.mjs   (npm run smoke:staging)

import { execSync } from 'node:child_process';

try {
  process.loadEnvFile();
} catch {
  // no .env; fall back to the process environment
}

const BASE = process.env.STAGING_URL?.replace(/\/+$/, '');
if (!BASE) {
  console.error('STAGING_URL is not set. Add it to .env, e.g. STAGING_URL=https://countmein-staging.<subdomain>.workers.dev');
  process.exit(1);
}

function stagingToken() {
  const out = execSync(
    'npx wrangler d1 execute countmein-staging --remote --env staging --json --command "SELECT token FROM users WHERE enabled = 1 ORDER BY id LIMIT 1"',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const token = JSON.parse(out.slice(out.indexOf('[')))[0].results[0]?.token;
  if (!token) throw new Error('no enabled user in the staging D1');
  return token;
}

const checks = [
  ['GET / is HTML', async () => {
    const res = await fetch(`${BASE}/`);
    return expectRes(res, 200, /text\/html/);
  }],
  ['GET /sw.js is JavaScript', async () => {
    const res = await fetch(`${BASE}/sw.js`);
    return expectRes(res, 200, /javascript/);
  }],
  ['GET /manifest.webmanifest', async () => {
    const res = await fetch(`${BASE}/manifest.webmanifest`);
    return expectRes(res, 200);
  }],
  ['GET /api/state without a token is 401', async () => {
    const res = await fetch(`${BASE}/api/state`);
    return expectRes(res, 401);
  }],
  ['GET /api/state with a token has trips', async () => {
    const res = await fetch(`${BASE}/api/state`, { headers: { 'x-token': stagingToken() } });
    const problem = expectRes(res, 200, /json/);
    if (problem) return problem;
    const body = await res.json();
    return Array.isArray(body.trips) ? null : 'no trips array';
  }],
];

function expectRes(res, status, type) {
  if (res.status !== status) return `HTTP ${res.status}, expected ${status}`;
  const contentType = res.headers.get('content-type') ?? '';
  if (type && !type.test(contentType)) return `content-type ${contentType || '(none)'}`;
  return null;
}

console.log(`Smoke checks against ${BASE}`);
let failed = 0;
for (const [name, run] of checks) {
  let problem;
  try {
    problem = await run();
  } catch (err) {
    problem = err instanceof Error ? (err.cause?.message ?? err.message) : String(err);
  }
  if (problem) failed++;
  console.log(`${problem ? 'FAIL' : 'ok  '} ${name}${problem ? ` - ${problem}` : ''}`);
}
if (failed) {
  console.error(`${failed} of ${checks.length} checks failed.`);
  process.exit(1);
}

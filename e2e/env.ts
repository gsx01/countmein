import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PORT = 8788;
export const BASE = `http://127.0.0.1:${PORT}`;
export const CONFIG = 'e2e/wrangler.e2e.toml';
export const STATE = 'e2e/.state';
export const VIDEO = Boolean(process.env.E2E_VIDEO);
export const SHOTS = Boolean(process.env.E2E_SHOTS);

export interface VapidPair {
  publicKey: string;
  privateKey: string;
  subject: string;
}

function newVapidPair(): VapidPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(x ?? '', 'base64url'),
    Buffer.from(y ?? '', 'base64url'),
  ]);
  return {
    publicKey: raw.toString('base64url'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    subject: 'mailto:e2e@example.com',
  };
}

// One VAPID pair per run, never written to disk. Playwright re-evaluates this
// module in every worker; they inherit the runner's environment, so all of them
// keep the pair the server was started with.
process.env.E2E_VAPID ??= JSON.stringify(newVapidPair());
export const VAPID: VapidPair = JSON.parse(process.env.E2E_VAPID);

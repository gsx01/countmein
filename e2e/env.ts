import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PORT = 8788;
export const BASE = `http://127.0.0.1:${PORT}`;
export const CONFIG = 'e2e/wrangler.e2e.toml';
export const STATE = 'e2e/.state';
export const VIDEO = Boolean(process.env.E2E_VIDEO);
export const SHOTS = Boolean(process.env.E2E_SHOTS);

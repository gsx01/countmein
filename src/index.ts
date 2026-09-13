import { handleApi } from './api';
import { handleScheduled } from './cron';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // Per-env VAPID keypair. The public key is a plaintext var (public by design);
  // the private key and subject are Worker secrets. The worker reads the public
  // key from env (not a build-time constant) because wrangler bundles the worker
  // separately from the Vite client build, so a client-side define never reaches
  // it. The web client gets its own copy of the public key at build time.
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  // The office destination as a JSON string (label/lat/lng/place_id/emoji), set
  // per deployment (see wrangler.toml.example). Optional: src/config.ts falls
  // back to a placeholder default when it is unset or malformed.
  OFFICE_DESTINATION?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleScheduled(env);
  },
} satisfies ExportedHandler<Env>;

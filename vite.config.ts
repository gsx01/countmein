import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// Public client config, injected into the client bundle at build time and
// selected by the Vite mode (`vite build --mode staging`, set by deploy:staging;
// production is the default). Loaded from .env / .env.<mode> (gitignored; see
// .env.example), so each deployment supplies its own values without editing
// source. All of these are public by design - the VAPID public key is half a
// keypair whose private half is a Worker secret; the Maps key is referrer- and
// quota-restricted in Google Cloud. NEVER put a secret in these files.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    root: 'web',
    plugins: [preact(), cloudflare()],
    define: {
      __VAPID_PUBLIC_KEY__: JSON.stringify(env.VAPID_PUBLIC_KEY ?? ''),
      __GOOGLE_MAPS_API_KEY__: JSON.stringify(env.GOOGLE_MAPS_API_KEY ?? ''),
      __GOOGLE_MAPS_MAP_ID__: JSON.stringify(env.GOOGLE_MAPS_MAP_ID ?? 'DEMO_MAP_ID'),
    },
    build: {
      outDir: '../dist/client',
      emptyOutDir: true,
    },
  };
});

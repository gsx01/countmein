import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The client build-time constants (injected by vite.config.ts) are not defined
  // under vitest, so stub them here for the web modules that read them.
  define: {
    __VAPID_PUBLIC_KEY__: '""',
    __GOOGLE_MAPS_API_KEY__: '""',
    __GOOGLE_MAPS_MAP_ID__: '"DEMO_MAP_ID"',
  },
  test: {
    include: ['src/**/*.test.ts', 'web/**/*.test.ts'],
  },
});

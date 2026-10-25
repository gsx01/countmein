import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export const TEST_OFFICE = JSON.stringify({
  label: '@TestOffice',
  lat: 52.37,
  lng: 4.89,
  place_id: null,
  emoji: null,
});

export default defineConfig({
  test: {
    projects: [
      {
        // The client build-time constants (injected by vite.config.ts) are not defined
        // under vitest, so stub them here for the web modules that read them.
        define: {
          __VAPID_PUBLIC_KEY__: '""',
          __GOOGLE_MAPS_API_KEY__: '""',
          __GOOGLE_MAPS_MAP_ID__: '"DEMO_MAP_ID"',
        },
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'web/**/*.test.ts', 'test/*.test.ts'],
        },
      },
      {
        plugins: [
          // Bindings are declared inline so the tests never read the gitignored
          // wrangler.toml; the distinct office label proves this config is in effect.
          cloudflareTest(async () => ({
            main: './src/index.ts',
            miniflare: {
              compatibilityDate: '2026-09-01',
              d1Databases: ['DB'],
              bindings: {
                OFFICE_DESTINATION: TEST_OFFICE,
                VAPID_PUBLIC_KEY: 'test-public-key',
                VAPID_SUBJECT: 'mailto:test@example.com',
                TEST_MIGRATIONS: await readD1Migrations('./migrations'),
              },
            },
          })),
        ],
        test: {
          name: 'api',
          include: ['test/api/**/*.test.ts'],
          setupFiles: ['./test/api/setup.ts'],
        },
      },
    ],
  },
});

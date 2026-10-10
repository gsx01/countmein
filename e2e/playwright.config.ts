import { defineConfig, devices } from '@playwright/test';
import { BASE, CONFIG, PORT, ROOT, SHOTS, STATE, VIDEO } from './env';

const channel = process.env.PW_CHANNEL || undefined;

// Playwright starts the webServer before any globalSetup, so the e2e build and
// the local migrations run inside the server command, ahead of `wrangler dev`.
const serve = [
  'npx vite build --mode e2e',
  `npx wrangler d1 migrations apply countmein-e2e --local --config ${CONFIG} --persist-to ${STATE}`,
  `npx wrangler dev --config ${CONFIG} --persist-to ${STATE} --ip 127.0.0.1 --port ${PORT} --show-interactive-dev-session=false`,
].join(' && ');

// iPhone descriptors default to WebKit; only the viewport, scale, UA and touch
// matter for a layout check, so every device runs on Chromium. The desktop
// profile covers the side-label layout and a fine pointer.
const SHOT_DEVICES = ['iPhone SE', 'iPhone 15', 'Pixel 7', 'Desktop Chrome'];

export default defineConfig({
  testDir: '.',
  testMatch: SHOTS ? '*.shots.ts' : '*.spec.ts',
  projects: SHOTS
    ? SHOT_DEVICES.map((name) => ({
        name: name.toLowerCase().replace(/\s+/g, '-'),
        use: { ...devices[name], browserName: 'chromium' as const, ...(channel ? { channel } : {}) },
      }))
    : undefined,
  outputDir: './test-results',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
  use: {
    baseURL: BASE,
    timezoneId: 'Europe/Amsterdam',
    viewport: { width: 420, height: 900 },
    trace: 'retain-on-failure',
    video: VIDEO ? { mode: 'on', size: { width: 420, height: 900 } } : 'off',
    launchOptions: VIDEO ? { slowMo: 250 } : {},
    ...(channel ? { channel } : {}),
  },
  webServer: {
    command: serve,
    cwd: ROOT,
    url: `${BASE}/`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

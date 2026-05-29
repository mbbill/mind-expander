import { defineConfig, devices } from '@playwright/test';

// Tier-3 end-to-end config. These specs spawn the real `mind-expander
// view` server (see e2e/_harness.ts) and drive a real Chromium, so they
// are intentionally separate from the fast vitest suite (`npm test`) and
// run via `npm run test:e2e` / a dedicated CI job.
export default defineConfig({
  testDir: './e2e',
  // One server is spawned per worker (worker-scoped fixture). Keep a
  // single worker so there is exactly one server + deterministic layout;
  // these tests are about correctness, not throughput.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    // Real-font geometry is the whole point; a fixed viewport keeps
    // screen-space assertions stable across machines.
    viewport: { width: 1400, height: 900 },
    // A screenshot + trace is captured only when a test fails, as a
    // human-reviewed debugging artifact — never as the pass/fail oracle.
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

import { defineConfig, devices } from 'playwright/test';
import { LOCAL_STORE, FAKE_API_PORT } from './e2e/globalSetup.js';

const PORT  = 3099;
const BASE  = `http://localhost:${PORT}`;

export default defineConfig({
  testDir:     './e2e',
  testMatch:   '**/*.spec.ts',
  globalSetup:    './e2e/globalSetup.ts',
  globalTeardown: './e2e/globalTeardown.ts',
  fullyParallel: false, // share the single Express server
  retries: 0,
  timeout: 30_000,

  use: {
    baseURL:           BASE,
    headless:          true,
    screenshot:        'only-on-failure',
    video:             'retain-on-failure',
    actionTimeout:     10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    // testServer.ts installs fetch interception when FAKE_API_PORT is set
    command: [
      `LOCAL_STORE_DIR=${LOCAL_STORE}`,
      `CONFIG_JSON='{"services":[]}'`,
      `CF_REGIONS=${process.env.CF_REGIONS ?? 'eu10'}`,
      `CF_USERNAME=test-user`,
      `CF_PASSWORD=test-pass`,
      `FAKE_API_PORT=${FAKE_API_PORT}`,
      `PORT=${PORT}`,
      `PLAYWRIGHT_BROWSERS_PATH=./server/pw-browsers`,
      `node server/dist/testServer.js`,
    ].join(' '),
    port:                PORT,
    reuseExistingServer: false,
    timeout:             20_000,
  },
});

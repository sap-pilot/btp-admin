/**
 * Test entry point for Playwright E2E tests.
 *
 * When FAKE_API_PORT is set, patches globalThis.fetch to redirect all https://
 * requests to the in-process fake BTP/CF/XSUAA server running on that port.
 * All other behaviour is identical to the production index.ts entry point.
 *
 * Environment variables expected by Playwright globalSetup:
 *   FAKE_API_PORT        — port of the fake BTP/CF HTTP server
 *   LOCAL_STORE_DIR      — pre-seeded temp directory with fake data
 *   CONFIG_JSON          — minimal JSON config (no real services needed)
 *   CF_USERNAME/PASSWORD — fake credentials for refresh flows
 *   CF_REGIONS           — fake region (e.g. "eu10")
 */

const fakePort = process.env.FAKE_API_PORT ? parseInt(process.env.FAKE_API_PORT, 10) : 0;

if (fakePort > 0) {
  // Install fetch interceptor before importing any service module.
  // Dynamic import ensures env vars are processed before module code runs.
  const { installFetchInterceptor } = await import('./test-helpers/interceptFetch.js');
  installFetchInterceptor(fakePort);
}

// Kick off the real Express app
await import('./index.js');

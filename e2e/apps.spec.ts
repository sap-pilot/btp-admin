/**
 * E2E: Apps page — top apps and per-subaccount view
 * Seeded data: one STARTED app "my-app" for the test subaccount.
 */
import { test, expect } from 'playwright/test';
import { FAKE } from '../server/src/test-helpers/fakeBtpCfServer.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/apps');
});

test('apps page loads without error', async ({ page }) => {
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);
});

test('page renders a heading or top-level container', async ({ page }) => {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  // Apps page always has a refresh button or similar control
  const heading = page.locator('h1, h2, button, [role="button"]').first();
  await expect(heading).toBeVisible({ timeout: 8_000 });
});

test('shows seeded app name after navigating to subaccount view', async ({ page }) => {
  // Navigate to per-subaccount apps view
  await page.goto(`/apps/${FAKE.SA.region}/${FAKE.SA.subdomain}`);
  await expect(page.getByText(FAKE.APP.name).first()).toBeVisible({ timeout: 10_000 });
});

test('shows STARTED state for the seeded app', async ({ page }) => {
  await page.goto(`/apps/${FAKE.SA.region}/${FAKE.SA.subdomain}`);
  // "STARTED" should appear somewhere on the page for our seeded app
  await expect(page.getByText('STARTED')).toBeVisible({ timeout: 10_000 });
});

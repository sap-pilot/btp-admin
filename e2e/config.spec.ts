/**
 * E2E: Config page — subaccounts table
 * Verifies that the seeded subaccount data is loaded from the local store
 * and rendered in the UI.
 */
import { test, expect } from 'playwright/test';
import { FAKE } from '../server/src/test-helpers/fakeBtpCfServer.js';

test.beforeEach(async ({ page }) => {
  // Config page requires the React app to load subaccounts via /api/config/subaccounts
  await page.goto('/config/orgs');
});

test('config/orgs page loads without error', async ({ page }) => {
  // Page should not show the generic error boundary
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);
});

test('shows the seeded subaccount name', async ({ page }) => {
  await expect(page.getByText(FAKE.SA.displayName)).toBeVisible({ timeout: 10_000 });
});

test('shows the seeded subdomain', async ({ page }) => {
  await expect(page.getByText(FAKE.SA.subdomain)).toBeVisible({ timeout: 10_000 });
});

test('shows the seeded global account name', async ({ page }) => {
  await expect(page.getByText(FAKE.GA.displayName)).toBeVisible({ timeout: 10_000 });
});

test('shows the seeded region', async ({ page }) => {
  await expect(page.getByText(FAKE.SA.region)).toBeVisible({ timeout: 10_000 });
});

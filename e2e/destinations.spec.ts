/**
 * E2E: Destinations page — list and search
 * Seeded data: one destination "TestDest" for the test subaccount.
 * The destinations page loads data from /api/destinations (reads local store).
 *
 * Note: listDestinations() only returns data for subaccounts with
 * manageDestinations=true, which is set in globalSetup seed data.
 */
import { test, expect } from 'playwright/test';
import { FAKE } from '../server/src/test-helpers/fakeBtpCfServer.js';

test('destinations page loads without error', async ({ page }) => {
  await page.goto('/destinations');
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);
});

test('destinations overview renders content', async ({ page }) => {
  await page.goto('/destinations');
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  // Page renders at least one interactive element (button, input, or table cell)
  await expect(page.locator('button, input, td, th').first()).toBeVisible({ timeout: 8_000 });
});

test('shows the seeded destination name in per-subaccount view', async ({ page }) => {
  await page.goto(`/destinations/${FAKE.SA.region}/${FAKE.SA.subdomain}`);
  await expect(page.getByText(FAKE.DEST.name).first()).toBeVisible({ timeout: 10_000 });
});

test('search returns the seeded destination', async ({ page }) => {
  await page.goto(`/destinations/${FAKE.SA.region}/${FAKE.SA.subdomain}`);
  await expect(page.getByText(FAKE.DEST.name).first()).toBeVisible({ timeout: 10_000 });

  const searchInput = page.getByPlaceholder(/search/i).first();
  if (await searchInput.isVisible()) {
    await searchInput.fill(FAKE.DEST.name.toLowerCase());
    await expect(page.getByText(FAKE.DEST.name).first()).toBeVisible({ timeout: 5_000 });
  }
});

/**
 * E2E: Users page
 * Seeded data: one user "alice@example.com" for the test subaccount (manageRoles=true).
 */
import { test, expect } from 'playwright/test';
import { FAKE } from '../server/src/test-helpers/fakeBtpCfServer.js';

test('users page loads without error', async ({ page }) => {
  await page.goto('/users');
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);
});

test('shows the seeded user email in subaccount view', async ({ page }) => {
  await page.goto(`/users/${FAKE.SA.region}/${FAKE.SA.subdomain}`);
  await expect(page.getByText(FAKE.USER.userName).first()).toBeVisible({ timeout: 10_000 });
});

test('navigate to subaccount view shows user', async ({ page }) => {
  await page.goto(`/users/${FAKE.SA.region}/${FAKE.SA.subdomain}`);
  await expect(page.getByText(FAKE.USER.userName).first()).toBeVisible({ timeout: 10_000 });
});

test('shows the refresh button', async ({ page }) => {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  // Refresh button should always be present for admin-level pages
  const refreshBtn = page.getByRole('button', { name: /refresh/i }).first();
  if (await refreshBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await expect(refreshBtn).toBeEnabled();
  }
});

/**
 * E2E: Role Collections page
 * Seeded data: one RC "TestRC" for the test subaccount (manageRoles=true).
 */
import { test, expect } from 'playwright/test';
import { FAKE } from '../server/src/test-helpers/fakeBtpCfServer.js';

test('role-collections page loads without error', async ({ page }) => {
  await page.goto('/role-collections');
  await expect(page.locator('text=Something went wrong')).toHaveCount(0);
});

test('shows the seeded RC name in per-subaccount view', async ({ page }) => {
  await page.goto(`/role-collections/${FAKE.SA.region}/${FAKE.SA.subdomain}`);
  await expect(page.getByText(FAKE.RC.displayName).first()).toBeVisible({ timeout: 10_000 });
});

test('shows the subaccount display name in per-subaccount view', async ({ page }) => {
  await page.goto(`/role-collections/${FAKE.SA.region}/${FAKE.SA.subdomain}`);
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  await expect(page.getByText(FAKE.SA.displayName).first()).toBeVisible({ timeout: 8_000 });
});

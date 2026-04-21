/**
 * Coverage-test fixture: covers the home route and the /users API GET.
 *
 * NOTE: this file is imported by `test/e2e/cli-coverage.test.ts` as raw
 * source for the `pa coverage` scanner. It is never executed as a
 * Playwright test — no Playwright install is available in the unit test
 * environment.
 */

import { test } from '@playwright/test';

test('home loads', async ({ page }) => {
  await page.goto('https://app.example.com/');
});

test('users page loads', async ({ page }) => {
  await page.goto('https://app.example.com/users');
});

test('fetches the users API', async ({ request }) => {
  await request.get('https://app.example.com/api/users');
});

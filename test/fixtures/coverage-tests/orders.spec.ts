/**
 * Coverage-test fixture: covers the /orders route only.
 *
 * Leaves /settings uncovered (see fixture bundle in the e2e test) so the
 * CLI exercises a genuine uncovered-route code path.
 */

import { test } from '@playwright/test';

test('orders list', async ({ page }) => {
  await page.goto('https://app.example.com/orders');
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Real billing components in the account frame, using synthetic stub data without an authenticated session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { assertDrawn, billingFixture, shots } from './billing-fixture.mjs';

test('billing home: monthly pool, bounded project list, chart/table, navigation and recovery in both themes', async t => {
  const fixture = await billingFixture(t);
  if (!fixture) return;
  const open = (width = 1440, sample = 'pro', view = 'owner', theme = 'dark') =>
    fixture.open(`sample=${sample}&view=${view}`, width, theme);
  const page = await open();
  assert.match(await page.title(), /Billing/);
  assert.match(await page.locator('main').textContent(), /746 of 1,000 included landings used/);
  await page.getByRole('button', { name: 'nforge billing', exact: true }).click();
  assert.match(await page.locator('#billing-cli').textContent(), /run allowance  separate/);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  assert.equal(await page.getByRole('table', { name: 'Monthly landing counts, sample data' }).count(), 1);
  await page.getByRole('button', { name: 'Chart', exact: true }).click();
  await page.locator('.head').getByRole('link', { name: 'Change plan' }).click();
  assert.match(page.url(), /screen=plan/);
  assert.match(await page.locator('h1').textContent(), /Change plan/);
  await page.locator('h1').getByRole('link', { name: 'Billing' }).click();
  assert.equal(await page.getByRole('region', { name: 'This month', exact: true }).count(), 1);

  await page.goto('https://forge.test/account/billing?sample=pro&screen=__proto__');
  await page.getByRole('region', { name: 'This month', exact: true }).waitFor();
  assert.match(await page.locator('h1').textContent(), /Billing/);

  const worst = await open(390, 'worst');
  await worst.getByRole('button', { name: 'Show 2 more', exact: true }).click();
  const projectRows = worst.locator('table.stack tbody tr');
  await projectRows.nth(9).waitFor();
  assert.equal(await projectRows.count(), 10);
  const member = await open(390, 'pro', 'member');
  assert.equal(await member.getByRole('region', { name: 'Payment', exact: true }).count(), 0);
  assert.doesNotMatch(await member.locator('main').textContent(), /SAMPLE-0004|ending 0000/);
  const error = await open(390, 'pro', 'error');
  assert.match(await error.getByRole('alert').textContent(), /last snapshot/);
  await error.getByRole('button', { name: 'Retry', exact: true }).click();
  assert.equal(await error.getByRole('alert').count(), 0);
  assert.match(await error.locator('main').textContent(), /746 of 1,000/);
  const first = await open(390, 'first');
  assert.match(await first.locator('main').textContent(), /No landings yet/);
  assert.match(await first.locator('main').textContent(), /No invoices/);
  const loading = await open(390, 'pro', 'loading');
  assert.equal(await loading.locator('[aria-busy=true]').count(), 1);

  for (const width of [1440, 390])
    for (const theme of ['dark', 'light']) {
      const draw = await open(width, 'pro', 'owner', theme);
      await assertDrawn(draw, `${width}/${theme}`);
      await draw.getByRole('button', { name: 'nforge billing', exact: true }).focus();
      await draw.keyboard.press('Enter');
      assert.equal(await draw.locator('#billing-cli').count(), 1, 'keyboard opens the command reply');
      await draw.keyboard.press('Enter');
      await draw.locator('h1').click();
      if (shots) {
        await draw.screenshot({ path: join(shots, `billing-${width}-${theme}.png`), fullPage: true });
        await draw.screenshot({ path: join(shots, `billing-${width}-${theme}-viewport.png`) });
      }
      await draw.close();
    }
});

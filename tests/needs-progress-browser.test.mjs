// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Needs me in a real browser (Items 3fa3187d, 0cb9b064), on synthetic data through its real view
// (tests/browser/needs-progress.tsx): Done is the all-time total with today beside it, a capped read shows "N+" on every
// figure, a withdrawn landing sits under FYI and out of the Needs you count; axe is clean with no sideways scroll
// at desk and phone width in both themes. Set FORGE_LANE_SHOTS to a folder to also save the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';
import { axePath, buildBrowserFixture, routeBrowserFixture } from './browser-fixture.mjs';

const shots = process.env.FORGE_LANE_SHOTS || null;
const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const FIXTURE = 'tests/browser/needs-progress.tsx';

test('Needs me: exact progress, N+ when capped, a withdrawn landing under FYI; axe and widths in both themes', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-needs-progress-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const { html } = await buildBrowserFixture(out, { entry: FIXTURE, title: 'Needs me fixture' });
  const browser = await chromium.launch(launchOptions);
  async function open(t, viewport, query = '') {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-11-10T12:00:00Z'));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    await routeBrowserFixture(page, out, html, { paths: ['/needs.html'] });
    await page.goto(`https://forge.test/needs.html${query}`);
    await page
      .locator('.ps')
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, [], 'no page errors');
    });
    return page;
  }
  const standing = page =>
    page.locator('.ps').evaluateAll(nodes =>
      nodes.map(node =>
        [...node.childNodes]
          .map(child => child.textContent.trim())
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' '),
      ),
    );
  try {
    await t.test('exact figures, today beside Done, the withdrawal under FYI', async t => {
      const page = await open(t, DESK);
      const [done, inProgress, left] = await standing(page);
      assert.match(done, /^Done 579 Items · 12 today$/);
      assert.match(inProgress, /^In progress 57 Items/);
      assert.match(left, /^Left 245 Items$/);
      // FYI is the quiet group of Item 48049998: the withdrawal is a row there, never counted in Needs you.
      assert.deepEqual(await page.getByText(/^Refused$/).allTextContents(), []);
      const fyi = page.getByRole('region', { name: 'FYI', exact: true });
      const withdrawn = fyi.locator('.fyi-row', {
        has: page.getByRole('heading', { name: 'Site function for share cards' }),
      });
      assert.match(await withdrawn.locator('.needs-card-status').textContent(), /Withdrawn/);
      assert.match(await withdrawn.locator('.fyi-fact').textContent(), /Withdrawn to add a delta/);
      assert.doesNotMatch(
        await page.locator('section[aria-label="Needs you"]').textContent(),
        /Site function for share cards/,
      );
    });
    await t.test('a capped read: every figure reads N+', async t => {
      const page = await open(t, DESK, '?capped');
      const [done, inProgress, left] = await standing(page);
      assert.match(done, /^Done 200\+ Items$/);
      assert.match(inProgress, /^In progress 7\+ Items/);
      assert.match(left, /^Left 52\+ Items$/);
    });
    await t.test('axe and widths: both themes, desk and phone', async t => {
      for (const viewport of [DESK, PHONE]) {
        const page = await open(t, viewport);
        await page.addScriptTag({ path: axePath });
        for (const theme of ['dark', 'light']) {
          await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
          const [scroll, inner] = await page.evaluate(() => [
            document.documentElement.scrollWidth,
            innerWidth,
          ]);
          assert.ok(
            scroll <= inner,
            `no sideways scroll at ${viewport.width} ${theme}: ${scroll} > ${inner}`,
          );
          const violations = await page.evaluate(async () => {
            const result = await window.axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
            });
            return result.violations.map(
              v =>
                `${v.id}: ${v.nodes.map(n => `${n.target.join(' ')} ${JSON.stringify(n.any[0]?.data ?? '')}`).join(', ')}`,
            );
          });
          assert.deepEqual(violations, [], `axe at ${viewport.width} ${theme}`);
          if (shots)
            await page.screenshot({
              path: join(shots, `needs-progress-${viewport.width}-${theme}.png`),
              fullPage: true,
            });
        }
      }
    });
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 0a99ab23: an old /approve link in a real browser (tests/browser/approve-redirect.tsx). The submission and lane
// forms make one read and replace the address with the Lane page (or Needs me for a settings request), so Back never
// returns to the link; a link the reader cannot open says so, with no read when it names nothing, and that screen is
// axe-clean with no sideways scroll at desk and phone width in both themes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';
import { axePath, buildBrowserFixture, routeBrowserFixture } from './browser-fixture.mjs';

const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const LANE = '7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
const SUBMISSION = '5d1c7a0e-0000-4000-8000-000000000501';

test('0a99ab23: /approve looks its link up once and opens the Lane page in place', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-approve-redirect-'));
  const { html } = await buildBrowserFixture(out, {
    entry: 'tests/browser/approve-redirect.tsx',
    title: 'Approve link fixture',
  });
  const browser = await chromium.launch(launchOptions);
  async function open(t, viewport, query) {
    const context = await browser.newContext({ viewport, locale: 'en-US' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    await routeBrowserFixture(page, out, html, { paths: ['/approve', '/start'] });
    // A page before the link, so Back shows where the reader came from.
    await page.goto('https://forge.test/start');
    await page.goto(`https://forge.test/approve?${query}`);
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, [], 'no page errors');
    });
    return page;
  }
  // Distinct reads: the Convex client shares one subscription per query and arguments, however often it is asked.
  const reads = page =>
    page.evaluate(() => [...new Map(window.__reads.map(read => [JSON.stringify(read), read])).values()]);
  try {
    await t.test('the submission form opens the Lane page; Back skips the link', async t => {
      const page = await open(t, PHONE, `project=p1&submission=${SUBMISSION}&answer=lane`);
      // The link names its landing, so the Lane page decides that exact attempt.
      await page.waitForURL(
        `https://forge.test/sample-owner/tide-pool/lanes/${LANE}?submission=${SUBMISSION}`,
      );
      assert.deepEqual(await reads(page), [
        { name: 'urlProjects:approvalTarget', args: { projectId: 'p1', submission: SUBMISSION } },
      ]);
      await page.goBack();
      await page.waitForURL('https://forge.test/start');
    });
    await t.test('the lane form opens the Lane page', async t => {
      const page = await open(t, DESK, `project=p1&lane=${LANE}&answer=lane`);
      await page.waitForURL(`https://forge.test/sample-owner/tide-pool/lanes/${LANE}`);
      assert.deepEqual(await reads(page), [
        { name: 'urlProjects:approvalTarget', args: { projectId: 'p1', lane: LANE } },
      ]);
    });
    await t.test('a settings request opens Needs me', async t => {
      const page = await open(t, DESK, 'project=p1&lane=setting%3Apolicy&answer=needs');
      await page.waitForURL('https://forge.test/sample-owner/tide-pool');
    });
    await t.test('a link naming nothing reads nothing and says so', async t => {
      const page = await open(t, DESK, 'project=p1');
      await page.getByRole('heading', { name: 'No approval to open' }).waitFor();
      assert.deepEqual(await reads(page), []);
    });
    await t.test('a link the reader cannot open: axe and widths in both themes', async t => {
      for (const viewport of [DESK, PHONE]) {
        const page = await open(t, viewport, `project=p1&lane=${LANE}&answer=none`);
        await page.getByRole('heading', { name: 'No approval to open' }).waitFor();
        assert.equal(new URL(page.url()).pathname, '/approve', 'the address stays the link');
        assert.equal(
          await page.getByRole('link', { name: 'Your projects' }).getAttribute('href'),
          '/account',
        );
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.addScriptTag({ path: axePath });
        for (const theme of ['dark', 'light']) {
          await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
          const [scroll, inner] = await page.evaluate(() => [
            document.documentElement.scrollWidth,
            innerWidth,
          ]);
          assert.ok(scroll <= inner, `no sideways scroll at ${viewport.width} ${theme}`);
          const violations = await page.evaluate(async () => {
            const result = await window.axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
            });
            return result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
          });
          assert.deepEqual(violations, [], `axe at ${viewport.width} ${theme}`);
        }
      }
    });
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});

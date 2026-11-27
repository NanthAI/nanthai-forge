// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 16093ed1, in a real browser on synthetic worst-case data (tests/browser/setting-change.tsx): a held settings
// change never scrolls the page sideways at desk or phone width, no direction override or zero-width character reaches
// the page as an acting character (each shows as a marker), and axe is clean in both themes, on the approve page's
// tokens and the design system's, compared or not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';
import { axePath, buildBrowserFixture, serveBrowserFixture } from './browser-fixture.mjs';

const FIXTURE = 'tests/browser/setting-change.tsx';

test('a held settings change: no sideways scroll, hidden characters shown, axe clean', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-setting-change-'));
  const built = await buildBrowserFixture(out, {
    entry: FIXTURE,
    title: 'Settings change fixture',
    bodyStyle: 'margin:0;background:var(--bg, var(--fx-bg));color:var(--text, var(--fx-text))',
  });
  const server = await serveBrowserFixture(out, url =>
    url.pathname === '/'
      ? built.page({
          htmlAttrs: url.searchParams.has('ds')
            ? 'lang="en" data-ds data-theme="dark"'
            : 'lang="en" data-theme="dark"',
        })
      : null,
  );
  const browser = await chromium.launch(launchOptions);
  try {
    for (const ds of [false, true])
      for (const none of [false, true])
        for (const width of [1440, 390, 375]) {
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          const tab = await context.newPage();
          await tab.goto(`${server.url}/?${ds ? 'ds&' : ''}${none ? 'none' : ''}`);
          await tab.waitForSelector('.sc');
          assert.equal(
            await tab.evaluate(() => document.querySelector('.sc-details').open),
            none,
            'Details opens only when nothing was compared',
          );
          await tab.evaluate(() => (document.querySelector('.sc-details').open = true));
          await tab.addScriptTag({ path: axePath });
          for (const theme of ['dark', 'light']) {
            const where = `${ds ? 'design system' : 'approve page'} ${none ? 'uncompared' : 'compared'} ${width} ${theme}`;
            await tab.evaluate(value => (document.documentElement.dataset.theme = value), theme);
            const [scroll, inner] = await tab.evaluate(() => [
              document.documentElement.scrollWidth,
              innerWidth,
            ]);
            assert.ok(scroll <= inner, `no sideways scroll, ${where}: ${scroll} > ${inner}`);
            const text = await tab.evaluate(() => document.body.innerText);
            assert.ok(!/[‪-‮⁦-⁩​]/.test(text), `no acting hidden character, ${where}`);
            assert.match(text, none ? /\\u202e/ : /U\+202E/, `the override shows, ${where}`);
            if (!none) {
              assert.match(text, /U\+0430/, `the look-alike letter shows its code point, ${where}`);
              assert.doesNotMatch(text, /U\+203A/, `Forge separator › stays plain, ${where}`);
            }
            const violations = await tab.evaluate(async () =>
              (
                await window.axe.run(document, {
                  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
                })
              ).violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`),
            );
            assert.deepEqual(violations, [], `axe, ${where}`);
          }
          await context.close();
        }
  } finally {
    await browser.close();
    await server.close();
    rmSync(out, { recursive: true, force: true });
  }
});

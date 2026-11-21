// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import { chromiumLaunchOptions, settleBrowserPage } from './browser-runtime.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://forge.test';
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AccountFrame, ProjectFrame } from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import { useRoute } from ${JSON.stringify(join(root, 'web/src/app/router.ts'))};
import { accountPlaceLabels, projectPlaceLabels } from ${JSON.stringify(join(root, 'web/src/app/places.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const controls = { viewerHandle: 'sample', onPalette() {}, onKeys() {}, onPicker() {} };
function Fixture() {
  const route = useRoute();
  return route.frame === 'account'
    ? <AccountFrame place={route.place} back={null} controls={controls}><h1>{accountPlaceLabels[route.place]}</h1></AccountFrame>
    : <ProjectFrame route={route} name="Tidepool" controls={controls}><h1>{projectPlaceLabels[route.place]}</h1></ProjectFrame>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

const frames = [
  {
    name: 'Project',
    base: '/-/sample/tidepool',
    tabs: [
      ['Needs me', ''],
      ['Lanes', '/lanes'],
      ['Plan', '/plan'],
      ['Code', '/code'],
    ],
    more: [
      ['Stats', '/stats'],
      ['Settings', '/settings'],
    ],
  },
  {
    name: 'Account',
    base: '/-/account',
    tabs: [
      ['Projects', ''],
      ['Billing', '/billing'],
      ['People', '/people'],
    ],
    more: [
      ['Sign-in and devices', '/devices'],
      ['Your data', '/data'],
    ],
  },
];

test('every project and account place is reachable from the phone tabs at 390 px', async t => {
  const launch = chromiumLaunchOptions(t);
  if (!launch) return;
  const temp = await mkdtemp(join(tmpdir(), 'forge-phone-navigation-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const out = join(temp, 'out');
  const html = join(temp, 'index.html');
  await writeFile(
    html,
    `<!doctype html><html lang="en" data-ds>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>Forge phone navigation</title><style>body{margin:0}</style></head>
    <body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>`,
  );
  await writeFile(join(temp, 'fixture.tsx'), fixture);
  const { output } = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: temp,
    envDir: false,
    logLevel: 'error',
    resolve: {
      alias: {
        react: dirname(require.resolve('react/package.json')),
        'react-dom': dirname(require.resolve('react-dom/package.json')),
      },
    },
    build: { outDir: out, rolldownOptions: { input: html } },
  });
  const layerPath =
    '/' + output.find(file => file.facadeModuleId?.endsWith('/ds/behaviour/index.ts')).fileName;
  const browser = await chromium.launch(launch);
  t.after(() => browser.close());

  for (const { name, base, tabs, more } of frames) {
    for (const theme of ['dark', 'light']) {
      await t.test(`${name} navigation in ${theme} theme`, async t => {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          hasTouch: true,
          isMobile: true,
          reducedMotion: 'reduce',
        });
        t.after(() => context.close());
        const page = await context.newPage();
        let release;
        const layerGate = new Promise(resolve => {
          release = resolve;
        });
        t.after(release);
        await page.addInitScript(theme => {
          document.addEventListener(
            'DOMContentLoaded',
            () => (document.documentElement.dataset.theme = theme),
          );
        }, theme);
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) return route.abort();
          const path = url.pathname;
          if (path === layerPath) await layerGate;
          return route.fulfill({
            path: path.startsWith('/fonts/')
              ? join(root, 'web/public', path)
              : join(out, route.request().isNavigationRequest() ? 'index.html' : path),
          });
        });
        await page.goto(origin + base);
        const nav = page.getByRole('navigation', { name, exact: true });
        const trigger = nav.getByRole('button', { name: 'More', exact: true });
        const menu = page.getByRole('menu', { name: 'More', exact: true });
        const current = nav.locator('[aria-current]');
        for (const [label, path] of tabs) {
          await nav.getByRole('link', { name: label, exact: true }).tap();
          assert.equal(page.url(), origin + base + path);
          assert.equal(await current.textContent(), label);
        }

        // More opens in place, clears the bar and exposes the complete list to assistive technology.
        const triggerBefore = await trigger.boundingBox();
        if (name === 'Account') {
          const cdp = await context.newCDPSession(page);
          const { x, y, width, height } = triggerBefore;
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: x + width / 2, y: y + height / 2 }],
          });
          release();
          await page.evaluate(async path => {
            await import(path);
            await new Promise(resolve => requestAnimationFrame(resolve));
          }, layerPath);
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else if (theme === 'light') {
          await trigger.focus();
          await page.keyboard.down('Space');
          release();
          await menu.waitFor();
          await page.keyboard.up('Space');
        } else {
          await trigger.tap();
          assert.equal(await menu.count(), 0, 'the first press arrives before the behaviour layer');
          release();
        }
        await menu.waitFor();
        await settleBrowserPage(page);
        assert.equal(page.url(), origin + base + tabs.at(-1)[1]);
        assert.deepEqual(await trigger.boundingBox(), triggerBefore);
        assert.ok(triggerBefore.height >= 40);
        const box = await menu.boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= triggerBefore.y, 'opens above the tab bar');
        assert.ok(box.x >= 0 && box.x + box.width <= 390, 'fits within the phone viewport');
        assert.deepEqual(
          await menu.getByRole('menuitem').allTextContents(),
          more.map(([label]) => label),
        );
        assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
        await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
        const violations = await page.evaluate(async () =>
          (await window.axe.run()).violations.map(v => v.id),
        );
        assert.deepEqual(violations, []);
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
        await trigger.and(page.locator(':focus')).waitFor();
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');

        // Keyboard users can enter, move through and activate the same destinations.
        for (const [index, [label, path]] of more.entries()) {
          await trigger.press('Enter');
          await menu.waitFor();
          if (index) await page.keyboard.press('ArrowDown');
          assert.equal(await page.locator(':focus').textContent(), label);
          await page.keyboard.press('Enter');
          await page.waitForURL(origin + base + path);
          await menu.waitFor({ state: 'hidden' });
          await page.getByRole('heading', { name: label, exact: true }).waitFor();
          assert.equal(await current.getAttribute('aria-current'), 'true');
          assert.equal(await current.textContent(), 'More');
        }
        await page.goBack();
        await page.getByRole('heading', { name: more[0][0], exact: true }).waitFor();
        assert.equal(await trigger.getAttribute('aria-current'), 'true');
        await page.goBack();
        await current.and(nav.getByRole('link', { name: tabs.at(-1)[0], exact: true })).waitFor();
      });
    }
  }
});

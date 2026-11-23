// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const project = '/sample/tidepool';
const shots = process.env.FORGE_SIDEBAR_SHOTS;
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AccountFrame, ProjectFrame } from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import { Head, crumbsFor } from ${JSON.stringify(join(root, 'web/src/app/Place.tsx'))};
import { useRoute } from ${JSON.stringify(join(root, 'web/src/app/router.ts'))};
import { accountPlaceLabels } from ${JSON.stringify(join(root, 'web/src/app/places.tsx'))};
import { ConvexProvider } from ${JSON.stringify(join(root, 'node_modules/convex/dist/esm/react/index.js'))};
import { Keys, useFrameKeys } from ${JSON.stringify(join(root, 'web/src/app/keys.tsx'))};
import { fakeConvex } from ${JSON.stringify(join(root, 'tests/convex-fake.mjs'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const backend = fakeConvex({ resolve() { throw Error('Navigation must not read Convex'); } });
window.fixtureConvexStats = backend.stats;
const feed = { lanes: [], more: 0, moreIsLowerBound: false, main: null };
function Fixture() {
  const route = useRoute();
  const [palette, setPalette] = React.useState(false);
  const [keys, setKeys] = React.useState(false);
  const go = { route, openPalette: () => setPalette(true), openKeys: () => setKeys(true), signOut() {} };
  useFrameKeys(go);
  const controls = { viewerHandle: 'sample', onPalette: go.openPalette, onKeys: go.openKeys, onPicker() {} };
  return route.frame === 'account'
    ? <AccountFrame place={route.place} back={null} controls={controls}><h1>{accountPlaceLabels[route.place]}</h1></AccountFrame>
    : <ProjectFrame route={route} projectId="tidepool" name="Tidepool" feed={feed} needs={{ n: 2 }} controls={controls}>
      <Head trail={crumbsFor(route, 'Tidepool')} sentence={<><b>Project activity</b> and recent work.</>} />
      <section aria-label="Fixture results"><label>Find a result <input /></label></section>
      <Keys go={go} palette={palette} setPalette={setPalette} keys={keys} setKeys={setKeys} projectId="tidepool" />
    </ProjectFrame>;
}
createRoot(document.getElementById('root')).render(<ConvexProvider client={backend.client}><Fixture /></ConvexProvider>);
`;

const frames = [
  {
    name: 'Project',
    base: project,
    tabs: [
      ['Needs me', ''],
      ['Lanes', '/lanes'],
      ['Plan', '/plan'],
      ['Code', '/code'],
    ],
    more: [
      ['Stats', '/stats'],
      ['People and access', '/settings'],
      ['Landing and checks', '/settings/checks'],
      ['GitHub mirror', '/settings/mirror'],
      ['Secrets', '/settings/secrets'],
      ['Agents', '/settings/agents'],
      ['Project', '/settings/project'],
      ['You', '/settings/you'],
    ],
  },
  {
    name: 'Account',
    base: '/account',
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

test('project pages stay reachable by sidebar, flyout and phone sheets, with stable addresses', async t => {
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
  if (shots) await mkdir(shots, { recursive: true });

  async function assets(page, layerGate) {
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      const path = url.pathname;
      if (path === layerPath && layerGate) await layerGate;
      return route.fulfill({
        path: path.startsWith('/fonts/')
          ? join(root, 'web/public', path)
          : join(out, route.request().isNavigationRequest() ? 'index.html' : path),
      });
    });
  }

  async function axe(page) {
    await settleBrowserPage(page);
    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.map(v => v.id)), []);
  }

  for (const theme of ['dark', 'light']) {
    await t.test(`wide and narrow rail, focus, local storage and Back in ${theme}`, async t => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 800 },
        colorScheme: theme,
      });
      t.after(() => context.close());
      await context.addInitScript(() => {
        localStorage.setItem(
          'forge.plan.views.tidepool',
          JSON.stringify(
            Array.from({ length: 12 }, (_, index) => ({
              name: `Saved ${index + 1}`,
              query: `?type=sample-${index + 1}`,
            })),
          ),
        );
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await assets(page);
      const detail = '/lanes/11223344-5566-4778-8990-112233445566';
      for (const width of [1440, 1024]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(origin + project);
        const heading = page.getByRole('heading', { level: 1, name: 'Now', exact: true });
        await heading.waitFor();
        const { width: headingWidth, height: headingHeight } = await heading.boundingBox();
        assert.deepEqual([headingWidth, headingHeight], [1, 1], 'the top-level heading is visually hidden');
        assert.equal(await heading.getByRole('link').count(), 0, 'the hidden heading adds no Tab stops');
        assert.equal(await heading.evaluate(node => getComputedStyle(node).clipPath), 'inset(50%)');
        if (shots) await page.screenshot({ path: join(shots, `head-place-${width}-${theme}.png`) });

        await page.goto(origin + project + detail);
        const parent = page
          .getByRole('heading', { level: 1 })
          .getByRole('link', { name: 'Open', exact: true });
        await parent.waitFor();
        assert.equal(await parent.getAttribute('href'), project + '/lanes');
        assert.ok((await parent.boundingBox()).width > 1, 'detail pages keep the trail back to the place');
        if (shots) await page.screenshot({ path: join(shots, `head-detail-${width}-${theme}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 800 });
      await page.goto(origin + project + '/lanes/history');
      const nav = page.locator('.rail');
      const lanes = nav.getByRole('link', { name: 'Lanes', exact: true });
      const history = nav.getByRole('link', { name: 'History' });
      await history.waitFor();
      assert.equal((await nav.boundingBox()).width, 224);
      assert.equal((await page.locator('main').boundingBox()).y, 48);
      assert.equal(await lanes.getAttribute('aria-current'), 'true');
      assert.equal(await history.getAttribute('aria-current'), 'page');
      assert.match(await nav.ariaSnapshot(), /group "Lanes pages":[\s\S]*link "History"/);
      await axe(page);
      if (shots) await page.screenshot({ path: join(shots, `expanded-${theme}.png`) });

      const requests = [];
      page.on('request', request => requests.push(request.url()));
      await history.focus();
      await page.keyboard.press('[');
      await lanes.and(page.locator(':focus')).waitFor();
      await nav.getByRole('button', { name: 'Expand sidebar' }).waitFor();
      assert.equal((await nav.boundingBox()).width, 56);
      const needs = nav.getByRole('link', { name: 'Needs me', exact: true });
      assert.equal(await needs.locator('.cnt').textContent(), '2');
      assert.deepEqual(requests, [], 'collapsing sends no request');
      assert.equal(await page.evaluate(() => window.fixtureConvexStats.executions), 0);
      await page.keyboard.press('ArrowRight');
      await history.and(page.locator(':focus')).waitFor();
      await nav.getByRole('link', { name: 'Plan', exact: true }).hover();
      await history.and(page.locator(':focus')).waitFor();
      await page.keyboard.press('ArrowUp');
      await nav.getByRole('link', { name: 'Open', exact: true }).and(page.locator(':focus')).waitFor();
      await page.keyboard.press('ArrowUp');
      await nav.getByRole('link', { name: 'Sessions' }).and(page.locator(':focus')).waitFor();
      await page.keyboard.press('Escape');
      await lanes.and(page.locator(':focus')).waitFor();
      await history.waitFor({ state: 'hidden' });
      assert.doesNotMatch(await nav.ariaSnapshot(), /link "History"/);
      await page.keyboard.press('Tab');
      await nav.getByRole('link', { name: 'Plan', exact: true }).and(page.locator(':focus')).waitFor();
      await page.getByRole('textbox', { name: 'Find a result' }).fill('[');
      assert.equal(await page.locator('.shell').getAttribute('data-rail'), 'shut');
      await page.keyboard.press('[');
      assert.equal(await page.locator('.shell').getAttribute('data-rail'), 'shut');

      await page.setViewportSize({ width: 1024, height: 768 });
      await lanes.hover();
      await history.waitFor();
      await axe(page);
      if (shots) await page.screenshot({ path: join(shots, `collapsed-${theme}.png`) });
      await nav.getByRole('link', { name: 'Who is touching what' }).click();
      await page.waitForURL(origin + project + '/lanes/touching');
      await page.locator('main:focus').waitFor();
      await lanes.focus();
      await page.keyboard.press('ArrowRight');
      await nav.getByRole('link', { name: 'Who is touching what' }).and(page.locator(':focus')).waitFor();
      await page.goBack();
      await page.waitForURL(origin + project + '/lanes/history');
      await lanes.and(page.locator(':focus')).waitFor();
      await nav.getByRole('button', { name: 'Expand sidebar' }).click();
      await page.reload();
      await nav.getByRole('button', { name: 'Collapse sidebar' }).waitFor();
      assert.equal((await nav.boundingBox()).width, 224);
      await page.setViewportSize({ width: 1440, height: 800 });
      await nav.getByRole('button', { name: 'Expand sidebar' }).waitFor();
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('forge.rail'))), {
        wide: 'shut',
        narrow: 'open',
      });
      const second = await context.newPage();
      await assets(second);
      await second.goto(origin + project);
      await second.getByRole('button', { name: 'Expand sidebar' }).click();
      await nav.getByRole('button', { name: 'Collapse sidebar' }).waitFor();
      await history.focus();
      await second.getByRole('button', { name: 'Collapse sidebar' }).click();
      await nav.getByRole('button', { name: 'Expand sidebar' }).waitFor();
      await lanes.and(page.locator(':focus')).waitFor();
      await second.getByRole('button', { name: 'Expand sidebar' }).click();
      await nav.getByRole('button', { name: 'Collapse sidebar' }).waitFor();
      await second.setViewportSize({ width: 1024, height: 768 });
      await second.getByRole('button', { name: 'Collapse sidebar' }).click();
      await history.focus();
      await page.setViewportSize({ width: 1024, height: 768 });
      await nav.getByRole('button', { name: 'Expand sidebar' }).waitFor();
      await lanes.and(page.locator(':focus')).waitFor();
      await nav.getByRole('button', { name: 'Expand sidebar' }).click();
      await page.setViewportSize({ width: 1440, height: 800 });
      await second.evaluate(() => {
        const key = 'forge.plan.views.tidepool';
        const views = JSON.parse(localStorage.getItem(key));
        localStorage.setItem(
          key,
          JSON.stringify([{ name: 'Release readiness', query: '?type=release' }, ...views]),
        );
      });

      await page.keyboard.press('Control+k');
      const palette = page.getByRole('dialog', { name: 'Go to or run' });
      await palette.getByRole('searchbox').fill('Plan: Saved 12');
      await palette.getByRole('menuitem', { name: 'Plan: Saved 12' }).click();
      await page.waitForURL(origin + project + '/plan?type=sample-12');
      const overflow = nav.getByRole('button', { name: 'All saved views' });
      assert.equal(await overflow.getAttribute('aria-current'), 'true');
      await overflow.click();
      assert.equal(await page.getByRole('menuitem', { name: 'Release readiness' }).count(), 1);
      await page.getByRole('menuitem', { name: 'Saved 11' }).click();
      await page.waitForURL(origin + project + '/plan?type=sample-11');
      await page.setViewportSize({ width: 1240, height: 500 });
      const foot = await nav.getByRole('button', { name: 'Collapse sidebar' }).boundingBox();
      assert.equal(foot.y + foot.height, 500);
      assert.equal(
        await nav.locator('.rail-list').evaluate(node => node.scrollHeight > node.clientHeight),
        true,
      );
      assert.deepEqual(errors, []);
    });
  }

  await t.test('touch tablet pins one flyout and storage denial keeps session choices', async t => {
    const context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      hasTouch: true,
      isMobile: true,
    });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw Error('Storage is off');
        },
      });
    });
    await assets(page);
    await page.goto(origin + project);
    const nav = page.locator('.rail');
    const settings = nav.getByRole('link', { name: 'Settings', exact: true });
    const secrets = nav.getByRole('link', { name: 'Secrets' });
    await settings.tap();
    await secrets.waitFor();
    await nav.getByRole('link', { name: 'Code', exact: true }).hover();
    await secrets.waitFor();
    assert.equal(page.url(), origin + project);
    await settings.tap();
    await secrets.waitFor({ state: 'hidden' });
    await settings.tap();
    await page.locator('main .sit').tap();
    await secrets.waitFor({ state: 'hidden' });
    await settings.tap();
    await secrets.tap();
    await page.waitForURL(origin + project + '/settings/secrets');
    await nav.getByRole('link', { name: 'Stats', exact: true }).tap();
    await page.waitForURL(origin + project + '/stats');
    await nav.getByRole('button', { name: 'Expand sidebar' }).tap();
    await nav.getByRole('button', { name: 'Collapse sidebar' }).waitFor();
  });

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
        await assets(page, layerGate);
        await page.goto(origin + base);
        if (name === 'Project') {
          await page
            .getByRole('heading', { level: 1 })
            .getByRole('button', { name: 'Needs me: Now. Choose a page' })
            .waitFor();
        }
        const nav = page.getByRole('navigation', { name, exact: true });
        const trigger = nav.getByRole('button', { name: 'More', exact: true });
        const menu = page.getByRole('menu', { name: 'More', exact: true });
        const current = nav.locator('[aria-current]');
        for (const [, path] of tabs) {
          await nav.locator(`a[href="${base + path}"]`).tap();
          assert.equal(page.url(), origin + base + path);
          assert.equal(await current.getAttribute('href'), base + path);
        }

        if (name === 'Project') {
          await nav.getByRole('link', { name: 'Lanes', exact: true }).tap();
          const title = page.getByRole('button', { name: 'Lanes: Open. Choose a page' });
          await title.tap();
          const pages = page.getByRole('dialog', { name: 'Lanes' });
          assert.equal(await pages.count(), 0, 'the first press arrives before the behaviour layer');
          release();
          await pages.getByRole('link', { name: 'History' }).tap();
          await page.waitForURL(origin + base + '/lanes/history');
          await page.locator('main:focus').waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
          await axe(page);
          if (shots) await page.screenshot({ path: join(shots, `phone-${theme}.png`) });
          await page.getByRole('button', { name: 'Lanes: History. Choose a page' }).tap();
          await pages.waitFor();
          await axe(page);
          assert.equal(
            await pages.getByRole('link', { name: 'History' }).getAttribute('aria-current'),
            'page',
          );
          assert.match(await pages.ariaSnapshot(), /dialog "Lanes":[\s\S]*link "History"/);
          if (shots) await page.screenshot({ path: join(shots, `phone-pages-${theme}.png`) });
          await pages.getByRole('button', { name: 'Close' }).click();
          await page
            .getByRole('button', { name: 'Lanes: History. Choose a page' })
            .and(page.locator(':focus'))
            .waitFor();

          await trigger.press('Enter');
          const sheet = page.getByRole('dialog', { name: 'More' });
          await sheet.waitFor();
          assert.deepEqual(
            await sheet.getByRole('link').allTextContents(),
            more.map(([label]) => label),
          );
          await axe(page);
          await page.keyboard.press('Escape');
          await trigger.and(page.locator(':focus')).waitFor();
          for (const [label, path] of more) {
            await trigger.tap();
            await sheet.getByRole('link', { name: label, exact: true }).tap();
            await page.waitForURL(origin + base + path);
            await sheet.waitFor({ state: 'hidden' });
            assert.equal(await trigger.getAttribute('aria-current'), 'true');
          }
          await page.goBack();
          await page.waitForURL(origin + base + '/settings/project');
          await page.getByRole('button', { name: 'Settings: Project. Choose a page' }).waitFor();
          if (shots) {
            await trigger.tap();
            await sheet.getByRole('link', { name: 'Landing and checks' }).tap();
            await sheet.waitFor({ state: 'hidden' });
            await trigger.tap();
            await sheet.getByRole('link', { name: 'Landing and checks' }).waitFor();
            await page.waitForFunction(() => {
              const scrim = document.querySelector('.scrim');
              return scrim && getComputedStyle(scrim).opacity === '1';
            });
            await page.screenshot({ path: join(shots, `phone-more-${theme}.png`) });
          }
          return;
        }

        // More opens in place, clears the bar and exposes the complete list to assistive technology.
        const triggerBefore = await trigger.boundingBox();
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

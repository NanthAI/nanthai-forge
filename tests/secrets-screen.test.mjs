// SPDX-License-Identifier: Apache-2.0
// The actual screen and frame, with synthetic metadata only: values have no entry or display surface; access-loss,
// failure and partial-page states are honest; commands are inert, quoted proposals; both widths and themes pass axe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';
import { moduleUrl } from './convex-module.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { secretSetCommand, secretsView } = await import(moduleUrl('../web/src/app/secrets/secrets-model.ts'));

test('the stub has no invented data; proposed commands quote a metadata name as one inert shell argument', () => {
  assert.deepEqual(secretsView(), { status: 'unavailable' });
  assert.equal(secretSetCommand('SERVICE_KEY', 'checks'), 'nforge secret set SERVICE_KEY --set checks');
  const hostile = "x' ; $(false)";
  assert.equal(secretSetCommand(hostile, 'development'), "nforge secret set 'x'\\'' ; $(false)'");
});

test('Secrets: value-free screen, honest states, accessible themes and zero protocol activity', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const server = await createServer({
    root: join(root, 'web'),
    configFile: false,
    logLevel: 'silent',
    cacheDir: join(root, 'node_modules/.cache/secrets-vite'),
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    plugins: [
      {
        name: 'secrets-test-only',
        configureServer(s) {
          s.middlewares.use('/fixture.html', (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(
              `<html lang="en"><head><title>Secrets fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="/@fs/${root}tests/browser/secrets.tsx"></script></body></html>`,
            );
          });
        },
      },
    ],
  });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch(launchOptions);
  t.after(() => browser.close());
  const context = await browser.newContext({
    locale: 'en-US',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const errors = [];
  const protocol = [];
  page.on('pageerror', () => errors.push('pageerror'));
  page.on('request', req => {
    if (req.method() !== 'GET' || !req.url().startsWith(base)) protocol.push('unexpected request');
  });
  const open = async (state = 'calm', theme = 'dark') => {
    await page.goto(`${base}/fixture.html?state=${state}&theme=${theme}`);
    await page.getByRole('heading', { name: 'Secrets', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  const show = name =>
    page.evaluate(name => window.secretsFixture.show(window.secretsFixture.state(name)), name);
  const shots = process.env.FORGE_SECRETS_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const capture = async name => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  };

  await t.test(
    'today’s stub explains runner passthrough without pretending the sealed protocol exists',
    async () => {
      await open('unavailable');
      assert.equal(await page.getByText('Sealed secrets are not connected yet.', { exact: true }).count(), 1);
      assert.equal(await page.getByRole('region', { name: 'Names', exact: true }).count(), 0);
      assert.equal(await page.locator('input,textarea,[contenteditable=true]').count(), 0);
      await page.getByRole('button', { name: 'nforge agent . secrets Proposed' }).click();
      assert.equal(await page.locator('#secrets-cli').isVisible(), true);
      assert.ok(
        (await page.locator('#secrets-cli').innerText()).includes('awaits the sealed-secret protocol'),
      );
      await page.getByRole('button', { name: 'nforge agent . secrets Proposed' }).press('Enter');
      assert.equal(await page.locator('#secrets-cli').count(), 0);
      // Item 0485fe7d: on a wide window the two guidance columns sit side by side, not one narrow column.
      const [today, planned] = await page
        .locator('.secret-guidance')
        .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
      assert.ok(planned.left >= today.right && Math.abs(planned.top - today.top) < 2);
      await capture('unavailable');
    },
  );

  await t.test(
    'names and counts match; no value fields, unknown payloads or executable metadata render',
    async () => {
      await open();
      assert.ok((await page.locator('.sit').innerText()).startsWith('6 secrets in 2 sets.'));
      assert.equal(await page.locator('.row.secret-name').count(), 6);
      assert.equal(await page.locator('input:not([type=radio]),textarea,[contenteditable=true]').count(), 0);
      await page.evaluate(() => {
        const view = window.secretsFixture.state('calm');
        view.metadata.value = 'hidden-fixture-marker';
        view.metadata.sets[0].names[0].value = 'hidden-fixture-marker';
        view.metadata.sets[0].names[0].name = '<img src=x onerror="window.executed=true">';
        window.secretsFixture.show(view);
      });
      assert.equal(await page.locator('.secrets-screen img').count(), 0);
      assert.equal(
        await page.evaluate(() => document.body.innerHTML.includes('hidden-fixture-marker')),
        false,
      );
      assert.equal(await page.evaluate(() => Boolean(window.executed)), false);
    },
  );

  await t.test(
    'copy is a name-only proposal, works by keyboard, and clipboard failure stays generic',
    async () => {
      await open('rotate');
      const copy = page.getByRole('button', { name: 'Copy command', exact: true }).first();
      await copy.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('status').filter({ hasText: 'Command copied.' }).waitFor();
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        'nforge secret set DEV_SERVICE_URL',
      );
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText() {
              throw Error('private error fixture');
            },
          },
        }),
      );
      await page.getByRole('button', { name: 'Copy command', exact: true }).first().click();
      await page.getByRole('status').filter({ hasText: 'Could not copy the command.' }).waitFor();
      assert.equal(
        await page.evaluate(() => document.body.innerHTML.includes('private error fixture')),
        false,
      );
    },
  );

  await t.test(
    'a failed read keeps explicit previous names; forbidden state drops even a stale supplied snapshot',
    async () => {
      await open('failed');
      assert.equal(await page.locator('.row.secret-name').count(), 6);
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      assert.equal(await page.evaluate(() => window.secretsFixture.retries), 1);
      await page.evaluate(() =>
        window.secretsFixture.show({
          status: 'forbidden',
          previous: window.secretsFixture.data,
          metadata: window.secretsFixture.data,
        }),
      );
      await page.getByText('Secrets are for people who can write.', { exact: true }).waitFor();
      assert.equal(await page.locator('.row.secret-name').count(), 0);
      assert.equal(await page.getByRole('region', { name: 'Recent', exact: true }).count(), 0);
      await show('failed-empty');
      await page.getByText('No secret metadata was returned.', { exact: true }).waitFor();
    },
  );

  await t.test(
    'partial counts reconcile and lone reissuable holders do not trigger a recovery warning',
    async () => {
      await open('worst');
      assert.equal(await page.getByText('60 of 120 names shown.', { exact: true }).count(), 1);
      assert.equal(await page.getByText('50 of 1,200 holders shown.', { exact: true }).count(), 1);
      await show('one');
      await page.getByText('1 secret in 2 sets.', { exact: true }).waitFor();
      assert.equal(await page.locator('.row.secret-name').count(), 1);
      assert.ok((await page.locator('.sit').innerText()).includes('1 name has no value.'));
      await show('single-reissuable');
      assert.equal(await page.getByText('One holder', { exact: true }).count(), 0);
      await show('single');
      await page.getByText('One holder', { exact: true }).waitFor();
      assert.equal(await page.getByText(/print.*recovery key/i).count(), 0);
      await show('member');
      await page.getByText('Automatic.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Remove', exact: true }).count(), 0);
      assert.equal(await page.getByRole('radio').count(), 0);
    },
  );

  await t.test('all states: axe and no horizontal overflow at 1440 and 390, in both themes', async () => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const theme of ['dark', 'light']) {
        await open('calm', theme);
        await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
        for (const name of [
          'calm',
          'rotate',
          'waiting',
          'single',
          'empty',
          'one',
          'reader',
          'member',
          'failed',
          'failed-empty',
          'loading',
          'unavailable',
          'worst',
        ]) {
          await show(name);
          await page.evaluate(() => new Promise(requestAnimationFrame));
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `no overflow: ${width} ${theme} ${name}`,
          );
          const violations = await page.evaluate(async () =>
            (
              await window.axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
              })
            ).violations.map(v => v.id),
          );
          assert.deepEqual(violations, [], `axe: ${width} ${theme} ${name}`);
          if (
            [
              'calm',
              'rotate',
              'waiting',
              'single',
              'empty',
              'one',
              'reader',
              'member',
              'failed',
              'worst',
            ].includes(name)
          )
            await capture(`${name}-${width}-${theme}`);
        }
      }
    }
  });

  if (shots) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = [];
    for (const state of ['calm', 'double']) {
      const start = performance.now();
      await open(state);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const { metrics: browserMetrics } = await cdp.send('Performance.getMetrics');
      metrics.push({
        names: await page.locator('.row.secret-name').count(),
        renderWallMs: performance.now() - start,
        jsHeapUsedBytes: browserMetrics.find(m => m.name === 'JSHeapUsedSize')?.value,
        convexCalls: 0,
        dbIoBytes: 0,
        storageBytes: 0,
        landingCostDeltaPer1000: 0,
        provenance:
          'synthetic metadata fixture, one fresh navigation; not billed usage or a performance claim',
      });
    }
    writeFileSync(join(shots, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  }

  await t.test('an idle or hidden screen schedules no protocol calls or storage writes', async () => {
    await open();
    const before = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }));
    await page.clock.install();
    await page.clock.fastForward(600_000);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward(600_000);
    assert.deepEqual(
      await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })),
      before,
    );
    assert.deepEqual(protocol, []);
    assert.deepEqual(errors, []);
  });
});

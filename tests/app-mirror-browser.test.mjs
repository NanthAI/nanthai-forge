// SPDX-License-Identifier: Apache-2.0
// P8: the real import and mirror components preserve choices, confirm only disconnect, and work by keyboard in both themes.
import test from 'node:test';
import { settleBrowserPage } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.FORGE_MIRROR_SHOTS;

test('import defaults to two-way; mirror pauses/resumes the retained link and confirms disconnect, with accessible layouts', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-mirror-ui-'));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  const shim = join(temp, 'convex.ts');
  const real = join(root, 'node_modules/convex/dist/esm/react/index.js');
  writeFileSync(
    shim,
    `export * from ${JSON.stringify(real)};
    import { useSyncExternalStore } from 'react';
    export function useConvex() { return window.client; }
    export function useQuery() { return useSyncExternalStore(window.subscribe, () => window.mirror); }
  `,
  );
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mirror · Forge</title></head><body><main id="root"></main><script type="module" src="./fixture.tsx"></script></body></html>',
  );
  writeFileSync(
    join(temp, 'fixture.tsx'),
    `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import Mirror from ${JSON.stringify(join(root, 'web/src/app/mirror/Mirror.tsx'))};
    import ImportRepository from ${JSON.stringify(join(root, 'web/src/app/start/ImportRepository.tsx'))};
    import { mirrorSummary } from ${JSON.stringify(join(root, 'src/github-mirror-sentence.ts'))};
    import { getFunctionName } from 'convex/server';
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/tokens.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/base.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/core.css'))};
    window.calls = [];
    const listeners = new Set();
    window.subscribe = f => { listeners.add(f); return () => listeners.delete(f); };
    let legacy = new URLSearchParams(location.search).has('legacy');
    let policy = { githubMirror: { repo: 'example/parser', autoPush: !legacy, inbound: !legacy, laneRefs: false } };
    let pausedInbound = false;
    const status = { repository: 'example/parser', status: 'synced', lagging: false, targetHead: 'a'.repeat(64), mirroredHead: 'a'.repeat(64), gitHead: 'b'.repeat(40), mirroredAt: 1800000000000 };
    const refresh = () => { window.mirror = { ...mirrorSummary(policy.githubMirror ? { ...policy.githubMirror, paused: !legacy && !policy.githubMirror.autoPush } : null, status), owner: true, repoId: policy.githubMirror && !new URLSearchParams(location.search).has('unbound') ? 42 : null, inbound: policy.githubMirror?.autoPush === false ? (legacy || pausedInbound) : policy.githubMirror?.inbound === true, ends: policy.githubMirror ? { forgeHead: status.targetHead, mirroredHead: status.mirroredHead, gitHead: status.gitHead, mirroredAt: status.mirroredAt } : null }; listeners.forEach(f => f()); };
    window.client = {
      query: async () => policy,
      mutation: async (ref, args) => {
        const name = getFunctionName(ref); window.calls.push({ name, args });
        if (name === 'projectAutonomy:set') { const next = JSON.parse(args.command).githubMirror; if (policy.githubMirror?.autoPush && !next.autoPush) pausedInbound = policy.githubMirror.inbound; policy = { githubMirror: next }; if (next.autoPush) legacy = false; }
        if (name === 'githubBindingStore:remove') policy = {};
        refresh();
      },
      action: async () => ({ repository: 'example/parser', origin: 'public', choices: ['public', 'private'], ref: 'main', commit: 'c'.repeat(40), files: 2914, bytes: 8300000, submodules: 0, lfs: 'No LFS objects.', warnings: [] }),
    };
    refresh();
    const route = { frame: 'project', handle: 'example', project: 'parser', place: 'settings', section: 'mirror', rest: '' };
    createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('import') ? <ImportRepository /> : <Mirror route={route} projectId="synthetic" projectName="Parser" />);
  `,
  );
  const { build } = await import('vite');
  await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: temp,
    base: '/',
    envDir: false,
    logLevel: 'error',
    resolve: {
      alias: [
        { find: /^convex\/react$/, replacement: shim },
        { find: /^react\//, replacement: dirname(require.resolve('react/package.json')) + '/' },
        { find: /^react$/, replacement: dirname(require.resolve('react/package.json')) },
        { find: /^react-dom\//, replacement: dirname(require.resolve('react-dom/package.json')) + '/' },
        { find: /^convex\/server$/, replacement: join(root, 'node_modules/convex/dist/esm/server/index.js') },
      ],
    },
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: html } },
  });
  if (shots) mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  t.after(async () => {
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'forge.test') return route.abort();
    const path = url.pathname.slice(1);
    const file = path.startsWith('fonts/') ? join(root, 'web/public', path) : join(out, path);
    const asset = path && existsSync(file);
    return route.fulfill({
      contentType: !asset
        ? 'text/html'
        : file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'application/octet-stream',
      body: readFileSync(asset ? file : join(out, 'fixture.html')),
    });
  });
  await page.goto('https://forge.test/-/example/parser/settings/mirror');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  assert.match(await page.locator('.sit').textContent(), /paused/);
  assert.equal(await page.getByRole('switch').isChecked(), true);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  const calls = await page.evaluate(() => window.calls);
  assert.equal(JSON.parse(calls[0].args.command).githubMirror.autoPush, false);
  assert.equal(JSON.parse(calls[0].args.command).githubMirror.inbound, false);
  assert.equal(calls.at(-1).name, 'projectGithubMirrorResume:resume');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: 'Keep the mirror' }).evaluate(e => e === document.activeElement),
    true,
  );
  assert.equal(
    (await page.evaluate(() => window.calls)).some(c => c.name === 'githubBindingStore:remove'),
    false,
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  for (const width of [1440, 390])
    for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
      await settleBrowserPage(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
      const result = await page.evaluate(() =>
        window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }),
      );
      assert.deepEqual(
        result.violations.map(v => ({
          id: v.id,
          targets: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })),
        })),
        [],
      );
      if (shots) await page.screenshot({ path: join(shots, `mirror-${width}-${theme}.png`), fullPage: true });
    }
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('button', { name: 'Allow on GitHub' }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.calls)).filter(c => c.name === 'githubBindingStore:remove').length,
    1,
  );
  await page.goto('https://forge.test/-/example/parser/settings/mirror?legacy=1');
  await page.getByRole('heading', { name: 'Turn the mirror on', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (shots) await page.screenshot({ path: join(shots, 'mirror-legacy-off.png'), fullPage: true });
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  assert.equal(
    JSON.parse((await page.evaluate(() => window.calls))[0].args.command).githubMirror.inbound,
    true,
  );
  await page.goto('https://forge.test/-/example/parser/settings/mirror?unbound=1');
  assert.match(await page.locator('.mr').textContent(), /without a new GitHub approval/);
  assert(!(await page.locator('.mr').textContent()).includes('Reconnecting this stored link'));
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByRole('button', { name: 'Allow on GitHub' }).waitFor();
  const named = await page.evaluate(() => window.calls.at(-1));
  assert.equal(named.name, 'githubBindingStore:remove');
  assert.equal(named.args.repoId, 0);
  assert.equal(named.args.repository, 'example/parser');
  await page.goto('https://forge.test/-/new/import?import=1');
  await page.getByLabel('Address', { exact: true }).fill('https://github.com/example/parser');
  await page.getByRole('button', { name: 'Check it', exact: true }).click();
  const both = page.getByRole('checkbox', { name: 'Keep GitHub in sync both ways' });
  await both.waitFor();
  assert.equal(await both.isChecked(), true);
  await both.focus();
  await page.keyboard.press('Space');
  assert.match(await page.locator('.im-q').last().locator('..').textContent(), /One-way mirror/);
  await both.check();
  for (const width of [1440, 390])
    for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
      await settleBrowserPage(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
      const audit = await page.evaluate(() =>
        window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }),
      );
      assert.deepEqual(
        audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
        [],
      );
      if (shots) await page.screenshot({ path: join(shots, `import-${width}-${theme}.png`), fullPage: true });
    }
  assert.deepEqual(errors, []);
});

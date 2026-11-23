// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Incident replay (Item ee9899ca, 2026-11-20): signed in on the live site, the owner pasted the Item id 1d69905b
// into ⌘K and got "Nothing matches.". Every address under /- is the rebuilt app, and its palette (app/keys.tsx)
// had no id search. This drives that real palette: a typed id sends one debounced lookup (three existing reads,
// together), says it is looking until the answer, offers the Item, and Enter opens it; a failed read drops only its
// own rows; an idle or reopened palette sends nothing. Accessible, no sideways scroll at 1440 and 390 px in both
// themes. Set FORGE_ID_PALETTE_SHOTS to a folder to also save the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { settleBrowserPage } from './browser-runtime.mjs';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.FORGE_ID_PALETTE_SHOTS;
const itemId = '1d69905b-6539-42d9-a8ed-519234dbf9c6';

test('the rebuilt ⌘K palette finds an Item by a pasted id with one lookup, and opens it', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-id-palette-'));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  const shim = join(temp, 'convex.ts');
  writeFileSync(
    shim,
    `export * from ${JSON.stringify(join(root, 'node_modules/convex/dist/esm/react/index.js'))};
    export function useConvex() { return window.client; }`,
  );
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Parser · Forge</title></head><body><main id="root"><h1>Parser</h1></main><div id="app"></div><script type="module" src="./fixture.tsx"></script></body></html>',
  );
  writeFileSync(
    join(temp, 'fixture.tsx'),
    `
    import React, { useEffect, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { getFunctionName } from 'convex/server';
    import { ConvexError } from 'convex/values';
    import { Keys, useFrameKeys } from ${JSON.stringify(join(root, 'web/src/app/keys.tsx'))};
    import { parseAppPath } from ${JSON.stringify(join(root, 'web/src/app/paths.ts'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/tokens.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/base.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/core.css'))};
    window.calls = [];
    // Replies wait for window.release(), so the test sees the palette before the answer arrives.
    let held = [];
    window.release = () => { held.forEach(run => run()); held = []; };
    window.landingFails = false;
    // Like the server, an 8-character prefix or the full UUID (spaced search text) names the Item.
    const reply = (name, args) => {
      if (name === 'projectHostedPlanningSearch:search')
        return JSON.stringify({ items: ({
          '1d69905b': [{ id: ${JSON.stringify(itemId)}, kind: 'issue', title: 'Speed series follow-ups', matchedBy: 'id' }],
          abcdef12: [{ id: 'abcdef12-0000-4000-8000-000000000001', kind: 'issue', title: 'Second Item', matchedBy: 'id' }],
        })[args.text.slice(0, 8)] ?? [] });
      if (name === 'projectHostedLaneHistory:resolveLaneId') return JSON.stringify({ ids: [], more: false });
      throw new ConvexError(window.landingFails ? { code: 'HOSTED_ACTION_FAILED', message: 'Retry' } : { code: 'NOT_FOUND', message: 'No landing' });
    };
    window.client = {
      query: (ref, args) => {
        const name = getFunctionName(ref);
        window.calls.push({ name, args });
        return new Promise((resolve, reject) => held.push(() => { try { resolve(reply(name, args)); } catch (error) { reject(error); } }));
      },
    };
    function Fixture() {
      const [palette, setPalette] = useState(false);
      const [keys, setKeys] = useState(false);
      const go = { route: parseAppPath('/example/parser'), openPalette: () => setPalette(true), openKeys: () => setKeys(true), signOut() {} };
      useFrameKeys(go);
      // useFrameKeys adds the ⌘K listener in an effect after the first paint; this later effect in the same component
      // runs after it, so the test presses ⌘K only once the palette can hear it (Item 6a18b123: on loaded runners the
      // first press came before the listener and the palette never opened).
      useEffect(() => { document.documentElement.dataset.keysReady = ''; }, []);
      return <Keys go={go} palette={palette} setPalette={setPalette} keys={keys} setKeys={setKeys} projectId="synthetic" />;
    }
    createRoot(document.getElementById('app')).render(<Fixture />);
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
        // The fixture throws the same ConvexError class the palette reads codes from.
        { find: /^convex\/values$/, replacement: join(root, 'node_modules/convex/dist/esm/values/index.js') },
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
  await page.goto('https://forge.test/example/parser');
  await page.waitForFunction(() => 'keysReady' in document.documentElement.dataset);
  const calls = () => page.evaluate(() => window.calls);
  const input = page.getByRole('searchbox', { name: 'Search' });
  const open = async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await input.waitFor();
  };
  // Idle: an open palette and a typed place name send nothing.
  await open();
  await input.pressSequentially('Plan');
  await page.getByRole('menuitem', { name: 'Plan' }).waitFor();
  assert.deepEqual(await calls(), []);
  // Typing the id key by key, as on a phone: one lookup once typing settles, its three reads sent together.
  await input.fill('');
  await input.pressSequentially('1d69905b');
  await page.getByText('Looking up 1d69905b…').waitFor();
  await page.waitForFunction(() => window.calls.length === 3);
  assert.deepEqual(
    (await calls()).map(call => call.name),
    [
      'projectHostedPlanningSearch:search',
      'projectHostedLaneHistory:resolveLaneId',
      'projectHostedLandings:read',
    ],
  );
  await page.evaluate(() => window.release());
  const found = page.getByRole('menuitem', { name: '1d69905b · Speed series follow-ups' });
  await found.waitFor();
  assert.equal(await page.getByText('Nothing matches.').count(), 0);
  for (const width of [1440, 390])
    for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
      await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
      await settleBrowserPage(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
      const result = await page.evaluate(() =>
        window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }),
      );
      assert.deepEqual(
        result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
        [],
      );
      if (shots) await page.screenshot({ path: join(shots, `id-palette-${width}-${theme}.png`) });
    }
  // Enter opens the Item at its rebuilt address.
  await input.press('Enter');
  await page.waitForFunction(id => location.pathname === `/example/parser/plan/${id}`, itemId);
  // Reopened, the palette starts empty with no stale result. Within one opening the same id in any form is answered
  // from the first lookup; a new opening asks again, so an id filed meanwhile is found (review 4cb180d5 finding 2).
  await open();
  assert.equal(await page.getByRole('menuitem', { name: /Speed series/ }).count(), 0);
  assert.equal((await calls()).length, 3);
  await input.fill(itemId.toUpperCase());
  await page.waitForFunction(() => window.calls.length === 6);
  await page.evaluate(() => window.release());
  await found.waitFor();
  await input.fill(itemId);
  await found.waitFor();
  assert.equal((await calls()).length, 6);
  // A read that fails drops only its own rows (review finding on de1fd508): the Item still shows while the
  // receipt read fails, and with nothing else found the palette says the lookup failed, not that nothing matches.
  await page.evaluate(() => (window.landingFails = true));
  await input.fill('abcdef12');
  await page.waitForFunction(() => window.calls.length === 9);
  await page.evaluate(() => window.release());
  await page.getByRole('menuitem', { name: 'abcdef12 · Second Item' }).waitFor();
  await input.fill('cafebabe');
  await page.waitForFunction(() => window.calls.length === 12);
  await page.evaluate(() => window.release());
  await page.getByText('Could not look up this id. Edit the search to try again.').waitFor();
  // An id nothing in the project has says so by name.
  await page.evaluate(() => (window.landingFails = false));
  await input.fill('deadbeef');
  await page.waitForFunction(() => window.calls.length === 15);
  await page.evaluate(() => window.release());
  await page.getByText('Nothing in this project has id deadbeef.').waitFor();
  if (shots) await page.screenshot({ path: join(shots, 'id-palette-none.png') });
  assert.deepEqual(errors, []);
});

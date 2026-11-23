// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One main red in a browser (Item ae068e0c): the real red view with synthetic reads. With a proven culprit the head
// names it and links its receipt, and only it is marked; with candidates only, no landing is
// called the cause; a landing that made never-passed tests run is named as that; still red, it says so with the live
// reason and failing files; the log is read once, on the press,
// for that red's own run. Each layout passes axe in both themes at 1440 and 390 px without sideways scroll.
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
const shots = process.env.FORGE_RED_SHOTS;

test('a main red says what failed, which landing broke it or which are candidates, and how it ended', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-red-ui-'));
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
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Main broke · Forge</title></head><body><main id="root"></main><script type="module" src="./fixture.tsx"></script></body></html>',
  );
  writeFileSync(
    join(temp, 'fixture.tsx'),
    `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { getFunctionName } from 'convex/server';
    import { RedView } from ${JSON.stringify(join(root, 'web/src/app/red/MainRed.tsx'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/tokens.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/base.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/core.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/parts.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/review.css'))};
    const q = new URLSearchParams(location.search);
    const T = Date.UTC(2026, 10, 20, 10, 8);
    const landing = (n, title, extra = {}) => ({ receiptId: 'r' + n + '-0000-4000-8000-000000000000', sequence: n, at: T - (10 - n) * 60000, title, actor: 'sample-one', agent: true, ...extra });
    const culprit = landing(7, 'Parser: stream chunks across a very long boundary name that wraps on a phone');
    const landings = [landing(8, 'Types: narrow ReadResult'), culprit, landing(6, null, { actor: 'mara', agent: false })];
    const run = { runId: 'run-red', status: 'failed', files: { total: 412, failed: 2, flaky: 0 }, failed: [{ file: 'tests/parser-stream.test.mjs', firstError: 'Expected 3 chunks, received 2' }, { file: 'tests/very/deep/folder/with/a/long/path/reader-boundary.test.mjs' }] };
    const base = { red: { sequence: 9, at: T, head: '54558d87091c' + 'a'.repeat(52), runId: 'run-red', drill: null }, run, runLink: 'https://github.com/example/parser/actions/runs/123', lastGreen: { sequence: 5, head: 'b'.repeat(64), runId: 'run-green', at: T - 30 * 60000, audited: true }, landings, landingsMore: false };
    const reads = {
      culprit: { ...base, culprit: { receiptId: culprit.receiptId, landing: culprit }, end: { how: 'recovered', at: T + 20 * 60000, runId: 'run-g2', head: 'c'.repeat(64), reverted: true, by: { kind: 'revert', landing: landing(10, 'Revert “Parser: stream chunks”'), of: 1 } } },
      candidates: { ...base, run: { ...run, failed: [], files: { total: null, failed: null, flaky: null }, failureReason: 'The runner lost its connection.' }, runLink: null, landingsMore: true, culprit: null, end: { how: 'flaky', at: T + 12 * 60000, runId: 'run-p' } },
      red: { ...base, run: null, culprit: null, end: { how: 'red', reason: 'The newest audit failed on tests/parser-stream.test.mjs.', tests: ['tests/parser-stream.test.mjs'], moreTests: 3 } },
      covered: { ...base, culprit: null, newlyCoveredBy: { receiptId: culprit.receiptId, landing: culprit }, end: { how: 'recovered', at: T + 40 * 60000, runId: 'run-g3', head: 'c'.repeat(64), reverted: false, by: { kind: 'fix', landing: landing(11, 'Lane review: fit 390 px'), of: 1 } } },
      harness: { ...base, landings: [landing(8, 'Accept the same State')], culprit: null, controlBuildChange: 'same-source', controlBuildReason: "Forge's check harness changed. The same source passed before the change.", end: { how: 'recovered', at: T + 40 * 60000, runId: 'run-g3', head: base.red.head, reverted: false, by: null } },
    };
    const read = reads[q.get('case') ?? 'culprit'];
    window.calls = [];
    window.client = {
      query: async (ref, args) => {
        const name = getFunctionName(ref);
        window.calls.push({ name, args });
        if (name === 'projectHostedOutputRead:streams') return { page: [{ streamId: 's', stream: { stream: 'stdout' }, maxSequence: 1, chunks: 1, seal: { failureSummary: 'not ok 1 - parser stream\\n  Expected 3 chunks, received 2' } }], isDone: true, continueCursor: '' };
        throw new Error('unexpected query ' + name);
      },
      mutation: async ref => { throw new Error('unexpected mutation ' + getFunctionName(ref)); },
    };
    const trail = [{ label: 'Parser', href: '/example/parser' }, { label: 'Code', href: '/example/parser/code' }, { label: 'Main broke' }];
    createRoot(document.getElementById('root')).render(<RedView read={read} trail={trail} projectId="synthetic" receipt={id => '/example/parser/code/' + id} />);
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
      contentType:
        !asset || file.endsWith('.html')
          ? 'text/html'
          : file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'application/octet-stream',
      body: readFileSync(asset ? file : join(out, 'fixture.html')),
    });
  });
  const layouts = async name => {
    for (const width of [1440, 390])
      for (const theme of ['dark', 'light']) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
        await settleBrowserPage(page);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${name} ${width}`,
        );
        await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
        const result = await page.evaluate(() =>
          window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }),
        );
        assert.deepEqual(
          result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
          [],
          `${name} ${width} ${theme}`,
        );
        if (shots)
          await page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`), fullPage: true });
      }
  };
  const side = () => page.getByRole('region', { name: 'Which landing' });

  // A proven culprit: named in the head, linked to its receipt; the others are left unmarked.
  await page.goto('https://forge.test/fixture.html?case=culprit');
  await page.getByText('the bisect proved it').waitFor();
  assert.match(
    await page.locator('.sit').textContent(),
    /main failed at 54558d87091c.*“Parser: stream chunks/,
  );
  assert.equal(
    await page.getByRole('link', { name: 'Open the landing that broke it' }).getAttribute('href'),
    '/example/parser/code/r7-0000-4000-8000-000000000000',
  );
  assert.deepEqual(
    await side()
      .locator('a.red-landing')
      .evaluateAll(rows => rows.map(row => row.lastElementChild.textContent)),
    ['', 'Broke main', ''],
    'only the proven culprit is marked; the others are not called innocent either',
  );
  assert.match(await page.getByText(/Passed again at .* after a revert/).textContent(), /Revert “Parser/);
  assert.equal(
    await page.getByRole('link', { name: 'Full log at your CI' }).getAttribute('href'),
    'https://github.com/example/parser/actions/runs/123',
  );
  assert.equal(await page.evaluate(() => window.calls.length), 0, 'opening the view reads no log');
  await page.getByRole('button', { name: 'Read the log' }).click();
  await page.getByText('Expected 3 chunks, received 2', { exact: false }).nth(1).waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.calls.map(call => [call.name, call.args.runId])),
    [['projectHostedOutputRead:streams', 'run-red']],
    'the log is read once, for this red’s own run',
  );
  await layouts('culprit');

  // Candidates only: none is called the cause.
  await page.goto('https://forge.test/fixture.html?case=candidates');
  await page.getByText('came since the last audit pass; which one broke it is not proven').waitFor();
  assert.deepEqual(
    await side()
      .locator('a.red-landing')
      .evaluateAll(rows => rows.map(row => row.lastElementChild.textContent)),
    ['Candidate', 'Candidate', 'Candidate'],
  );
  assert.equal(await page.getByText('Broke main').count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Open the landing that broke it' }).count(), 0);
  assert.match(await page.locator('.red-end').textContent(), /Counted as flaky/);
  await layouts('candidates');

  // Still red: says so, with the live reason and the failing files.
  await page.goto('https://forge.test/fixture.html?case=red');
  await page.getByText('Still failing. The newest audit failed').waitFor();
  assert.match(await page.locator('.red-end').textContent(), /Still failing/);
  assert.match(await page.getByRole('region', { name: 'What failed' }).textContent(), /parser-stream/);
  await layouts('still-red');

  // Incident 687d1eda: tests a landing made run for the first time. After recovery the view still names that landing,
  // marks only it, and never calls it the one that broke main.
  await page.goto('https://forge.test/fixture.html?case=covered');
  await page.getByText('made these tests run; they had no pass on the last green main').waitFor();
  assert.deepEqual(
    await side()
      .locator('a.red-landing')
      .evaluateAll(rows => rows.map(row => row.lastElementChild.textContent)),
    ['', 'Made tests run', ''],
  );
  assert.equal(await page.getByText('Broke main').count(), 0);
  assert.equal(
    await page.getByRole('link', { name: 'Open the landing that made tests run' }).getAttribute('href'),
    '/example/parser/code/r7-0000-4000-8000-000000000000',
  );
  await layouts('covered');

  await page.goto('https://forge.test/fixture.html?case=harness');
  await page.getByText("Forge's check harness changed. The same source passed before the change.").waitFor();
  assert.equal(await page.getByRole('region', { name: 'Candidates' }).count(), 0);
  const chronology = page.getByRole('region', { name: 'Since main last passed' });
  assert.match(await chronology.textContent(), /Accept the same State/);
  assert.doesNotMatch(await chronology.textContent(), /Candidate/);
  assert.deepEqual(errors, []);
});

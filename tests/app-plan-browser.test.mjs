// SPDX-License-Identifier: Apache-2.0
// The Plan screen's views and bulk bar (Items e0a23825, 65b0e706) as real components with synthetic rows: the view
// lives in the address, list / tree / board show the same rows, only ticked rows change, a batch reply names a row
// changed meanwhile and offers one Undo, and every state passes axe with no sideways scroll at desk and phone width in
// both themes. Set FORGE_PLAN_SHOTS to a folder to also save the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.FORGE_PLAN_SHOTS;

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
// Loaded lazily, as the app loads the screen with its route (the first-paint chunk never carries it).
const PlanScreenView = React.lazy(() =>
  import(${JSON.stringify(join(root, 'web/src/app/plan/Plan.tsx'))}).then(m => ({ default: m.PlanScreenView })),
);
import { readQuery, writeQuery } from ${JSON.stringify(join(root, 'web/src/app/plan/query.ts'))};
import { ProjectFrame } from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import { navigate, useSearch } from ${JSON.stringify(join(root, 'web/src/app/router.ts'))};
import { batchUndo } from ${JSON.stringify(join(root, 'src/planning-batch.ts'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const route = { frame: 'project', handle: 'example-builder', project: 'synthetic', place: 'plan', section: '', rest: '' };
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const launch = { id: uuid(1), kind: 'initiative', title: 'Launch the parser', status: 'open', position: 0, version: 3 };
const docs = { id: uuid(2), kind: 'initiative', title: 'Documentation and recovery paths', status: 'open', position: 1, version: 1 };
const item = (n, fields) => ({ id: uuid(n), kind: 'issue', status: 'open', position: n, version: 2, doneWhen: [1, 3], ...fields });
const rows = [launch, docs,
  item(10, { title: 'Stream parser: preserve split bytes across reads', initiativeId: launch.id, owner: '@example-builder', type: 'bug', order: 'a' }),
  item(11, { title: 'Recover from a truncated frame without losing the next one', initiativeId: launch.id, status: 'in-progress', owner: '@example-builder/amber-fox', order: 'b' }),
  item(12, { title: 'Bench the parser against the old reader', initiativeId: launch.id, parentId: uuid(10), order: 'c', doneWhen: null }),
  item(13, { title: 'Name every error the parser can return', initiativeId: launch.id, status: 'proposed', relations: [{ kind: 'depends-on', id: uuid(10) }], order: 'd' }),
  item(14, { title: 'Write the recovery guide', initiativeId: docs.id, owner: '@peer-builder', type: 'docs', order: 'a' }),
  item(15, { title: 'Examples for every reader option, including the rarely used ones', initiativeId: docs.id, order: 'b', doneWhen: [0, 12] }),
  item(16, { title: 'Tidy the old notes', order: 'a', doneWhen: [2, 2] }),
];
const read = { rows: JSON.stringify(rows), more: false, settled: [{ initiativeId: launch.id, done: 4, dropped: 1, atLeast: false }, { initiativeId: docs.id, done: 0, dropped: 0, atLeast: false }], canEdit: true };
const settledRows = [item(20, { title: 'Old reader removed', status: 'closed', initiativeId: launch.id }), item(21, { title: 'Ship a second parser', status: 'abandoned' })];
const settled = { rows: settledRows, more: false, loading: false, failed: false, loadMore() {} };
window.calls = [];
const run = async writes => {
  window.calls.push(writes);
  const results = writes.map((write, index) => index === 1 && writes.length > 1 && window.calls.length === 1
    ? { index, itemId: write.itemId, action: write.action, outcome: 'refused', code: 'ITEM_CHANGED', currentVersion: 3 }
    : { index, itemId: write.itemId, action: write.action, outcome: 'applied', version: (write.expectedVersion || 0) + 1, before: { owner: null, status: 'open', type: null, initiativeId: null } });
  return { results, ...batchUndo(writes, results) };
};
const reads = { items: async () => [], comments: async () => ({ comments: [], more: [] }) };
function Fixture() {
  const search = useSearch();
  const query = readQuery(search);
  const go = patch => navigate(location.pathname + writeQuery({ ...query, ...patch }), { replace: true });
  return <ProjectFrame route={route} name="Synthetic project" feed={undefined} projects={null}
    controls={{ viewerHandle: 'example-builder', onPicker() {}, onPalette() {}, onKeys() {} }}>
    <React.Suspense fallback={<h1>Loading</h1>}><PlanScreenView route={route} projectId="synthetic" projectName="Synthetic project" feed={undefined} read={read}
      put={async () => undefined} run={run} reads={reads} query={query} go={go} viewer="example-builder"
      closed={query.scope === 'open' ? undefined : settled} /></React.Suspense>
  </ProjectFrame>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

test('plan views and bulk bar: real components keep the view in the address and change only ticked rows', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-plan-ui-'));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Plan · Forge</title><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
  );
  writeFileSync(join(temp, 'fixture.tsx'), fixture);
  const { build } = await import('vite');
  await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: temp,
    base: '/',
    envDir: false,
    logLevel: 'error',
    resolve: {
      alias: {
        react: dirname(require.resolve('react/package.json')),
        'react-dom': dirname(require.resolve('react-dom/package.json')),
      },
    },
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: html } },
  });
  if (shots) mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  t.after(async () => {
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  });
  const open = async (width, theme, search = '') => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const path = url.pathname.slice(1);
      const file = path.startsWith('fonts/') ? join(root, 'web/public', path) : join(out, path);
      const asset = path && existsSync(file) && !file.endsWith('/');
      return route.fulfill({
        contentType: !asset
          ? 'text/html'
          : file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : file.endsWith('.woff2')
                ? 'font/woff2'
                : 'application/octet-stream',
        body: readFileSync(asset ? file : join(out, 'fixture.html')),
      });
    });
    await page.goto(`https://forge.test/example-builder/synthetic/plan${search}`);
    await page.locator('.plan h1, .plan .ph').first().waitFor();
    await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
    return { page, errors, context };
  };
  const check = async (page, label) => {
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `${label}: no sideways scroll`,
    );
    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
    const result = await page.evaluate(() =>
      window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }),
    );
    assert.deepEqual(
      result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
      [],
      `${label}: axe`,
    );
  };

  // Behaviour at desk width: filters in the address, only ticked rows change, a refused row is named.
  {
    const { page, errors, context } = await open(1440, 'dark');
    const main = page.locator('main');
    assert.match(await main.textContent(), /Stream parser/);
    await page.getByRole('link', { name: /^No owner/ }).click();
    assert.match(page.url(), /owner=none/);
    assert.doesNotMatch(await main.textContent(), /Write the recovery guide/);
    assert.match(await main.textContent(), /Tidy the old notes/);
    await page.getByRole('button', { name: 'Remove Owner no one' }).click();
    assert.doesNotMatch(page.url(), /owner=/);
    await page
      .getByRole('checkbox', { name: 'Select Stream parser: preserve split bytes across reads' })
      .check();
    await page.getByRole('checkbox', { name: 'Select Write the recovery guide' }).check();
    const bar = page.getByRole('region', { name: 'Change the selected Items' });
    assert.match(await bar.textContent(), /2 selected/);
    if (shots) await page.screenshot({ path: join(shots, 'plan-selected-1440-dark.png'), fullPage: true });
    await bar.getByRole('button', { name: 'Assign' }).click();
    await page.getByRole('menuitem', { name: 'No one' }).click();
    const toast = page.locator('.toasts');
    await toast.waitFor();
    assert.match(await toast.textContent(), /1 of 2 changed\. 1 changed meanwhile/);
    assert.match(await toast.textContent(), /Write the recovery guide/);
    const sent = await page.evaluate(() => window.calls[0]);
    assert.deepEqual(
      sent.map(write => [write.itemId.slice(-2), write.owner]),
      [
        ['10', null],
        ['14', null],
      ],
      'only the ticked rows, one call',
    );
    await toast.getByRole('button', { name: 'Undo' }).click();
    assert.equal(await page.evaluate(() => window.calls.length), 2, 'Undo is one more call');
    // The refused row stays ticked so it can be tried again.
    assert.match(await bar.textContent(), /1 selected/);
    // Re-parent: only top-level Items of the same Initiative are offered, so no loop can be made.
    await bar.getByRole('button', { name: 'Clear the selection' }).click();
    await page.getByRole('checkbox', { name: 'Select Name every error the parser can return' }).check();
    await page
      .getByRole('region', { name: 'Change the selected Items' })
      .getByRole('button', { name: 'Put under…' })
      .click();
    assert.equal(await page.getByRole('menuitem', { name: 'Write the recovery guide' }).count(), 0);
    await page.getByRole('menuitem', { name: 'Stream parser: preserve split bytes across reads' }).click();
    await page.locator('.toasts').waitFor();
    assert.deepEqual(
      await page.evaluate(() =>
        window.calls.at(-1).map(write => [write.itemId.slice(-2), write.parentId.slice(-2)]),
      ),
      [['13', '10']],
    );
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    assert.match(page.url(), /view=board/);
    assert.equal(await page.locator('.plan-col').count(), 3, 'open scope: Proposed, Planned, In progress');
    await page.getByRole('button', { name: /^Order: / }).click();
    await page.getByRole('menuitem', { name: 'By title' }).click();
    assert.match(page.url(), /sort=title/);
    assert.deepEqual(errors, []);
    await context.close();
  }

  for (const [name, search] of [
    ['list', ''],
    ['tree', '?view=tree'],
    ['board', '?scope=all&view=board'],
    ['closed', '?scope=closed&sort=title'],
  ])
    for (const width of [1440, 390])
      for (const theme of ['dark', 'light'])
        await t.test(`${name} ${width} ${theme}: no clipping or axe violations`, async () => {
          const { page, errors, context } = await open(width, theme, search);
          if (name === 'list')
            await page.getByRole('checkbox', { name: 'Select Write the recovery guide' }).check();
          await check(page, `${name} ${width} ${theme}`);
          if (shots)
            await page.screenshot({
              path: join(shots, `plan-${name}-${width}-${theme}.png`),
              fullPage: true,
            });
          assert.deepEqual(errors, []);
          await context.close();
        });
});

// SPDX-License-Identifier: Apache-2.0
// The Plan screen's views and bulk bar (Items e0a23825, 65b0e706) as real components with synthetic rows: the view
// lives in the address, list / tree / board show the same rows, only ticked rows change, a batch reply names a row
// changed meanwhile and offers one Undo, and every state passes axe with no sideways scroll at desk and phone width in
// both themes. Initiative groups (Item 4df3ee17) fold and stay folded on reload, Collapse all gives the Initiatives
// overview, an Initiative moves with one order write, a group header's roll never draws over its breakdown words
// (f49e3a5c, 3-digit counts at 1440, 1024 and 390), the header's chip is every Item and its breakdown parts come in
// one order, add up to the chip and match the roll's ticks (b7a0dff1), and the Initiative page edits its title and asks for its done
// Items. On a phone, the list shows one count, Find and Tune at one height, each row's status on the line under its
// name, and the line's counts beside their own words. The title offers the views. Tune holds the filters, order,
// layout and folds. Set FORGE_PLAN_SHOTS to a folder to also save the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { itemWorkFixture } from './item-work-fixture.mjs';
import { settleBrowserPage } from './browser-runtime.mjs';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.FORGE_PLAN_SHOTS;
const sidebarShots = process.env.FORGE_SIDEBAR_SHOTS;

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConvexProvider } from ${JSON.stringify(join(root, 'node_modules/convex/dist/esm/react/index.js'))};
import { fakeConvex } from ${JSON.stringify(join(root, 'tests/convex-fake.mjs'))};
import { getFunctionName } from ${JSON.stringify(join(root, 'node_modules/convex/dist/esm/server/index.js'))};
// Loaded lazily, as the app loads the screen with its route (the first-paint chunk never carries it).
const PlanScreenView = React.lazy(() =>
  import(${JSON.stringify(join(root, 'web/src/app/plan/Plan.tsx'))}).then(m => ({ default: m.PlanScreenView })),
);
const LivePlan = React.lazy(() => import(${JSON.stringify(join(root, 'web/src/app/plan/Plan.tsx'))}));
import { readQuery, writeQuery } from ${JSON.stringify(join(root, 'web/src/app/plan/query.ts'))};
import { ProjectFrame } from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import { navigate, useSearch } from ${JSON.stringify(join(root, 'web/src/app/router.ts'))};
import { batchUndo } from ${JSON.stringify(join(root, 'src/planning-batch.ts'))};
import { readInitiative } from ${JSON.stringify(join(root, 'web/src/app/plan/batch.ts'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const launch = { id: uuid(1), kind: 'initiative', title: 'Launch the parser', status: 'open', position: 0, version: 3, owner: 'example-builder/amber-fox' };
const docs = { id: uuid(2), kind: 'initiative', title: 'Documentation and recovery paths', status: 'open', position: 1, version: 1 };
const largeInitiative = new URLSearchParams(location.search).has('large-initiative');
const splitInitiative = new URLSearchParams(location.search).has('split-initiative');
const exactCounts = new URLSearchParams(location.search).has('exact-counts');
const partialCounts = new URLSearchParams(location.search).has('partial-counts');
const big = { id: uuid(3), kind: 'initiative', title: 'A long running release with a name that will not fit on a phone line', status: splitInitiative ? 'closed' : 'open', position: 2, version: 1, hidden: largeInitiative };
const item = (n, fields) => ({ id: uuid(n), kind: 'issue', status: 'open', position: n, version: 2, doneWhen: [1, 3], ...fields });
const rows = [launch, docs, big,
  item(17, { title: 'Last open step of the long release', initiativeId: splitInitiative ? docs.id : big.id, status: 'in-progress', inLane: true, order: 'a' }),
  item(10, { title: 'Stream parser: preserve split bytes across reads', initiativeId: launch.id, owner: '@example-builder', type: 'bug', order: 'a' }),
  item(11, { title: 'Recover from a truncated frame without losing the next one', initiativeId: launch.id, status: 'in-progress', owner: '@example-builder/amber-fox', order: 'b' }),
  item(12, { title: 'Bench the parser against the old reader', initiativeId: splitInitiative ? big.id : launch.id, parentId: uuid(10), order: 'c', doneWhen: null }),
  item(13, { title: 'Name every error the parser can return', initiativeId: launch.id, status: 'proposed', relations: [{ kind: 'depends-on', id: uuid(10) }], order: 'd' }),
  item(14, { title: 'Write the recovery guide', initiativeId: docs.id, owner: '@peer-builder', type: 'docs', order: 'a' }),
  item(15, { title: 'Examples for every reader option, including the rarely used ones', initiativeId: docs.id, order: 'b', doneWhen: [0, 12] }),
  item(16, { title: 'Tidy the old notes', order: 'a', doneWhen: [2, 2] }),
];
if (largeInitiative) {
  for (const [index, [status, count]] of [['in-progress', 120], ['open', 200], ['proposed', 95]].entries())
    rows.push(...Array.from({ length: count }, (_, n) =>
      item(1000 + index * 500 + n, { title: 'Synthetic release step', status, initiativeId: big.id }),
    ));
}
const bigSettled = largeInitiative
  ? { done: 1000, dropped: 1000, atLeast: true }
  : { done: 123, dropped: 7, atLeast: false };
const launchProgress = exactCounts
  ? { done: 1024, dropped: 1, atLeast: false, live: { inProgress: 1, open: 525, proposed: 1 } }
  : { done: 4, dropped: 1, atLeast: false };
const read = {
  rows: JSON.stringify(partialCounts ? rows.filter(row => row.initiativeId !== docs.id) : rows),
  more: exactCounts || partialCounts,
  liveMore: exactCounts || partialCounts,
  settled: [{ initiativeId: launch.id, ...launchProgress }, { initiativeId: docs.id, done: partialCounts ? 2 : 0, dropped: 0, atLeast: partialCounts }, { initiativeId: big.id, ...bigSettled }],
  canEdit: true,
};
const settledRows = [item(20, { title: 'Old reader removed', status: 'closed', initiativeId: launch.id }), item(21, { title: 'Ship a second parser', status: 'abandoned' })];
const settled = { rows: settledRows, more: false, loading: false, failed: false, loadMore() {} };
// Archive and Deleted (Item 4c9e961e): each row says when it went and the status it left.
const shelfRows = {
  archived: [item(30, { title: 'Browser bundle size budget', status: 'archived', was: 'proposed', at: '2026-10-02T09:00:00.000Z', version: 4 })],
  deleted: [item(31, { title: 'Benchmark against the v1 parser', status: 'deleted', was: 'in-progress', at: '2026-11-01T09:00:00.000Z', purgeAt: Date.parse('2026-12-01T09:00:00.000Z'), version: 3 })],
};
const linkedOpen = rows.find(row => row.id === uuid(10));
const linkedDeleted = shelfRows.deleted[0];
window.initiativeReads = [];
const linkBackend = fakeConvex({
  resolve(name, args) {
    if (name === 'projectWorkIndex:detail' && args.id === launch.id) {
      window.initiativeReads.push(name);
      return { generationId: 'generation', revision: 1, value: JSON.stringify({
        ...launch, author: 'another-editor/ivory-raccoon', body: 'Everything that must land before the parser ships.',
      }) };
    }
    if (name === 'projectWorkIndex:records' && args.parentId === launch.id && args.collection === 'planningVersions') {
      window.initiativeReads.push(name);
      if (args.generationId !== 'generation' || args.paginationOpts.numItems !== 1 || args.paginationOpts.cursor !== null)
        throw Error('Expected one first version on the current detail’s generation');
      return { generationId: 'generation', page: [{ value: JSON.stringify({ ...launch, version: 1, author: 'release-lead/amber-fox' }) }], isDone: false };
    }
    if (name === 'projectPlanView:read') return { ...read, rows: JSON.stringify(window.readItemWork ? [launch, linkedOpen] : [linkedOpen]) };
    if (name === 'projectPlanSettled:item') {
      const candidates = [linkedOpen, linkedDeleted, ...settledRows].filter(row => row.id.startsWith(args.id));
      if (candidates.length !== 1) return null;
      const row = candidates[0];
      return { id: row.id, row: row === linkedOpen ? null : JSON.stringify(row) };
    }
    if (name === 'projectPlanWorkers:read') return '{"lanes":[]}';
    if (name === 'projectDiscussionThread:read') return { canRead: true, entries: [], before: null };
    if (name === 'projectItemWork:read') return window.readItemWork?.(args) ?? '{"role":false}';
    if (name === 'projectPlanSettled:page') return {
      page: settledRows.filter(row => row.status === args.status).map(row => JSON.stringify(row)),
      isDone: true, continueCursor: '',
    };
    if (args.paginationOpts) return { page: [], isDone: true, continueCursor: '' };
    return null;
  },
});
if (window.readItemWork) {
  const query = linkBackend.client.query;
  window.planQueries = [];
  linkBackend.client.query = (ref, args) => {
    window.planQueries.push(getFunctionName(ref));
    return query(ref, args);
  };
  window.planSubscriptions = () => [...linkBackend.live.values()].map(entry => entry.name);
}
window.calls = [];
window.closeUndos = [];
const run = async (writes, options) => {
  if (options?.close) return {
    results: writes.map((write, index) => ({ itemId: write.itemId, index, action: write.action, outcome: 'applied' })),
    detached: 1, undo: [], undoClose: options.operationId, kept: 0,
  };
  if (options?.undoClose) {
    window.closeUndos.push(options);
    if (window.closeUndos.length === 1) throw new Error('Reply lost');
    return { results: [], undo: [], kept: 0 };
  }
  window.calls.push(writes);
  const results = writes.map((write, index) => index === 1 && writes.length > 1 && window.calls.length === 1
    ? { index, itemId: write.itemId, action: write.action, outcome: 'refused', code: 'ITEM_CHANGED', currentVersion: 3 }
    : { index, itemId: write.itemId, action: write.action, outcome: 'applied', version: (write.expectedVersion || 0) + 1, before: { owner: null, status: 'open', type: null, initiativeId: null } });
  return { results, ...batchUndo(writes, results) };
};
window.purges = [];
const purge = async input => { window.purges.push(input); return Date.now(); };
window.puts = [];
window.doneFor = [];
const put = async command => { window.puts.push(command); };
const reads = {
  items: async ids => ids.map(id => ({ id, version: 1, kind: 'issue', title: id, body: '' })),
  initiative: id => readInitiative(linkBackend.client, 'synthetic', id),
  comments: async () => ({ comments: [], more: [] }),
  // Open Lanes active in the last 48 hours (d3357f40): three on the unowned in-progress Item, one on an owned
  // in-progress Item. The page asks by Intent: each in-progress Item and two follow-ups (window.workerAsked).
  workers: async ids => (window.workerReads = (window.workerReads ?? 0) + 1, window.workerAsked = [...ids], { lanes: [
    { intentId: uuid(17), actor: 'example-builder/amber-fox', at: 30 },
    { intentId: uuid(17), actor: 'peer-builder', at: 20 },
    { intentId: uuid(17), actor: 'peer-builder/copper-moth', at: 10 },
    { intentId: uuid(11), actor: 'peer-builder/ocean-lark', at: 5 },
    { intentId: uuid(11), actor: 'example-builder/amber-fox', at: 4 },
    { intentId: uuid(11), actor: 'peer-builder', at: 3 },
  ] }),
};
function Fixture() {
  const search = useSearch();
  const rest = decodeURIComponent(location.pathname.split('/plan/')[1] ?? '');
  const route = { frame: 'project', handle: 'example-builder', project: 'synthetic', place: 'plan', section: '', rest };
  const query = readQuery(search);
  const go = patch => navigate(location.pathname + writeQuery({ ...query, ...patch }), { replace: true });
  // The shell receives the same Needs you count as the page read (window.heldFeed, set before load).
  const feed = window.heldFeed ? { lanes: [{ laneId: uuid(90), stage: 'ready', held: true, overlap: false, changedAt: 1 }], more: 0, moreIsLowerBound: false, main: null } : undefined;
  return <ProjectFrame route={route} projectId="synthetic" name="Synthetic project" feed={feed}
    needs={window.heldFeed ? { n: 1, atLeast: false } : undefined} projects={null}
    controls={{ viewerHandle: 'example-builder', onPicker() {}, onPalette() {}, onKeys() {} }}>
    <React.Suspense fallback={<h1>Loading</h1>}>{window.livePlan ?
      <ConvexProvider client={linkBackend.client}><LivePlan route={route} projectId="synthetic"
        projectName="Synthetic project" viewerHandle="example-builder" /></ConvexProvider> :
      <PlanScreenView route={route} projectId={rest === uuid(16) ? undefined : "synthetic"} projectName="Synthetic project" feed={undefined} read={read}
      put={put} run={run} purge={purge} reads={reads} query={query} go={go} viewer="example-builder"
      readInitiativeWork={window.readItemWork ? initiativeId => window.readItemWork({initiativeId}) : undefined}
      closed={query.scope === 'open' && !rest ? undefined : settled}
      shelved={shelfRows[query.scope] ? { ...settled, rows: shelfRows[query.scope] } : undefined}
      shelvedItem={[...shelfRows.archived, ...shelfRows.deleted].find(row => row.id === rest) ?? null} showDone={id => window.doneFor.push(id)} />}</React.Suspense>
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
  const open = async (width, theme, search = '', held = false, livePlan = false, readItemWork) => {
    // One locale on every machine, so dates read the same locally and on the runner ("1 Nov", never "Nov 1" or "1 ott").
    const context = await browser.newContext({
      locale: 'en-GB',
      viewport: { width, height: width === 390 ? 844 : 1000 },
    });
    if (held) await context.addInitScript(() => (window.heldFeed = true));
    if (livePlan) await context.addInitScript(() => (window.livePlan = true));
    if (readItemWork) await context.exposeFunction('readItemWork', readItemWork);
    // Every layout shift from the first paint on, for the no-shift check below.
    await context.addInitScript(() => {
      window.shifts = [];
      new PerformanceObserver(list =>
        window.shifts.push(...list.getEntries().map(entry => entry.value)),
      ).observe({
        type: 'layout-shift',
        buffered: true,
      });
    });
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
        body: asset
          ? readFileSync(file)
          : // Start in the chosen theme so axe cannot race the fixture's color change.
            readFileSync(join(out, 'fixture.html'), 'utf8').replace(
              'data-ds>',
              `data-ds data-theme="${theme}">`,
            ),
      });
    });
    await page.goto(`https://forge.test/example-builder/synthetic/plan${search}`);
    await page.locator('.plan h1, .plan .ph').first().waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    return { page, errors, context };
  };
  const check = async (page, label) => {
    await settleBrowserPage(page);
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
    const heading = main.getByRole('heading', { level: 1 });
    const openTitle = main.getByRole('heading', { level: 1, name: 'Open work', exact: true });
    await openTitle.waitFor();
    assert.equal((await openTitle.boundingBox()).width, 1, 'Open work is the top-level Plan view');
    assert.match(await main.textContent(), /Stream parser/);
    assert.equal(await main.getByText('in Lane', { exact: true }).count(), 1);
    await page.getByRole('link', { name: /^No owner/ }).click();
    assert.match(page.url(), /owner=none/);
    assert.doesNotMatch(await main.textContent(), /Write the recovery guide/);
    assert.match(await main.textContent(), /Tidy the old notes/);
    await page.getByRole('button', { name: 'Remove Owner no one' }).click();
    assert.doesNotMatch(page.url(), /owner=/);
    await page.getByRole('button', { name: 'Type: any' }).click();
    await page.getByRole('menuitem', { name: 'Bug', exact: true }).click();
    await page.getByRole('button', { name: 'Save this view' }).click();
    const save = page.getByRole('dialog', { name: 'Save this view' });
    await save.getByRole('textbox', { name: 'Name' }).fill('Parser bugs');
    await save.getByRole('button', { name: 'Save', exact: true }).click();
    await save.waitFor({ state: 'hidden' });
    const saved = page.locator('.rail').getByRole('link', { name: 'Parser bugs' });
    assert.equal(await saved.getAttribute('aria-current'), 'page');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await page.getByRole('button', { name: 'View: Parser bugs' }).click();
    await page.getByRole('menuitem', { name: /^Open work/ }).click();
    assert.doesNotMatch(page.url(), /type=/);
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await saved.click();
    assert.match(page.url(), /type=bug/);
    const parent = heading.getByRole('link', { name: 'Plan', exact: true });
    await parent.waitFor();
    assert.equal(await parent.getAttribute('href'), '/-/example-builder/synthetic/plan');
    assert.ok((await parent.boundingBox()).width > 1, 'a query-backed saved view keeps the way back to Plan');
    await page.getByRole('button', { name: 'Remove Type bug' }).click();
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
    await page
      .getByRole('checkbox', { name: 'Select Stream parser: preserve split bytes across reads' })
      .check();
    await bar.getByRole('button', { name: 'Close with one note' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close anyway' }).click();
    await toast.getByText('Kept 1 live sub-item as Items.', { exact: false }).waitFor();
    await toast.getByRole('button', { name: 'Undo', exact: true }).click();
    await toast.getByRole('button', { name: 'Retry Undo', exact: true }).click();
    await toast.waitFor({ state: 'hidden' });
    const undoAttempts = await page.evaluate(() => window.closeUndos);
    assert.equal(undoAttempts.length, 2);
    assert.ok(undoAttempts[0].operationId);
    assert.deepEqual(
      undoAttempts[1],
      undoAttempts[0],
      'Undo reconciles the original operation after a lost reply',
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

  // d3357f40 (owner 2026-11-19): with no owner the Owner column shows who works on the Item now, newest first with
  // "+N"; "no one yet" only with neither; a set owner wins; an Item with no checklist shows no "none". One read.
  for (const theme of ['dark', 'light'])
    await t.test(`owner and progress cells 1440 ${theme}`, async () => {
      const { page, errors, context } = await open(1440, theme);
      const row = title =>
        page.locator('.plan .row').filter({ has: page.getByRole('link', { name: title }) });
      const owner = title => row(title).locator('.plan-wide').nth(1);
      await owner('Last open step of the long release').getByText('amber-fox').waitFor();
      assert.match(await owner('Last open step of the long release').textContent(), /amber-fox.*\+2/);
      assert.equal(
        await owner('Last open step of the long release').locator('.plan-who').getAttribute('title'),
        'Working on it now: example-builder/amber-fox, peer-builder, peer-builder/copper-moth',
      );
      // An owned in-progress Item with an active Lane shows its owner, never the Lane.
      const owned = 'Recover from a truncated frame without losing the next one';
      assert.match(await owner(owned).textContent(), /amber-fox/);
      assert.doesNotMatch(await owner(owned).textContent(), /ocean-lark/);
      assert.equal((await owner('Tidy the old notes').textContent()).trim(), 'no one yet');
      const checklist = row('Bench the parser against the old reader').locator('.dw');
      assert.equal(await checklist.getAttribute('title'), 'no checklist');
      // Nothing is drawn: the words are for a screen reader (and the hover) only.
      assert.equal(
        await checklist.evaluate(node =>
          [...node.childNodes]
            .filter(child => !child.classList?.contains('sr'))
            .map(child => child.textContent)
            .join('')
            .trim(),
        ),
        '',
        'nothing is drawn',
      );
      assert.equal(await checklist.locator('.sr').textContent(), 'no checklist');
      assert.equal(
        await page
          .locator('.plan .dw')
          .filter({ hasText: /^none$/ })
          .count(),
        0,
      );
      assert.equal(await page.evaluate(() => window.workerReads), 1, 'one read for the whole page');
      const asked = await page.evaluate(() => window.workerAsked);
      assert.ok(
        asked.includes('00000000-0000-4000-8000-000000000017'),
        'the in-progress Item is asked about',
      );
      assert.ok(
        !asked.includes('00000000-0000-4000-8000-000000000016'),
        'an Item not started is never asked about',
      );
      assert.ok(
        asked.includes('00000000-0000-4000-8000-000000000011'),
        'an owned in-progress Item is asked too',
      );
      assert.equal(asked.length % 3, 0, 'each Item with its first two follow-up Intents');
      // A hidden tab reads nothing; shown again, it reads once more (Lanes may have started meanwhile).
      const show = state =>
        page.evaluate(value => {
          Object.defineProperty(document, 'visibilityState', { value, configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
        }, state);
      await show('hidden');
      assert.equal(await page.evaluate(() => window.workerReads), 1, 'hidden: no read');
      await show('visible');
      await page.waitForFunction(() => window.workerReads === 2);
      await check(page, `owner cells ${theme}`);
      if (shots)
        await page.screenshot({ path: join(shots, `plan-owners-1440-${theme}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
    });

  const launchId = '00000000-0000-4000-8000-000000000001';
  const docsId = '00000000-0000-4000-8000-000000000002';
  /** Every group header's roll and its words, as boxes; the roll's ticks must fit inside it. */
  const headers = page =>
    page.locator('.plan-gh').evaluateAll(heads =>
      heads.flatMap(head => {
        const roll = head.querySelector('.roll');
        const words = head.querySelector('.plan-pl');
        if (!roll || !words) return [];
        const a = roll.getBoundingClientRect(),
          b = words.getBoundingClientRect();
        const ticks = [...roll.children].map(tick => tick.getBoundingClientRect());
        // b7a0dff1: the chip, the words in order and the roll's ticks, read off the screen.
        const chip = head.querySelector('.cnt');
        const parts = [...words.querySelectorAll('.plan-bp')].map(part => {
          const label = part.querySelector('.plan-bfull').textContent;
          return {
            swatch: part.querySelector('i').className,
            n: Number(label.replace(/[^0-9]/g, '')),
            word: label.replace(/^[0-9,]+\+?\s*/, ''),
            label,
          };
        });
        return [
          {
            chip: Number(chip?.textContent.replace(/[^0-9]/g, '')),
            parts,
            ticks: [...roll.children].map(tick => tick.className),
            words: parts.map(part => part.label).join(' · '),
            meet: a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
            spill: ticks.some(tick => tick.right > a.right + 0.5 || tick.left < a.left - 0.5),
          },
        ];
      }),
    );

  // f49e3a5c: a header's roll and its breakdown never meet, at 3-digit counts too, in both themes.
  for (const width of [1440, 1024, 700, 390])
    for (const theme of ['dark', 'light'])
      await t.test(`group header ${width} ${theme}: the roll never draws over its words`, async () => {
        const { page, errors, context } = await open(width, theme);
        const fullBreakdown = page.locator('.plan-gh .plan-bfull').first();
        assert.equal(await fullBreakdown.isVisible(), width >= 1024);
        const boxes = await headers(page);
        assert.ok(
          boxes.some(
            box => box.chip === 131 && box.words === '123 done · 1 in progress · 0 open · 7 removed',
          ),
          '3-digit counts are drawn',
        );
        for (const box of boxes) {
          assert.deepEqual({ ...box, meet: false, spill: false }, box, box.words);
          // b7a0dff1: the chip is every Item; the parts come in one order and add up to it; the roll's ticks run
          // in the same order and colours as the words' swatches.
          const order = ['done', 'in progress', 'open', 'proposed', 'removed'];
          assert.deepEqual(
            box.parts.map(part => part.word),
            order.filter(word => word !== 'proposed' || box.parts.some(part => part.word === word)),
            box.words,
          );
          assert.equal(
            box.parts.reduce((sum, part) => sum + part.n, 0),
            box.chip,
            `${box.words}: the parts add up to the chip`,
          );
          const runs = box.ticks.filter((tick, index) => tick !== box.ticks[index - 1]);
          const swatches = box.parts.map(part => part.swatch);
          assert.deepEqual(
            runs,
            swatches.filter(swatch => runs.includes(swatch)),
            `${box.words}: the roll runs in the words' order`,
          );
        }
        const launch = boxes.find(box => box.chip === 9);
        assert.equal(launch?.words, '4 done · 1 in progress · 2 open · 1 proposed · 1 removed');
        assert.deepEqual(launch.ticks, ['ok', 'ok', 'ok', 'ok', 'run', 'open', 'open', 'prop', 'gone']);
        if (shots && width !== 390)
          await page.screenshot({ path: join(shots, `plan-headers-${width}-${theme}.png`), fullPage: true });
        if (width === 1024) {
          await page.getByRole('button', { name: 'Expand sidebar' }).click();
          assert.equal(
            await fullBreakdown.isVisible(),
            false,
            'an expanded rail leaves less than 860px for Plan',
          );
          for (const box of await headers(page)) assert.deepEqual({ ...box, meet: false, spill: false }, box);
        }
        assert.deepEqual(errors, []);
        await context.close();
      });

  await t.test('a narrow Initiative group keeps its title and names every compact status count', async () => {
    const { page, context } = await open(1440, 'dark');
    try {
      const longName = 'A long running release with a name that will not fit on a phone line';
      const title = page.getByRole('link', { name: longName, exact: true });
      const longHeader = title.locator('..');
      const launchTitle = page.getByRole('link', { name: 'Launch the parser', exact: true });
      const launchHeader = launchTitle.locator('..');
      const parts = launchHeader.locator('.plan-bp');
      const labels = ['4 done', '1 in progress', '2 open', '1 proposed', '1 removed'];
      assert.deepEqual(await parts.allInnerTexts(), labels);
      await launchTitle.focus();
      await page.keyboard.press('Tab');
      const fold = launchHeader.getByRole('button', { name: 'Items of Launch the parser' });
      assert.equal(await fold.evaluate(node => node === document.activeElement), true);

      // The same desktop viewport can hold a narrow group. Its own width determines how it draws.
      for (const header of [longHeader, launchHeader])
        await header.evaluate(node => (node.style.maxInlineSize = '500px'));

      const bounds = await title.evaluate(node => ({
        width: node.clientWidth,
        textWidth: node.scrollWidth,
        overflow: getComputedStyle(node).textOverflow,
      }));
      assert.ok(bounds.width >= 80 && bounds.width < bounds.textWidth, JSON.stringify(bounds));
      assert.equal(bounds.overflow, 'ellipsis');
      assert.equal(await title.getAttribute('title'), longName);
      assert.deepEqual(await parts.allInnerTexts(), ['4', '1', '2', '1', '1']);
      for (const name of labels)
        assert.equal(await launchHeader.getByRole('img', { name, exact: true }).count(), 1);

      const done = launchHeader.getByRole('img', { name: '4 done', exact: true });
      const word = done.getByText('done', { exact: true });
      assert.equal(await word.isVisible(), false);
      await done.hover();
      assert.equal(await word.isVisible(), true);
      await page.mouse.move(0, 0);
      assert.equal(await word.isVisible(), false);
      await launchTitle.focus();
      await page.keyboard.press('Tab');
      assert.equal(await done.evaluate(node => node === document.activeElement), true);
      assert.equal(await word.isVisible(), true);
    } finally {
      await context.close();
    }
  });

  await t.test(
    'a hidden Initiative with large counts keeps its title and compact tips within the page',
    async () => {
      const { page, context } = await open(1180, 'dark', '?large-initiative');
      try {
        const title = page.getByRole('link', { name: /^A long running release/ });
        const header = title.locator('..');
        assert.ok((await title.boundingBox()).width >= 80);
        assert.ok(await header.getByText('1,000+ done', { exact: true }).isVisible());
        const fits = () => page.evaluate(() => document.documentElement.scrollWidth === innerWidth);
        assert.equal(await fits(), true);

        await page.setViewportSize({ width: 360, height: 844 });
        const proposed = header.getByRole('img', { name: '95 proposed', exact: true });
        assert.equal(await fits(), true);
        await proposed.focus();
        const tip = await proposed.getByText('proposed', { exact: true }).boundingBox();
        assert.ok(tip && tip.x >= 0 && tip.x + tip.width <= 360, JSON.stringify(tip));
        assert.equal(await fits(), true);
      } finally {
        await context.close();
      }
    },
  );

  // Item 88c08511 (web guidance trial): the reorder list paints its rows a render after its group headers, which moved
  // every header below the first (CLS 0.34 at 390 with the owner's 325 Items, 0.20 here). The list keeps its rows'
  // shortest room from the first paint; only a wrapped name's extra line can still move what follows, so the bar is
  // half the 0.1 "good" line (without the room this fixture gives 0.088 at 1440 and 0.20 at 390).
  for (const width of [1440, 390])
    await t.test(`load ${width}: the list keeps its rows' room, no layout shift`, async () => {
      const { page, errors, context } = await open(width, 'dark');
      await page.locator('.plan .row .ttl').first().waitFor();
      // The rows' frame is painted and its shift entries delivered once three more frames have run.
      const total = await page.evaluate(
        () =>
          new Promise(done => {
            const frames = n =>
              n
                ? requestAnimationFrame(() => frames(n - 1))
                : done(window.shifts.reduce((sum, v) => sum + v, 0));
            frames(3);
          }),
      );
      assert.ok(total < 0.05, `layout shift ${total}`);
      assert.deepEqual(errors, []);
      await context.close();
    });

  // Folds: per viewer on this browser, kept on reload; Collapse all is the Initiatives overview; moves are one write.
  {
    const { page, errors, context } = await open(1440, 'dark');
    const main = page.locator('main');
    await page.getByRole('button', { name: 'Items of Launch the parser' }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Items of Launch the parser' }).getAttribute('aria-expanded'),
      'false',
    );
    assert.doesNotMatch(await main.textContent(), /Stream parser/);
    await page.reload();
    await page.locator('.plan .ph').first().waitFor();
    assert.doesNotMatch(await main.textContent(), /Stream parser/, 'the fold is remembered');
    assert.match(await main.textContent(), /Write the recovery guide/);
    // Moving an open Initiative's header: one put with only an order, before the Initiative above it.
    await page.getByRole('button', { name: 'Move Documentation and recovery paths' }).click();
    await page.getByRole('menuitem', { name: 'To the top' }).click();
    await page.waitForFunction(() => window.puts.length === 1);
    const [moved] = await page.evaluate(() => window.puts);
    assert.deepEqual(Object.keys(moved).sort(), ['expectedVersion', 'itemId', 'order']);
    assert.equal(moved.itemId, docsId);
    assert.ok(moved.order < 'L000000V', 'ranks before Launch the parser, which was never moved');
    await page.getByRole('button', { name: 'Collapse all' }).click();
    assert.equal(await page.getByRole('grid', { name: 'Initiatives, in order' }).count(), 1, 'the overview');
    assert.doesNotMatch(await main.textContent(), /Write the recovery guide/);
    assert.equal(await page.getByRole('button', { name: 'Collapse all' }).isDisabled(), true);
    if (shots) await page.screenshot({ path: join(shots, 'plan-overview-1440-dark.png'), fullPage: true });
    await page.getByRole('button', { name: 'Expand all' }).click();
    assert.match(await main.textContent(), /Stream parser/);
    assert.match(await main.textContent(), /Write the recovery guide/);
    assert.deepEqual(errors, []);
    await context.close();
  }
  for (const width of [1440, 390])
    for (const theme of ['dark', 'light'])
      await t.test(`overview ${width} ${theme}: no clipping or axe violations`, async () => {
        const { page, errors, context } = await open(width, theme);
        // A phone keeps the folds in Tune.
        if (width === 390) await page.getByRole('button', { name: 'Tune' }).click();
        await page.getByRole('button', { name: 'Collapse all' }).click();
        if (width === 390) await page.getByRole('button', { name: 'Done' }).click();
        await page.getByRole('grid', { name: 'Initiatives, in order' }).waitFor();
        if (width === 390) {
          // Phones move a row through its handle's menu.
          await page.locator('.ds-move[aria-label="Move Documentation and recovery paths"]').click();
          await page.getByRole('menuitem', { name: 'Down one' }).click();
          await page.waitForFunction(() => window.puts.length === 1);
          assert.equal((await page.evaluate(() => window.puts[0])).itemId, docsId);
        }
        await check(page, `overview ${width} ${theme}`);
        if (shots)
          await page.screenshot({ path: join(shots, `plan-overview-${width}-${theme}.png`), fullPage: true });
        assert.deepEqual(errors, []);
        await context.close();
      });

  // The Initiative page: its open Items, progress and About; an edit writes only what changed; done Items on request.
  {
    const { page, errors, context } = await open(1440, 'dark', `/${launchId}`);
    const main = page.locator('main');
    assert.match(
      await main.textContent(),
      /9 Items in this Initiative · 4 done · 1 in progress · 2 open · 1 proposed · 1 removed\./,
    );
    assert.match(await main.textContent(), /Everything that must land before the parser ships\./);
    assert.match(await main.textContent(), /Stream parser/);
    assert.doesNotMatch(await main.textContent(), /Write the recovery guide/);
    await page.getByRole('button', { name: 'Done and dropped Items' }).click();
    await page.waitForFunction(id => window.doneFor.includes(id), launchId);
    assert.match(await main.textContent(), /Old reader removed/);
    assert.doesNotMatch(
      await main.textContent(),
      /Ship a second parser/,
      'another Initiative’s Item is not listed',
    );
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const name = page.getByRole('textbox', { name: 'Name' });
    await name.fill('Launch the streaming parser');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => window.puts.length === 1);
    assert.deepEqual(await page.evaluate(() => window.puts[0]), {
      itemId: launchId,
      expectedVersion: 3,
      title: 'Launch the streaming parser',
    });
    await page.getByRole('button', { name: /^New Item here/ }).click();
    assert.equal(await page.getByRole('combobox', { name: 'Initiative' }).inputValue(), launchId);
    assert.deepEqual(errors, []);
    await context.close();
  }
  await t.test(
    'an Initiative with live work under another parent links to its Items in the Plan tree',
    async () => {
      const initiative = '00000000-0000-4000-8000-000000000003';
      const { page, errors, context } = await open(390, 'dark', `/${initiative}?split-initiative`);
      await page
        .getByText(/131 Items in this Initiative · 123 done · 0 in progress · 1 open · 7 removed/)
        .waitFor();
      assert.equal(await page.getByText('No open Items.', { exact: true }).count(), 0);
      await page.getByRole('link', { name: 'See open Items under their parents in Plan' }).click();
      await page.waitForURL(url => url.searchParams.get('initiative') === initiative);
      await page
        .locator('.tt.sub')
        .getByRole('link', { name: 'Bench the parser against the old reader' })
        .waitFor();
      assert.deepEqual(errors, []);
      await context.close();
    },
  );
  await t.test('Initiative headers and detail show exact counts beyond the display window', async () => {
    const words = '1,024 done · 1 in progress · 525 open · 1 proposed · 1 removed';
    for (const layout of ['list', 'tree']) {
      const { page, context } = await open(390, 'dark', `?layout=${layout}&exact-counts`);
      const box = (await headers(page)).find(box => box.words === words);
      assert.equal(box?.chip, 1552);
      assert.equal(await page.getByText('Stream parser: preserve split bytes across reads').count(), 1);
      await context.close();
    }
    const { page, context } = await open(390, 'dark', `/${launchId}?exact-counts`);
    assert.match(
      await page.locator('main').textContent(),
      new RegExp(`1,552 Items in this Initiative · ${words}`),
    );
    await context.close();
  });
  await t.test(
    'a partial Initiative view names its lower bounds without saying all work is done',
    async () => {
      const { page, context } = await open(390, 'dark', `/${docsId}?partial-counts`);
      await page.getByText('No open Items shown.', { exact: true }).waitFor();
      assert.match(await page.locator('main').textContent(), /2\+ Items in this Initiative/);
      assert.equal(await page.getByRole('button', { name: 'Close the Initiative' }).count(), 0);
      const liveCount = page.locator('.plan-ini-body .ph .cnt').first();
      assert.equal(await liveCount.textContent(), '0+');
      assert.equal(await liveCount.isVisible(), true);
      assert.equal(await page.locator('.plan-gh .cnt').textContent(), '2+');
      await context.close();
    },
  );
  const initiativeFixture = await itemWorkFixture({ initiativeId: launchId, details: true, extraOpen: 2 });
  await initiativeFixture.rebuildInitiative();
  for (const width of [1440, 390])
    for (const theme of ['dark', 'light'])
      await t.test(`initiative page ${width} ${theme}: no clipping or axe violations`, async () => {
        const calls = [];
        const { page, errors, context } = await open(width, theme, `/${launchId}`, false, false, args => {
          calls.push(args);
          return initiativeFixture.readInitiativeRaw(args);
        });
        const progress = page.getByRole('region', { name: 'Initiative progress' });
        await progress.getByText('@release-lead', { exact: true }).waitFor();
        const working = progress.getByRole('link', { name: '2 agents', exact: true });
        await working.waitFor();
        assert.match(await working.getAttribute('href'), /\/lanes\/touching$/);
        assert.doesNotMatch(await progress.textContent(), /Owner|amber-fox|another-editor/);
        assert.deepEqual(await page.evaluate(() => window.initiativeReads), [
          'projectWorkIndex:detail',
          'projectWorkIndex:records',
        ]);
        assert.equal(await page.evaluate(() => window.workerReads), 1);
        await progress.getByText('2+', { exact: true }).waitFor();
        assert.ok(await progress.getByText(/^\d+ in progress$/).isVisible());
        assert.match(await progress.textContent(), /Lanes open3Landings2Files touched2\+/);
        assert.equal(await progress.getByRole('button', { name: 'Show more work' }).count(), 0);
        await page.getByRole('button', { name: 'Done and dropped Items' }).click();
        assert.deepEqual(calls, [{ initiativeId: launchId }]);
        await check(page, `initiative ${width} ${theme}`);
        if (shots)
          await page.screenshot({
            path: join(shots, `plan-initiative-${width}-${theme}.png`),
            fullPage: true,
          });
        assert.deepEqual(errors, []);
        await context.close();
      });

  // On a phone: one count for the list, Find and Tune on one row at one height, the
  // offered filters, order and layout folded into the sheet, each row's status under its name, the line's counts beside
  // their own words, and the page's end clear of the fixed tab bar even with a count on Needs me.
  for (const theme of ['dark', 'light'])
    await t.test(`phone ${theme}: one count, title picker, Tune, rows and the end of the page`, async () => {
      const { page, errors, context } = await open(390, theme, '', true);
      // On the app's own address a change of view is an in-page step, as for a reader (elsewhere it reloads the page).
      await page.evaluate(() => history.replaceState(null, '', `/-${location.pathname}`));
      const main = page.locator('main#main');
      const list = page.getByRole('region', { name: 'Open work' });
      const toolbarCount = list.locator('.plan-tbar').getByText(/^\d+ Items?$/);
      assert.equal(await toolbarCount.count(), 1, 'the toolbar keeps one count for assistive tech');
      assert.ok((await toolbarCount.boundingBox()).width <= 1, 'the toolbar count is visually hidden');
      assert.equal(
        await list.locator(':scope > .ph .cnt').isVisible(),
        true,
        'the list head shows its count',
      );
      assert.equal(
        await page.getByRole('combobox', { name: 'View' }).count(),
        0,
        'no view band above the list',
      );
      for (const hidden of ['Collapse all', 'Order: by hand', 'List'])
        assert.equal(
          await page.getByRole('button', { name: hidden, exact: true }).isVisible(),
          false,
          hidden,
        );
      assert.equal(await page.getByRole('button', { name: 'Type: any' }).isVisible(), false);
      const find = page.getByRole('searchbox', { name: 'Find in the plan' });
      const tune = page.getByRole('button', { name: 'Tune' });
      const [findBox, tuneBox] = [await find.boundingBox(), await tune.boundingBox()];
      assert.ok(
        Math.abs(findBox.y - tuneBox.y) < 1 && Math.abs(findBox.height - tuneBox.height) < 1,
        'one row, one height',
      );
      assert.equal(await page.locator('.plan-tbar .find svg').isVisible(), true, 'Find shows its icon');
      // A row: its status on the line under its name, the name keeping the width.
      const row = page.locator('.row', { hasText: 'Recover from a truncated frame' });
      const [title, status] = [row.locator('.ttl'), row.locator('.tt .plan-st')];
      assert.equal(await status.isVisible(), true);
      assert.equal(await row.locator('.state').isVisible(), false);
      assert.ok(
        (await status.boundingBox()).y >=
          (await title.boundingBox()).y + (await title.boundingBox()).height - 1,
      );
      assert.ok((await title.boundingBox()).width >= 200, 'the name keeps the width');
      // The line: each count nearer its own word than the next stop's.
      const stops = await page.locator('.line.phone [data-stop]').evaluateAll(links =>
        links.map(link => {
          const [label, count] = [link.querySelector('.lbl'), link.querySelector('.n')].map(n =>
            n.getBoundingClientRect(),
          );
          return { own: count.left - label.right, next: link.getBoundingClientRect().right - count.right };
        }),
      );
      for (const stop of stops) assert.ok(stop.own < stop.next, JSON.stringify(stop));
      // The title changes the view in the address. Tune changes a filter, the order and the layout.
      await page.getByRole('button', { name: 'Plan: Open work. Choose a page' }).click();
      const views = page.getByRole('dialog', { name: 'Plan' });
      await views.getByRole('link', { name: 'Closed', exact: true }).click();
      await page.waitForFunction(() => location.search.includes('scope=closed'));
      await page.getByRole('button', { name: 'Plan: Closed. Choose a page' }).click();
      await views.getByRole('link', { name: /^Open work/ }).click();
      await page.waitForFunction(() => !location.search.includes('scope='));
      await tune.click();
      const sheet = page.getByRole('dialog', { name: 'Tune' });
      await sheet.getByRole('combobox', { name: 'Owner' }).waitFor();
      await check(page, `phone sheet ${theme}`);
      await sheet.getByRole('combobox', { name: 'Owner' }).selectOption('none');
      await page.waitForFunction(() => location.search.includes('owner=none'));
      await sheet.getByRole('combobox', { name: 'Order' }).selectOption('title');
      await page.waitForFunction(() => location.search.includes('sort=title'));
      await sheet.getByRole('button', { name: 'Tree' }).click();
      await page.waitForFunction(() => location.search.includes('view=tree'));
      await sheet.getByRole('button', { name: 'Done' }).click();
      await sheet.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Remove Owner no one' }).click();
      await page.waitForFunction(() => !location.search.includes('owner='));
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const ends = await page.evaluate(() => {
        const tabs = document.querySelector('.shell > .tabs').getBoundingClientRect();
        const rows = [...document.querySelectorAll('main#main .row')].map(
          row => row.getBoundingClientRect().bottom,
        );
        return {
          tabsTop: tabs.top,
          tabsHeight: tabs.height,
          last: Math.max(...rows),
          pad: parseFloat(getComputedStyle(document.querySelector('.shell')).paddingBottom),
        };
      });
      assert.equal(await page.locator('.shell > .tabs .cnt').count(), 1, 'Needs me carries a count');
      assert.ok(
        Math.abs(ends.tabsHeight - ends.pad) < 1,
        `tab bar ${ends.tabsHeight}px, page leaves ${ends.pad}px`,
      );
      assert.ok(
        ends.last <= ends.tabsTop + 0.5,
        `last row ends at ${ends.last}, tab bar starts at ${ends.tabsTop}`,
      );
      assert.match(await main.textContent(), /Stream parser/);
      await check(page, `phone ${theme}`);
      if (shots) await page.screenshot({ path: join(shots, `plan-phone-${theme}.png`) });
      assert.deepEqual(errors, []);
      await context.close();
    });
  if (sidebarShots) {
    mkdirSync(sidebarShots, { recursive: true });
    for (const [width, theme, query] of [
      [1440, 'dark', '?owner=none'],
      [1440, 'light', ''],
      [1024, 'light', ''],
      [390, 'light', ''],
    ]) {
      const { page, context } = await open(width, theme, query);
      await page.evaluate(() =>
        localStorage.setItem(
          'forge.plan.views.synthetic',
          JSON.stringify([
            { name: 'Bugs with no owner', query: '?type=bug&owner=none' },
            { name: 'Documentation', query: '?type=docs' },
          ]),
        ),
      );
      await page.reload();
      await page.locator('.plan h1').first().waitFor();
      if (width === 1024) {
        await page.locator('.rail').getByRole('link', { name: 'Plan', exact: true }).hover();
        await page
          .getByRole('group', { name: 'Plan pages' })
          .getByRole('link', { name: /^Open work/ })
          .waitFor();
      }
      await page.setViewportSize({ width, height: width === 390 ? 844 : width === 1024 ? 768 : 860 });
      await settleBrowserPage(page);
      const name =
        width === 1440 ? `plan-${theme}` : width === 1024 ? 'plan-collapsed-light' : 'plan-phone-light';
      await page.screenshot({ path: join(sidebarShots, `${name}.png`) });
      if (width === 390) {
        await page.getByRole('button', { name: 'Plan: Open work. Choose a page' }).click();
        await page.getByRole('dialog', { name: 'Plan' }).waitFor();
        await settleBrowserPage(page);
        await page.screenshot({ path: join(sidebarShots, 'plan-phone-views-light.png') });
      }
      await context.close();
    }
  }
  // Archive and Deleted (Item 4c9e961e): a shelved row comes back to the status it left in one batch write with Undo,
  // and the Item page sends an Item to Deleted the same way.
  {
    const { page, errors, context } = await open(1440, 'dark', '?scope=deleted');
    const list = page.getByRole('list', { name: 'Deleted Items' });
    assert.match(
      await list.textContent(),
      /Benchmark against the v1 parser.*deleted 1 nov.*was In progress/i,
    );
    const date = list.locator('time');
    assert.equal(await date.textContent(), 'Purges from 1 Dec 2026');
    assert.equal(await date.getAttribute('datetime'), '2026-12-01T09:00:00.000Z');
    const before = await page.evaluate(() => window.calls.length);
    await list.getByRole('button', { name: 'Restore' }).click();
    await page.waitForFunction(n => window.calls.length === n + 1, before);
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), [
      {
        action: 'put-planning-item',
        itemId: '00000000-0000-4000-8000-000000000031',
        expectedVersion: 3,
        status: 'in-progress',
      },
    ]);
    await page.getByRole('status').getByRole('button', { name: 'Undo' }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    // The fixture has no Convex client, so this Item page is drawn without a project id (no comment reads).
    const tidy = '00000000-0000-4000-8000-000000000016';
    const { page, errors, context } = await open(1440, 'light', `/${tidy}`);
    const before = await page.evaluate(() => window.calls.length);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.waitForFunction(n => window.calls.length === n + 1, before);
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), [
      { action: 'put-planning-item', itemId: tidy, expectedVersion: 2, status: 'deleted' },
    ]);
    assert.match(await page.locator('.toast').textContent(), /Deleted “Tidy the old notes”\./);
    await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
    await page.waitForFunction(n => window.calls.length === n + 2, before);
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), [
      { action: 'put-planning-item', itemId: tidy, expectedVersion: 3, status: 'open' },
    ]);
    await check(page, 'item page after delete and undo');
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    // Review 9cc310fc: a Deleted Item opened by its link says where it is and offers Restore, never Archive or Delete.
    const gone = '00000000-0000-4000-8000-000000000031';
    const { page, errors, context } = await open(1440, 'light', `/${gone}`);
    assert.match(await page.locator('main').textContent(), /Benchmark against the v1 parser Deleted\./);
    assert.match(await page.locator('.quietline[role=status]').textContent(), /is deleted, was In progress/);
    await page.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menuitem');
    assert.deepEqual(await menu.allTextContents(), ['Restore', 'Delete forever']);
    await page.getByRole('menuitem', { name: 'Delete forever' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete forever' });
    const confirm = dialog.getByRole('button', { name: 'Delete forever' });
    assert.equal(await confirm.isDisabled(), true);
    await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
    await confirm.click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.purges), [
      { itemId: gone, version: 3, confirmation: 'DELETE' },
    ]);
    await page.getByRole('button', { name: 'More actions' }).click();
    const before = await page.evaluate(() => window.calls.length);
    await page.getByRole('menuitem', { name: 'Restore' }).click();
    await page.waitForFunction(n => window.calls.length === n + 1, before);
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), [
      {
        action: 'put-planning-item',
        itemId: gone,
        expectedVersion: 3,
        status: 'in-progress',
      },
    ]);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // A one-row open plan does not make its short address unique when a Deleted Item has the same prefix.
  for (const [address, words] of [
    ['00000000', 'This Item is not in open work.'],
    ['00000000-0000-4000-8000-000000000010', 'Stream parser: preserve split bytes across reads'],
    ['00000000-0000-4000-8000-000000000031', 'Benchmark against the v1 parser Deleted.'],
  ]) {
    const { page, context, errors } = await open(1440, 'light', `/${address}`, false, true);
    await page.locator('main .head .sit').filter({ hasText: words }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
  await t.test('Done and Dropped links open their Item pages and Work from the settled list', async () => {
    const { page, context, errors } = await open(1440, 'light', '?scope=closed', false, true);
    try {
      for (const title of ['Old reader removed', 'Ship a second parser']) {
        await page.getByRole('link', { name: title }).click();
        await page.locator('main .head .sit').filter({ hasText: title }).waitFor();
        await page.getByRole('region', { name: 'Work', exact: true }).waitFor();
        await page.goBack();
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
  // The browser dispatches the production query to the real handler through the indexed records fixture.
  // The same Item has 12 Lanes in both cases, so unrelated project history cannot change either page's cost.
  const workFixture = await itemWorkFixture({
    itemId: '00000000-0000-4000-8000-000000000010',
    initiativeId: launchId,
    extra: 8,
    details: true,
  });
  const { itemId } = workFixture;
  let workCosts;
  for (const unrelated of [0, 10_000]) {
    await t.test(`Item Work reads one bounded page on open with ${unrelated} unrelated Lanes`, async t => {
      await workFixture.addUnrelatedLanes(unrelated);
      const calls = [];
      const costs = [];
      for (const [width, theme] of unrelated
        ? [
            [1440, 'dark'],
            [390, 'light'],
          ]
        : [
            [1440, 'light'],
            [390, 'dark'],
          ]) {
        const { page, context, errors } = await open(width, theme, `/${itemId}`, false, true, async args => {
          calls.push(args);
          const start = performance.now();
          const reply = await workFixture.readRaw({
            cursor: args.cursor,
            limit: args.limit,
            details: args.details,
          });
          const { name, ...cost } = workFixture.counts.at(-1);
          costs.push({ ...cost, responseBytes: Buffer.byteLength(reply) });
          t.diagnostic(
            `${width} ${theme}: ${JSON.stringify(costs.at(-1))}, handler ${(performance.now() - start).toFixed(1)} ms`,
          );
          return reply;
        });
        try {
          const work = page.getByRole('region', { name: 'Work', exact: true });
          const more = work.getByRole('button', { name: 'Show more work' });
          await more.waitFor();
          await page.getByRole('region', { name: 'Comments', exact: true }).waitFor();
          const shift = await page.evaluate(() => window.shifts.reduce((sum, value) => sum + value, 0));
          t.diagnostic(`Item load shift ${width} ${theme}: ${shift.toFixed(3)}`);
          const lanes = work.locator('a.ttl[href*="/lanes/"]');
          const laneThreads = work.locator('a[href$="/thread"]');
          assert.equal(
            await work.getByRole('button', { name: 'Lanes', exact: true }).getAttribute('aria-expanded'),
            'true',
          );
          await work.getByRole('button', { name: 'Landings', exact: true }).click();
          await work.getByRole('button', { name: 'Related', exact: true }).click();
          assert.equal(await lanes.first().textContent(), 'Synthetic outcome');
          assert.match(await lanes.first().locator('..').textContent(), /cobalt-fox.*1 save.*Last save/);
          assert.equal(await work.getByText('2 files changed', { exact: true }).count(), 1);
          assert.equal(await work.getByText('Passed', { exact: true }).count(), 1);
          assert.equal(
            await work.getByRole('link', { name: 'Define the wire format' }).getAttribute('href'),
            `/-/example-builder/synthetic/plan/${workFixture.dependencyId}`,
          );
          assert.equal(await work.getByRole('link', { name: 'Parser release' }).count(), 1);
          assert.equal(await work.getByText('Split into', { exact: true }).count(), 1);
          assert.equal(await work.getByText('Blocks', { exact: true }).count(), 2);
          assert.equal(
            await work.getByRole('link', { name: 'Document compatibility' }).getAttribute('href'),
            `/-/example-builder/synthetic/plan/${workFixture.settledBlockerId}`,
          );
          assert.doesNotMatch(await page.locator('.head .crumb').textContent(), /00000000/);
          const landings = work.getByRole('link', { name: /^Landing / });
          assert.equal(await lanes.count(), 10);
          assert.equal(await laneThreads.count(), 10);
          assert.equal(
            await laneThreads.first().getAttribute('href'),
            `/-/example-builder/synthetic/lanes/${workFixture.open.id}/thread`,
          );
          assert.equal(
            await lanes.first().getAttribute('href'),
            `/-/example-builder/synthetic/lanes/${workFixture.open.id}`,
          );
          assert.equal(await landings.count(), 2);
          assert.equal(
            await landings.first().getAttribute('href'),
            `/-/example-builder/synthetic/code/files?at=${'c'.repeat(64)}`,
          );
          assert.deepEqual(calls.slice(-1), [
            { itemId, projectId: 'synthetic', limit: 10, cursor: null, details: true },
          ]);
          await check(page, `Item Work ${width} ${theme}`);
          assert.equal(
            await lanes.evaluateAll(links =>
              links.some(link => {
                const row = link.closest('.row');
                const facts = row.querySelector('.r').getBoundingClientRect();
                const title = link.getBoundingClientRect();
                const identity = row.querySelector('.who').getBoundingClientRect();
                const titleOverlaps =
                  title.right > facts.left + 1 &&
                  title.bottom > facts.top + 1 &&
                  title.top + 1 < facts.bottom;
                return titleOverlaps || identity.top + 1 < facts.bottom;
              }),
            ),
            false,
            'Lane title, status and identity never overlap',
          );
          if (shots) {
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: join(shots, `item-work-${width}-${theme}.png`), fullPage: true });
          }
          assert.deepEqual(await page.evaluate(() => window.planQueries), ['projectItemWork:read']);
          assert.deepEqual((await page.evaluate(() => window.planSubscriptions())).sort(), [
            'projectDiscussionThread:read',
            'projectPlanCounts:read',
            'projectPlanView:read',
            'projectWorkIndex:workspace',
          ]);
          await more.click();
          await lanes.filter({ hasText: 'Synthetic outcome' }).last().waitFor();
          await work.locator(`a[href$="/lanes/${workFixture.abandoned.id}"]`).waitFor();
          assert.equal(await lanes.count(), 12);
          assert.equal(await laneThreads.count(), 12);
          assert.equal(await landings.count(), 2);
          assert.equal(await work.getByRole('link', { name: 'Define the wire format' }).count(), 1);
          assert.equal(await more.count(), 0);
          assert.deepEqual(await page.evaluate(() => window.planQueries), [
            'projectItemWork:read',
            'projectItemWork:read',
          ]);
          assert.equal(calls.at(-1).itemId, itemId);
          assert.equal(calls.at(-1).limit, 10);
          assert.equal(calls.at(-1).details, true);
          assert(calls.at(-1).cursor?.startsWith('forge-item-work-v2:'));
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      }
      assert.equal(calls.length, 4);
      for (const cost of costs) {
        assert.equal(cost.writes, 0);
        assert(cost.ranges <= 85, JSON.stringify(cost));
        // A Work page may probe up to ten legacy Lane stamps. Unrelated
        // history below must leave the complete database and response costs unchanged.
        assert(cost.documents <= 105, JSON.stringify(cost));
        assert(cost.readBytes < 32 * 1024, JSON.stringify(cost));
      }
      if (unrelated)
        assert.deepEqual(costs, workCosts, 'unrelated Lane heads add no database I/O or response bytes');
      else workCosts = costs;
    });
  }
  for (const [name, search] of [
    ['list', ''],
    ['tree', '?view=tree'],
    ['board', '?scope=all&view=board'],
    ['closed', '?scope=closed&sort=title'],
    ['archive', '?scope=archived'],
    ['deleted', '?scope=deleted'],
    // Find and the Item page (Item 4c9e961e): the same width and theme checks as the plan views.
    ['find', '?q=parser'],
    ['item', '/00000000-0000-4000-8000-000000000016'],
    ['archived item', '/00000000-0000-4000-8000-000000000030'],
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

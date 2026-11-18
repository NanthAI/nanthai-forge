// SPDX-License-Identifier: Apache-2.0
// The Plan screen's views and bulk bar (Items e0a23825, 65b0e706) as real components with synthetic rows: the view
// lives in the address, list / tree / board show the same rows, only ticked rows change, a batch reply names a row
// changed meanwhile and offers one Undo, and every state passes axe with no sideways scroll at desk and phone width in
// both themes. Initiative groups (Item 4df3ee17) fold and stay folded on reload, Collapse all gives the Initiatives
// overview, an Initiative moves with one order write, a group header's roll never draws over its "N of M done" words
// (f49e3a5c, 3-digit counts at 1440, 1024 and 390), and the Initiative page edits its title and asks for its done
// Items. On a phone (owner review 2026-11-17) the list shows one count, Find and one Filter and view key at one height,
// each row's status on the line under its name, and the line's counts beside their own words; the views, filters,
// order, layout and folds are in the sheet. Set FORGE_PLAN_SHOTS to a folder to also save the screenshots.
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
const rest = decodeURIComponent(location.pathname.split('/plan/')[1] ?? '');
const route = { frame: 'project', handle: 'example-builder', project: 'synthetic', place: 'plan', section: '', rest };
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const launch = { id: uuid(1), kind: 'initiative', title: 'Launch the parser', status: 'open', position: 0, version: 3 };
const docs = { id: uuid(2), kind: 'initiative', title: 'Documentation and recovery paths', status: 'open', position: 1, version: 1 };
const big = { id: uuid(3), kind: 'initiative', title: 'A long running release with a name that will not fit on a phone line', status: 'open', position: 2, version: 1 };
const item = (n, fields) => ({ id: uuid(n), kind: 'issue', status: 'open', position: n, version: 2, doneWhen: [1, 3], ...fields });
const rows = [launch, docs, big,
  item(17, { title: 'Last open step of the long release', initiativeId: big.id, status: 'in-progress', order: 'a' }),
  item(10, { title: 'Stream parser: preserve split bytes across reads', initiativeId: launch.id, owner: '@example-builder', type: 'bug', order: 'a' }),
  item(11, { title: 'Recover from a truncated frame without losing the next one', initiativeId: launch.id, status: 'in-progress', owner: '@example-builder/amber-fox', order: 'b' }),
  item(12, { title: 'Bench the parser against the old reader', initiativeId: launch.id, parentId: uuid(10), order: 'c', doneWhen: null }),
  item(13, { title: 'Name every error the parser can return', initiativeId: launch.id, status: 'proposed', relations: [{ kind: 'depends-on', id: uuid(10) }], order: 'd' }),
  item(14, { title: 'Write the recovery guide', initiativeId: docs.id, owner: '@peer-builder', type: 'docs', order: 'a' }),
  item(15, { title: 'Examples for every reader option, including the rarely used ones', initiativeId: docs.id, order: 'b', doneWhen: [0, 12] }),
  item(16, { title: 'Tidy the old notes', order: 'a', doneWhen: [2, 2] }),
];
const read = { rows: JSON.stringify(rows), more: false, settled: [{ initiativeId: launch.id, done: 4, dropped: 1, atLeast: false }, { initiativeId: docs.id, done: 0, dropped: 0, atLeast: false }, { initiativeId: big.id, done: 123, dropped: 7, atLeast: false }], canEdit: true };
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
window.puts = [];
window.doneFor = [];
const put = async command => { window.puts.push(command); };
const reads = {
  items: async ids => ids.map(id => (id === launch.id ? { ...launch, body: 'Everything that must land before the parser ships.' } : { id, version: 1, kind: 'issue', title: id, body: '' })),
  comments: async () => ({ comments: [], more: [] }),
};
function Fixture() {
  const search = useSearch();
  const query = readQuery(search);
  const go = patch => navigate(location.pathname + writeQuery({ ...query, ...patch }), { replace: true });
  // The shell receives the same Needs you count as the page read (window.heldFeed, set before load).
  const feed = window.heldFeed ? { lanes: [{ laneId: uuid(90), stage: 'ready', held: true, overlap: false, changedAt: 1 }], more: 0, moreIsLowerBound: false, main: null } : undefined;
  return <ProjectFrame route={route} name="Synthetic project" feed={feed}
    needs={window.heldFeed ? { n: 1, atLeast: false } : undefined} projects={null}
    controls={{ viewerHandle: 'example-builder', onPicker() {}, onPalette() {}, onKeys() {} }}>
    <React.Suspense fallback={<h1>Loading</h1>}><PlanScreenView route={route} projectId="synthetic" projectName="Synthetic project" feed={undefined} read={read}
      put={put} run={run} reads={reads} query={query} go={go} viewer="example-builder"
      closed={query.scope === 'open' && !rest ? undefined : settled} showDone={id => window.doneFor.push(id)} /></React.Suspense>
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
  const open = async (width, theme, search = '', held = false) => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 } });
    if (held) await context.addInitScript(() => (window.heldFeed = true));
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
        return [
          {
            words: words.textContent,
            meet: a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
            spill: ticks.some(tick => tick.right > a.right + 0.5 || tick.left < a.left - 0.5),
          },
        ];
      }),
    );

  // f49e3a5c: a header's roll and its "N of M done" never meet, at 3-digit counts too, at three widths, both themes.
  for (const width of [1440, 1024, 390])
    for (const theme of ['dark', 'light'])
      await t.test(`group header ${width} ${theme}: the roll never draws over its words`, async () => {
        const { page, errors, context } = await open(width, theme);
        const boxes = await headers(page);
        assert.ok(
          boxes.some(box => /123 of 131 done, 7 dropped/.test(box.words)),
          '3-digit counts are drawn',
        );
        for (const box of boxes) assert.deepEqual({ ...box, meet: false, spill: false }, box, box.words);
        if (shots && width === 1024)
          await page.screenshot({ path: join(shots, `plan-headers-${width}-${theme}.png`), fullPage: true });
        assert.deepEqual(errors, []);
        await context.close();
      });

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
        // A phone keeps the folds in Filter and view.
        if (width === 390) await page.getByRole('button', { name: 'Filter and view' }).click();
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
    assert.match(await main.textContent(), /4 of 9 done, 1 in progress/);
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
  for (const width of [1440, 390])
    for (const theme of ['dark', 'light'])
      await t.test(`initiative page ${width} ${theme}: no clipping or axe violations`, async () => {
        const { page, errors, context } = await open(width, theme, `/${launchId}`);
        await page.getByRole('button', { name: 'Done and dropped Items' }).click();
        await check(page, `initiative ${width} ${theme}`);
        if (shots)
          await page.screenshot({
            path: join(shots, `plan-initiative-${width}-${theme}.png`),
            fullPage: true,
          });
        assert.deepEqual(errors, []);
        await context.close();
      });

  // On a phone (owner review 2026-11-17): one count for the list, Find and Filter and view on one row at one height, the
  // offered filters, order and layout folded into the sheet, each row's status under its name, the line's counts beside
  // their own words, and the page's end clear of the fixed tab bar even with a count on Needs me.
  for (const theme of ['dark', 'light'])
    await t.test(`phone ${theme}: one count, Filter and view, rows and the end of the page`, async () => {
      const { page, errors, context } = await open(390, theme, '', true);
      // On the app's own address a change of view is an in-page step, as for a reader (elsewhere it reloads the page).
      await page.evaluate(() => history.replaceState(null, '', `/-${location.pathname}`));
      const main = page.locator('main#main');
      const list = page.getByRole('region', { name: 'Open work' });
      assert.equal(
        await list.getByText(/^\d+ Items?$/).count(),
        1,
        'the toolbar count is for assistive tech only',
      );
      assert.ok(
        (await list.getByText(/^\d+ Items?$/).boundingBox()).width <= 1,
        'drawn only as the head count',
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
      const tune = page.getByRole('button', { name: 'Filter and view' });
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
      // The sheet: a view, a filter (then a chip on the bar), the order and the layout, all in the address.
      await tune.click();
      const sheet = page.getByRole('dialog', { name: 'Filter and view' });
      await sheet.getByRole('combobox', { name: 'View' }).waitFor();
      await check(page, `phone sheet ${theme}`);
      await sheet.getByRole('combobox', { name: 'View' }).selectOption('Closed');
      await page.waitForFunction(() => location.search.includes('scope=closed'));
      await sheet.getByRole('combobox', { name: 'View' }).selectOption('Open work');
      await page.waitForFunction(() => !location.search.includes('scope='));
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

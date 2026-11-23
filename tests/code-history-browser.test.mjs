// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// What landed narrowed to one file (Item 3968a655), the real Code place signed in on synthetic reads: a deep link to
// ?path= reads that file's landings with one bounded projectCode:fileHistory read per step and never the live page of
// every landing; a step with no match still offers the next; a failed step keeps the rows already read; an older match
// opens its receipt; Clear and Back walk the address without reading again; a reply for a file the reader has left
// never replaces the file now shown; Files links here; nothing is read while idle or on a hidden tab's return; and the
// ready, empty, loading, failed and worst-case states pass axe at 1440 and 390 in both themes without sideways scroll.
// The mock (03-history, ?v=landed): the head offers the agent's command, the receipt shows the landing's message and
// "See the Lane", and who landed it is one handle with its square, cut at the end with the full handle in its label.
// FORGE_CODE_HISTORY_SHOTS=<dir> also writes the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { chromium } from 'playwright';
import { chromiumLaunchOptions, settleBrowserPage } from './browser-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_CODE_HISTORY_SHOTS;
const base = '/ada/atlas/code';
const PATH = 'src/parser/stream-parser.ts';
const OTHER = 'src/lines.ts';
const LONG =
  'packages/a-very-deeply-nested-workspace/src/generated/schemas/deployment-configuration.schema.generated.d.ts';

async function fixture(out) {
  const entry = 'virtual:code-history-test';
  const source = `
    import {createElement as h} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ConvexProvider} from 'convex/react';
    import {getFunctionName} from 'convex/server';
    import CodePlace from ${JSON.stringify(join(root, 'web/src/app/code/CodePlace.tsx'))};
    import {useRoute} from ${JSON.stringify(join(root, 'web/src/app/router.ts'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    const HEAD = 'a'.repeat(64), BASE = 'b'.repeat(64);
    const now = Date.now();
    const LONG_RUN = 'an-unreasonably-long-agent-handle-that-keeps-going';
    const WHY = 'A multi-byte character split across two chunks was decoded as two replacement characters. The parser now keeps the incomplete tail of a chunk.';
    const LONG_WHY = WHY + ' Generated id: ' + 'f'.repeat(400);
    const land = (sequence, title, more = {}) => ({
      receiptId: String(sequence).padStart(8, '0') + '-0000-4000-8000-000000000000',
      sequence, at: new Date(now - (300 - sequence) * 3_600_000).toISOString(), title, why: null,
      actor: 'mara', agent: true, agentRun: 'amber-fox', agentClient: null, head: HEAD, base: BASE,
      automatic: false, check: { runId: 'run-' + sequence, testsSkipped: false }, firstCheck: 'admission-run',
      batch: false, docsMerged: false, ...more,
    });
    const page = (landings, scanned, nextBefore, missing = 0) => ({ landings, missing, scanned, nextBefore });
    const P = ${JSON.stringify(PATH)}, O = ${JSON.stringify(OTHER)}, L = ${JSON.stringify(LONG)};
    // Each path's steps by their start; a function answers per attempt.
    let failed = 0;
    const steps = {
      [P]: {
        null: page([land(300, 'Stream parser: handle split UTF-8', { why: WHY }), land(290, 'End of stream flushes held bytes', { agentRun: null, agent: false })], 96, 205),
        205: page([], 96, 109),
        109: () => (failed++ ? page([land(50, 'Parser: first version', { check: null })], 108, null) : null),
      },
      [O]: { null: page([land(280, 'Lines: drain in one place')], 40, null) },
      'docs/never.md': { null: page([], 96, 205), 205: page([], 4, null) },
      [L]: { null: page([
        land(299, 'إضافة ميزانية إعادة المحاولة إلى محوّل الجلب وكل ما يتبعه من اختبارات ووثائق', { actor: 'bartholomew-fitzgerald-the-third', agentRun: LONG_RUN, why: LONG_WHY }),
        land(298, null, { actor: undefined }),
        land(297, 'x', { agent: false, agentRun: null }),
        land(296, '🦀 Regenerate every schema, all 4,812 of them, after the configuration format changed again', { actor: undefined, agent: false, agentRun: null, check: null }),
      ], 96, 1, 3) },
    };
    const held = new Map();
    window.release = path => { held.get(path)?.(); held.delete(path); };
    window.calls = [];
    const noop = () => {};
    const fail = () => Promise.reject(Object.assign(new Error('refused'), { data: { message: 'The read did not finish. Your work is safe; try again.' } }));
    const history = { landings: [land(300, 'Stream parser: handle split UTF-8'), land(299, 'Docs: the import format'), land(280, 'Lines: drain in one place')], nextCursor: null };
    const watched = (name, args) => {
      if (name === 'projectCode:history') return JSON.stringify(history);
      // The receipt's evidence (the existing landings read): its Lane, and six minutes from land to main.
      if (name === 'projectHostedLandings:read')
        return JSON.stringify({ schema: 1, landings: [300, 299].map(sequence => {
          const row = land(sequence, null);
          return { receiptId: row.receiptId, laneId: 'lane-' + sequence, intentId: null, submittedAt: new Date(Date.parse(row.at) - 360_000).toISOString(), committedAt: row.at };
        }) });
      throw new Error('unexpected watch ' + name);
    };
    const client = {
      watchQuery: (ref, args) => {
        window.calls.push(['watch', getFunctionName(ref), args]);
        return { onUpdate: () => noop, localQueryResult: () => watched(getFunctionName(ref), args), localQueryLogs: () => undefined, journal: noop };
      },
      query: async (ref, args) => {
        const name = getFunctionName(ref);
        window.calls.push(['query', name, args]);
        if (name === 'projectCode:history' && args.receiptId)
          return JSON.stringify({ landings: [land(50, 'Parser: first version', { check: null })].filter(row => row.receiptId === args.receiptId), nextCursor: null });
        if (name !== 'projectCode:fileHistory') throw new Error('unexpected query ' + name);
        if (args.path === 'src/fail.ts') return fail();
        if (args.path === 'src/slow.ts' || (window.hold && window.hold.includes(args.path + ':' + args.before)))
          await new Promise(resolve => held.set(args.path === 'src/slow.ts' ? args.path : args.path + ':' + args.before, resolve));
        const step = steps[args.path]?.[String(args.before)];
        const answer = typeof step === 'function' ? step() : step;
        return answer ? JSON.stringify(answer) : fail();
      },
      action: async (ref, args) => {
        window.calls.push(['action', getFunctionName(ref), args]);
        if (args.want === 'changes') return JSON.stringify({ state: args.state, changes: [{ path: P, status: 'modified' }], total: 1 });
        const dir = (path, names) => ({ path, entries: names.map(([name, kind]) => ({ name, path: (path ? path + '/' : '') + name, kind })), total: names.length, next: null });
        const dirs = [dir('', [['src', 'dir']]), dir('src', [['parser', 'dir'], ['lines.ts', 'file']]), dir('src/parser', [['stream-parser.ts', 'file']])];
        const text = 'export class StreamParser {}\\n';
        return JSON.stringify({ state: HEAD, files: 2, kind: 'file', dirs, file: { available: true, path: args.path, blob: 'c'.repeat(64), mode: 'file', page: { kind: 'text', text, offset: 0, nextOffset: null, totalCharacters: text.length } } });
      },
      mutation: () => Promise.reject(new Error('no writes here')),
      logger: { warn: noop, log: noop, error: noop, logVerbose: noop },
      connectionState: () => ({ isWebSocketConnected: true, hasInflightRequests: false }),
      subscribeToConnectionState: () => noop,
    };
    const feed = { main: { head: HEAD }, lanes: [], more: 0, moreIsLowerBound: false };
    function Root() {
      const route = useRoute();
      return h(CodePlace, { route, projectId: 'p1', projectName: 'atlas', feed, viewerHandle: 'ada' });
    }
    createRoot(document.getElementById('root')).render(h(ConvexProvider, {client}, h(Root)));`;
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    plugins: [
      {
        name: 'code-history-fixture',
        resolveId(id) {
          if (id === entry) return '\0code-history-test.js';
        },
        load(id) {
          if (id === '\0code-history-test.js') return source;
        },
      },
    ],
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: entry } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const script = output.find(
    item => item.type === 'chunk' && item.isEntry && item.facadeModuleId?.includes('code-history-test'),
  ).fileName;
  const styles = output
    .filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map(item => `<link rel="stylesheet" href="/${item.fileName}">`)
    .join('');
  return `<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Forge</title><style>body{margin:0}</style>${styles}</head><body><main id="main" tabindex="-1"><div id="root"></div></main><script type="module" src="/${script}"></script></body></html>`;
}

const q = encodeURIComponent;
/** Waits for an address by its path and its ?path=, however the browser spells the query. */
const at = (view, pathname, path = null) =>
  view.waitForURL(url => url.pathname === pathname && url.searchParams.get('path') === path);
const receipt50 = `${base}/00000050-0000-4000-8000-000000000000`;
const fileReads = view =>
  view.evaluate(() =>
    window.calls.filter(([, name]) => name === 'projectCode:fileHistory').map(([, , args]) => args),
  );

test('What landed narrowed to one file: bounded steps, kept rows, exact address, no idle reads', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-code-history-'));
  const html = await fixture(out);
  const browser = await chromium.launch(launchOptions);
  if (shots) mkdirSync(shots, { recursive: true });
  t.after(async () => {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  });
  const errors = [];
  const open = async (path, { width = 1440, theme = 'dark', ready = true, hold } = {}) => {
    const view = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 1000 },
      locale: 'en-GB',
      timezoneId: 'UTC',
    });
    t.after(() => view.close());
    view.on('pageerror', error => errors.push(error.message));
    await view.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const file = join(out, url.pathname.slice(1));
      const asset = url.pathname.startsWith('/assets/') && existsSync(file);
      const type = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'font/woff2';
      return route.fulfill(
        asset ? { contentType: type, body: readFileSync(file) } : { contentType: 'text/html', body: html },
      );
    });
    if (hold) await view.addInitScript(value => (window.hold = value), hold);
    await view.goto(`https://forge.test${path}`);
    await view.evaluate(value => (document.documentElement.dataset.theme = value), theme);
    await view.locator('h1').first().waitFor();
    if (ready) await view.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    return view;
  };
  const list = view => view.getByRole('region', { name: 'What landed' });
  const titles = view => list(view).locator('a.hrow .ttl').allTextContents();

  // A deep link reads the file's first step once, and never the live page of every landing.
  const deep = await open(`${base}?path=${q(PATH)}`);
  assert.deepEqual(await titles(deep), [
    'Stream parser: handle split UTF-8',
    'End of stream flushes held bytes',
  ]);
  assert.deepEqual(await fileReads(deep), [{ projectId: 'p1', path: PATH, before: null }]);
  const calls = await deep.evaluate(() => window.calls.map(([kind, name]) => `${kind} ${name}`));
  assert.ok(!calls.includes('watch projectCode:history'), 'a narrowed list does not read every landing');
  assert.equal(await list(deep).locator('.chip .path-cut').textContent(), `\u200e${PATH}`);
  assert.equal(await list(deep).locator('.tbar .n').textContent(), '2 of 96 landings');
  assert.match(await deep.locator('.head .sit').textContent(), /^2 landings touched stream-parser\.ts\./);
  assert.match(await list(deep).locator('.path-foot').textContent(), /Looked at 96 landings\./);
  // The receipt beside it is the first match's, and it reads only that landing's evidence and changes.
  const receipt = deep.getByRole('region', { name: 'Receipt' });
  await receipt.getByRole('heading', { name: 'Stream parser: handle split UTF-8' }).waitFor();
  // As the mock: the message under the title, one handle for who landed it, and "See the Lane" beside "Read the code here".
  await receipt.getByText(/^A multi-byte character split across two chunks/).waitFor();
  const lane = receipt.getByRole('link', { name: 'See the Lane' });
  await lane.waitFor();
  assert.equal(await lane.getAttribute('href'), '/ada/atlas/lanes/lane-300');
  assert.match(await receipt.textContent(), /6 min 0 s from land/);
  // Files says how many and lists them under it, never a bare ellipsis (Item 0485fe7d).
  assert.match(await receipt.locator('.kv').textContent(), /Files1 file, listed below/);
  assert.deepEqual(
    await receipt.getByRole('list', { name: 'Files it changed' }).locator('li a').allTextContents(),
    [PATH],
  );
  const handles = cells => cells.locator('.who.handle > .mono').allTextContents();
  assert.deepEqual(await handles(list(deep).locator('a.hrow > .who')), ['mara/amber-fox', '@mara']);
  assert.deepEqual(await handles(receipt.locator('.kv')), ['mara/amber-fox']);
  assert.doesNotMatch(
    await deep.locator('.panes').textContent(),
    /for @/,
    'one handle, never "run · for @person"',
  );
  // The head offers what an agent runs: a key that shows the exact command for this file.
  const cli = deep.locator('.head .tools button.cli');
  assert.equal(await cli.textContent(), 'nforge agent . history');
  await cli.focus();
  await deep.keyboard.press('Enter');
  assert.equal(await cli.getAttribute('aria-expanded'), 'true');
  assert.match(
    await deep.locator('#history-cli').textContent(),
    /^\$ nforge agent \. history '\{"op":"log","path":"src\/parser\/stream-parser\.ts","limit":50\}'/,
  );
  await deep.keyboard.press('Enter');
  assert.ok(
    await deep.locator('#history-cli').isHidden(),
    'Enter again folds it; aria-controls keeps its target',
  );

  // A step with no match still says how far it looked and offers the next step.
  await list(deep).getByRole('button', { name: 'Look further back' }).click();
  await list(deep).locator('.path-foot').getByText('Looked at 192 landings.').waitFor();
  assert.equal(await list(deep).locator('.tbar .n').textContent(), '2 of 192 landings');
  assert.equal(await list(deep).getByRole('button', { name: 'Look further back' }).count(), 1);
  // A failed step keeps the rows already read and says when they were read; Retry asks for the same step.
  await list(deep).getByRole('button', { name: 'Look further back' }).click();
  const notice = deep.getByRole('alert');
  await notice.getByText(/could not be read just now\. What is below is from \d\d:\d\d\./).waitFor();
  assert.deepEqual(await titles(deep), [
    'Stream parser: handle split UTF-8',
    'End of stream flushes held bytes',
  ]);
  await notice.getByRole('button', { name: 'Retry' }).click();
  await list(deep).getByText('Parser: first version').waitFor();
  assert.equal(await deep.getByRole('alert').count(), 0);
  assert.match(await list(deep).locator('.path-foot').textContent(), /That is the first landing\./);
  assert.equal(await list(deep).getByRole('button', { name: 'Look further back' }).count(), 0);
  assert.deepEqual(
    (await fileReads(deep)).map(args => args.before),
    [null, 205, 109, 109],
    'one read per requested step, and the retry repeats only the failed step',
  );
  // The older match opens its receipt from the row already read: no exact receipt read.
  await list(deep)
    .getByRole('link', { name: /Parser: first version/ })
    .click();
  await at(deep, receipt50, PATH);
  await receipt.getByRole('heading', { name: 'Parser: first version' }).waitFor();
  assert.match(await receipt.textContent(), /Landed without a check/);
  assert.deepEqual(
    await deep.evaluate(() =>
      window.calls.filter(([, name, args]) => name === 'projectCode:history' && args.receiptId),
    ),
    [],
    'a row already read opens its receipt with no exact receipt read',
  );
  // Clear lists every landing; Back returns to the narrowed list from the steps already read.
  await list(deep).getByRole('button', { name: 'Clear the path' }).click();
  await at(deep, base);
  await list(deep).getByText('Docs: the import format').waitFor();
  assert.equal(await list(deep).locator('.chip').count(), 0);
  await deep.goBack();
  await at(deep, receipt50, PATH);
  await list(deep).getByText('Parser: first version').waitFor();
  assert.equal((await fileReads(deep)).length, 4, 'Back reads nothing again');
  // Keyboard: the find field takes a path; Enter narrows to it; Up and Down move between rows.
  await list(deep).getByRole('searchbox', { name: 'Narrow to one file' }).fill(OTHER);
  await deep.keyboard.press('Enter');
  await at(deep, base, OTHER);
  await list(deep).getByText('Lines: drain in one place').waitFor();
  assert.deepEqual(await titles(deep), ['Lines: drain in one place']);
  await deep.goBack();
  await at(deep, receipt50, PATH);
  await list(deep).locator('a.hrow').first().focus();
  await deep.keyboard.press('ArrowDown');
  const focused = () => deep.evaluate(() => document.activeElement?.querySelector('.ttl')?.textContent);
  assert.equal(await focused(), 'End of stream flushes held bytes', 'Down moves to the next row');
  await deep.keyboard.press('ArrowUp');
  assert.equal(await focused(), 'Stream parser: handle split UTF-8', 'Up moves back');
  // Idle and a hidden tab's return read nothing: the narrowed list has no subscription to catch up.
  const before = await deep.evaluate(() => window.calls.length);
  await deep.evaluate(() => {
    for (const state of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  await settleBrowserPage(deep);
  assert.equal(await deep.evaluate(() => window.calls.length), before, 'no read while idle or on return');

  // A reply for a file the reader has left never replaces the file now shown.
  const stale = await open(`${base}?path=${q(PATH)}`, { hold: [`${PATH}:null`], ready: false });
  await list(stale).locator('[aria-busy="true"]').waitFor();
  await list(stale).getByRole('searchbox', { name: 'Narrow to one file' }).fill(OTHER);
  await stale.keyboard.press('Enter');
  await list(stale).getByText('Lines: drain in one place').waitFor();
  await stale.evaluate(path => window.release(`${path}:null`), PATH);
  await settleBrowserPage(stale);
  assert.deepEqual(await titles(stale), ['Lines: drain in one place']);
  assert.match(await stale.locator('.head .sit').textContent(), /^1 landing touched lines\.ts\./);
  // The same holds for a later step still in flight when the reader moves on.
  await stale.goBack();
  await at(stale, base, PATH);
  await list(stale).getByText('Stream parser: handle split UTF-8').waitFor();
  await stale.evaluate(path => (window.hold = [`${path}:205`]), PATH);
  await list(stale).getByRole('button', { name: 'Look further back' }).click();
  await stale.goForward();
  await list(stale).getByText('Lines: drain in one place').waitFor();
  await stale.evaluate(path => window.release(`${path}:205`), PATH);
  await settleBrowserPage(stale);
  assert.deepEqual(await titles(stale), ['Lines: drain in one place']);
  assert.equal(await list(stale).locator('.tbar .n').textContent(), '1 of 40 landings');

  // A step still in flight when its file leaves the kept steps (12 other paths later) is dropped: going back reads
  // the file from its first step again instead of showing the later step alone as its whole history.
  const evicted = await open(`${base}?path=${q(PATH)}`);
  await evicted.evaluate(path => (window.hold = [`${path}:205`]), PATH);
  await list(evicted).getByRole('button', { name: 'Look further back' }).click();
  const find = list(evicted).getByRole('searchbox', { name: 'Narrow to one file' });
  for (let i = 0; i < 12; i++) {
    await find.fill(`src/other-${i}.ts`);
    await evicted.keyboard.press('Enter');
    await at(evicted, base, `src/other-${i}.ts`);
    await evicted.getByRole('alert').waitFor();
  }
  await evicted.evaluate(path => window.release(`${path}:205`), PATH);
  await find.fill(PATH);
  await evicted.keyboard.press('Enter');
  await list(evicted).getByText('End of stream flushes held bytes').waitFor();
  await settleBrowserPage(evicted);
  assert.deepEqual(await titles(evicted), [
    'Stream parser: handle split UTF-8',
    'End of stream flushes held bytes',
  ]);
  assert.equal(await list(evicted).locator('.tbar .n').textContent(), '2 of 96 landings');
  assert.deepEqual(
    (await fileReads(evicted)).filter(args => args.path === PATH).map(args => args.before),
    [null, 205, null],
  );

  // Files: the file's own short list links to the full timeline at ?path=.
  const files = await open(`${base}/files/${PATH}`);
  const touched = files.getByRole('region', { name: 'In this file' });
  const all = touched.getByRole('link', { name: 'All landings that touched it' });
  await all.waitFor();
  assert.equal(await all.getAttribute('href'), `${base}?path=${PATH}`);
  await all.click();
  await at(files, base, PATH);
  await list(files).getByText('End of stream flushes held bytes').waitFor();

  // An older match linked from elsewhere is one exact receipt read, beside the file's first step.
  const older = await open(`${receipt50}?path=${q(PATH)}`);
  await older
    .getByRole('region', { name: 'Receipt' })
    .getByRole('heading', { name: 'Parser: first version' })
    .waitFor();
  assert.deepEqual(
    await older.evaluate(() =>
      window.calls
        .filter(([kind, name]) => kind === 'query' && name === 'projectCode:history')
        .map(([, , a]) => a.receiptId),
    ),
    ['00000050-0000-4000-8000-000000000000'],
  );

  // Every state at both widths and themes: axe-clean and no sideways scroll; a title wraps, never one cut line.
  const states = [
    ['ready', `${base}?path=${q(PATH)}`, {}],
    ['empty', `${base}?path=docs/never.md`, {}],
    ['loading', `${base}?path=src/slow.ts`, { ready: false }],
    ['failed', `${base}?path=src/fail.ts`, {}],
    ['worst', `${base}?path=${q(LONG)}`, {}],
  ];
  for (const [name, path, options] of states)
    for (const width of [1440, 390])
      for (const theme of ['dark', 'light']) {
        const view = await open(path, { width, theme, ...options });
        if (name === 'failed') await view.getByRole('alert').waitFor();
        if (name === 'loading') await list(view).locator('[aria-busy="true"]').waitFor();
        await settleBrowserPage(view);
        const where = `${name} ${width}/${theme}`;
        const scroll = await view.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(scroll <= 0, `${where}: no sideways scroll`);
        if (name === 'empty') {
          // More steps remain, so the sentence never says that no landing touched it.
          assert.match(
            await view.locator('.head .sit').textContent(),
            /No landing looked at so far touched never\.md\. 96 landings looked at\./,
          );
          await list(view).getByRole('link', { name: 'Clear the path' }).waitFor();
          await list(view).getByRole('button', { name: 'Look further back' }).waitFor();
        }
        if (name === 'worst') {
          // The Wrap Rule: against the one-letter title's single line, a long title wraps to two lines on a
          // phone and never more; it is never one line cut short.
          const heights = await list(view)
            .locator('a.hrow .ttl')
            .evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().height));
          const lines = Math.round(heights[3] / heights[2]);
          assert.ok(lines >= 1 && lines <= 2, `${where}: a long title takes at most two lines (${lines})`);
          if (width === 390) assert.equal(lines, 2, `${where}: the long title wraps`);
          assert.equal(await list(view).locator('a.hrow .ttl').nth(1).textContent(), 'Landing aaaaaaaa');
          // Who landed it is never dropped, at either width; a missing author says so.
          const who = list(view).locator('a.hrow > .who');
          assert.equal(await who.nth(1).textContent(), 'an agent');
          assert.equal(await who.nth(3).textContent(), 'not reported');
          for (const cell of await who.all()) assert.ok(await cell.isVisible(), `${where}: who is shown`);
          // An 83-character handle is cut at its end, the full handle in its label: in the list and the receipt.
          const full = 'bartholomew-fitzgerald-the-third/an-unreasonably-long-agent-handle-that-keeps-going';
          const cuts = [who.first().locator('.who.handle')];
          if (width === 1440)
            cuts.push(view.getByRole('region', { name: 'Receipt' }).locator('.kv .who.handle'));
          for (const handle of cuts) {
            assert.equal(await handle.getAttribute('title'), full);
            const name = handle.locator('.mono');
            assert.equal(await name.textContent(), full);
            assert.ok(
              await name.evaluate(cell => cell.scrollWidth > cell.clientWidth),
              `${where}: the handle is cut`,
            );
          }
          // A long path in the chip is cut at its start, so the file name stays in view.
          const chip = await list(view)
            .locator('.chip .path-cut')
            .evaluate(cell => {
              const box = cell.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(cell);
              const text = [...range.getClientRects()];
              return {
                cut: cell.scrollWidth > cell.clientWidth,
                end: Math.max(...text.map(r => r.right)) - box.right,
              };
            });
          assert.ok(chip.cut, `${where}: the long path is cut`);
          assert.ok(chip.end <= 1, `${where}: the path's end (the file name) is in view`);
          assert.match(await list(view).textContent(), /What 3 landings changed was not kept/);
        }
        await view.addScriptTag({ path: axe });
        const violations = await view.evaluate(async () =>
          (await axe.run(document, { rules: { 'color-contrast': { enabled: true } } })).violations.map(
            v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`,
          ),
        );
        assert.deepEqual(violations, [], `${where}: axe`);
        if (shots)
          await view.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`), fullPage: true });
      }
  // A receipt opened on a phone: a 400-character token in its message wraps inside the pane, never sideways.
  const phone = await open(`${base}/00000299-0000-4000-8000-000000000000?path=${q(LONG)}`, { width: 390 });
  const opened = phone.getByRole('region', { name: 'Receipt' });
  await opened.getByText(/Generated id: f+/).waitFor();
  assert.ok(
    (await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0,
    '390: an open receipt with a long token has no sideways scroll',
  );
  assert.deepEqual(errors, []);
});

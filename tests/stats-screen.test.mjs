// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Stats screen (Items 2cf30e0a, a61d3c91): the real StatsView in the project frame with synthetic closed days built by
// the real contract (src/stats-estimate.ts). Guards: the headline is against the merge queue building 5 at once, the
// baselines are named by mechanism with GitHub's setting names, discarded checks are split by cause, the replay states
// its assumptions behind "How this is worked out", runs without minutes are named, never zero, a window
// under the minimum shows only measured figures, every chart has its table and prints its values, the period picker
// re-aggregates the page (this month, last month, a custom range), per-day bars keep a fixed width from the left at 1,
// 2 and 31 days, the first day shows live landings, an empty month says so, agent setups and people form a table, and axe passes at 1440 and 390 in
// both themes with no horizontal page scroll.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_STATS_SHOTS;
const viewport = width => ({ width, height: width === 390 ? 844 : 1000 });

async function fixture(out) {
  const entry = 'virtual:stats-test';
  const source = `
    import {createElement as h} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ConvexProvider, ConvexReactClient} from 'convex/react';
    import {StatsView} from ${JSON.stringify(join(root, 'web/src/app/stats/Stats.tsx'))};
    import {ProjectFrame} from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
    import {statsCarry, statsDay, statsFailedDay} from ${JSON.stringify(join(root, 'src/stats-estimate.ts'))};
    import {classifyRuns} from ${JSON.stringify(join(root, 'src/stats-runs.ts'))};
    import {previousRange, statsRangeReply} from ${JSON.stringify(join(root, 'src/stats-period.ts'))};
    import {periodOf} from ${JSON.stringify(join(root, 'web/src/app/stats/model.ts'))};
    import {useState} from 'react';
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    const min = 60000, base = Date.UTC(2026, 10, 1), now = Date.UTC(2026, 10, 19, 12);
    const agents = ['agent:codex:gpt-6.2-sol', 'agent:claude-code:sonnet', 'agent:antigravity:', 'person:example', 'person:another'];
    function day(start, count) {
      return Array.from({length: count}, (_, i) => {
        const at = start + 8 * 3600000 + i * 4 * min;
        return {id: 'l' + start + '-' + i, attribution: sample === 'dominant' && i >= count - 2 ? 'agent:codex:rare' : agents[i % agents.length], submittedAt: at, landedAt: at + 6 * min + (i % 3) * min,
          checkStartedAt: at + 40000, checkEndedAt: at + 40000 + 302000, runnerSeconds: i % 17 === 0 ? null : 250,
          discardedRunnerSeconds: i % 17 === 0 ? null : (i % 11 === 0 ? 250 : 0), attempts: sample === 'notCounted' && agents[i % agents.length] === 'person:example' ? null : sample === 'dominant' ? (agents[i % agents.length] === 'person:example' ? 2 : 1) : i % 11 === 0 ? 2 : 1, ranInFull: i % 4 === 0,
          ...(sample === 'tokens' && i % 3 === 0 ? {tokens: 2000000 + i * 1000} : {})};
      });
    }
    // Samples, as [UTC start of day, landings]: November so far with one October day; two days; one day; a full
    // 31-day October; a few early landings; nothing closed at all (an empty month).
    const sample = new URLSearchParams(location.search).get('sample');
    const dayAt = (y, m, d) => Date.UTC(y, m, d);
    const nov = [22, 18, 14, 9, 21, 24, 19, 23, 20, 13, 11, 25, 27, 26, 14].map((n, i) => [base + i * 86400000, n]);
    const plan = {
      now: [[dayAt(2026, 9, 20), 30], ...nov],
      two: [[dayAt(2026, 10, 17), 31], [dayAt(2026, 10, 18), 128]],
      one: [[dayAt(2026, 10, 18), 7]],
      month31: Array.from({length: 31}, (_, i) => [dayAt(2026, 9, 1 + i), 5 + ((i * 37) % 120)]),
      early: [[base, 4], [base + 86400000, 5]],
      none: [],
      // 60 landings on days closed before every check run was recorded; the same with no solo full check; a day the
      // close read only in part.
      unrecorded: [[base, 30], [base + 86400000, 30]],
      nosolo: [[base, 30], [base + 86400000, 30]],
      partial: [[base, 30], [base + 86400000, 30]],
      // Under 50 landings, read in part; and two months, read in part (review b4dd69b4 finding 3).
      partialFew: [[base, 10]],
      partialMonths: [[dayAt(2026, 9, 31), 30], [base, 30]],
      // Landings read in part, every check run read (review d6b0f1aa finding 1); and a day whose close did not finish
      // between two closed days (finding 5).
      landingsCut: [[base, 30], [base + 86400000, 30]],
      // A third of the landings report their agent's tokens (Item a61d3c91).
      tokens: nov,
      // Today so far (Item 580b1a1a): the open day's provisional row, counted up to 10:00 UTC.
      today: [...nov, [dayAt(2026, 10, 19), 12]],
      firstSummary: [[dayAt(2026, 10, 19), 2]],
      // By agent: one person without recorded attempts, and a setup below the first-try baseline beside a rare setup.
      notCounted: [[base, 30]],
      dominant: [[base, 30]],
      notMeasured: [[dayAt(2026, 9, 31), 30], [base, 30], [base + 86400000, 30]],
    }[sample ?? 'now'];
    // Every check run of a day: each landing's own solo run, a recheck after main moved for every 11th, a failed earlier
    // submission for every 9th, one cancelled run without minutes and one run by hand that no landing names.
    function runsOf(landings) {
      if (sample === 'unrecorded') return null;
      const runs = [], attempts = [], landed = new Set();
      landings.forEach((l, i) => {
        runs.push({id: 'r' + l.id, at: l.checkStartedAt, endedAt: l.checkEndedAt, status: 'passed', runnerSeconds: 600, fullSuite: true, scopedRecheck: false, audit: false});
        attempts.push({id: 'a' + l.id, submissionId: 's' + l.id, parentAttemptId: null, runId: 'r' + l.id, member: false});
        landed.add('a' + l.id);
        if (i % 11 === 0) {
          runs.push({id: 'm' + l.id, at: l.submittedAt, endedAt: l.submittedAt + 302000, status: 'passed', runnerSeconds: 600, fullSuite: true, scopedRecheck: false, audit: false});
          attempts.push({id: 'ma' + l.id, submissionId: 's' + l.id, parentAttemptId: null, runId: 'm' + l.id, member: false});
          attempts.push({id: 'mc' + l.id, submissionId: 's' + l.id, parentAttemptId: 'ma' + l.id, runId: null, member: false});
        }
        if (i % 9 === 0) {
          runs.push({id: 'f' + l.id, at: l.submittedAt, endedAt: l.submittedAt + 200000, status: 'failed', runnerSeconds: 300, fullSuite: true, scopedRecheck: false, audit: false});
          attempts.push({id: 'fa' + l.id, submissionId: 'fs' + l.id, parentAttemptId: null, runId: 'f' + l.id, member: false});
        }
      });
      if (landings.length) {
        const first = landings[0];
        runs.push({id: 'c' + first.id, at: first.submittedAt, endedAt: null, status: 'cancelled', runnerSeconds: null, fullSuite: true, scopedRecheck: false, audit: false});
        attempts.push({id: 'ca' + first.id, submissionId: 'cs' + first.id, parentAttemptId: null, runId: 'c' + first.id, member: false});
        runs.push({id: 'h' + first.id, at: first.submittedAt, endedAt: first.submittedAt + 300000, status: 'passed', runnerSeconds: 600, fullSuite: true, scopedRecheck: false, audit: false});
      }
      // No solo sample: every run checked a scoped selection, so none prices a full GitHub run.
      if (sample === 'nosolo') for (const run of runs) run.fullSuite = false;
      return classifyRuns({runs, attempts, landedAttemptIds: landed, pendingSubmissionIds: new Set(), partial: (sample ?? '').startsWith('partial')});
    }
    let carry = statsCarry(null);
    const all = plan.map(([start, n], i) => {
      const name = new Date(start).toISOString().slice(0, 10);
      if (sample === 'notMeasured' && i === 1) return statsFailedDay(name, carry, 3);
      const landings = day(start, n);
      const d = statsDay(name, landings, runsOf(landings), carry, 6);
      carry = statsCarry(d);
      if ((sample === 'today' || sample === 'firstSummary') && i === plan.length - 1)
        return {...d, provisional: Date.UTC(2026, 10, 19, 10)};
      return sample === 'landingsCut' ? {...d, partial: true} : d;
    });
    const client = new ConvexReactClient('https://forge.test.convex.cloud');
    const route = {frame: 'project', handle: 'example', project: 'tidepool', place: 'stats', section: '', rest: ''};
    function Fixture() {
      // The real period model and the real read reply, over the sample's day rows.
      const [search, setSearch] = useState(location.search.slice(1).split('&').filter(p => !p.startsWith('sample=')).join('&'));
      const period = periodOf(new URLSearchParams(search), now);
      const days = all.filter(d => d.day >= period.from && d.day <= period.to);
      const data = statsRangeReply(days, period);
      // Each fold's part, recorded so the test can tell an unopened fold made no read.
      const usePart = part => {
        (window.foldReads ??= new Set()).add(part);
        const before = part === 'trend' ? previousRange(period) : null;
        const previous = before ? all.filter(d => d.day >= before.from && d.day <= before.to) : [];
        return statsRangeReply(days, period, part, previous);
      };
      const live = new URLSearchParams(location.search).get('live');
      return h(StatsView, {data, period, busy: new URLSearchParams(search).has('busy'), now, liveLanded: live === null ? null : Number(live), usePart, onPeriod: setSearch});
    }
    createRoot(document.getElementById('root')).render(h(ConvexProvider, {client},
      h(ProjectFrame, {route, name: 'tidepool', projects: [], controls: {onPalette(){}, onKeys(){}, onPicker(){}, viewerHandle: 'example'}},
        h(Fixture))));`;
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    plugins: [
      {
        name: 'stats-fixture',
        resolveId(id) {
          if (id === entry) return '\0stats-test.js';
        },
        load(id) {
          if (id === '\0stats-test.js') return source;
        },
      },
    ],
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: entry } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const script = output.find(
    item => item.type === 'chunk' && item.isEntry && item.facadeModuleId?.includes('stats-test'),
  ).fileName;
  const styles = output
    .filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map(item => `<link rel="stylesheet" href="/${item.fileName}">`)
    .join('');
  return `<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Stats · tidepool · Forge</title><style>body{margin:0}</style>${styles}</head><body><div id="root"></div><script type="module" src="/${script}"></script></body></html>`;
}

test('stats: short headline, one freshness line, today so far, comparison, tables and both themes', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-stats-screen-'));
  const html = await fixture(out);
  const browser = await chromium.launch(launchOptions);
  if (shots) mkdirSync(shots, { recursive: true });
  t.after(async () => {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  });
  const errors = [];
  const open = async (width = 1440, sample = 'now', theme = 'dark', query = '') => {
    const page = await browser.newPage({ viewport: viewport(width) });
    t.after(() => page.close());
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const file = join(out, url.pathname.slice(1));
      const asset = url.pathname.startsWith('/assets/') && existsSync(file);
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.woff2')
            ? 'font/woff2'
            : 'text/html';
      return route.fulfill({
        contentType: asset ? contentType : 'text/html',
        body: asset ? readFileSync(file) : html,
      });
    });
    await page.goto(`https://forge.test/example/tidepool/stats?sample=${sample}${query ? `&${query}` : ''}`);
    await page.locator('h1').waitFor();
    await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
    return page;
  };
  const page = await open();
  const sentence = await page.locator('.sit').textContent();
  // Item 3678767e: the value story. Dollars of CI at GitHub list price and hours of waiting to reach main, the merge
  // queue at the project's own width; the period it covers in the opening words.
  assert.match(
    sentence,
    /^Since 1 Nov, Forge saved about \$[\d,.]+ of CI and [\d,.]+ hours? of waiting to reach main\. Against your own history replayed through a merge queue at your width, [\d,]+ landings\.(Through|$)/,
    'the headline tells the value in dollars and hours',
  );
  assert.match(
    (await page.locator('.sit .stats-hint').first().getAttribute('title')) ?? '',
    /GitHub’s list price for a standard Linux 2-core runner, \$0\.006 a minute \(read from GitHub’s pricing page on 2026-11-23\).*public repositories too.*may mean your project pays less/,
    'the dollar figure says what it is priced at, and that a project may pay less',
  );
  assert.doesNotMatch(sentence, /one at a time/i, 'one at a time stays in the chart');
  assert.deepEqual(
    await page.locator('.stats-freshness').allTextContents(),
    ['Through Sun 15 Nov.'],
    'today in the period with no row for it yet: the newest day counted',
  );
  const today = await open(1440, 'today');
  assert.deepEqual(await today.locator('.stats-freshness').allTextContents(), [
    'Includes today up to 10:00 UTC.',
  ]);
  assert.match(
    await today.locator('.sit').textContent(),
    /Since 1 Nov, .* 298 landings\./,
    'today is in the totals',
  );
  // Item 6bd1cf57: today's landings are the live figure (20, the top bar's), not the close's 12 at 10:00 UTC; the
  // derived figures keep the close and say so beside them.
  const live = await open(1440, 'today', 'dark', 'live=20');
  assert.match(await live.locator('main').textContent(), /306 landings · plan usage in Billing/);
  assert.match(
    await live.locator('.sit').textContent(),
    /Since 1 Nov, .* merge queue at your width, 298 landings, as of 10:00 UTC\./,
  );
  assert.deepEqual(await live.locator('.stats-freshness').allTextContents(), [
    'Landings are live; the other figures count today up to 10:00 UTC.',
  ]);
  assert.match(await live.locator('main').textContent(), /Measured.*as of 10:00 UTC/);
  const pending = await open(1440, 'now', 'dark', 'busy');
  assert.equal(
    await pending.locator('.stats-freshness').count(),
    0,
    'no freshness for a retained busy reply',
  );
  const main = await page.locator('main').textContent();
  // Baselines are named by how they merge on one line, the merge queue at the project's own width, the exact setting
  // names on hover; each card leads with its percent.
  assert.match(main, /Forge.*Merge queue, 6 at a time \(your setting\).*One at a time/);
  assert.match(
    main,
    /\d+% fewer CI minutes.*than a merge queue at your width · \d+% fewer than one at a time, the worst case/,
  );
  assert.match(
    main,
    /\d+% sooner to main.*than a merge queue at your width · \d+% sooner than one at a time, the worst case.*of waiting saved.*\(median saving × landings\)/,
  );
  assert.match(
    (await page.locator('.hb .hlab[title]').last().getAttribute('title')) ?? '',
    /Require branches to be up to date before merging/,
  );
  assert.equal(
    await page
      .locator('.hb .hlab')
      .first()
      .evaluate(node => node.scrollWidth <= node.clientWidth),
    true,
    'a bar label sits on one line',
  );
  // Discarded checks, every run, by cause; runs without minutes are named, never zero.
  assert.match(main, /Discarded checks[\d,.]+ min [\d,]+ runs that did not land/);
  assert.match(main, /main moved [\d,.]+ min [\d,]+ runs/);
  assert.match(main, /failed [\d,.]+ min [\d,]+ runs/);
  assert.match(
    main,
    /every check run, [\d,]+ runs, [\d,]+ without minutes, [\d,]+ not tied to a landing; [\d,.]+ min on the landed path alone/,
  );
  // Every cause names its runs; the cancelled run without minutes is named under its cause, never zero.
  assert.match(main, /failed [1-9][\d,.]* min [1-9][\d,]* runs/);
  assert.match(main, /cancelled 0 min [1-9][\d,]* runs?, [1-9][\d,]* without minutes/);
  assert.doesNotMatch(
    main,
    /lower bound|upper bound|read in part/,
    'a day read in full is not marked partial',
  );
  assert.doesNotMatch(main, /Wasted/, '"Wasted CI minutes" is now "Discarded checks"');
  assert.doesNotMatch(main, /Agent tokens/, 'no token tile until there is measured data');
  // Once agents report tokens at landing, the measured figure shows from N of M landings, with the benchmark for the
  // GitHub comparison (never a per-project estimate).
  const reported = await open(1440, 'tokens');
  assert.match(
    await reported.locator('main').textContent(),
    /Agent tokens[\d,]+ per landing reported by agents, measured from [1-9][\d,]* of [\d,]+ landings\. The benchmark compares tokens with a GitHub flow\./,
  );
  assert.equal(
    await reported.getByRole('link', { name: 'The benchmark' }).getAttribute('href'),
    '/docs/research/p6-exit-bench-results/',
  );
  // A link inside a sentence is underlined, not muted text like its sentence (review 23927f12 finding 1).
  assert.equal(
    await reported
      .getByRole('link', { name: 'The benchmark' })
      .evaluate(a => getComputedStyle(a).textDecorationLine),
    'underline',
  );
  const method = page.locator('#stats-how');
  const methodButton = page.getByRole('button', { name: 'How this is worked out' });
  assert.equal(await method.count(), 0);
  await methodButton.click();
  assert.equal(await methodButton.getAttribute('aria-expanded'), 'true');
  const how = await method.textContent();
  assert.match(how, /^We compare Forge’s recorded results with two GitHub replays of the same 15 days/);
  assert.match(
    how,
    /price a replayed full run at 10 runner minutes\. That is the median of 319 solo full checks/,
  );
  const settings = await page.locator('.hb .hlab[title]').evaluateAll(nodes => nodes.map(node => node.title));
  // GitHub's exact names stay available on the chart. The fold describes the behavior.
  assert.match(
    settings[0],
    /“Build concurrency” \(maximum pull requests to build\) 6 and “Maximum pull requests to merge” 1/,
  );
  assert.match(settings[1], /“Require branches to be up to date before merging”/);
  assert.match(how, /add up the recorded minutes for checks that started on these days/);
  assert.match(how, /one check per change and a rerun each time another change reached main while it waited/);
  assert.match(how, /a pull-request check and a queue build for each change that lands/);
  assert.match(how, /failed pull-request check \([\d,]+ runs?\) keeps its change out of the queue/);
  assert.match(how, /removes the change from the queue \([\d,]+ checks?\) and restarts the builds/);
  assert.match(how, /A cut-short build counts for the share it ran/);
  assert.match(how, /Waiting changes carry into the next day/);
  assert.match(how, /median time from “land” to main for changes that landed on those days/);
  assert.match(how, /Forge uses recorded times\. The GitHub setups replay the wait and checks/);
  assert.match(how, /15 checks that Stats couldn’t match to a landing count only here \(150 min\)/);
  // All changes on the recheck must have passed earlier that day. Flakes follow the same rule.
  assert.match(how, /counts as a queue failure only if every change in it had passed that day/);
  assert.doesNotMatch(how, /never as queue ejections/);
  assert.match(how, /10% faster or slower, the median time to main is 9 min 4 s to 11 min 4 s/);
  assert.match(how, /15 runs reported no minutes/);
  assert.match(how, /Only signed-in project members with write access can see them/);
  // The page opens with the headline and landings per day; every other chart is a fold that reads only once opened.
  const foldReads = () => page.evaluate(() => [...(window.foldReads ?? [])].sort());
  assert.deepEqual(await foldReads(), [], 'an unopened fold reads nothing');
  await page.getByRole('button', { name: 'Where work waited' }).click();
  assert.deepEqual(await foldReads(), ['waited']);
  await page.getByRole('button', { name: 'By agent' }).click();
  assert.deepEqual(await foldReads(), ['agents', 'waited']);
  // Every chart prints its values: each day's count on its bar, each stop's name and value, each bucket's count.
  const values = await page.locator('.stats-days .v').allTextContents();
  assert.deepEqual(values, [
    '22',
    '18',
    '14',
    '9',
    '21',
    '24',
    '19',
    '23',
    '20',
    '13',
    '11',
    '25',
    '27',
    '26',
    '14',
  ]);
  const waited = await page.getByRole('region', { name: 'Where work waited' }).textContent();
  assert.match(waited, /median of each stop, in minutes:seconds/, 'the unit is stated');
  for (const name of [
    'In queue \\d+:\\d\\d',
    'Checking, on your CI \\d+:\\d\\d',
    'Landing \\d+:\\d\\d',
    'Total \\d+:\\d\\d',
  ])
    assert.match(waited, new RegExp(name), `${name} is labelled on the chart`);
  const tableName = 'Landings by agent setup and person';
  const byAgent = page.getByRole('table', { name: tableName });
  assert.deepEqual(await byAgent.getByRole('columnheader').allTextContents(), [
    'Agent setup or person',
    'Landings',
    'First try',
    'Median time to main',
    'CI minutes per landing',
  ]);
  const named = byAgent.locator('tbody tr');
  assert.equal(await named.count(), 5);
  assert.match(await named.allTextContents().then(rows => rows.join(' ')), /Codex · gpt-6.2-sol/);
  assert.match(await byAgent.textContent(), /Antigravity · model not recorded/);
  assert.doesNotMatch(await byAgent.textContent(), /\d+ of \d+ recorded/);
  const ciValues = await named.locator('td:last-child').allTextContents();
  assert.ok(
    ciValues.every(value => /^\d+(?:\.\d+)?$/.test(value)),
    'partially recorded CI shows a value',
  );
  for (const width of [1440, 390]) {
    const counted = await open(width, 'notCounted');
    await counted.getByRole('button', { name: 'By agent' }).click();
    const person = counted
      .getByRole('table', { name: tableName })
      .getByRole('row')
      .filter({ hasText: '@example' });
    assert.equal(await person.getByRole('cell').nth(2).textContent(), 'Not recorded');
    const dominant = await open(width, 'dominant');
    await dominant.getByRole('button', { name: 'By agent' }).click();
    const rows = dominant.getByRole('table', { name: tableName }).locator('tbody tr');
    const counts = await rows
      .locator('td:nth-child(2)')
      .allTextContents()
      .then(cells => cells.map(Number));
    assert.deepEqual(
      counts,
      [...counts].sort((a, b) => b - a),
    );
    assert.match(
      await rows.last().textContent(),
      /Other.*2 landings from setups or people with fewer than 5 each/,
    );
    assert.match(
      await rows.filter({ hasText: '@example' }).textContent(),
      /First try \d+ percentage points below the project/,
    );
    assert.equal(await dominant.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  for (const caption of ['Landings per day']) {
    await page.getByRole('button', { name: `Table: ${caption}` }).click();
    assert.equal(await page.getByRole('table', { name: caption }).count(), 1, `${caption} has its table`);
    await page.getByRole('button', { name: `Chart: ${caption}` }).click();
  }
  // The period picker re-aggregates every figure from the chosen days.
  await page.getByLabel('Period').selectOption('last');
  assert.match(
    await page.locator('.sit').textContent(),
    /^30 landings on 20 Oct 2026 \(1 closed day\)\./,
    'under 50: measured only',
  );
  assert.match(await page.locator('main').textContent(), /20 landings to go/);
  assert.equal(await page.locator('.stats-days button').count(), 1);
  await page.getByLabel('Period').selectOption('custom');
  await page.getByLabel('From', { exact: true }).fill('2026-10-01');
  await page.getByLabel('To', { exact: true }).fill('2026-11-19');
  await page.getByRole('button', { name: 'Show' }).click();
  assert.match(await page.locator('.sit').textContent(), /^From 20 Oct to 15 Nov, Forge saved about/);
  await page.getByRole('button', { name: 'By month' }).click();
  assert.equal(await page.getByRole('table', { name: 'Stats by month' }).locator('tbody tr').count(), 2);
  // October 20 to November 1 had no closed day: the gap draws as zero-landing days, not as nothing.
  assert.equal(await page.locator('.stats-days button').count(), 27);
  await page.getByLabel('Period').selectOption('this');
  assert.match(await page.locator('.sit').textContent(), /^Since 1 Nov, Forge saved about/);
  // Last 7 days ends today (19 Nov): its label names only the closed days in it.
  await page.getByLabel('Period').selectOption('7');
  assert.match(await page.locator('.sit').textContent(), /^Since 13 Nov, Forge saved about/);
  await page.getByLabel('Period').selectOption('30');
  assert.match(
    await page.locator('.sit').textContent(),
    /^Since 1 Nov, Forge saved about/,
    '21 Oct to 19 Nov',
  );

  // Fixed-width bars fill from the left: two days stay two narrow bars, 31 days fit a phone.
  const bars = async p =>
    p
      .locator('.stats-days button')
      .evaluateAll(list =>
        list.map(b => b.getBoundingClientRect()).map(r => ({ left: r.left, width: r.width })),
      );
  for (const width of [1440, 390]) {
    const two = await open(width, 'two');
    const [first, second] = await bars(two);
    const plot = await two.locator('.stats-plot').evaluate(el => el.getBoundingClientRect().left);
    assert(first.width <= 26 && second.width <= 26, `${width}: bars keep their width`);
    assert(second.left + second.width - plot < 60, `${width}: two days sit at the left, not across the page`);
    assert.deepEqual(await two.locator('.stats-days .v').allTextContents(), ['31', '128']);
    assert.deepEqual(await two.locator('.stats-freshness').allTextContents(), ['Through Wed 18 Nov.']);
    const one = await open(width, 'one');
    assert.equal((await bars(one)).length, 1);
    assert.match(await one.locator('.sit').textContent(), /^7 landings on 18 Nov 2026 \(1 closed day\)\./);
    const month = await open(width, 'month31', 'dark', 'period=last');
    const list = await bars(month);
    assert.equal(list.length, 31);
    assert.match(
      await month.locator('.sit').textContent(),
      /^In October 2026, Forge saved about/,
      'a fully closed month is named',
    );
    assert(list.at(-1).left + list.at(-1).width <= width, `${width}: 31 days fit`);
    const shown = await month
      .locator('.stats-days .v')
      .evaluateAll(list => list.filter(v => getComputedStyle(v).visibility !== 'hidden').length);
    assert(
      width === 1440 ? shown === 31 : shown >= 3 && shown < 31,
      `${width}: ${shown} values shown on 31 bars`,
    );
  }
  const firstDay = await open(390, 'none', 'dark', 'live=2');
  assert.equal(await firstDay.locator('.sit b').textContent(), '2 landings today.');
  assert.match(await firstDay.locator('main').textContent(), /first hourly summary.*midnight UTC/);
  assert.equal(await firstDay.getByRole('button', { name: 'Against the days before' }).count(), 0);
  assert.equal(await firstDay.evaluate(() => window.foldReads?.size ?? 0), 0);
  await firstDay.getByLabel('Period').selectOption('last');
  assert.equal(await firstDay.locator('.sit').textContent(), 'No landing figures in October 2026.');
  assert.match(await firstDay.locator('main').textContent(), /Try a longer period\./);
  const firstSummary = await open(390, 'firstSummary', 'dark', 'live=3');
  assert.equal(await firstSummary.locator('.sit b').textContent(), '3 landings today.');
  assert.deepEqual(await firstSummary.locator('.stats-freshness').allTextContents(), [
    'Live count since 00:00 UTC. Other figures are provisional through 10:00 UTC. The reporting day ends at midnight UTC.',
    'Trends appear once this period and the same number of days before it both have summaries.',
  ]);
  assert.equal(await firstSummary.getByRole('group', { name: 'Landings per day' }).count(), 1);
  assert.doesNotMatch(await firstSummary.locator('.sit').textContent(), /closed day|starts at 50 landings/);
  const recent = await open(390, 'today', 'dark', 'from=2026-11-17&to=2026-11-19');
  await recent.getByRole('button', { name: 'Against the days before' }).click();
  assert.match(
    await recent.getByRole('table', { name: 'This period beside the one before' }).textContent(),
    /Landings per day with figures/,
  );
  assert.match(await recent.locator('.stats-readout[title]').textContent(), /1 partial day/);
  const empty = await open(390, 'none', 'dark', 'live=0&from=2026-11-19&to=2026-11-19');
  assert.equal(await empty.locator('.sit').textContent(), 'No landings reported today.');
  const early = await open(390, 'early');
  assert.match(
    await early.locator('.sit').textContent(),
    /^9 landings over 1–2 Nov 2026 \(2 closed days\)\. The comparison/,
  );
  // 60 landings on days closed before every check run was recorded: "not recorded" and why, never "0 landings to go".
  const unrecorded = await open(390, 'unrecorded');
  const unrecordedMain = await unrecorded.locator('main').textContent();
  assert.match(unrecordedMain, /2 days here closed before Stats recorded every check run/);
  assert.match(unrecordedMain, /CI minutes per landingNot recorded/);
  assert.match(unrecordedMain, /Discarded checksNot recorded/);
  assert.doesNotMatch(unrecordedMain, /landings? to go/);
  // Every run recorded, none of them a solo full check: no price for a GitHub run, said so.
  const nosolo = await open(390, 'nosolo');
  const nosoloMain = await nosolo.locator('main').textContent();
  assert.match(nosoloMain, /No change here has run the whole check on its own yet/);
  assert.doesNotMatch(nosoloMain, /landings? to go|Not recorded/);
  // A day the close read only in part says so once, on hover over the headline's marker (Item 3678767e, review b4dd69b4
  // finding 3): its check runs read in part, runs and CI minutes are at least what is shown and the minutes saved at
  // most. No caveat sentence repeats down the page.
  const partial = await open(390, 'partial');
  const partialMain = await partial.locator('main').textContent();
  assert.equal(await partial.locator('.stats-hint[title*="read in part"]').count(), 1, 'said once');
  const partialHover =
    (await partial.locator('.stats-hint[title*="read in part"]').getAttribute('title')) ?? '';
  assert.match(
    partialHover,
    /runs and CI minutes are at least what is shown, so the minutes saved are at most these/,
  );
  assert.doesNotMatch(partialHover, /CI minutes per landing are at most/, 'every landing was read');
  assert.doesNotMatch(partialMain, /lower bound|upper bound/, 'no caveat sentence on the page itself');
  // Under 50 landings, read in part: never "exact from the first".
  const partialFew = await open(390, 'partialFew');
  const fewSentence = await partialFew.locator('.sit').textContent();
  assert.match(fewSentence, /what Forge measured is shown as far as it was read/);
  assert.doesNotMatch(fewSentence, /exact from the first/);
  // A month with a day read in part is marked in the month table.
  const partialMonths = await open(1440, 'partialMonths', 'dark', 'from=2026-10-31&to=2026-11-02');
  await partialMonths.getByRole('button', { name: 'By month' }).click();
  const monthRows = partialMonths.getByRole('table', { name: 'Stats by month' }).locator('tbody tr');
  assert.match(await monthRows.first().textContent(), /October 2026 · read in part: saving is at most this/);
  assert.match(
    await partialMonths.getByRole('table', { name: 'Stats by month' }).textContent(),
    /Fewer than a merge queue \(estimate\)/,
  );
  // Landings read in part, every run read: every run's minutes over fewer landings, so minutes per landing are an upper
  // bound, never a lower one; rates and times cover the landings read; saved minutes a lower bound (review d6b0f1aa
  // finding 1).
  const landingsCut = await open(390, 'landingsCut');
  const cutHover =
    (await landingsCut.locator('.stats-hint[title*="read in part"]').getAttribute('title')) ?? '';
  assert.match(
    cutHover,
    /landings are at least what is shown, CI minutes per landing are at most what is shown/,
  );
  assert.match(
    cutHover,
    /rates and times cover only the landings read, and the minutes saved are at least these/,
  );
  assert.doesNotMatch(cutHover, /runs and CI minutes are at least/);
  // A day whose close did not finish is missing, never zero: its bar says so, its table row says so, and it is in no
  // figure (review d6b0f1aa finding 5).
  const notMeasured = await open(1440, 'notMeasured', 'dark', 'from=2026-10-31&to=2026-11-02');
  const missing = notMeasured.locator('.stats-days button[data-missing]');
  assert.equal(await missing.count(), 1, 'one day drawn as missing');
  assert.match(
    (await missing.getAttribute('aria-label')) ?? '',
    /Nov 1: not measured: its close did not finish/,
  );
  assert.equal(await notMeasured.locator('.stats-days button:not([data-missing])').count(), 2);
  assert.match(await notMeasured.locator('.sit').textContent(), /60 landings/, 'the missing day adds none');
  const newestFailed = await open(1440, 'notMeasured', 'dark', 'from=2026-10-31&to=2026-11-01');
  assert.deepEqual(await newestFailed.locator('.stats-freshness').allTextContents(), ['Through Sat 31 Oct.']);
  await notMeasured.getByRole('button', { name: 'By month' }).click();
  assert.match(
    await notMeasured.getByRole('table', { name: 'Stats by month' }).locator('tbody tr').nth(1).textContent(),
    /November 2026 · 1 day not measured30/,
  );

  for (const [sample, query] of [
    ['now', ''],
    ['today', ''],
    ['month31', 'period=last'],
    ['two', ''],
    ['none', ''],
    ['unrecorded', ''],
    ['tokens', ''],
    ['notCounted', ''],
    ['dominant', ''],
  ])
    for (const width of [1440, 390])
      for (const theme of ['dark', 'light']) {
        const draw = await open(width, sample, theme, query);
        await draw.evaluate(() => document.fonts.ready);
        if (sample === 'now')
          for (const name of ['How this is worked out', 'Where work waited', 'By agent'])
            await draw.getByRole('button', { name }).click();
        if (sample === 'notCounted' || sample === 'dominant')
          await draw.getByRole('button', { name: 'By agent' }).click();
        await draw.addScriptTag({ path: axe });
        const violations = await draw.evaluate(async () =>
          (await axe.run(document, { rules: { 'color-contrast': { enabled: true } } })).violations
            // The shared top-bar line's known finding; the shell Lane fixes it.
            .filter(v => v.id !== 'label-content-name-mismatch')
            .map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, why: n.failureSummary })) })),
        );
        assert.deepEqual(violations, [], `${sample} ${width}/${theme}: axe`);
        assert(
          await draw.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${sample} ${width}/${theme}: no horizontal page scroll`,
        );
        if (shots)
          await draw.screenshot({
            path: join(shots, `stats-${sample}-${width}-${theme}.png`),
            fullPage: true,
          });
      }
  assert.deepEqual(errors, []);
});

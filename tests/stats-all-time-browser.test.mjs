// SPDX-License-Identifier: Apache-2.0
// Stats All time and the self-trend in the browser (Item a61d3c91, Done-when 22:05Z): the real StatsView in the project
// frame over the real replies (src/stats-period.ts). All time names the closed days it covers and draws one bar a month
// from the month rollups; a range has "Against the days before", a fold that reads nothing until opened, with its
// method on hover only; axe passes at 1440 and 390 in both themes with no horizontal page scroll.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

async function fixture(out) {
  const entry = 'virtual:stats-all-test';
  const source = `
    import {createElement as h, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ConvexProvider, ConvexReactClient} from 'convex/react';
    import {StatsView} from ${JSON.stringify(join(root, 'web/src/app/stats/Stats.tsx'))};
    import {ProjectFrame} from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
    import {statsCarry, statsDay, statsFailedDay} from ${JSON.stringify(join(root, 'src/stats-estimate.ts'))};
    import {previousRange, statsAllReply, statsMonth, statsRangeReply} from ${JSON.stringify(join(root, 'src/stats-period.ts'))};
    import {periodOf} from ${JSON.stringify(join(root, 'web/src/app/stats/model.ts'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    const min = 60000, now = Date.UTC(2026, 10, 19, 12);
    function landings(name, n) {
      const start = Date.parse(name + 'T08:00:00Z');
      return Array.from({length: n}, (_, i) => ({id: name + i, who: ['amber-fox', 'still-heron'][i % 2], submittedAt: start + i * 4 * min,
        landedAt: start + i * 4 * min + (6 + i % 3) * min, checkStartedAt: start + i * 4 * min + 40000, checkEndedAt: start + i * 4 * min + 340000,
        runnerSeconds: 250, discardedRunnerSeconds: 0, attempts: i % 5 === 0 ? 2 : 1, ranInFull: true}));
    }
    // September and October closed (rolled up), November open; 3 Nov left not measured.
    let carry = statsCarry(null);
    const days = [];
    for (let t = Date.UTC(2026, 8, 1); t <= Date.UTC(2026, 10, 18); t += 86400000) {
      const name = new Date(t).toISOString().slice(0, 10);
      if (new Date(t).getUTCDay() === 0) continue;
      const d = name === '2026-11-03' ? statsFailedDay(name, carry, 3) : statsDay(name, landings(name, 3 + (t / 86400000) % 7), null, carry);
      carry = statsCarry(d);
      days.push(d);
    }
    const months = ['2026-09', '2026-10'].map(m => statsMonth(m, days.filter(d => d.day.startsWith(m))));
    const tail = days.filter(d => d.day >= '2026-11');
    const client = new ConvexReactClient('https://forge.test.convex.cloud');
    const route = {frame: 'project', handle: 'example', project: 'tidepool', place: 'stats', section: '', rest: ''};
    function Fixture() {
      const [search, setSearch] = useState(location.search.slice(1));
      const period = periodOf(new URLSearchParams(search), now);
      const all = period.kind === 'all';
      const inRange = (list, r) => list.filter(d => d.day >= r.from && d.day <= r.to);
      const reply = part => all ? statsAllReply(months, tail, part)
        : statsRangeReply(inRange(days, period), period, part, part === 'trend' ? inRange(days, previousRange(period)) : []);
      const usePart = part => ((window.foldReads ??= new Set()).add(part), reply(part));
      return h(StatsView, {projectName: 'tidepool', data: reply('head'), period, usePart, historyHref: '/-/example/tidepool/lanes/history', onPeriod: setSearch});
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
        name: 'stats-all-fixture',
        resolveId(id) {
          if (id === entry) return '\0stats-all-test.js';
        },
        load(id) {
          if (id === '\0stats-all-test.js') return source;
        },
      },
    ],
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: entry } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const script = output.find(
    item => item.type === 'chunk' && item.isEntry && item.facadeModuleId?.includes('stats-all-test'),
  ).fileName;
  const styles = output
    .filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map(item => `<link rel="stylesheet" href="/${item.fileName}">`)
    .join('');
  return `<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Stats · tidepool · Forge</title><style>body{margin:0}</style>${styles}</head><body><div id="root"></div><script type="module" src="/${script}"></script></body></html>`;
}

test('stats: All time from month rollups, and the previous period as a fold read only when opened', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-stats-all-'));
  const html = await fixture(out);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  });
  const errors = [];
  const open = async (query, width = 1440, theme = 'dark') => {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
    t.after(() => page.close());
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const file = join(out, url.pathname.slice(1));
      const asset = url.pathname.startsWith('/assets/') && existsSync(file);
      const type = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'font/woff2';
      return route.fulfill({
        contentType: asset ? type : 'text/html',
        body: asset ? readFileSync(file) : html,
      });
    });
    await page.goto(`https://forge.test/-/example/tidepool/stats?${query}`);
    await page.locator('h1').waitFor();
    await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
    return page;
  };
  const foldReads = page => page.evaluate(() => [...(window.foldReads ?? [])].sort());

  // All time: picked in the one picker, the covered days named (3 Nov not measured is not a closed day), one bar a month.
  const all = await open('period=all');
  assert.equal(await all.locator('.stats-period select').inputValue(), 'all');
  assert.match(await all.locator('.sit').textContent(), /over 1 Sept? – 18 Nov 2026 \([\d,]+ closed days\)/);
  assert.equal(await all.getByRole('heading', { name: 'Landings per month' }).count(), 1);
  const bars = await all
    .locator('.stats-days button')
    .evaluateAll(list => list.map(b => b.getAttribute('aria-label')));
  assert.equal(bars.length, 3);
  assert.match(bars[0], /^September 2026: [\d,]+ landings$/);
  assert.match(bars[2], /^November 2026: [\d,]+ landings$/);
  assert.equal(
    await all.getByRole('button', { name: 'Against the days before' }).count(),
    0,
    'no previous period',
  );
  await all.getByRole('button', { name: 'By month' }).click();
  assert.equal(await all.getByRole('table', { name: 'Stats by month' }).locator('tbody tr').count(), 3);
  assert.match(
    await all.getByRole('table', { name: 'Stats by month' }).locator('tbody tr').nth(2).textContent(),
    /November 2026 · 1 day not measured/,
  );

  // A range: the previous period is a fold, unread until opened; its method on hover, not on the page.
  const week = await open('period=7');
  assert.deepEqual(await foldReads(week), [], 'an unopened fold reads nothing');
  await week.getByRole('button', { name: 'Against the days before' }).click();
  assert.deepEqual(await foldReads(week), ['trend']);
  const table = week.getByRole('table', { name: 'This period beside the one before' });
  assert.equal(await table.locator('tbody tr').count(), 4);
  assert.match(
    await table.locator('tbody tr').first().textContent(),
    /^Landings per closed day[\d.]+[\d.]+([+−][\d.]+|the same)$/,
  );
  const readout = week.locator('.stats-readout[title]');
  assert.match((await readout.getAttribute('title')) ?? '', /however many of their days closed/);
  assert.doesNotMatch(
    await week.locator('main').textContent(),
    /however many of their days closed/,
    'hover only',
  );

  for (const query of ['period=all', 'period=7'])
    for (const width of [1440, 390])
      for (const theme of ['dark', 'light']) {
        const draw = await open(query, width, theme);
        await draw.evaluate(() => document.fonts.ready);
        for (const name of query === 'period=all' ? ['By month'] : ['Against the days before'])
          await draw.getByRole('button', { name }).click();
        await draw.addScriptTag({ path: axe });
        const violations = await draw.evaluate(async () =>
          (await axe.run(document, { rules: { 'color-contrast': { enabled: true } } })).violations
            // The shared top-bar line's known finding; the shell Lane fixes it.
            .filter(v => v.id !== 'label-content-name-mismatch')
            .map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, why: n.failureSummary })) })),
        );
        assert.deepEqual(violations, [], `${query} ${width}/${theme}: axe`);
        assert(
          await draw.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${query} ${width}/${theme}: no horizontal page scroll`,
        );
      }
  assert.deepEqual(errors, []);
});

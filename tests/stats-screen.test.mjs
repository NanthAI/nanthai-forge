// SPDX-License-Identifier: Apache-2.0
// Stats screen (Items 2cf30e0a, a61d3c91): the real StatsView in the project frame with synthetic closed days built by
// the real contract (src/stats-estimate.ts). Guards: the headline is the lower bound ("at least"), the replay states
// its assumptions behind "How this is worked out", landings without runner minutes are named as left out, a window
// under the minimum shows only measured figures, every chart has its table, and axe passes at 1440 and 390 in both
// themes with no horizontal page scroll.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { chromium } from 'playwright';
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
    import {statsDay, statsWindow} from ${JSON.stringify(join(root, 'src/stats-estimate.ts'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    const min = 60000, base = Date.UTC(2026, 10, 1);
    const agents = ['amber-fox', 'still-heron', 'copper-moth', 'quiet-otter', 'by hand'];
    function day(index, count) {
      const start = base + index * 86400000 + 8 * 3600000;
      return Array.from({length: count}, (_, i) => {
        const at = start + i * 4 * min;
        return {id: 'l' + index + '-' + i, who: agents[i % agents.length], submittedAt: at, landedAt: at + 6 * min + (i % 3) * min,
          checkStartedAt: at + 40000, checkEndedAt: at + 40000 + 302000, runnerSeconds: i % 17 === 0 ? null : 250,
          discardedRunnerSeconds: i % 17 === 0 ? null : (i % 11 === 0 ? 250 : 0), attempts: i % 11 === 0 ? 2 : 1, ranInFull: i % 4 === 0};
      });
    }
    const counts = new URLSearchParams(location.search).get('sample') === 'early' ? [4, 5] : [22, 18, 14, 9, 21, 24, 19, 23, 20, 13, 11, 25, 27, 26, 14];
    let freeAt = 0;
    const days = counts.map((n, i) => { const d = statsDay(new Date(base + i * 86400000).toISOString().slice(0, 10), day(i, n), freeAt); freeAt = d.replay.freeAt; return d; });
    const october = new URLSearchParams(location.search).get('sample') === 'early' ? [] : [statsDay('2026-10-20', day(-12, 30), 0)];
    const all = [...october, ...days];
    const months = [...new Set(all.map(d => d.day.slice(0, 7)))].reverse().map(month => ({month, ...statsWindow(all.filter(d => d.day.startsWith(month)))}));
    const data = {schema: 1, compareFrom: 50, through: all.at(-1).day, perDay: all.map(d => [d.day, d.landings]), months, all: {from: all[0].day, ...statsWindow(all)}};
    const client = new ConvexReactClient('https://forge.test.convex.cloud');
    const route = {frame: 'project', handle: 'example', project: 'tidepool', place: 'stats', section: '', rest: ''};
    createRoot(document.getElementById('root')).render(h(ConvexProvider, {client},
      h(ProjectFrame, {route, name: 'tidepool', projects: [], controls: {onPalette(){}, onKeys(){}, onPicker(){}, viewerHandle: 'example'}},
        h(StatsView, {projectName: 'tidepool', data: new URLSearchParams(location.search).get('sample') === 'none' ? {...data, through: null, perDay: [], months: [], all: {...data.all, days: 0}} : data}))));`;
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

test('stats: own-history comparison headline, stated assumptions, left-out landings, tables and both themes', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-stats-screen-'));
  const html = await fixture(out);
  const browser = await chromium.launch();
  if (shots) mkdirSync(shots, { recursive: true });
  t.after(async () => {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  });
  const errors = [];
  const open = async (width = 1440, sample = 'now', theme = 'dark') => {
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
    await page.goto(`https://forge.test/-/example/tidepool/stats?sample=${sample}`);
    await page.locator('h1').waitFor();
    await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
    return page;
  };
  const page = await open();
  const sentence = await page.locator('.sit').textContent();
  assert.match(sentence, /^At least [\d,.]+ CI minutes fewer in November 2026\./, 'the lower bound leads');
  assert.match(sentence, /sooner than the same arrivals through a one-at-a-time merge queue/);
  const main = await page.locator('main').textContent();
  assert.match(main, /up to [\d,.]+ fewer/, 'the upper bound follows the lower bound');
  assert.match(main, /without runner minutes left out/, 'unknown runner minutes are named, not zero');
  assert.match(main, /Not reported/, 'no token saving is claimed');
  await page.getByRole('button', { name: 'How this is worked out' }).click();
  const how = await page.locator('#stats-how').textContent();
  assert.match(how, /Nothing here comes from a benchmark/);
  assert.match(how, /once as a pull request and once in a merge queue/);
  assert.match(how, /landings without runner minutes are left out of both CI figures/);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  assert.equal(await page.getByRole('table', { name: 'Landings per day' }).count(), 1);
  await page.getByRole('button', { name: 'Chart', exact: true }).click();
  await page.getByLabel('Period').selectOption('2026-10');
  assert.match(
    await page.locator('.sit').textContent(),
    /^30 landings in October 2026\./,
    'under 50: measured only',
  );
  assert.match(await page.locator('main').textContent(), /20 landings to go/);

  const early = await open(390, 'early');
  assert.match(await early.locator('.sit').textContent(), /^9 landings in November 2026\. The comparison/);
  const none = await open(390, 'none');
  assert.match(await none.locator('.sit').textContent(), /No closed days yet/);

  for (const width of [1440, 390])
    for (const theme of ['dark', 'light']) {
      const draw = await open(width, 'now', theme);
      await draw.evaluate(() => document.fonts.ready);
      await draw.getByRole('button', { name: 'How this is worked out' }).click();
      await draw.addScriptTag({ path: axe });
      const violations = await draw.evaluate(async () =>
        (await axe.run(document, { rules: { 'color-contrast': { enabled: true } } })).violations
          // The shared top-bar line's known finding; the shell Lane fixes it.
          .filter(v => v.id !== 'label-content-name-mismatch')
          .map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, why: n.failureSummary })) })),
      );
      assert.deepEqual(violations, [], `${width}/${theme}: axe`);
      assert(
        await draw.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${width}/${theme}: no horizontal page scroll`,
      );
      if (shots) await draw.screenshot({ path: join(shots, `stats-${width}-${theme}.png`), fullPage: true });
    }
  assert.deepEqual(errors, []);
});

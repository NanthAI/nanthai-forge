// SPDX-License-Identifier: Apache-2.0
// The yard's running checks in a real browser (Item ecd6e610), on synthetic data through its real model and row
// (tests/browser/lanes-progress.tsx; usual check 10 min, usual slowest 18 min): the row says how long the check has run
// against the usual time and turns overdue in the warning tone past the slowest; the mark sits along the Checking stop
// by elapsed / usual at two elapsed times, and the browser's own animation moves it with no script; reduced motion
// shows the same place with nothing moving; and the glide costs no layout, style or paint per frame. Passed and failed
// rows keep their stop words. Set FORGE_LANE_SHOTS to a folder to save screenshots at desk and phone width, both themes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.FORGE_LANE_SHOTS || null;
const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const FIXTURE = 'tests/browser/lanes-progress.tsx';
// The Checking stop runs 3 to 4 on a track of 0 to 4 (the line's stops: Editing, Saved, In queue, Checking); a running
// check goes from 3.1 to 3.7 (model.ts CHECK_FROM/TO) and a passed one rests at 3.85 (Item 85f456c1).
const placeAt = minutes => 3.1 + 0.6 * Math.min(1, minutes / 10);

async function buildFixture(out) {
  const { build } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: { fixture: join(root, FIXTURE) } } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const entry = output.find(item => item.isEntry && item.facadeModuleId?.endsWith(FIXTURE));
  const chunks = new Map(output.map(item => [item.fileName, item]));
  const css = new Set();
  const seen = new Set();
  const walk = name => {
    if (seen.has(name)) return;
    seen.add(name);
    const chunk = chunks.get(name);
    for (const file of chunk?.viteMetadata?.importedCss ?? []) css.add(file);
    for (const next of [...(chunk?.imports ?? []), ...(chunk?.dynamicImports ?? [])]) walk(next);
  };
  walk(entry.fileName);
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Lanes progress fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

test('the yard: a running check says its time, sits by elapsed / usual and glides at no frame cost', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-lanes-progress-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch(launchOptions);
  async function open(t, viewport, query = '', options = {}) {
    const context = await browser.newContext({ viewport, ...options });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname === '/progress.html') return route.fulfill({ contentType: 'text/html', body: html });
      const file = join(out, url.pathname.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto(`https://forge.test/progress.html${query}`);
    await page
      .locator('.yard .ln')
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, [], 'no page errors');
    });
    return page;
  }
  /** Each row's words, tone and where its mark sits on the track (0 to 4), as drawn now. */
  const rows = page =>
    page.locator('.yard .ln').evaluateAll(nodes =>
      nodes.map(node => {
        const rail = node.querySelector('.trk .rl').getBoundingClientRect();
        const mark = node.querySelector('.trk .nw').getBoundingClientRect();
        return {
          title: node.querySelector('.ttl')?.textContent,
          tone: node.getAttribute('data-st'),
          word: node.querySelector('.actn .st')?.textContent,
          why: node.querySelector('.actn .why')?.textContent,
          at: (mark.left - rail.left) / (rail.width / 4),
          moving: node.querySelector('.trk').classList.contains('going'),
        };
      }),
    );
  const row = (all, prefix) => all.find(r => r.title.startsWith(prefix));
  try {
    await t.test('running, overdue, passed and failed rows', async t => {
      const all = await rows(await open(t, DESK));
      const running = row(all, 'Hosted CLI');
      assert.deepEqual(
        [running.word, running.tone, running.why],
        ['Checking', 'active', '3 min so far usually about 10 min'],
      );
      const overdue = row(all, 'Stamp every save');
      assert.deepEqual(
        [overdue.word, overdue.tone, overdue.why],
        ['Checking', 'waiting', 'overdue: over 18 min usually about 10 min'],
        'past the usual slowest: overdue in the warning tone',
      );
      assert.ok(Math.abs(overdue.at - 3.7) < 0.02 && !overdue.moving, 'overdue holds at the end of the stop');
      const passed = row(all, 'Account Projects');
      assert.equal(passed.word, 'Waiting its turn');
      assert.ok(Math.abs(passed.at - 3.85) < 0.02, 'a pass rests at the end of Checking');
      const failed = row(all, 'Public pages');
      assert.deepEqual([failed.word, failed.tone], ['Check failed', 'failed']);
      assert.ok(
        !failed.moving && Math.abs(failed.at - 3.4) < 0.02,
        'a failure rests in its stop, not moving',
      );
    });

    await t.test('position at two elapsed times, then the browser alone moves it', async t => {
      for (const minutes of [2, 7]) {
        const page = await open(t, DESK, `?elapsed=${minutes}`);
        const running = row(await rows(page), 'Hosted CLI');
        assert.ok(running.moving, 'the running check glides');
        assert.ok(
          Math.abs(running.at - placeAt(minutes)) < 0.02,
          `at ${minutes} min: ${running.at} is not ${placeAt(minutes)}`,
        );
      }
      // Two more minutes on the browser's animation clock, no script and no server: the mark is where 4 min puts it.
      const page = await open(t, DESK, '?elapsed=2');
      const moved = await page.evaluate(async () => {
        const animations = document
          .getAnimations()
          .filter(
            animation => animation instanceof CSSAnimation && animation.animationName.startsWith('yard-'),
          );
        await Promise.all(animations.map(animation => animation.ready));
        for (const animation of animations) animation.currentTime = Number(animation.currentTime) + 120_000;
        return animations.map(animation => animation.animationName);
      });
      assert.deepEqual(
        moved.sort(),
        ['yard-check', 'yard-fill'],
        `one glide and one fill, on the running check only: ${moved}`,
      );
      const running = row(await rows(page), 'Hosted CLI');
      assert.ok(Math.abs(running.at - placeAt(4)) < 0.02, `after 2 more min: ${running.at}`);
    });

    await t.test('reduced motion: the same place, nothing moves', async t => {
      const page = await open(t, DESK, '?elapsed=2', { reducedMotion: 'reduce' });
      assert.equal(await page.evaluate(() => document.getAnimations().length), 0, 'no animation runs');
      const running = row(await rows(page), 'Hosted CLI');
      assert.ok(Math.abs(running.at - placeAt(2)) < 0.02, `still at its place now: ${running.at}`);
    });

    await t.test('frame cost: no layout, style or paint on each frame of the glide', async t => {
      const page = await open(t, DESK, '?elapsed=2');
      // Both glides have started on the compositor before anything is counted.
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map(animation => animation.ready)).then(() => true),
      );
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      const metrics = async () =>
        Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      /** Two seconds of the page as it runs: drawn frames from the trace (a script frame counter would itself make a
       * main-thread frame, and a style pass, every frame), and the layouts, style passes and paints among them. */
      const measure = async () => {
        await browser.startTracing(page, {
          categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame'],
        });
        const before = await metrics();
        // About two seconds of drawn frames, counted from the browser's screencast, which sends a frame each time the
        // compositor draws a changed screen: waiting on it puts no work on the page's main thread (an in-page waiter
        // would itself make a main-thread frame, and a style pass, every frame).
        await new Promise(done => {
          let shown = 0;
          const frame = ({ sessionId }) => {
            void cdp.send('Page.screencastFrameAck', { sessionId });
            if (++shown < 60) return;
            cdp.off('Page.screencastFrame', frame);
            void cdp.send('Page.stopScreencast').then(done);
          };
          cdp.on('Page.screencastFrame', frame);
          void cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: 10,
            maxWidth: 320,
            everyNthFrame: 2,
          });
        });
        const after = await metrics();
        const trace = JSON.parse((await browser.stopTracing()).toString());
        const count = name => trace.traceEvents.filter(event => event.name === name).length;
        return {
          frames: count('DrawFrame'),
          layouts: after.LayoutCount - before.LayoutCount,
          styles: after.RecalcStyleCount - before.RecalcStyleCount,
          paints: count('Paint'),
        };
      };
      // A main-thread animation lays out, restyles and paints on every frame. The compositor's glide does none of it
      // per frame: no layout or paint at all, and only the odd style pass Chromium makes to sync a running animation.
      const glide = await measure();
      assert.ok(glide.frames >= 60, `frames drawn: ${JSON.stringify(glide)}`);
      assert.equal(glide.layouts, 0, `layouts: ${JSON.stringify(glide)}`);
      assert.equal(glide.paints, 0, `paints: ${JSON.stringify(glide)}`);
      assert.ok(glide.styles * 10 <= glide.frames, `style passes: ${JSON.stringify(glide)}`);
      assert.ok(await page.evaluate(() => document.getAnimations().every(a => a.playState === 'running')));
      // Control: the same mark moved by a layout property is caught, so the bar above is not blind.
      await page.addStyleTag({
        content:
          '@keyframes probe { from { left: 0 } to { left: 90px } } [data-ds] .yard .trk.going .nw { animation: probe 1s linear infinite; }',
      });
      const probe = await measure();
      assert.ok(probe.layouts * 2 >= probe.frames, `a layout animation is caught: ${JSON.stringify(probe)}`);
    });

    if (shots)
      await t.test('screenshots: desk and phone, both themes', async t => {
        for (const viewport of [DESK, PHONE]) {
          const page = await open(t, viewport, '?elapsed=4');
          for (const theme of ['dark', 'light']) {
            await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
            const [scroll, inner] = await page.evaluate(() => [
              document.documentElement.scrollWidth,
              innerWidth,
            ]);
            assert.ok(scroll <= inner, `no sideways scroll at ${viewport.width} ${theme}`);
            await page.screenshot({
              path: join(shots, `lanes-progress-${viewport.width}-${theme}.png`),
              fullPage: true,
            });
          }
        }
      });
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});

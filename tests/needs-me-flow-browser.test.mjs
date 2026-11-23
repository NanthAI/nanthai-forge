// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Flow picture on Needs me (Item 85f456c1, Lane 2) in a real browser, on the Needs me fixture
// (tests/browser/needs-me.tsx) through the real shell frame: every stop's count is the top bar's count and its blocks
// (one source, the line feed); the home layout (a 2 x 2: picture top left, Needs you top right, Loose ends bottom left, FYI bottom right, the
// picture gives Needs you width while it holds anything, a phone reads Needs you first); widths 861 to 1440 have no
// sideways scroll and the right size step; a held block's tag goes to its row under Needs you; worst-case text (long
// handles, right-to-left and 50+ character titles) and a request asked ahead stay inside their boxes, axe clean in
// both themes; nothing sets a repeating timer. Set FORGE_NEEDS_SHOTS to a folder to also save the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_NEEDS_SHOTS || null;
const FIXTURE = 'tests/browser/needs-me.tsx';
const HOME = '/sample-one/tidepool';
const STOPS = ['editing', 'saved', 'queued', 'checking'];
/** The picture's size step for its width (web/src/app/flow/geometry.ts `tierOf`). */
const tierOf = width => (width >= 1000 ? 2 : width >= 640 ? 1 : 0);

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
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Needs me fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

test('Needs me Flow picture: one source, the home layout, widths, tags and worst-case text', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-needs-flow-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch(launchOptions);
  async function open(
    t,
    width,
    data,
    { theme = 'dark', layout = null, reducedMotion = 'no-preference', liveDrawer = false } = {},
  ) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion });
    await context.addInitScript(
      dock => {
        // Any interval, or a timeout of a second or more still pending, would be a page waking itself up.
        window.timers = { intervals: 0, pending: new Set() };
        const every = window.setInterval;
        window.setInterval = (...args) => {
          window.timers.intervals++;
          return every(...args);
        };
        const later = window.setTimeout;
        const clear = window.clearTimeout;
        window.setTimeout = (run, ms, ...rest) => {
          const id = later(
            (...a) => {
              window.timers.pending.delete(id);
              return typeof run === 'function' ? run(...a) : undefined;
            },
            ms,
            ...rest,
          );
          if (ms >= 1000) window.timers.pending.add(id);
          return id;
        };
        window.clearTimeout = id => {
          window.timers.pending.delete(id);
          return clear(id);
        };
        try {
          localStorage.setItem('forge.firstRun.lane', '1');
          if (dock) localStorage.setItem('forge.dock.person:sample-one:needs-me', dock);
        } catch {}
      },
      layout && JSON.stringify(layout),
    );
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(2026, 10, 17, 15));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname === HOME) return route.fulfill({ contentType: 'text/html', body: html });
      const file = join(out, url.pathname.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.woff2')
          ? 'font/woff2'
          : 'text/css';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto(
      `https://forge.test${HOME}?data=${data}&theme=${theme}${liveDrawer ? '&live-drawer' : ''}`,
    );
    await page
      .locator('.dock[data-dock] .region')
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
    if (width > 860) await page.locator('.fv-pic').waitFor();
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, [], 'no page errors');
    });
    return page;
  }
  /** What would wake an idle page: intervals ever set and long timeouts still pending. Idle costs nothing. */
  const idleTimers = page => page.evaluate(() => window.timers.intervals + window.timers.pending.size);
  const region = (page, name) => page.locator(`section.region[aria-label="${name}"]`);
  const box = async (page, name) => (await region(page, name).boundingBox()) ?? assert.fail(`no ${name}`);
  try {
    await t.test('a receipt-only day shows its count, partial timing and retained main verdict', async t => {
      for (const measured of [false, true]) {
        const page = await open(t, 1440, measured ? 'partial-measured' : 'partial-empty');
        const figures = page.locator('.flow-figs');
        assert.match(
          await figures.getByRole('link', { name: /Land to main/ }).textContent(),
          measured ? /partial sample/ : /No timing samples/,
        );
        const main = figures.getByRole('link', { name: 'main green' });
        assert.equal(await main.textContent(), 'main green');
        assert.equal(await main.getAttribute('title'), 'Latest full check of main passed at 14:48');
        assert.equal(await page.locator('header.top .line .tomain').getAttribute('title'), 'Main passing');
      }
      const phone = await open(t, 390, 'partial-empty');
      assert.match(await phone.locator('.flow-rows > li').last().textContent(), /main green/);
    });

    await t.test('the Flow state legend and recorded checks render at reference weight', async t => {
      for (const width of [1440, 390]) {
        const page = await open(t, width, 'busy');
        const legend = page.getByRole('list', { name: 'Lane states' });
        const words = await legend.getByRole('listitem').allTextContents();
        // Item 9b9057a9, owner 2026-11-23: one word per look, drawn as its block; the meaning is a hover, not text.
        assert.deepEqual(words, ['Working', 'Waiting its turn', 'Held', 'Check failed', 'Conflict']);
        const drawn = await legend
          .getByRole('listitem')
          .evaluateAll(items =>
            items.map(item => [
              item.querySelector('svg.fv-cube').dataset.st,
              item.querySelectorAll('path.hole').length,
              item.querySelectorAll('path.g').length,
            ]),
          );
        assert.deepEqual(drawn, [
          ['active', 0, 0],
          ['waiting', 0, 0],
          ['waiting', 1, 0],
          ['failed', 0, 1],
          ['conflict', 0, 1],
        ]);
        assert.match(
          await legend.getByRole('listitem').nth(4).getAttribute('title'),
          /^This Lane’s changes clash with another Lane’s on the same lines/,
        );
        // Owner 2026-11-23 14:20Z: running checks are the Standing line's roll, one segment each, filled by elapsed time
        // against the day's middle landing time (9 min here), free room empty; the bar's width is the check width.
        const roll = page.locator('.flow-bar .roll i');
        assert.deepEqual(await roll.evaluateAll(parts => parts.map(part => part.className)), [
          'run',
          'run',
          '',
          '',
        ]);
        assert.deepEqual(
          await roll.evaluateAll(parts => parts.map(part => part.querySelector('span')?.style.width ?? null)),
          ['47%', '23%', null, null],
        );
        assert.match(
          await roll.nth(0).getAttribute('title'),
          /^Running check: 2 Lanes together · running 4 min · landings usually take 9 min/,
        );
        assert.equal(
          await roll.nth(1).getAttribute('title'),
          'Running check: 1 Lane · running 2 min · landings usually take 9 min',
        );
        assert.match(
          await page.locator('.flow-chk .flow-check-title').textContent(),
          /^Checks2 running · 2 passed, waiting to land · 2 more checks can start now$/,
        );
        assert.doesNotMatch(
          await page.locator('.flow-chk').textContent(),
          /Shards|Free slots|Since requested|slots/,
        );
        assert.match(
          await page.locator('.flow-ci').textContent(),
          /CI minutes today.*Landed [\d,]+ min\s*Did not land 20 min/,
        );
        assert.equal(await idleTimers(page), 0);
        await page.getByRole('button', { name: /^Checks/ }).click();
        const drawer = page.getByRole(width === 390 ? 'dialog' : 'region', { name: 'Checking' });
        await drawer.waitFor();
        const checkOne = drawer.locator('.grp').filter({ has: page.getByText('Check 1', { exact: true }) });
        await checkOne.waitFor();
        assert.equal(await checkOne.locator('a.fv-rrow').count(), 2);
        assert.deepEqual(
          (
            await checkOne
              .locator('a.fv-rrow')
              .evaluateAll(links => links.map(a => a.getAttribute('href')?.slice(-3)))
          ).sort(),
          ['430', '431'],
          'the older queued group cannot take the running Check 1 label',
        );
      }
    });

    await t.test('the main count stays on one line on Needs me with the shared figure styles', async t => {
      for (const width of [390, 861, 1440]) {
        const page = await open(t, width, 'busy');
        const main = page.locator('.line:visible .tomain');
        assert.equal(await main.getAttribute('title'), 'Main passing');
        const { text, height, fontSize } = await main.evaluate(link => {
          const parts = [...link.querySelectorAll('span.g')].flatMap(span => {
            const range = document.createRange();
            range.selectNodeContents(span);
            return [...range.getClientRects()];
          });
          return {
            text: link.innerText,
            height: Math.max(...parts.map(r => r.bottom)) - Math.min(...parts.map(r => r.top)),
            fontSize: parseFloat(getComputedStyle(link).fontSize),
          };
        });
        assert.match(text, /main · 92/);
        assert.ok(Number.isFinite(height) && height < fontSize * 2, `main fits on one line at ${width}px`);
      }
    });

    await t.test('every stop counts what the top bar counts, block for block (one source)', async t => {
      for (const data of ['busy', 'calm', 'worst']) {
        const page = await open(t, 1440, data);
        const counts = await page.evaluate(stops => {
          const text = el => el?.textContent?.trim();
          return stops.map(stop => ({
            stop,
            line: text(document.querySelector(`header.top .line a.stop[data-stop="${stop}"] .n`)),
            label: text(document.querySelector(`.fv-pic .fv-stn[data-stop="${stop}"] .c`)),
            passed:
              parseInt(text(document.querySelector(`.fv-pic .fv-stn[data-stop="${stop}"] .flow-passed`))) ||
              0,
            blocks: document.querySelectorAll(`.fv-pic g[data-stop="${stop}"] .fv-cube`).length,
          }));
        }, STOPS);
        for (const { stop, line, label, passed, blocks } of counts) {
          assert.equal(label, line, `${data} ${stop}: the picture says the top bar's count`);
          assert.equal(blocks, Number(line) + passed, `${data} ${stop}: one block per open Lane`);
        }
        const lanesOpen = await region(page, 'On the way to main').locator('.ph .cnt').textContent();
        const standing = await page.locator('.needs-me').textContent();
        assert.match(
          standing,
          new RegExp(`${lanesOpen} Lanes open`),
          `${data}: the region counts the Lanes open`,
        );
        if (data === 'worst') assert.equal(lanesOpen, '56');
      }
      // A phone reads the same counts as flat rows.
      const phone = await open(t, 390, 'busy');
      const rows = await phone.locator('.flow-row .c').allTextContents();
      const line = await phone.locator('header.top .line a.stop .n').allTextContents();
      assert.deepEqual(rows.slice(0, 4), line, 'the phone rows count what the line counts');
    });

    await t.test(
      '5a7d57a3: four checks run while six amber Lanes wait, and the old queued Lane is active',
      async t => {
        for (const width of [1440, 390]) {
          for (const theme of ['dark', 'light']) {
            const page = await open(t, width, 'stall', { theme });
            await page.evaluate(() => document.fonts.ready.then(() => null));
            const strip = page.getByRole('navigation', { name: 'Lane progress in this project' });
            const stopClipping = () =>
              strip.locator('[data-stop]').evaluateAll(stops =>
                stops.flatMap(stop => {
                  const cell = stop.getBoundingClientRect();
                  const range = document.createRange();
                  return [...stop.querySelectorAll('.lbl, .line-count, .n, .line-passed')].flatMap(part => {
                    const box = part.getBoundingClientRect();
                    range.selectNodeContents(part);
                    const text = range.getBoundingClientRect();
                    // Integer scrollWidth and clientWidth can round the same fractional text edge differently.
                    const left = Math.max(cell.left, box.left);
                    const right = Math.min(cell.right, box.right);
                    return box.left < cell.left - 0.5 ||
                      box.right > cell.right + 0.5 ||
                      box.top < cell.top - 0.5 ||
                      box.bottom > cell.bottom + 0.5 ||
                      text.left < left - 0.5 ||
                      text.right > right + 0.5
                      ? [{ label: part.innerText, left, right, textLeft: text.left, textRight: text.right }]
                      : [];
                  });
                }),
              );
            assert.deepEqual(await stopClipping(), [], `stop words and counts fit at ${width}px in ${theme}`);
            if (width === 1440) {
              // The passed line hangs under the label: Checking's label sits on the baseline the other stages share.
              const centres = await strip.locator('[data-stop]').evaluateAll(stops =>
                stops.map(stop => {
                  const range = document.createRange();
                  range.selectNodeContents(stop.querySelector('.line-checking') ?? stop);
                  const box = range.getBoundingClientRect();
                  return Math.round(box.top + box.height / 2);
                }),
              );
              assert.ok(
                Math.max(...centres) - Math.min(...centres) <= 1,
                `stage labels share one baseline: ${centres}`,
              );
            }
            if (width === 390) {
              const widerText = await page.addStyleTag({
                content: '.line.phone .line-passed { font-size: var(--t-small); }',
              });
              const clipped = await stopClipping();
              await widerText.evaluate(style => style.remove());
              assert.deepEqual(clipped, [], 'Checking reserves room when the passed label measures wider');
            }
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
              false,
              `the page fits at ${width}px in ${theme}`,
            );
            const line = strip.locator('[data-stop="checking"]');
            assert.equal(await line.locator('.n').textContent(), '4');
            assert.equal(await line.locator('.line-passed').innerText(), '6 Lanes passed');
            assert.equal(
              await line.locator('.line-passed').getAttribute('title'),
              '6 Lanes passed, waiting to land',
            );
            assert.match(
              await line.getAttribute('aria-label'),
              /Check(?:ing)? 4 Lanes, 6 Lanes passed, waiting to land in this project/,
            );
            const station =
              width === 390
                ? page.locator('.flow-rows .flow-row').nth(3)
                : page.locator('.fv-pic .fv-stn[data-stop="checking"]');
            assert.equal(await station.locator('.c').textContent(), '4');
            assert.equal(await station.locator('.flow-passed').textContent(), '6 passed, waiting to land');
            const button = station.getByRole('button', { name: 'Checking 4' });
            assert.equal(await button.count(), 1);
            assert.equal(
              await button.getAttribute('aria-describedby'),
              await station.locator('.flow-passed').getAttribute('id'),
            );
            const waiting =
              width === 390
                ? station.locator('.flow-marks [data-st="waiting"]')
                : page.locator('.fv-pic g[data-stop="checking"] .fv-cube[data-st="waiting"]');
            assert.equal(await waiting.count(), 6);
            const hovers = await waiting.evaluateAll(marks =>
              marks.map(mark => mark.title || mark.getAttribute('aria-label')),
            );
            assert.equal(hovers.length, 6);
            assert.ok(hovers.every(title => title.endsWith('Passed, waiting to land')));
            const loose = region(page, 'Loose ends');
            assert.match(
              await loose.textContent(),
              /Still active.*Compare and restore Item versions.*Landing queue/,
            );
            assert.equal(await loose.getByText('Stopped mid-task').count(), 0);
            if (shots) await page.screenshot({ path: join(shots, `stall-${width}-${theme}.png`) });
            await line.click();
            const drawer = page.getByRole(width === 390 ? 'dialog' : 'region', { name: 'Checking' });
            await drawer.waitFor();
            assert.equal(await drawer.getByText('Passed, waiting to land', { exact: true }).count(), 6);
          }
        }
      },
    );

    await t.test(
      'the home layout: a 2 x 2, picture and Needs you above, Loose ends and FYI below (9e748e41)',
      async t => {
        const ratio = async page => {
          const [flow, needs] = [await box(page, 'On the way to main'), await box(page, 'Needs you')];
          return flow.width / needs.width;
        };
        const calm = await open(t, 1440, 'calm');
        const [flow, needs, fyi, loose] = [
          await box(calm, 'On the way to main'),
          await box(calm, 'Needs you'),
          await box(calm, 'FYI'),
          await box(calm, 'Loose ends'),
        ];
        assert.ok(flow.x < needs.x && Math.abs(flow.y - needs.y) < 2, 'the picture is left of Needs you');
        assert.ok(
          loose.y > flow.y + flow.height - 2 && Math.abs(loose.x - flow.x) < 2,
          'Loose ends is below the picture',
        );
        assert.ok(
          fyi.y > needs.y + needs.height - 2 && Math.abs(fyi.x - needs.x) < 2,
          'FYI is below Needs you',
        );
        assert.ok(Math.abs((await ratio(calm)) - 1.6) < 0.05, 'nothing waits: the picture has 1.6 : 1');
        assert.equal(await calm.locator('.fv-pic').getAttribute('data-tier'), '1');
        const busy = await open(t, 1440, 'busy');
        for (const [data, page] of [
          ['busy', busy],
          ['worst', await open(t, 1440, 'worst')],
          ['over', await open(t, 1440, 'over')],
        ]) {
          const [picture, needsYou, fyi] = [
            await box(page, 'On the way to main'),
            await box(page, 'Needs you'),
            await box(page, 'FYI'),
          ];
          assert.ok(
            picture.x < needsYou.x && Math.abs(picture.y - needsYou.y) < 2,
            `Needs you stays at the top right for ${data}`,
          );
          assert.ok(needsYou.y < fyi.y, 'FYI never comes before Needs you');
          assert.ok(
            Math.abs((await ratio(page)) - 1 / 1.1) < 0.05,
            'something waits: Needs you gets 1.1 : 1',
          );
          assert.equal(
            await page.locator('.fv-pic').getAttribute('data-tier'),
            '0',
            'the picture drops a size',
          );
        }
        const phone = await open(t, 390, 'busy');
        const order = await phone.evaluate(() =>
          [...document.querySelectorAll('section.region')].map(section => section.getAttribute('aria-label')),
        );
        assert.deepEqual(
          order,
          ['Needs you', 'On the way to main', 'FYI', 'Loose ends'],
          'a phone reads Needs you first',
        );
        await phone.locator('.needs-me .pstate a').last().focus();
        const firstRegionFocused = [];
        for (let i = 0; i < 80 && firstRegionFocused.length < 4; i++) {
          await phone.keyboard.press('Tab');
          const active = await phone.evaluate(
            () => document.activeElement?.closest('section.region')?.ariaLabel,
          );
          if (active && !firstRegionFocused.includes(active)) firstRegionFocused.push(active);
        }
        assert.deepEqual(firstRegionFocused, order, 'Tab enters every region in DOM order');
        for (const page of [busy, phone])
          assert.equal(await idleTimers(page), 0, 'an idle page sets no timer');
        await phone.getByRole('button', { name: 'Move FYI' }).click();
        await phone.getByRole('menuitem', { name: 'Up one' }).click();
        const after = await phone
          .locator('section.region')
          .evaluateAll(sections => sections.map(section => section.ariaLabel));
        assert.deepEqual(
          after,
          ['Needs you', 'FYI', 'On the way to main', 'Loose ends'],
          'the phone grip can rearrange regions',
        );
      },
    );

    await t.test(
      'widths 861 to 1440: no sideways scroll, the size step, labels inside the picture',
      async t => {
        for (const width of [861, 1000, 1100, 1440])
          for (const data of ['calm', 'busy']) {
            const page = await open(t, width, data);
            const seen = await page.evaluate(() => {
              const pic = document.querySelector('.fv-pic');
              const frame = pic.getBoundingClientRect();
              const out = [...pic.querySelectorAll('.fv-stn, .fv-tag, .fv-back')]
                .map(el => [el.textContent, el.getBoundingClientRect()])
                .filter(([, r]) => r.left < frame.left - 1 || r.right > frame.right + 1)
                .map(([text]) => text);
              return {
                scroll: document.documentElement.scrollWidth,
                inner: innerWidth,
                tier: pic.dataset.tier,
                width: frame.width,
                out,
              };
            });
            assert.ok(seen.scroll <= seen.inner, `no sideways scroll at ${width} ${data}`);
            assert.equal(Number(seen.tier), tierOf(seen.width), `size step at ${width} ${data}`);
            assert.deepEqual(seen.out, [], `labels inside the picture at ${width} ${data}`);
            if (shots)
              for (const theme of ['dark', 'light']) {
                await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
                await page.screenshot({ path: join(shots, `flow-${data}-${width}-${theme}.png`) });
              }
          }
      },
    );

    await t.test(
      'an individual cube opens its Lane, a solid opens its station, and the top line opens a phone sheet',
      async t => {
        const page = await open(t, 1440, 'busy', { reducedMotion: 'reduce' });
        const cube = page.locator('a.fv-cube').first();
        const id = await cube.getAttribute('data-id');
        assert.equal(await cube.getAttribute('href'), `${HOME}/lanes/${id}`);
        assert.match(await cube.getAttribute('aria-label'), /Editing/);
        await cube.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await cube.evaluate(el => el.matches(':focus-visible')), true);
        await page.locator('.fv-hint').waitFor();
        await page.keyboard.press('Enter');
        assert.equal(new URL(page.url()).pathname, `${HOME}/lanes/${id}`);

        const clicked = await open(t, 1440, 'busy', { reducedMotion: 'reduce' });
        const target = clicked.locator('g[data-stop="editing"] a.fv-cube').last();
        const href = await target.getAttribute('href');
        await target.locator('.t').click();
        assert.equal(new URL(clicked.url()).pathname, href);

        const over = await open(t, 1440, 'over', { reducedMotion: 'reduce' });
        assert.equal(await region(over, 'On the way to main').locator('.ph .cnt').textContent(), '77');
        assert.equal(await over.locator('a.fv-cube').count(), 3, 'held Lanes retain their own cubes');
        const sized = await over
          .locator('a.fv-solid')
          .evaluateAll(solids => solids.reduce((sum, solid) => sum + Number(solid.dataset.n), 0));
        assert.equal(sized, 57, 'the solids account for the other sampled Lanes');
        assert.match(await over.locator('.flow .pf').textContent(), /17 open Lanes past the first 60/);
        await over.locator('g[data-stop="editing"] .fv-solid .t').click();
        const drawer = region(over, 'Editing');
        await drawer.waitFor();
        assert.match(await drawer.locator('.tally').textContent(), /here/);
        assert.equal(new URL(over.url()).searchParams.get('open'), 'editing');
        await over.keyboard.press('Escape');
        await drawer.waitFor({ state: 'detached' });
        await over.locator('.fv-stn[data-stop="saved"] .c').click();
        await region(over, 'Saved').waitFor();

        const phone = await open(t, 390, 'over');
        for (const page of [over, phone]) {
          const strip = page.getByRole('navigation', { name: 'Lane progress in this project' });
          const counts = strip.locator('[data-stop] .n');
          assert.equal(await counts.count(), STOPS.length);
          assert.ok((await counts.allTextContents()).every(text => /^\d+\+$/.test(text)));
          assert.match(
            await strip.locator('[data-stop="saved"]').getAttribute('aria-label'),
            /^Saved \d+\+ Lanes, \d+\+ held \(first 60 open Lanes in this project\)$/,
          );
        }
        const phoneMarks = await phone.locator('.flow-row .flow-marks > span, .flow-row .fv-tag').count();
        assert.equal(phoneMarks, 3, 'the compact rows keep held marks only past the cap');
        await phone.locator('.line.phone [data-stop="checking"]').click();
        const sheet = phone.getByRole('dialog', { name: 'Checking' });
        await sheet.waitFor();
        await phone.keyboard.press('Escape');
        await sheet.waitFor({ state: 'detached' });
      },
    );

    await t.test(
      'focused Lane links and visible tooltips survive its live move and unrelated updates',
      async t => {
        const page = await open(t, 1440, 'calm');
        const id = '5d1c7a0e-0000-4000-8000-000000000400';
        const cube = page.locator(`a[data-id="${id}"]`);
        await cube.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await cube.evaluate(el => el.matches(':focus-visible')), true);
        await page.evaluate(() => window.advanceFlow('save'));
        await page.locator(`g[data-stop="saved"] .fv-arrive a[data-id="${id}"]:focus`).waitFor();
        await page.evaluate(() => window.advanceFlow('unrelated'));
        await page.locator('.fv-strata.red').waitFor();
        assert.equal(await cube.evaluate(el => el.matches(':focus-visible')), true);
        await page.locator('.fv-hint').waitFor();
        await page.keyboard.press('Enter');
        assert.equal(new URL(page.url()).pathname, `${HOME}/lanes/${id}`);
      },
    );

    await t.test(
      'the checks bar and CI minutes keep their place whatever runs, and no figure wraps mid-value (9e748e41)',
      async t => {
        for (const width of [1440, 390]) {
          for (const data of ['busy', 'stall', 'calm']) {
            const page = await open(t, width, data, { reducedMotion: 'reduce' });
            const at = await page.evaluate(() => {
              const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
              const chk = rect('.flow-chk');
              const ci = rect('.flow-ci');
              const bar = rect('.flow-bar');
              const single = el => {
                const style = getComputedStyle(el);
                const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
                return el.getBoundingClientRect().height <= line * 1.5;
              };
              return {
                left: Math.round(ci.left - chk.left),
                width: Math.round(ci.width),
                full: Math.abs(ci.width - chk.width) < 1.5,
                below: !bar || ci.top >= bar.bottom - 0.5,
                wrapped: [...document.querySelectorAll('.flow-ci-key > span, .flow-figs b')]
                  .filter(el => !single(el))
                  .map(el => `${el.className} ${el.textContent} ${el.getBoundingClientRect().height}`),
              };
            });
            assert.equal(at.full, true, `CI minutes spans the row at ${width} ${data}`);
            assert.equal(at.below, true, `CI minutes sits under the checks bar at ${width} ${data}`);
            assert.deepEqual(at.wrapped, [], `no value wraps at ${width} ${data}`);
            assert.equal(
              at.left,
              0,
              `CI minutes starts at the panel's edge with ${data} checks running at ${width}`,
            );
          }
        }
      },
    );

    await t.test(
      'a check that holds a slot but whose CI run has not started is a starting segment, counted and slow when it waits (9e748e41)',
      async t => {
        for (const width of [1440, 390]) {
          const page = await open(t, width, 'starting', { reducedMotion: 'reduce' });
          const roll = page.locator('.flow-bar .roll i');
          assert.deepEqual(
            await roll.evaluateAll(parts => parts.map(part => part.className)),
            ['run', 'run hatched', '', '', '', '', '', ''],
            'one segment per slot: running, starting, then the free room, 8 in all',
          );
          assert.equal(
            await roll.nth(1).getAttribute('title'),
            'Starting check: 1 Lane · requested 3 min ago · CI provider not started yet · starting slowly: longer than this project’s usual pickup',
          );
          assert.match(
            await page.locator('.flow-chk .flow-check-title').textContent(),
            /^Checks1 running · 1 starting · .*6 more checks can start now$/,
          );
          if (shots) await page.screenshot({ path: join(shots, `checks-starting-${width}.png`) });
        }
      },
    );

    await t.test(
      'a block hover draws above every cube and label, inside the picture, and names no id (9b9057a9)',
      async t => {
        for (const [width, data] of [
          [1440, 'busy'],
          [1440, 'towers'],
          [900, 'busy'],
        ]) {
          const page = await open(t, width, data, { reducedMotion: 'reduce' });
          // The hover takes no pointer in use; the test lets it, to ask what is on top at its centre.
          await page.addStyleTag({ content: '.fv-hint { pointer-events: auto !important; }' });
          const cubes = page.locator('a.fv-cube');
          const total = await cubes.count();
          let tried = 0;
          for (let i = total - 1; i >= 0 && tried < 12; i--) {
            const at = await cubes.nth(i).evaluate(el => {
              const r = el.querySelector('.t').getBoundingClientRect();
              const x = r.left + r.width / 2;
              const y = r.top + r.height / 2;
              return document.elementFromPoint(x, y)?.closest('a.fv-cube') === el ? [x, y] : null;
            });
            if (!at) continue; // another block stands in front of this one's top
            tried++;
            await page.mouse.move(...at);
            const hint = page.locator('.fv-hint');
            await hint.waitFor();
            const seen = await hint.evaluate(el => {
              const pic = el.closest('.fv-pic').getBoundingClientRect();
              const r = el.getBoundingClientRect();
              const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return {
                text: el.textContent,
                inside:
                  r.left >= pic.left - 0.5 &&
                  r.right <= pic.right + 0.5 &&
                  r.top >= pic.top - 0.5 &&
                  r.bottom <= pic.bottom + 0.5,
                onTop: top === el,
              };
            });
            assert.equal(
              seen.onTop,
              true,
              `hover over every cube and label at ${width} ${data}: ${seen.text}`,
            );
            assert.equal(seen.inside, true, `hover inside the picture at ${width} ${data}: ${seen.text}`);
            assert.doesNotMatch(
              seen.text,
              /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/,
              'a hover never names an id',
            );
            if (shots && tried === 3)
              await page.screenshot({ path: join(shots, `hover-${data}-${width}.png`) });
          }
          assert.ok(tried >= 3, `hovered ${tried} blocks at ${width} ${data}`);
          await page.mouse.move(2, 2);
          await page.locator('.fv-hint').waitFor({ state: 'detached' });
        }
        // Keyboard focus on a block wins over a pointer left on another one: the hover says what has the focus.
        const both = await open(t, 1440, 'busy', { reducedMotion: 'reduce' });
        const first = both.locator('a.fv-cube').first();
        const [x, y] = await first.evaluate(el => {
          const r = el.querySelector('.t').getBoundingClientRect();
          return [r.left + r.width / 2, r.top + r.height / 2];
        });
        await both.mouse.move(x, y);
        await both.locator('.fv-hint').waitFor();
        const other = both.locator('a.fv-cube').last();
        await other.focus();
        await both.keyboard.press('Tab');
        await both.keyboard.press('Shift+Tab');
        assert.equal(await other.evaluate(el => el.matches(':focus-visible')), true);
        await both.waitForFunction(
          label => document.querySelector('.fv-hint')?.textContent === label,
          await other.getAttribute('aria-label'),
        );
        // Under 860px the picture is rows: no block, no hover.
        const phone = await open(t, 390, 'busy');
        if (shots) await phone.screenshot({ path: join(shots, 'hover-rows-390.png') });
        assert.equal(await phone.locator('.fv-pic').isVisible(), false);
        assert.equal(await phone.locator('.fv-hint').count(), 0);
      },
    );

    await t.test(
      'a held drawer row reveals a decision beyond the cap and moves focus out of the phone sheet',
      async t => {
        const id = '5d1c7a0e-0000-4000-8000-000000000005';
        for (const width of [390, 1440]) {
          const page = await open(t, width, 'held-more', { reducedMotion: 'reduce' });
          const decision = page.locator(`#d-${id}`);
          assert.equal(await decision.count(), 0, 'the fifth decision starts beyond the visible cap');
          await region(page, 'On the way to main')
            .getByRole('button', { name: /^Checking/ })
            .click();
          const drawer =
            width === 390 ? page.getByRole('dialog', { name: 'Checking' }) : region(page, 'Checking');
          await drawer.getByRole('link', { name: /Decision 5/ }).click();
          if (width === 390) await drawer.waitFor({ state: 'detached' });
          await page.locator(`#d-${id}:focus`).waitFor();
          await decision.getByRole('button', { name: 'Approve and land', exact: true }).waitFor();
        }
      },
    );

    await t.test(
      'seven distinct checks and a 24-Lane tower remain visible and accessible in a narrow column',
      async t => {
        const page = await open(t, 1440, 'towers', { reducedMotion: 'reduce' });
        const picture = page.locator('.fv-pic');
        assert.equal(await picture.getAttribute('data-tier'), '0');
        const cubes = picture.locator('g[data-stop="checking"] a.fv-cube');
        assert.equal(await cubes.count(), 31);
        const geometry = await cubes.evaluateAll(nodes => {
          const area = nodes[0].closest('.fv-pic').getBoundingClientRect();
          return nodes.map(node => ({
            position: node.parentElement.parentElement.getAttribute('transform'),
            inside: node.querySelector('.t').getBoundingClientRect().top >= area.top,
          }));
        });
        assert.equal(new Set(geometry.map(cube => cube.position)).size, 31);
        assert.ok(
          geometry.every(cube => cube.inside),
          'no top above the picture',
        );
        for (const cube of [cubes.nth(6), cubes.last()]) {
          await cube.focus();
          const hint = page.locator('.fv-hint');
          await hint.waitFor();
          assert.equal(
            await hint.evaluate(
              el => el.getBoundingClientRect().top >= el.closest('.fv-pic').getBoundingClientRect().top,
            ),
            true,
          );
        }
        const href = await cubes.last().getAttribute('href');
        await page.keyboard.press('Enter');
        assert.equal(new URL(page.url()).pathname, href);
      },
    );

    await t.test(
      'opening an empty station does not fetch Lanes; one populated drawer reads one bounded page',
      async t => {
        const page = await open(t, 1440, 'calm', { liveDrawer: true, reducedMotion: 'reduce' });
        assert.deepEqual(await page.evaluate(() => window.drawerReads), []);
        await page.locator('.fv-stn[data-stop="editing"] .flow-stop').click();
        await region(page, 'Editing').waitFor();
        assert.deepEqual(await page.evaluate(() => window.drawerReads), [
          {
            name: 'projectHostedLiveLanes:list',
            limit: 100,
          },
        ]);
        await page.keyboard.press('Escape');
        await page.locator('.fv-stn[data-stop="main"] .flow-stop').click();
        await region(page, 'main').waitFor();
        assert.deepEqual(
          (await page.evaluate(() => window.drawerReads)).map(r => r.name),
          ['projectHostedLiveLanes:list', 'projectLandingReads:list'],
        );

        const empty = await open(t, 1440, 'quiet', { liveDrawer: true });
        await empty.locator('.fv-stn[data-stop="editing"] .flow-stop').click();
        await region(empty, 'Editing').waitFor();
        assert.deepEqual(await empty.evaluate(() => window.drawerReads), []);
      },
    );

    await t.test(
      'ambient motion follows work, calms after 60 s, pauses when hidden and respects reduced motion',
      async t => {
        const loops = page =>
          page.locator('.flow').evaluate(el =>
            el
              .getAnimations({ subtree: true })
              .filter(a => a.effect.getTiming().iterations === Infinity)
              .map(a => ({
                name: a.animationName,
                duration: a.effect.getTiming().duration,
                state: a.playState,
              })),
          );
        for (const data of ['quiet', 'empty', 'busy', 'loading', 'error']) {
          const page = await open(t, 1440, data);
          assert.deepEqual(await loops(page), [], `${data} is still (busy fixture has decisions)`);
        }
        const page = await open(t, 1440, 'calm');
        const full = await loops(page);
        assert.ok(full.some(a => a.name === 'fv-travel' && a.state === 'running'));
        assert.ok(full.some(a => a.name === 'fv-breathe' && a.state === 'running'));
        for (const stop of ['editing', 'checking'])
          assert.ok(await page.locator(`g[data-stop="${stop}"] .fv-cube.run`).count(), `${stop} breathes`);
        await page.locator('.flow-clock').evaluate(el => {
          const clock = el.getAnimations()[0];
          if (clock.effect.getTiming().duration !== 60_000)
            throw new Error('Calm-down clock must run at 60 s.');
          clock.finish();
        });
        await page.waitForSelector('.flow[data-slow]');
        assert.deepEqual(
          (await loops(page)).map(a => a.duration),
          full.map(a => 2 * a.duration),
        );
        await page.keyboard.press('Shift');
        assert.deepEqual(
          (await loops(page)).map(a => a.duration),
          full.map(a => a.duration),
        );
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        const paused = await loops(page);
        assert.equal(paused.length, full.length);
        assert.ok(paused.every(a => a.state === 'paused'));
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.deepEqual(await loops(page), []);

        const phone = await open(t, 390, 'calm');
        assert.deepEqual([...new Set((await loops(phone)).map(a => a.name))], ['fv-breathe']);
      },
    );

    await t.test('a new feed moves a saved Lane and shows its landing at main once', async t => {
      const page = await open(t, 1440, 'calm');
      const id = '5d1c7a0e-0000-4000-8000-000000000400';
      assert.equal(await page.locator('.fv-arrive').count(), 0);
      if (shots) await page.screenshot({ path: join(shots, 'motion-01-editing.png') });
      await page.evaluate(() => window.advanceFlow('save'));
      const arrived = page.locator(`g[data-stop="saved"] .fv-arrive [data-id="${id}"]`);
      await arrived.waitFor();
      const freezeFrame = async (selector, time) =>
        page.locator(selector).evaluate((node, time) => {
          for (const animation of node.getAnimations()) {
            animation.pause();
            animation.currentTime = time;
          }
        }, time);
      if (shots) {
        await freezeFrame('.fv-arrive', 260);
        await page.screenshot({ path: join(shots, 'motion-02-gliding.png') });
      }
      await page.evaluate(() => window.advanceFlow('land'));
      await page.locator('.fv-landed').waitFor();
      assert.equal(await page.locator(`[data-id="${id}"]`).count(), 0);
      assert.equal(await page.locator('.fv-landing-pulse').count(), 1);
      await freezeFrame('.fv-landed', 300);
      const inTransit = await page.locator('.fv-landed').evaluate(el => ({
        opacity: Number(getComputedStyle(el).opacity),
        x: new DOMMatrix(getComputedStyle(el).transform).m41,
      }));
      assert.ok(inTransit.opacity > 0.9 && inTransit.x !== 0, 'the cube stays visible during transit');
      await freezeFrame('.fv-landed', 800);
      assert.equal(await page.locator('.fv-landed').evaluate(el => Number(getComputedStyle(el).opacity)), 0);
      if (shots) {
        await freezeFrame('.fv-landed', 540);
        await page.screenshot({ path: join(shots, 'motion-03-landing.png') });
      }
    });

    await t.test(
      'empty, quiet, moving, loading and stale at both widths and themes; Loose ends action stays readable',
      async t => {
        for (const width of [1440, 390]) {
          for (const data of ['empty', 'quiet', 'calm', 'busy', 'loading', 'error', 'over']) {
            const page = await open(t, width, data);
            const flow = region(page, 'On the way to main');
            assert.equal(await flow.locator('.flow-figs').count(), data === 'loading' ? 0 : 1);
            assert.equal(await flow.locator('.flow[aria-busy="true"]').count(), data === 'loading' ? 1 : 0);
            if (width === 1440 && ['loading', 'empty'].includes(data))
              assert.equal(await flow.locator('.fv-plat.zero').count(), 5, 'all five platforms are empty');
            if (data === 'error') assert.match(await flow.getByRole('status').textContent(), /Last read at/);
            for (const theme of ['dark', 'light']) {
              await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
              const action = region(page, 'Loose ends').getByRole('button', { name: 'Set aside' }).first();
              const paint = await action.evaluate(el => getComputedStyle(el).backgroundColor);
              assert.equal(paint, 'rgba(0, 0, 0, 0)', `${theme} row action uses the quiet button surface`);
              if (shots)
                await page.screenshot({
                  path: join(shots, `flow-${data === 'calm' ? 'moving' : data}-${width}-${theme}.png`),
                  fullPage: data === 'busy' || width === 390,
                });
            }
          }
        }
      },
    );

    await t.test('a held block’s tag goes to its row under Needs you, which marks itself once', async t => {
      const page = await open(t, 1440, 'busy');
      const tag = page.locator('.fv-pic a.fv-tag').first();
      const id = await tag.getAttribute('data-for');
      await tag.click();
      assert.equal(new URL(page.url()).hash, '', 'the page stays: the row is reached in place');
      await page.locator(`#d-${id}.flow-here`).waitFor();
      assert.equal(await page.locator(`#d-${id}`).getAttribute('class'), 'dec flow-here');
      assert.ok(
        (await region(page, 'Needs you').locator(`#d-${id}`).count()) === 1,
        'the row is under Needs you',
      );
      // Only what waits on the reader is tagged: an agent's conflict and a refusal are held blocks with no tag.
      assert.equal(await page.locator('.fv-pic .fv-tag').count(), 1);
    });

    await t.test(
      'worst case: long handles, right-to-left and long titles, asked ahead; axe in both themes',
      async t => {
        // Full width (a reader's layout): the largest size, where tags float above their blocks with the agent's name.
        const wide = await open(t, 1440, 'worst', {
          layout: { top: ['flow'], a: ['fyi'], b: ['needs', 'loose'] },
        });
        assert.equal(await wide.locator('.fv-pic').getAttribute('data-tier'), '2');
        const tags = await wide.evaluate(() => {
          const frame = document.querySelector('.fv-pic').getBoundingClientRect();
          return [...document.querySelectorAll('.fv-pic > .fv-tag')].map(el => {
            const r = el.getBoundingClientRect();
            return {
              text: el.textContent,
              inside: r.left >= frame.left && r.right <= frame.right,
              cut: [el, ...el.querySelectorAll('span')].some(part => part.scrollWidth > part.clientWidth),
            };
          });
        });
        assert.equal(tags.length, 2, 'the two Lanes waiting on the reader carry tags');
        assert.ok(
          tags.every(tag => tag.inside),
          JSON.stringify(tags),
        );
        assert.ok(
          tags.some(tag => tag.text.includes('an-agent-name') && tag.cut),
          'a long handle is cut, not spilled',
        );
        const needs = region(wide, 'Needs you');
        assert.ok(
          (await needs.locator('h3').allTextContents()).some(text => /تحديث/.test(text)),
          'a right-to-left title',
        );
        assert.equal(await needs.locator('h3[dir="auto"]').count(), await needs.locator('h3').count());
        assert.equal(await needs.locator('details.sumdec').count(), 1, 'the request asked ahead is listed');
        const defaults = [
          [1440, await open(t, 1440, 'worst')],
          [390, await open(t, 390, 'worst')],
        ];
        for (const [width, page] of [[1440, wide], ...defaults]) {
          await page.addScriptTag({ path: axePath });
          for (const theme of ['dark', 'light']) {
            await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
            await page.evaluate(() =>
              document
                .getAnimations()
                .filter(a => a.effect?.getTiming().iterations !== Infinity)
                .forEach(a => a.finish()),
            );
            const [scroll, inner] = await page.evaluate(() => [
              document.documentElement.scrollWidth,
              innerWidth,
            ]);
            assert.ok(scroll <= inner, `no sideways scroll at ${width} ${theme}`);
            await page.evaluate(() => scrollTo(0, 0));
            const violations = await page.evaluate(async () => {
              const result = await window.axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
              });
              return result.violations
                .filter(v => v.id !== 'label-content-name-mismatch')
                .map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
            });
            assert.deepEqual(violations, [], `axe at ${width} ${theme} worst`);
            if (shots && page !== wide)
              await page.screenshot({
                path: join(shots, `flow-worst-${width}-${theme}.png`),
                fullPage: true,
              });
          }
        }
      },
    );
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});

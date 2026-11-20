// SPDX-License-Identifier: Apache-2.0
// The Flow picture on Needs me (Item 85f456c1, Lane 2) in a real browser, on the Needs me fixture
// (tests/browser/needs-me.tsx) through the real shell frame: every stop's count is the top bar's count and its blocks
// (one source, the line feed); the approved home layout (picture left, Needs you right, FYI and Loose ends below, the
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

const root = fileURLToPath(new URL('../', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_NEEDS_SHOTS || null;
const FIXTURE = 'tests/browser/needs-me.tsx';
const HOME = '/-/sample-one/tidepool';
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
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-needs-flow-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch();
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
      const contentType = file.endsWith('.js') ? 'text/javascript' : 'text/css';
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
        assert.match(await figures.getByRole('link', { name: /main Passing/ }).textContent(), /Checked/);
        assert.equal(await page.locator('header.top .line .tomain').getAttribute('title'), 'Main passing');
      }
      const phone = await open(t, 390, 'partial-empty');
      assert.match(await phone.locator('.flow-rows > li').last().textContent(), /Passing/);
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
            blocks: String(document.querySelectorAll(`.fv-pic g[data-stop="${stop}"] .fv-cube`).length),
          }));
        }, STOPS);
        for (const { stop, line, label, blocks } of counts) {
          assert.equal(label, line, `${data} ${stop}: the picture says the top bar's count`);
          assert.equal(blocks, line, `${data} ${stop}: one block per open Lane`);
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

    await t.test('the home layout: picture left, Needs you right, FYI and Loose ends below', async t => {
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
      assert.ok(fyi.y > flow.y + flow.height - 2 && Math.abs(fyi.x - flow.x) < 2, 'FYI is below the picture');
      assert.ok(loose.y > needs.y && Math.abs(loose.x - needs.x) < 2, 'Loose ends is below Needs you');
      assert.ok(Math.abs((await ratio(calm)) - 1.6) < 0.05, 'nothing waits: the picture has 1.6 : 1');
      assert.equal(await calm.locator('.fv-pic').getAttribute('data-tier'), '1');
      const busy = await open(t, 1440, 'busy');
      assert.ok(Math.abs((await ratio(busy)) - 1 / 1.1) < 0.05, 'something waits: Needs you gets 1.1 : 1');
      assert.equal(await busy.locator('.fv-pic').getAttribute('data-tier'), '0', 'the picture drops a size');
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
      for (const page of [busy, phone]) assert.equal(await idleTimers(page), 0, 'an idle page sets no timer');
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
    });

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
        await cube.locator('.fv-cube-hint').waitFor();
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
        await cube.locator('.fv-cube-hint').waitFor();
        await page.keyboard.press('Enter');
        assert.equal(new URL(page.url()).pathname, `${HOME}/lanes/${id}`);
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
          const hint = cube.locator('.fv-cube-hint');
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
            limit: 60,
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
          for (const data of ['empty', 'quiet', 'calm', 'loading', 'error', 'over']) {
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
                  fullPage: true,
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
        for (const width of [1440, 390]) {
          const page = width === 1440 ? wide : await open(t, width, 'worst');
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
            if (shots)
              await page.screenshot({
                path: join(shots, `flow-worst-${width}-${theme}.png`),
                fullPage: width === 390,
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

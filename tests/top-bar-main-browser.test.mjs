// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The real project frame on synthetic data (Item 32e8de50). The top bar's main segment shows the count and
// share without clipping, keeps its accessible name and stays idle. 390 px uses the separate phone row;
// 861 px is the tightest docked row; 1000 px covers the reported overflow; 1440 px uses the wide line.
// The project and account icon rails also keep their link names (Item dcedeead).
// Set FORGE_TOPBAR_SHOTS to a folder to save screenshots of the top bar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_TOPBAR_SHOTS || null;
const FIXTURE = 'tests/browser/top-bar-main.tsx';
const cases = [
  { land: 0, width: 390, theme: 'light' },
  { land: 1, width: 390, theme: 'dark' },
  { land: 300, width: 390, theme: 'dark' },
  { land: 0, width: 861, theme: 'dark' },
  { land: 1, width: 861, theme: 'light' },
  { land: 300, width: 861, theme: 'light' },
  { land: 300, width: 1000, theme: 'dark' },
  { land: 300, width: 1440, theme: 'light' },
];
const railLinks = {
  Project: ['Needs me', 'Lanes', 'Plan', 'Code', 'Stats', 'Settings'],
  Account: ['Projects', 'Billing', 'People and teams', 'Sign-in and devices', 'Your data', 'tidepool-ingest'],
};

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
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Top bar fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body style="margin:0"><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

async function routeFixture(page, out, html, requests) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:') return route.continue();
    if (url.hostname !== 'forge.test') {
      requests?.push(url.href);
      return route.abort();
    }
    if (url.pathname === '/top.html') return route.fulfill({ contentType: 'text/html', body: html });
    const file = join(out, url.pathname.slice(1));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const contentType = file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.woff2')
          ? 'font/woff2'
          : 'text/html';
    return route.fulfill({ contentType, body: readFileSync(file) });
  });
}

const expected = {
  0: { desk: 'main · 0 today', phone: 'main · 0' },
  1: { desk: 'main · 1 today · 100% first try', phone: 'main · 1 · 100%' },
  300: { desk: 'main · 300 today · 87% first try', phone: 'main · 300 · 87%' },
};

async function chromeGeometry(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('header.top, .shell > .line.phone, .shell > .tabs')]
      .filter(bar => bar.getClientRects().length)
      .map(bar => {
        const bounds = bar.getBoundingClientRect();
        // The rail paints separately when a resize changes its tally capacity. Its geometry is tested below.
        const children = [...bar.querySelectorAll(':not(.sr, .sr *, .marks *)')]
          .map(child => ({ child, rect: child.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 0 && rect.height > 0);
        const spilled = children.filter(
          ({ rect }) =>
            rect.left < bounds.left - 0.5 ||
            rect.right > bounds.right + 0.5 ||
            rect.top < bounds.top - 0.5 ||
            rect.bottom > bounds.bottom + 0.5,
        );
        return {
          bar: bar.className,
          top: bounds.top,
          height: bounds.height,
          spilled: spilled.map(({ child }) => child.textContent.trim() || child.tagName),
          positions: children.map(({ rect }) => [rect.x, rect.y, rect.width, rect.height]),
        };
      }),
  );
}

test('the top bar main segment and side rails stay accessible at responsive widths', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-top-bar-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch(launchOptions);
  try {
    for (const { land, width, theme } of cases)
      await t.test(`${land} landings at ${width} px, ${theme}`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 800 } });
        await context.addInitScript(() => {
          // Any interval, or a timeout of a second or more still pending, would be the page waking itself up.
          window.intervals = 0;
          window.pending = new Set();
          const original = window.setInterval;
          window.setInterval = (...args) => {
            window.intervals++;
            return original(...args);
          };
          const later = window.setTimeout;
          const clear = window.clearTimeout;
          window.setTimeout = (run, ms, ...rest) => {
            const id = later(
              (...a) => {
                window.pending.delete(id);
                return typeof run === 'function' ? run(...a) : undefined;
              },
              ms,
              ...rest,
            );
            if (ms >= 1000) window.pending.add(id);
            return id;
          };
          window.clearTimeout = id => {
            window.pending.delete(id);
            return clear(id);
          };
        });
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date('2026-11-10T12:00:00Z'));
        const errors = [];
        const requests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => message.type() === 'error' && errors.push(message.text()));
        await routeFixture(page, out, html, requests);
        try {
          await page.goto(`https://forge.test/top.html?land=${land}&theme=${theme}`);
          const phone = width < 861;
          const segment = page.locator(phone ? '.line.phone .tomain' : 'header.top .line .tomain');
          await segment.waitFor({ timeout: 10_000 });
          const seen = await segment.evaluate(link => {
            const cell = link.getBoundingClientRect();
            const parts = [...link.querySelectorAll('.g')].map(node => node.getBoundingClientRect());
            return {
              text: [...link.querySelectorAll('.g')]
                .map(node => node.innerText)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim(),
              visible: getComputedStyle(link).display !== 'none' && cell.width > 0,
              inside: parts.every(
                r =>
                  r.left >= cell.left - 0.5 &&
                  r.right <= cell.right + 0.5 &&
                  r.top >= cell.top - 0.5 &&
                  r.bottom <= cell.bottom + 0.5,
              ),
              clipped: [...link.querySelectorAll('.g')].some(node => node.scrollWidth > node.clientWidth + 1),
              rows: new Set(parts.map(r => Math.round(r.top))).size,
              line: Math.round(link.parentElement.getBoundingClientRect().width),
              room: Math.round(cell.width - (Math.max(...parts.map(r => r.right)) - cell.left)),
            };
          });
          t.diagnostic(JSON.stringify({ land, width, theme, ...seen }));
          const want = expected[land][width <= 861 ? 'phone' : 'desk'];
          assert.ok(seen.visible, 'the segment is on screen');
          assert.equal(seen.text, want);
          assert.ok(seen.inside, `every word inside its cell: ${JSON.stringify(seen)}`);
          assert.ok(!seen.clipped, 'nothing cut off');
          assert.ok(seen.rows <= (phone ? 1 : 2), `at most ${phone ? 'one row' : 'two rows'}: ${seen.rows}`);
          // The stops keep their words: "Ready to land" is not cut short to make room (861 px is the tightest).
          const cut = await page.evaluate(
            selector =>
              [...document.querySelectorAll(`${selector} [data-stop] .lbl`)]
                .filter(node => node.scrollWidth > node.clientWidth)
                .map(node => node.textContent),
            phone ? '.line.phone' : 'header.top .line',
          );
          assert.deepEqual(cut, [], 'no stop word ellipsized');
          const name = await segment.ariaSnapshot();
          const named = page.getByRole('link', { name: new RegExp('^' + RegExp.escape(want)) });
          assert.equal(await segment.and(named).count(), 1, name);
          assert.match(name, /today.*\(UTC day\)/);
          const sideways = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
          assert.equal(sideways, false, 'no sideways scroll');
          await page.addScriptTag({ path: axePath });
          // The top bar and the phone's line row: the rail and page belong to their own tests.
          const axe = await page.evaluate(
            async phone =>
              (
                await window.axe.run(
                  { include: [phone ? '.line.phone' : 'header.top'] },
                  {
                    runOnly: {
                      type: 'tag',
                      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
                    },
                  },
                )
              ).violations,
            phone,
          );
          assert.deepEqual(
            axe.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`),
            [],
            'axe clean',
          );
          assert.equal(
            await page.evaluate(() => window.intervals + window.pending.size),
            0,
            'no repeating or long timer',
          );
          assert.deepEqual(requests, [], 'no request leaves the page');
          assert.deepEqual(errors, [], 'no page errors');
          if (shots)
            await page.screenshot({
              path: join(shots, `top-bar-${land}-${width}-${theme}.png`),
              clip: { x: 0, y: 0, width, height: phone ? 160 : 48 },
            });
        } finally {
          await context.close();
        }
      });
    for (const type of [chromium, webkit]) {
      if (type !== chromium && !existsSync(type.executablePath())) {
        t.diagnostic(`Playwright ${type.name()} is absent; the hosted cache supplies Chromium.`);
        continue;
      }
      await t.test(`the bar contains landing stats and stays pinned in ${type.name()}`, async () => {
        const engine = type === chromium ? browser : await type.launch();
        const page = await engine.newPage({ viewport: { width: 1000, height: 800 } });
        await page.clock.setFixedTime(new Date('2026-11-10T12:00:00Z'));
        try {
          await routeFixture(page, out, html);
          const widths = [320, 360, 768, 860, 861, 900, 1000, 1100, 1240, 1241, 1280, 1440, 1600];
          for (const [land, text] of [
            [101, '101'],
            [1284, '1,284'],
          ]) {
            await page.goto(`https://forge.test/top.html?land=${land}`);
            await page.locator('header.top .tomain').waitFor();
            await page.evaluate(() => document.fonts.ready.then(() => null));
            for (const width of widths) {
              await page.setViewportSize({ width, height: 800 });
              await page.evaluate(async () => {
                window.scrollTo(0, 0);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              });
              const before = await chromeGeometry(page);
              const context = `${text} landings at ${width} px`;
              assert.deepEqual(
                before.flatMap(bar => bar.spilled),
                [],
                context,
              );
              assert.equal(before[0].height, 48, context);
              if (width <= 860) assert.equal(before[1].height, 46, context);
              const segment = page.locator(width <= 860 ? '.line.phone .tomain' : 'header.top .tomain');
              assert.match(await segment.ariaSnapshot(), /today.*first try/, context);
              const shown = await segment.locator('.g:visible').allInnerTexts();
              assert.ok(shown[0]?.includes(text), context);
              if (width === 1000)
                assert.equal(shown.join(' ').replace(/\s+/g, ' '), `main · ${text} today · 28% first try`);
              await page.evaluate(() => window.scrollTo(0, 650));
              assert.ok(await page.evaluate(() => window.scrollY > 0), context);
              const after = await chromeGeometry(page);
              const stickyOffset = before[0].height + (width <= 860 ? before[1].height : 0);
              assert.equal((await page.locator('.bulk').boundingBox()).y, stickyOffset, context);
              assert.deepEqual(
                after.map(({ positions, ...bar }) => bar),
                before.map(({ positions, ...bar }) => bar),
                context,
              );
              for (const [index, { positions }] of after.entries()) {
                const previous = before[index].positions;
                assert.equal(positions.length, previous.length, context);
                assert.ok(
                  positions.every((rect, child) =>
                    rect.every((value, dimension) => Math.abs(value - previous[child][dimension]) < 0.25),
                  ),
                  `bar children stay pinned: ${context}`,
                );
              }
            }
          }

          await page.setViewportSize({ width: 861, height: 800 });
          for (const [projectName, text] of [
            ['tidepool-ingest', 'main · 101 · 28%'],
            ['A long shared project title that takes up the space in the picker', 'main · 101'],
          ]) {
            await page.goto(`https://forge.test/top.html?land=101&name=${encodeURIComponent(projectName)}`);
            const segment = page.locator('header.top .tomain');
            await segment.waitFor();
            await page.evaluate(() => document.fonts.ready.then(() => null));
            const visible = await segment.locator('.g:visible').allInnerTexts();
            assert.equal(visible.join(' ').replace(/\s+/g, ' ').trim(), text);
            const name = await segment.ariaSnapshot();
            assert.ok(name.includes(text), name);
            assert.match(name, /101 landings today, 28% first try/);
            assert.deepEqual(
              (await chromeGeometry(page)).flatMap(bar => bar.spilled),
              [],
            );
          }
          for (const width of [390, 1000]) {
            await page.setViewportSize({ width, height: 800 });
            await page.goto('https://forge.test/top.html?unloaded');
            await page.getByRole('link', { name: /^main *,? not loaded yet$/ }).waitFor();
          }
        } finally {
          await page.close();
          if (engine !== browser) await engine.close();
        }
      });
    }
    await t.test('50 Lanes keep held marks while crowded stops fold, at 390 and 1440 px', async t => {
      for (const width of [390, 1440]) {
        for (const theme of ['dark', 'light']) {
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          await page.clock.setFixedTime(new Date('2026-11-10T12:00:00Z'));
          try {
            await routeFixture(page, out, html);
            await page.goto(`https://forge.test/top.html?lanes=50&theme=${theme}`);
            const line = page.locator('.line:visible');
            await line.locator('.m[data-hold]').first().waitFor();
            const marks = await line.evaluate(bar => {
              const stops = [...bar.querySelectorAll('[data-stop]')];
              const rects = [...bar.querySelectorAll('.m')].map(mark => {
                const state = mark.dataset.stage;
                const stop = stops.find(anchor => anchor.dataset.stop === state).getBoundingClientRect();
                const rect = mark.getBoundingClientRect();
                return {
                  width: rect.width,
                  held: mark.hasAttribute('data-hold'),
                  withinStop:
                    rect.left >= stop.left && rect.right <= stop.right && rect.bottom <= stop.bottom,
                };
              });
              return {
                whole: rects.filter(mark => mark.width === 8).length,
                tally: rects.filter(mark => mark.width === 3).length,
                held: rects.filter(mark => mark.held && mark.width === 8).length,
                clipped: rects.filter(mark => !mark.withinStop).length,
              };
            });
            t.diagnostic(JSON.stringify({ width, theme, ...marks }));
            assert.equal(marks.held, 5);
            assert.equal(marks.clipped, 0);
            assert.deepEqual((await line.locator('.n').allTextContents()).map(Number), [13, 13, 12, 11]);
            assert.match(await line.locator('[data-stop="checking"]').ariaSnapshot(), /11 Lanes, 1 held/);
            if (width === 390) assert.ok(marks.tally > 0);
            else assert.equal(marks.whole, 50);
            assert.deepEqual(
              (await chromeGeometry(page)).flatMap(bar => bar.spilled),
              [],
            );
            if (shots)
              await page.screenshot({
                path: join(shots, `top-bar-50-lanes-${width}-${theme}.png`),
                clip: { x: 0, y: 0, width, height: width === 390 ? 94 : 48 },
              });
          } finally {
            await page.close();
          }
        }
      }
    });
    await t.test(
      'the brand spot always reads Forge beside the mark; a conflict is announced, never drawn in the name (Item 8f94e5c3)',
      async () => {
        const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
        try {
          await routeFixture(page, out, html);
          await page.goto('https://forge.test/top.html');
          const brand = page.locator('.brand').first();
          await brand.waitFor();
          assert.equal((await brand.innerText()).trim(), 'Forge');
          await page.evaluate(() =>
            window.dispatchEvent(
              new CustomEvent('deliver-line', {
                detail: previous => ({
                  ...previous,
                  lanes: [
                    {
                      laneId: 'c0000000-0000-4000-8000-000000000001',
                      stage: 'saved',
                      held: true,
                      fix: true,
                      overlap: true,
                      changedAt: 1,
                    },
                  ],
                }),
              }),
            ),
          );
          // The real incident: a held Lane with a conflict put "Conflict" in the name's place.
          await page
            .locator('[role="status"]', { hasText: 'Conflict' })
            .first()
            .waitFor({ state: 'attached' });
          assert.equal((await brand.innerText()).trim(), 'Forge');
          assert.equal(await brand.locator('.st').count(), 0, 'no state pill in the brand spot');
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      '29 updates travel in one delivery, and reduced motion draws the same final stops instantly',
      async t => {
        for (const reducedMotion of ['no-preference', 'reduce']) {
          const page = await browser.newPage({ viewport: { width: 1760, height: 800 }, reducedMotion });
          try {
            await page.clock.setFixedTime(new Date('2026-11-10T12:00:00Z'));
            await routeFixture(page, out, html);
            await page.goto('https://forge.test/top.html?lanes=50');
            const line = page.locator('.line:visible');
            await line.locator('.m').first().waitFor();
            const result = await line.evaluate(async (bar, at) => {
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const states = { editing: 'saved', saved: 'queued', queued: 'checking' };
              const before = new Map([...bar.querySelectorAll('.m')].map(node => [node.dataset.lane, node]));
              for (const mark of before.values()) mark.getBoundingClientRect();
              const changed = new Set();
              const longFrames = [];
              const observer = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
                ? new PerformanceObserver(list =>
                    longFrames.push(...list.getEntries().map(entry => entry.duration)),
                  )
                : null;
              observer?.observe({ type: 'long-animation-frame' });
              const started = performance.now();
              const drawn = new Promise(resolve => {
                const observer = new MutationObserver(() => {
                  observer.disconnect();
                  resolve(performance.now() - started);
                });
                observer.observe(bar.querySelector('.marks'), {
                  subtree: true,
                  attributeFilter: ['data-stage'],
                });
              });
              window.dispatchEvent(
                new CustomEvent('deliver-line', {
                  detail: previous => ({
                    ...previous,
                    lanes: previous.lanes.map((lane, i) => {
                      if ((i >= 10 && i < 13) || (i >= 22 && i < 26) || i >= 36) return lane;
                      changed.add(lane.laneId);
                      return { ...lane, stage: states[lane.stage], changedAt: at };
                    }),
                  }),
                }),
              );
              const updateMs = await drawn;
              const moved = [...bar.querySelectorAll('.m')].filter(mark => changed.has(mark.dataset.lane));
              await new Promise(resolve => requestAnimationFrame(resolve));
              const animations = moved.flatMap(mark => mark.getAnimations());
              const timings = animations.map(animation => animation.effect.getTiming());
              await Promise.all(animations.map(animation => animation.finished));
              const elapsedMs = performance.now() - started;
              if (observer) longFrames.push(...observer.takeRecords().map(entry => entry.duration));
              observer?.disconnect();
              return {
                updateMs,
                moved: moved.length,
                retained: moved.filter(mark => before.get(mark.dataset.lane) === mark).length,
                animations: animations.length,
                delays: [...new Set(timings.map(timing => timing.delay))].sort((a, b) => a - b),
                elapsedMs,
                settleMs: Math.max(0, ...timings.map(timing => timing.delay + timing.duration)),
                longFrames: observer ? longFrames : null,
              };
            }, Date.parse('2026-11-10T12:00:00Z'));
            t.diagnostic(JSON.stringify({ reducedMotion, ...result }));
            assert.equal(result.moved, 29);
            assert.equal(result.retained, 29, 'the same marks travel between stops');
            if (reducedMotion === 'reduce') assert.equal(result.animations, 0);
            else {
              assert.equal(result.animations, 29);
              assert.deepEqual(result.delays, [0, 40, 80, 120, 160, 200, 240]);
              assert.equal(result.settleMs, 840);
            }
          } finally {
            await page.close();
          }
        }
      },
    );
    await t.test(
      'only an explicit landing rings main, and hidden updates return without replay',
      async () => {
        const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
        try {
          await page.clock.setFixedTime(new Date('2026-11-10T12:00:00Z'));
          await routeFixture(page, out, html);
          await page.goto('https://forge.test/top.html?lanes=50&exits');
          const line = page.locator('.line:visible');
          await line.locator('.m').first().waitFor();
          const exits = async kind =>
            page.evaluate(
              ({ kind, at }) => {
                window.dispatchEvent(
                  new CustomEvent('deliver-line', {
                    detail: previous => ({
                      ...previous,
                      lanes: previous.lanes.slice(1),
                      exit: kind ? { kind, laneId: previous.lanes[0].laneId, at } : null,
                    }),
                  }),
                );
              },
              { kind, at: Date.parse('2026-11-10T12:00:00Z') },
            );
          const visibility = async hidden =>
            page.evaluate(hidden => {
              Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
              document.dispatchEvent(new Event('visibilitychange'));
            }, hidden);

          await exits(null);
          await line.locator('.m[data-lane$="000000000000"]').waitFor({ state: 'detached' });
          assert.equal(
            await line.locator('[data-exit], .line-ring').count(),
            0,
            'a missing Lane has no guessed exit',
          );
          await exits('set-aside');
          const aside = line.locator('[data-exit="set-aside"]');
          await aside.waitFor({ state: 'attached' });
          assert.equal(await aside.getAttribute('data-st'), 'stale', 'a ready Lane can be set aside');
          assert.equal(await line.locator('.line-ring').count(), 0);
          await exits('landed');
          await line.locator('[data-exit="landed"]').waitFor({ state: 'attached' });
          assert.equal(await line.locator('.line-ring').count(), 1);
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await line.locator('.line-ring').waitFor({ state: 'detached' });
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          assert.equal(
            await line.locator('[data-exit], .line-ring').count(),
            0,
            'enabling motion never replays an exit',
          );
          await visibility(true);
          await line.locator('.marks').waitFor({ state: 'hidden' });
          await exits('landed');
          await visibility(false);
          await line.locator('.marks').waitFor();
          assert.equal(
            await line.locator('[data-exit], .line-ring').count(),
            0,
            'return draws the latest snapshot once',
          );
        } finally {
          await page.close();
        }
      },
    );
    for (const width of [861, 1000, 1239])
      await t.test(`rail links have accessible names at ${width} px`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        await page.clock.setFixedTime(new Date('2026-11-10T12:00:00Z'));
        try {
          await routeFixture(page, out, html);
          const unnamed = [];
          const missing = [];
          for (const [frame, names] of Object.entries(railLinks)) {
            await page.goto(`https://forge.test/top.html?frame=${frame.toLowerCase()}`);
            const rail = page
              .locator('nav.rail')
              .and(page.getByRole('navigation', { name: frame, exact: true }));
            await rail.waitFor({ timeout: 10_000 });
            await page.addScriptTag({ path: axePath });
            const axe = await rail.evaluate(async rail => {
              const { violations } = await window.axe.run(rail, { runOnly: ['link-name'] });
              return violations.flatMap(rule => rule.nodes.map(node => node.target.join(' ')));
            });
            unnamed.push(...axe.map(link => `${frame}: ${link}`));
            for (const name of names)
              if (!(await rail.getByRole('link', { name, exact: true }).isVisible()))
                missing.push(`${frame}: ${name}`);
          }
          assert.deepEqual(unnamed, [], 'rail links with no accessible name');
          assert.deepEqual(missing, [], 'expected named rail links are visible');
        } finally {
          await page.close();
        }
      });
  } finally {
    await browser.close();
  }
});

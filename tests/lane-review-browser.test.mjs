// SPDX-License-Identifier: Apache-2.0
// The Lane review screen in a real browser (Items 52235fbf, 4bc460aa, a1e3d771, c2388099), on synthetic data through
// its real components (tests/browser/lane-review.tsx). Only overlaps and protected paths need eyes, as the Facts say;
// every row shows the +/- counts its save recorded with no read; file order is one press away, a folded file reads
// nothing and an opened one makes only its own download calls, the labelled Read box reconciles with the count and
// is gone once the Lane has landed or is set aside, a combined file shows where each line came from, and axe is clean
// with no sideways scroll at desk and phone width in both themes. Set FORGE_LANE_SHOTS to a folder to also save the screenshots.
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
const shots = process.env.FORGE_LANE_SHOTS || null;
const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

/** Build the fixture module as a page script; the page itself is written here (an HTML input outside web/ cannot be
 * emitted), linking every stylesheet the build produced. */
async function buildFixture(out) {
  const { build } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    build: {
      outDir: out,
      emptyOutDir: true,
      rolldownOptions: {
        input: { fixture: join(root, 'tests/browser/lane-review.tsx') },
      },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  // The config adds its own pages' entries; the fixture's is the one built from its module.
  const entry = output.find(
    item => item.isEntry && item.facadeModuleId?.endsWith('tests/browser/lane-review.tsx'),
  );
  // Only the stylesheets the fixture's own chunks import: the other pages' (legacy) styles must not leak in.
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
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Lane review fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

test('the Lane review screen: order, lazy bodies, ticks, line origin, axe and widths in both themes', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-lane-review-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch(launchOptions);
  async function open(t, viewport, query, path = '/lane-review.html') {
    const context = await browser.newContext({ viewport, locale: 'en-US' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    page.on('requestfailed', request => errors.push(`failed ${request.url().slice(0, 80)}`));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname === path) return route.fulfill({ contentType: 'text/html', body: html });
      const file = join(out, url.pathname.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto(`https://forge.test${path}?${query}`);
    if (path === '/lane-review.html')
      await page
        .locator('section[aria-label="The change"]')
        .waitFor({ timeout: 10_000 })
        .catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, [], 'no page errors');
    });
    return page;
  }
  const calls = page => page.evaluate(() => window.__calls?.length ?? 0);
  const bands = page =>
    page
      .locator('section[aria-label="The change"] .band')
      .evaluateAll(nodes =>
        nodes.map(node => [
          node.querySelector('span')?.textContent,
          Number(node.querySelector('.cnt')?.textContent),
        ]),
      );
  const shot = async (page, name) => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  };

  try {
    await t.test(
      'the same live Lane and board reads show the failure to readers and let an authorized writer dismiss it',
      async t => {
        const board = '/-/sample-owner/tide-pool/lanes';
        const laneId = '7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
        for (const [path, loaded, names] of [
          [
            board,
            'On the way to main',
            // Needs you is the frame's own Needs me read (same query, same args: one subscription in the app, e317b6ea).
            [
              'projectHostedLiveLanes:list',
              'projectHostedQueueView:read',
              'projectNeedsMe:read',
              'projectNowOverlaps:now',
              // The strip's Item counts: the stored counter Needs me and Plan read (d3357f40).
              'projectPlanCounts:read',
            ],
          ],
          [`${board}/${laneId}`, 'Changed files', ['projectLaneReview:read']],
        ]) {
          const subscriptions = page =>
            page.evaluate(() => [...window.__subscriptions].sort((a, b) => a.name.localeCompare(b.name)));
          const healthy = await open(t, PHONE, 'routes&s=save-healthy', path);
          await healthy.getByRole('heading', { name: loaded }).waitFor();
          assert.equal(await healthy.getByText('Save failed', { exact: true }).count(), 0);
          assert.equal(await healthy.getByRole('button', { name: /^Dismiss save failure/ }).count(), 0);
          const healthyReads = await subscriptions(healthy);
          assert.deepEqual(
            healthyReads.map(read => read.name),
            names,
          );
          assert.equal(await calls(healthy), 0);

          const reader = await open(t, PHONE, 'routes&s=save-reader', path);
          const readerNotice = reader.getByRole('status').filter({ hasText: 'Save failed' });
          await readerNotice.waitFor();
          assert.match(await readerNotice.textContent(), /WORK_STALE/);
          assert.equal(await reader.getByRole('button', { name: /^Dismiss save failure/ }).count(), 0);
          assert.deepEqual(await subscriptions(reader), healthyReads);
          assert.equal(await calls(reader), 0);

          const failed = await open(t, PHONE, 'routes&s=save-failed', path);
          await failed.getByRole('heading', { name: loaded }).waitFor();
          const notice = failed.getByRole('status').filter({ hasText: 'Save failed' });
          const dismiss = failed.getByRole('button', { name: /^Dismiss save failure/ });
          await notice.waitFor();
          assert.match(await notice.textContent(), /WORK_STALE/);
          assert.deepEqual(await subscriptions(failed), healthyReads);
          assert.equal(await calls(failed), 0);
          if (path === board) {
            const link = notice.getByRole('link', { name: 'Stream parser: handle split UTF-8 · 7a2b4c6d' });
            assert.equal(await link.getAttribute('href'), `${board}/${laneId}`);
            await link.focus();
            await failed.keyboard.press('Tab');
            assert.equal(await dismiss.evaluate(button => document.activeElement === button), true);
          } else {
            await dismiss.focus();
          }
          const fits = await dismiss.evaluate(button => {
            const rect = button.getBoundingClientRect();
            return (
              rect.left >= 0 && rect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth
            );
          });
          assert.equal(fits, true, 'the notice and its control fit at phone width');
          await failed.keyboard.press('Enter');
          await notice.waitFor({ state: 'detached' });
          assert.equal(await dismiss.count(), 0);
          assert.equal(await failed.evaluate(() => document.activeElement.id), 'main');
          assert.deepEqual(await failed.evaluate(() => [window.__calls, window.__dismissArgs]), [
            ['projectHostedSaves:dismissFailure'],
            {
              projectId: 'p1',
              laneId,
              operationId: '7c6b5a49-3827-4160-9e8d-1a2b3c4d5e6f',
              attemptId: '5a78d310-8a93-4e4b-a236-f6b76aea2057',
            },
          ]);
          assert.deepEqual(await subscriptions(failed), healthyReads);
        }
      },
    );

    await t.test('a refused dismissal keeps the save failure and keyboard focus', async t => {
      const path = '/-/sample-owner/tide-pool/lanes/7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
      const page = await open(t, PHONE, 'routes&s=save-denied', path);
      const dismiss = page.getByRole('button', { name: 'Dismiss save failure' });
      await dismiss.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('alert').filter({ hasText: 'Could not dismiss this save failure.' }).waitFor();
      assert.equal(await page.getByText('Save failed', { exact: true }).isVisible(), true);
      assert.equal(await dismiss.evaluate(button => document.activeElement === button), true);
      assert.equal(await calls(page), 1);
    });

    await t.test('954afe8c: Lanes and Who is touching what open the same Item heading', async t => {
      const lanes = '/-/sample-owner/tide-pool/lanes';
      const title = 'Stream parser: handle split UTF-8';
      const itemLabel = `${title} · 9e8d7c6b`;
      const page = await open(t, DESK, 'routes', lanes);
      const fromLanes = page.getByRole('link', { name: `${title}, Lane 7a2b4c6d`, exact: true });
      const heading = page.locator('.head .sit');
      await fromLanes.click();
      await page.getByRole('link', { name: `Item: ${itemLabel}`, exact: true }).waitFor();
      const openedFromLanes = await page.evaluate(() => location.pathname);
      const headingFromLanes = await heading.textContent();
      assert.match(headingFromLanes, new RegExp(itemLabel));

      await page.goBack();
      await fromLanes.waitFor();
      await page.getByRole('link', { name: 'Who is touching what', exact: true }).click();
      await page.locator('.lanes-files').getByRole('link', { name: title, exact: true }).click();
      await page.getByRole('link', { name: `Item: ${itemLabel}`, exact: true }).waitFor();
      assert.equal(await page.evaluate(() => location.pathname), openedFromLanes);
      assert.equal(await heading.textContent(), headingFromLanes);
    });

    await t.test('the Lane strip opens the merged Thread without reading it on Changes', async t => {
      const lane = '/-/sample-owner/tide-pool/lanes/7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
      for (const viewport of [DESK, PHONE]) {
        const page = await open(t, viewport, 'routes', lane);
        const strip = page.getByRole('navigation', { name: 'Lane sections' });
        await strip.getByRole('link', { name: 'Changes' }).waitFor();
        assert.equal(
          await page.evaluate(() => window.__watches.includes('projectDiscussionThread:read')),
          false,
        );
        await strip.getByRole('link', { name: 'Thread' }).click();
        const section = page.getByRole('region', { name: 'Thread', exact: true });
        await section.getByRole('button', { name: 'Old client' }).waitFor();
        assert.match(
          await section.locator('article').first().textContent(),
          /Which client should land first/,
        );
        assert.match(await section.locator('article').last().textContent(), /Legacy board note/);
        assert.equal(await page.evaluate(() => location.pathname), lane + '/thread');
        assert.equal(await page.getByRole('region', { name: 'The change' }).count(), 0);
        await page.addScriptTag({ path: axePath });
        for (const theme of ['dark', 'light']) {
          await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
          const [fits, violations] = await page.evaluate(async () => [
            document.documentElement.scrollWidth <= innerWidth,
            (
              await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })
            ).violations.map(v => v.id),
          ]);
          assert.equal(fits, true);
          assert.deepEqual(violations, []);
          await shot(page, `lane-thread-${viewport.width}-${theme}`);
        }
        await strip.getByRole('link', { name: 'Changes' }).click();
        await page.getByRole('region', { name: 'The change' }).waitFor();
      }
    });

    await t.test(
      '954afe8c: unavailable titles use the short Item id, and recorded titles are retained',
      async t => {
        for (const [scenario, label] of [
          ['unavailable', '9e8d7c6b · title unavailable'],
          ['legacy-id', '9e8d7c6b · title unavailable'],
          ['uuid-title', '2a3f12de-8371-4310-a004-f9cae1ef291c · 9e8d7c6b'],
        ]) {
          const path = '/-/sample-owner/tide-pool/lanes/7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
          const page = await open(t, DESK, `routes&s=${scenario}`, path);
          const item = page.getByRole('link', { name: `Item: ${label}`, exact: true });
          assert.equal(
            await item.getAttribute('href'),
            '/-/sample-owner/tide-pool/plan/9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a',
          );
          assert.equal(await page.locator('.head .sit b').textContent(), label);
        }
      },
    );

    await t.test(
      'grouped by what needs eyes, with reasons; file order one press away; counts reconcile',
      async t => {
        const page = await open(t, DESK, 's=review');
        assert.deepEqual(await bands(page), [
          ['Needs your eyes', 2],
          ['Code', 12],
          ['Tests', 1],
          ['Low risk', 2],
        ]);
        const first = page.locator('.lr-file').first();
        assert.match(await first.locator('.path').textContent(), /src\/parser\/stream-parser\.ts/);
        assert.match(await first.locator('.why').textContent(), /same lines as sample-two\/salt-wren, 22-24/);
        assert.match(await page.locator('.lr-file').nth(1).locator('.why').textContent(), /a protected path/);
        // c2388099: the eyes group is exactly what Facts name, an overlap file and a protected-path match.
        const fact = name =>
          page.locator('dt', { hasText: name }).locator('xpath=following-sibling::dd[1]').textContent();
        assert.match(await fact('Overlaps'), /same lines in 1 file/);
        assert.match(await fact('Protected paths'), /^1 file matches/);
        assert.equal(
          await page.locator('.band', { hasText: 'Needs your eyes' }).locator('.hint').textContent(),
          'overlaps and protected paths',
        );
        // 8 drawn in a band, the rest one press away; the band's count is the whole group.
        assert.equal(await page.locator('.lr-more').first().textContent(), 'Show 4 more');
        await page.locator('.lr-more').first().click();
        assert.equal(await page.locator('.lr-file').count(), 17);
        // Friction e2f436b6: held, but Needs me has not said it waits on this reader, so never "Held for you".
        assert.match(await page.locator('.head .sit').textContent(), /Held\. 2 of 17 files need your eyes/);
        // Every row with recorded counts shows them folded, with no read; an older save's row shows none.
        const row = path => page.locator('.lr-file', { hasText: path });
        assert.equal(await row('src/parser/stream-parser.ts').locator('.fstat').textContent(), '+3 −2');
        assert.equal(await row('src/generated/tables.ts').locator('.fstat').textContent(), '+1,204 −380');
        assert.equal(await row('src/parser/legacy-decoder.ts').locator('.fstat').textContent(), '−1');
        assert.equal(await row('docs/parser.md').locator('.fstat').count(), 0);
        assert.equal(await page.locator('.lr-file .fstat').count(), 15);
        // "code changed" is dropped: the row's counts say it; a new or removed file keeps its word.
        assert.equal(await row('adapter-number-1-with').locator('.why').count(), 0);
        assert.equal(await row('src/parser/utf8-carry.ts').locator('.why').textContent(), 'new file');
        // The box carries its word; what it means is its hover hint.
        const box = row('src/parser/stream-parser.ts').locator('.tick');
        assert.equal(await box.textContent(), 'Read');
        assert.equal(
          await box.getAttribute('title'),
          'Only in this browser; comes back unread if the file changes.',
        );
        assert.equal(await calls(page), 0, 'counts need no read');
        await page.getByRole('button', { name: 'Files', exact: true }).click();
        const paths = await page.locator('.lr-file .path').allTextContents();
        assert.deepEqual(paths, [...paths].sort());
        assert.equal(await calls(page), 0, 'nothing read for folded files');
      },
    );

    await t.test('an opened file reads only its own bytes; large files are named, not fetched', async t => {
      const page = await open(t, DESK, 's=review');
      await page.locator('.lr-file').first().locator('summary').click();
      await page.locator('.lr-file').first().locator('.code .l.add').first().waitFor();
      assert.deepEqual(await page.evaluate(() => window.__calls), [
        'projectObjectDownloads:describe',
        'projectObjectDownloads:describe',
      ]);
      await page.locator('.lr-more').first().click();
      const large = page.locator('.lr-file', { hasText: 'src/generated/tables.ts' });
      await large.locator('summary').click();
      await large.getByText(/Too long to draw here/).waitFor();
      assert.equal(await calls(page), 3, 'one describe names the size; no bytes for a file over the limit');
      // Reading ticks the file; the count beside the list reconciles.
      await page.getByRole('button', { name: 'Read src/parser/stream-parser.ts' }).click();
      assert.match(
        await page.locator('section[aria-label="The change"] .ph .hint').textContent(),
        /^1 of 17 files read$/,
      );
      assert.match(
        await page.locator('.cmd').first().textContent(),
        /^nforge agent \. sync '\{"laneId":.*"predecessor":\{/,
      );
      // An older save's row counts the body it opened.
      const docs = page.locator('.lr-file', { hasText: 'docs/parser.md' });
      await docs.locator('summary').click();
      await docs.locator('.code .l.add').first().waitFor();
      assert.equal(await docs.locator('.fstat').textContent(), '+2');
      await shot(page, 'lane-review-open-1440-dark');
    });

    await t.test('once landed or set aside, read marks and the needs-eyes order are gone', async t => {
      for (const s of ['landed', 'abandoned']) {
        const page = await open(t, DESK, `s=${s}`);
        assert.deepEqual(await bands(page), [['All files', 17]], s);
        await page.locator('.lr-more').first().click();
        assert.equal(await page.locator('.lr-file .tick').count(), 0, `${s}: no Read box`);
        assert.equal(await page.getByRole('button', { name: 'Needs eyes first' }).count(), 0, s);
        assert.equal(await page.locator('section[aria-label="The change"] .ph .hint').count(), 0, s);
        assert.equal(await page.locator('.lr-file .fstat').count(), 15, `${s}: counts stay`);
        await shot(page, `lane-review-${s}-files-1440-dark`);
      }
    });

    await t.test('a combined file says where each line came from, and that it is provisional', async t => {
      const page = await open(t, DESK, 's=combined');
      await page.getByText('Provisional').waitFor();
      await page.locator('.lr-more').first().click();
      const file = page.locator('.lr-file', { hasText: 'src/parser/stream-parser.ts' });
      await file.locator('summary').click();
      await file.getByRole('button', { name: 'Where lines came from' }).click();
      await file.locator('.tally').waitFor();
      assert.equal(
        (await file.locator('.tally').textContent()).replace(/\s+/g, ' '),
        '2 lines from sample-two/salt-wren1 from this Lane38 from main1 of sample-two/salt-wren’s left out',
      );
      assert.equal(
        await file.locator('.code.by .l.gone').count(),
        3,
        'two main lines replaced, one left out',
      );
      await shot(page, 'lane-review-origin-1440-dark');
    });

    await t.test('e1633718: a parked Lane says who it waits on, for how long, and why', async t => {
      const page = await open(t, DESK, 's=parked');
      assert.equal(
        await page.getByText(/^Parked for @sample-two/).textContent(),
        'Parked for @sample-two (1 h 35 min): Waits for the bench window to end before it lands.',
      );
    });

    await t.test('the Lane sidebar stays pinned below the project bar', async t => {
      const page = await open(t, { width: 1000, height: 540 }, 's=review&frame');
      const change = page.getByRole('region', { name: 'The change' });
      await change.evaluate(pane => (pane.style.minHeight = '1800px'));
      const side = page.getByRole('region', { name: 'About this Lane' });
      const bar = page.locator('header.top');
      for (const distance of [450, 650]) {
        await page.evaluate(y => window.scrollTo(0, y), distance);
        assert.equal(await page.evaluate(() => window.scrollY), distance);
        const bounds = await bar.boundingBox();
        assert.equal((await side.boundingBox()).y, bounds.y + bounds.height);
      }
    });

    await t.test('axe and widths: both themes, desk and phone', async t => {
      for (const viewport of [DESK, PHONE])
        for (const s of ['review', 'combined', 'parked']) {
          const page = await open(t, viewport, `s=${s}`);
          await page.locator('.lr-file').first().locator('summary').click();
          await page.locator('.lr-file').first().locator('.code').first().waitFor();
          await page.addScriptTag({ path: axePath });
          for (const theme of ['dark', 'light']) {
            await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
            const [scroll, inner] = await page.evaluate(() => [
              document.documentElement.scrollWidth,
              innerWidth,
            ]);
            assert.ok(
              scroll <= inner,
              `no sideways scroll at ${viewport.width} ${s} ${theme}: ${scroll} > ${inner}`,
            );
            const violations = await page.evaluate(async () => {
              const result = await window.axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
              });
              return result.violations.map(
                v =>
                  `${v.id}: ${v.nodes.map(n => `${n.target.join(' ')} ${JSON.stringify(n.any[0]?.data ?? '')}`).join(', ')}`,
              );
            });
            assert.deepEqual(violations, [], `axe at ${viewport.width} ${s} ${theme}`);
            await shot(page, `lane-review-${s}-${viewport.width}-${theme}`);
          }
        }
    });

    await t.test('a landed Lane names its time to main and each stop, at both widths and themes', async t => {
      for (const viewport of [DESK, PHONE]) {
        const page = await open(t, viewport, 's=landed');
        // Theme switches below; reduced motion makes colours final at once, so axe never reads a colour mid-transition.
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const row = page.locator('dt', { hasText: 'Time to main' }).locator('xpath=following-sibling::dd[1]');
        assert.match(
          await row.textContent(),
          /^7:57 from “land”: in queue 0:42, checking 7:10, landing 0:05$/,
          'the Lane page shows its own landing timing',
        );
        await page.addScriptTag({ path: axePath });
        for (const theme of ['dark', 'light']) {
          await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
          const [scroll, inner] = await page.evaluate(() => [
            document.documentElement.scrollWidth,
            innerWidth,
          ]);
          assert.ok(scroll <= inner, `no sideways scroll at ${viewport.width} landed ${theme}`);
          const violations = await page.evaluate(async () => {
            const result = await window.axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
            });
            return result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
          });
          assert.deepEqual(violations, [], `axe at ${viewport.width} landed ${theme}`);
          await shot(page, `lane-review-landed-${viewport.width}-${theme}`);
        }
      }
    });

    await t.test('phone width holds with a wider fallback font (Linux CI metrics)', async t => {
      // 1dd4e095: Linux's fallback glyphs are wider than macOS's; the recommendation header once overflowed to 398 px.
      const page = await open(t, PHONE, 's=review');
      await page.addStyleTag({ content: '* { font-family: Verdana, monospace !important; }' });
      const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
      assert.ok(
        scroll <= inner,
        `no sideways scroll at ${PHONE.width} with a wide font: ${scroll} > ${inner}`,
      );
    });
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});

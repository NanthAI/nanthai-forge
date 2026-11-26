// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Lane review screen in a real browser (Items 52235fbf, 4bc460aa, a1e3d771, c2388099), on synthetic data through
// its real components (tests/browser/lane-review.tsx). Only overlaps and protected paths need eyes, as the Facts say;
// every row shows the +/- counts its save recorded with no read; file order is one press away, a folded file reads
// nothing and an opened one makes only its own download calls, the labelled Read box reconciles with the count and
// is gone once the Lane has landed or is set aside, a combined file shows where each line came from, and axe is clean
// with no sideways scroll at desk and phone width in both themes. Set FORGE_LANE_SHOTS to a folder to also save the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';
import { axePath, buildBrowserFixture, routeBrowserFixture } from './browser-fixture.mjs';

const shots = process.env.FORGE_LANE_SHOTS || null;
const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };

test('the Lane review screen: order, lazy bodies, ticks, line origin, axe and widths in both themes', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-lane-review-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const { html } = await buildBrowserFixture(out, {
    entry: 'tests/browser/lane-review.tsx',
    title: 'Lane review fixture',
  });
  const browser = await chromium.launch(launchOptions);
  async function open(t, viewport, query, path = '/lane-review.html') {
    const context = await browser.newContext({ viewport, locale: 'en-US' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    page.on('requestfailed', request => errors.push(`failed ${request.url().slice(0, 80)}`));
    await routeBrowserFixture(page, out, html, { paths: [path] });
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
        const board = '/sample-owner/tide-pool/lanes';
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
      const path = '/sample-owner/tide-pool/lanes/7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
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
      const lanes = '/sample-owner/tide-pool/lanes';
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
      // Df1f2d46: a pair names its Items in its fold; opened, it links each of its Lanes by its mark.
      await page.locator('.cx-pair', { hasText: title }).first().click();
      await page.locator('.cx-open').getByRole('link', { name: '7a2b4c6d', exact: true }).first().click();
      await page.getByRole('link', { name: `Item: ${itemLabel}`, exact: true }).waitFor();
      assert.equal(await page.evaluate(() => location.pathname), openedFromLanes);
      assert.equal(await heading.textContent(), headingFromLanes);
    });

    await t.test('the Lane strip opens the merged Thread without reading it on Changes', async t => {
      const lane = '/sample-owner/tide-pool/lanes/7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
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
        await page.emulateMedia({ reducedMotion: 'reduce' });
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

    async function checkHistoryThemes(page, viewport, scenario) {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addScriptTag({ path: axePath });
      for (const theme of ['dark', 'light']) {
        await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
        const [fits, violations] = await page.evaluate(async () => [
          document.documentElement.scrollWidth <= innerWidth,
          (
            await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })
          ).violations.map(v => v.id),
        ]);
        const label = `${scenario}-${viewport.width}-${theme}`;
        assert.equal(fits, true, label);
        assert.deepEqual(violations, [], label);
        await shot(page, label);
      }
    }

    await t.test(
      'Lane History loads only on open, keeps later saves, and can undo a return by keyboard',
      async t => {
        const lane = '/sample-owner/tide-pool/lanes/7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
        for (const viewport of [DESK, PHONE]) {
          const page = await open(t, viewport, 'routes&s=history-loading', lane);
          const history = page
            .getByRole('navigation', { name: 'Lane sections' })
            .getByRole('link', { name: 'History', exact: true });
          await history.focus();
          assert.equal(await page.evaluate(() => window.__saveHistory.reads), 0);
          await page.keyboard.press('Enter');
          const section = page.getByRole('region', { name: 'Saves', exact: true });
          const reserved = section.locator('.sk-rows');
          await reserved.getByRole('status').getByText('Loading saves').waitFor();
          assert.equal(await reserved.locator('.row').count(), 4);
          await page.evaluate(() => window.__showSaveHistory());
          const earlier = section.getByRole('listitem').filter({ hasText: 'Record parser baseline' });
          const later = section.getByRole('listitem').filter({ hasText: 'Add marker' });
          await later.getByText('Current save').waitFor();
          assert.equal(await section.getByRole('listitem').first().textContent(), await later.textContent());
          assert.match(await earlier.textContent(), /1 file changed[\s\S]*long-path-/);
          await earlier.getByText('Drops 1 later save from the current Lane. It stays in History.').waitFor();
          assert.equal(await earlier.locator('time').getAttribute('datetime'), '2026-11-24T09:00:00.000Z');
          const action = earlier.getByRole('button', { name: /^Return to this save/ });
          await action.focus();
          await page.keyboard.press('Enter');
          await earlier.getByText('Current save').waitFor();
          assert.equal(await later.getByRole('button', { name: /^Return to this save/ }).isEnabled(), true);
          assert.equal(
            await section
              .getByRole('heading', { name: 'Saves' })
              .evaluate(el => el === document.activeElement),
            true,
          );
          const status = section.getByRole('status');
          await status.getByText('Returned to this save. All saves are still in History.').waitFor();
          const undo = status.getByRole('button', { name: 'Undo', exact: true });
          await page.keyboard.press('Tab');
          assert.equal(await undo.evaluate(el => el === document.activeElement), true);
          await page.keyboard.press('Enter');
          await later.getByText('Current save').waitFor();
          await section.getByText('Return undone. All saves are still in History.').waitFor();
          const historyCalls = await page.evaluate(() => ({
            reads: window.__saveHistory.reads,
            watches: window.__watches,
          }));
          assert.equal(historyCalls.reads, 1);
          assert(!historyCalls.watches.includes('projectHostedLaneHistory:saves'));
          await checkHistoryThemes(page, viewport, 'lane-saves');
        }
      },
    );

    await t.test(
      'Lane History explains unavailable returns and retains exact pins for network and archive retries',
      async t => {
        const lane = '/sample-owner/tide-pool/lanes/7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d/history';
        const readOnly = {
          'history-one': null,
          'history-reader': /Only the holder, author/,
          'history-closed': /This Lane is closed/,
          'history-native': /This project manages Lane changes outside the browser/,
          'history-read-refused': /This Lane is not on this project/,
        };
        for (const viewport of [DESK, PHONE]) {
          for (const scenario of [
            ...Object.keys(readOnly),
            'history-wait',
            'history-refused',
            'history-retry',
            'history-press-wait',
            'history-archive',
          ]) {
            await t.test(`${scenario} at ${viewport.width}px`, async t => {
              const page = await open(t, viewport, `routes&s=${scenario}`, lane);
              const section = page.getByRole('region', { name: 'Saves', exact: true });
              const action = section.getByRole('button', {
                name: 'Return to this save: Record parser baseline',
                exact: true,
              });
              const undo = section.getByRole('button', { name: 'Undo', exact: true });
              if (scenario in readOnly) {
                if (readOnly[scenario]) await section.getByText(readOnly[scenario]).waitFor();
                else await section.getByText('Current save').waitFor();
                assert.equal(await section.getByRole('button', { name: /^Return to this save/ }).count(), 0);
                if (scenario === 'history-read-refused')
                  assert.equal(await section.getByRole('button', { name: 'Retry' }).count(), 0);
                await checkHistoryThemes(page, viewport, scenario);
                return;
              }
              if (scenario === 'history-wait') {
                await section.getByText(/Wait for it to finish/).waitFor();
                assert.equal(await action.isEnabled(), false);
                await section.getByRole('button', { name: 'Show earlier saves' }).click();
                const draft = section.getByRole('listitem').filter({ hasText: 'Draft parser' });
                await draft
                  .getByText('Drops 2 later saves from the current Lane. They stay in History.')
                  .waitFor();
                await checkHistoryThemes(page, viewport, scenario);
                await section.getByRole('button', { name: 'Check again' }).click();
                await action.click();
                await undo.waitFor();
                await draft.waitFor();
                return;
              }
              await action.focus();
              await page.keyboard.press('Enter');
              if (scenario === 'history-archive') {
                await undo.waitFor();
                await checkHistoryThemes(page, viewport, scenario);
              } else {
                const alert = section.getByRole('alert');
                if (scenario === 'history-refused') {
                  const pending = section.getByRole('button', { name: 'Returning: Record parser baseline' });
                  await pending.waitFor();
                  assert.equal(await pending.evaluate(el => el === document.activeElement), true);
                  await page.keyboard.press('Enter');
                  assert.equal(await page.evaluate(() => window.__saveHistory.writes.length), 1);
                  await page.evaluate(() => window.__finishSaveReturn());
                  await alert.getByText(/Only this Lane’s holder/).waitFor();
                  assert.equal(await action.evaluate(el => el === document.activeElement), true);
                  assert.equal(await undo.count(), 0);
                  await checkHistoryThemes(page, viewport, scenario);
                  return;
                }
                await alert
                  .getByText(
                    scenario === 'history-press-wait'
                      ? /Wait for it to finish/
                      : /Could not confirm the return/,
                  )
                  .waitFor();
                assert.equal(await action.evaluate(el => el === document.activeElement), true);
                await checkHistoryThemes(page, viewport, scenario);
                await alert.getByRole('button', { name: 'Retry return' }).click();
                await undo.waitFor();
              }
              const [first, retry] = await page.evaluate(() => window.__saveHistory.writes);
              assert.deepEqual(retry, first);
            });
          }
        }
      },
    );

    await t.test(
      '954afe8c: unavailable titles use the short Item id, and recorded titles are retained',
      async t => {
        for (const [scenario, label] of [
          ['unavailable', '9e8d7c6b · title unavailable'],
          ['legacy-id', '9e8d7c6b · title unavailable'],
          ['uuid-title', '2a3f12de-8371-4310-a004-f9cae1ef291c · 9e8d7c6b'],
        ]) {
          const path = '/sample-owner/tide-pool/lanes/7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
          const page = await open(t, DESK, `routes&s=${scenario}`, path);
          const item = page.getByRole('link', { name: `Item: ${label}`, exact: true });
          assert.equal(
            await item.getAttribute('href'),
            '/sample-owner/tide-pool/plan/9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a',
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
      // An older save's row counts the body it opened.
      const docs = page.locator('.lr-file', { hasText: 'docs/parser.md' });
      await docs.locator('summary').click();
      await docs.locator('.code .l.add').first().waitFor();
      assert.equal(await docs.locator('.fstat').textContent(), '+2');
      await shot(page, 'lane-review-open-1440-dark');
    });

    await t.test(
      'Q24: copy the exact predecessor command and evidence, or read the prompt by hand',
      async t => {
        const page = await open(t, DESK, 's=two-conflicts');
        const heading = page.getByRole('heading', { name: 'Ask your agent to resolve this conflict' });
        await heading.waitFor();
        await page
          .context()
          .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://forge.test' });
        const copy = page.getByRole('button', { name: 'Copy prompt', exact: true });
        await copy.focus();
        await page.keyboard.press('Enter');
        await page.getByRole('status').filter({ hasText: 'Copied' }).waitFor();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        const laneId = '7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
        const predecessor = {
          submissionId: '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9',
          head: 'a1'.repeat(32),
          receiptId: '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d',
        };
        assert.ok(copied.includes(`https://forge.test/sample-owner/tide-pool/lanes/${laneId}`));
        assert.ok(copied.includes(`nforge agent . save --sync '${JSON.stringify({ laneId, predecessor })}'`));
        assert.ok(
          copied.includes('{"path":"src/parser/stream-parser.ts","mine":[[22,24]],"theirs":[[22,24]]}'),
        );
        assert.ok(
          copied.includes('Other side: main\n{"path":"package.json","mine":[[2,2]],"theirs":[[2,2]]}'),
        );
        assert.ok(copied.includes('Other side: 3c1f9a20-5b7e-4d2a-9c11-2f0e6b8a4d19'));
        await page.getByText('Show prompt', { exact: true }).click();
        assert.equal(await page.locator('details[open] > .cmd').textContent(), copied);
        assert.equal(await calls(page), 0, 'copy and disclosure issue no Convex request');

        const main = await open(t, PHONE, 's=main-conflict');
        await main.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }));
        await main.getByRole('button', { name: 'Copy prompt', exact: true }).click();
        await main.getByRole('status').filter({ hasText: 'Select the text to copy' }).waitFor();
        await main.getByText('Show prompt', { exact: true }).click();
        const manual = await main.locator('details[open] > .cmd').textContent();
        assert.ok(manual.includes(`nforge agent . status '${JSON.stringify({ laneId })}'`));
        assert.ok(manual.includes('Other side: main'));
        assert.ok(
          !manual.includes('save --sync'),
          'an unpinned conflict never suggests a guessed resolution',
        );
        assert.equal(await calls(main), 0);

        const combined = await open(t, PHONE, 's=combined-notice');
        await combined.getByRole('heading', { name: 'Combined result' }).waitFor();
        assert.equal(await combined.getByRole('button', { name: 'Copy prompt' }).count(), 0);
      },
    );

    await t.test('once landed or set aside, read marks and the needs-eyes order are gone', async t => {
      for (const s of ['landed', 'abandoned']) {
        const page = await open(t, DESK, `s=${s}`);
        assert.deepEqual(await bands(page), [['All files', 17]], s);
        await page.locator('.lr-more').first().click();
        assert.equal(await page.locator('.lr-file .tick').count(), 0, `${s}: no Read box`);
        assert.equal(await page.getByRole('button', { name: 'Needs eyes first' }).count(), 0, s);
        assert.equal(await page.getByRole('button', { name: 'Copy prompt' }).count(), 0, s);
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

    await t.test(
      '0a99ab23: a request asked before the Lane holds a landing is decided on the Lane page',
      async t => {
        for (const viewport of [DESK, PHONE]) {
          const page = await open(t, viewport, 's=asked');
          const decision = page.getByRole('region', { name: 'Your decision' });
          await decision.waitFor();
          assert.match(await decision.textContent(), /holds nothing yet/);
          assert.match(await decision.textContent(), /Touches the billing migration; please look first\./);
          assert.equal(
            await page.evaluate(
              () => (window.__watches ?? []).filter(name => name === 'projectNeedsMe:read').length,
            ),
            0,
            'decided from the Lane read: no Needs me read',
          );
          await decision.getByRole('button', { name: 'Decline', exact: true }).waitFor();
          await decision.getByRole('button', { name: 'Approve', exact: true }).click();
          await page.getByRole('status').filter({ hasText: 'Approved. It is in the log.' }).waitFor();
          const [sent] = await page.evaluate(() => window.__decide);
          assert.equal(sent.decision, 'grant');
          assert.equal(sent.laneId, '7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d');
          // Asked at an older save (a1…): a save between the request and the review must not leave the keys stale.
          assert.equal(sent.head, 'c3'.repeat(32), "the decision names the Lane's current save");
          assert.match(sent.operationId, /^[0-9a-f-]{36}$/);
        }
      },
    );

    await t.test(
      '0a99ab23: a declined request that still holds the Lane can be approved instead',
      async t => {
        const page = await open(t, DESK, 's=declined');
        const decision = page.getByRole('region', { name: 'Your decision' });
        await decision.waitFor();
        assert.match(await decision.textContent(), /you declined it/);
        assert.match(await decision.textContent(), /You said: Wait for the schema review\./);
        assert.equal(await decision.getByRole('button', { name: 'Decline', exact: true }).count(), 0);
        await decision.getByRole('button', { name: 'Approve', exact: true }).click();
        const [sent] = await page.evaluate(() => window.__decide);
        assert.equal(sent.decision, 'grant');
        assert.equal(sent.head, 'c3'.repeat(32));
      },
    );

    await t.test(
      '4f1f7984: a granted request stays on its Lane page, read-only, with nothing to decide',
      async t => {
        for (const viewport of [DESK, PHONE]) {
          const page = await open(t, viewport, 's=granted');
          const decision = page.getByRole('region', { name: 'Your decision' });
          await decision.waitFor();
          assert.match(await decision.textContent(), /you granted it/);
          assert.match(await decision.textContent(), /Touches the billing migration; please look first\./);
          assert.equal(
            await decision.getByRole('button').count(),
            0,
            `nothing to press at ${viewport.width}`,
          );
        }
      },
    );

    await t.test(
      '0a99ab23: an approval link decides the landing it names, not another of the Lane',
      async t => {
        const page = await open(t, DESK, 's=linked&submission=a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d');
        const decision = page.getByRole('region', { name: 'Your decision' });
        await decision.waitFor();
        await decision.getByRole('button', { name: 'Approve and land' }).click();
        await page.waitForFunction(() => window.__decide?.length === 1);
        const [sent] = await page.evaluate(() => window.__decide);
        assert.equal(sent.submissionId, 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d');
        assert.equal(sent.attemptId, 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e');
        assert.equal(await page.getByRole('dialog', { name: 'Approve without a check?' }).count(), 0);
      },
    );

    await t.test(
      'an unchecked Lane approval asks once and Escape restores focus without approving',
      async t => {
        for (const viewport of [DESK, PHONE]) {
          for (const theme of ['light', 'dark']) {
            const page = await open(
              t,
              viewport,
              `s=linked&unchecked&theme=${theme}&submission=a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d`,
            );
            const decision = page.getByRole('region', { name: 'Your decision' });
            const approve = decision.getByRole('button', { name: 'Approve and land' });
            await approve.focus();
            await page.keyboard.press('Enter');
            const sheet = page.getByRole('dialog', { name: 'Approve without a check?' });
            await sheet.waitFor();
            await sheet.locator('button:focus').filter({ hasText: 'Not now' }).waitFor({ timeout: 3_000 });
            assert.equal(
              await page
                .locator('#root')
                .evaluate(root => Boolean(root.closest('[inert], [aria-hidden="true"]'))),
              true,
              'the background is inert',
            );
            await page.addScriptTag({ path: axePath });
            assert.deepEqual(
              await page.evaluate(async () => (await window.axe.run()).violations.map(v => v.id)),
              [],
            );
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await shot(page, `approve-without-check-${viewport.width}-${theme}`);
            for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab']) {
              await page.keyboard.press(key);
              assert.equal(await sheet.evaluate(node => node.contains(document.activeElement)), true);
            }
            await page.keyboard.press('Escape');
            await sheet.waitFor({ state: 'hidden' });
            await decision
              .locator('button:focus')
              .filter({ hasText: 'Approve and land' })
              .waitFor({ timeout: 3_000 });
            assert.deepEqual(await page.evaluate(() => window.__decide ?? []), []);
            await page.keyboard.press('Enter');
            await sheet.locator('button:focus').filter({ hasText: 'Not now' }).waitFor({ timeout: 3_000 });
            await page.keyboard.press('Tab');
            await page.keyboard.press('Enter');
            await sheet.waitFor({ state: 'hidden' });
            const sent = await page.evaluate(() => window.__decide);
            assert.equal(sent.length, 1);
            assert.equal(sent[0].attemptId, 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e');
          }
        }
      },
    );

    // Item 0a99ab23 line 1: the old /approve page took an optional typed reason; the owner's decline here does too.
    await t.test(
      '0a99ab23: declining a request asked ahead sends the typed reason, or none when it is left empty',
      async t => {
        for (const viewport of [DESK, PHONE]) {
          const typed = await open(t, viewport, 's=asked');
          const decision = typed.getByRole('region', { name: 'Your decision' });
          await decision.getByRole('button', { name: 'Decline', exact: true }).click();
          const why = decision.getByRole('textbox', { name: /^Why/ });
          assert.equal(await why.evaluate(node => node === document.activeElement), true, 'focus moves in');
          assert.match(await decision.textContent(), /0\/500/);
          await why.fill('Wait for the schema review.');
          assert.match(await decision.textContent(), /27\/500/);
          await decision.getByRole('button', { name: 'Decline', exact: true }).click();
          await typed.getByRole('status').filter({ hasText: 'Declined. The agent was told.' }).waitFor();
          const [sent] = await typed.evaluate(() => window.__decide);
          assert.equal(sent.decision, 'decline');
          assert.equal(sent.reason, 'Wait for the schema review.');
          assert.equal(sent.head, 'c3'.repeat(32));

          const plain = await open(t, viewport, 's=asked');
          const bare = plain.getByRole('region', { name: 'Your decision' });
          await bare.getByRole('button', { name: 'Decline', exact: true }).click();
          await bare.getByRole('button', { name: 'Decline', exact: true }).click();
          await plain.getByRole('status').filter({ hasText: 'Declined. The agent was told.' }).waitFor();
          const [none] = await plain.evaluate(() => window.__decide);
          assert.equal(none.decision, 'decline');
          assert.equal('reason' in none, false, 'an empty reason is a plain decline');
        }
      },
    );

    await t.test(
      '0a99ab23: declining the landing an approval link names sends its attempt and the typed reason',
      async t => {
        const page = await open(t, DESK, 's=linked&submission=a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d');
        const decision = page.getByRole('region', { name: 'Your decision' });
        await decision.getByRole('button', { name: 'Decline', exact: true }).click();
        await decision.getByRole('textbox', { name: /^Why/ }).fill('  Not this one.  ');
        await decision.getByRole('button', { name: 'Decline', exact: true }).click();
        await page.waitForFunction(() => window.__decide?.length === 1);
        const [sent] = await page.evaluate(() => window.__decide);
        assert.equal(sent.submissionId, 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d');
        assert.equal(sent.attemptId, 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e');
        assert.equal(sent.reason, 'Not this one.', 'trimmed');
        assert.match(sent.operationId, /^[0-9a-f-]{36}$/);
      },
    );

    await t.test('0a99ab23: the reason stops at 500 characters and Not now closes the form', async t => {
      const page = await open(t, PHONE, 's=asked');
      const decision = page.getByRole('region', { name: 'Your decision' });
      await decision.getByRole('button', { name: 'Decline', exact: true }).click();
      const why = decision.getByRole('textbox', { name: /^Why/ });
      await why.fill('x'.repeat(600));
      assert.equal((await why.inputValue()).length, 500);
      assert.match(await decision.textContent(), /500\/500/);
      await decision.getByRole('button', { name: 'Not now' }).click();
      assert.equal(await decision.getByRole('textbox').count(), 0);
      assert.equal(await page.evaluate(() => (window.__decide ?? []).length), 0, 'nothing was sent');
    });

    await t.test('0a99ab23: axe with the decline form open: both themes, desk and phone', async t => {
      for (const viewport of [DESK, PHONE]) {
        const page = await open(t, viewport, 's=asked');
        const decision = page.getByRole('region', { name: 'Your decision' });
        await decision.getByRole('button', { name: 'Decline', exact: true }).click();
        await decision.getByRole('textbox', { name: /^Why/ }).fill('Wait for the schema review.');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.addScriptTag({ path: axePath });
        for (const theme of ['dark', 'light']) {
          await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
          const [scroll, inner] = await page.evaluate(() => [
            document.documentElement.scrollWidth,
            innerWidth,
          ]);
          assert.ok(scroll <= inner, `no sideways scroll at ${viewport.width} ${theme}`);
          const violations = await page.evaluate(async () => {
            const result = await window.axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
            });
            return result.violations.map(
              v =>
                `${v.id}: ${v.nodes.map(n => `${n.target.join(' ')} ${JSON.stringify(n.any[0]?.data ?? '')}`).join(', ')}`,
            );
          });
          assert.deepEqual(violations, [], `axe at ${viewport.width} decline form ${theme}`);
          await shot(page, `lane-review-decline-${viewport.width}-${theme}`);
        }
      }
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
        for (const s of ['review', 'main-conflict', 'combined', 'parked', 'asked', 'declined', 'granted']) {
          const page = await open(t, viewport, `s=${s}`);
          await page.locator('.lr-file').first().locator('summary').click();
          await page.locator('.lr-file').first().locator('.code').first().waitFor();
          await page.emulateMedia({ reducedMotion: 'reduce' });
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
            if (s === 'review' || s === 'main-conflict') {
              const disclosure = page.getByText('Show prompt', { exact: true });
              await disclosure.click();
              const [width, openViolations] = await page.evaluate(async () => [
                document.documentElement.scrollWidth,
                (await window.axe.run(document.querySelector('.lr-lead'))).violations.map(v => v.id),
              ]);
              assert.ok(width <= viewport.width, `opened ${s} prompt fits at ${viewport.width}`);
              assert.deepEqual(
                openViolations,
                [],
                `axe with opened ${s} prompt at ${viewport.width} ${theme}`,
              );
              await shot(page, `lane-review-${s}-prompt-${viewport.width}-${theme}`);
              await disclosure.click();
            }
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
      // 1dd4e095 / friction f747f424: Linux's fallback glyphs are wider than macOS's; the recommendation
      // header once overflowed to 398 px. Guard every phone lead-card state under the wide fallback font.
      for (const s of [
        'review',
        'main-conflict',
        'combined',
        'parked',
        'asked',
        'declined',
        'granted',
        'landed',
      ]) {
        const page = await open(t, PHONE, `s=${s}`);
        await page.addStyleTag({ content: '* { font-family: Verdana, monospace !important; }' });
        const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
        assert.ok(
          scroll <= inner,
          `no sideways scroll at ${PHONE.width} ${s} with a wide font: ${scroll} > ${inner}`,
        );
      }
    });
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});

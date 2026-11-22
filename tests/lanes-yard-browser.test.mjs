// SPDX-License-Identifier: Apache-2.0
// The Lanes yard in a real browser (Items 29671737, d9e1ac62, d4b68402), on synthetic data through its real model and
// row (tests/browser/lanes-yard.tsx): a Lane held for approval reads Needs you, never Check failed; two rows of one
// Item never look the same and a left-behind one says what replaced it, below the live one; a Ready Lane behind
// another says what it waits on; a Lane further back is traced to the front of the queue (9e748e41); in the dense
// yard the Lane mark is never cut (real case: Item 1dd4e095, whose two Lanes read the same once the meta line was
// cut); axe is clean with no sideways scroll at desk and phone width in both themes, plain and dense; a parked Lane
// names who it waits on and why (Item e1633718); a row that shares saved files says how many with how many Lanes, in
// a link of its own to Who is touching what, never nested in the row's link (Item f787005c). On the app's own address
// the real Lanes place draws each link to the one screen the real route registry gives it, a failed row to its check,
// and phone Back returns to the same view (Item e317b6ea). The overview matches the approved flow lanes.html (lead mock
// check 2026-11-22): the four stops and main head the yard with the top bar's counts, a row starts with who holds it
// and says its app and when it was seen, Needs you holds only what this reader decides (48049998) with Review at the
// right and Return opening it, a failed check opens its check screen (Open check: whether Retry is offered is that
// screen's to say), and the agent's `nforge agent . queue` reply opens from its chip. Set
// FORGE_LANE_SHOTS to a folder to also save the screenshots.
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
const FIXTURE = 'tests/browser/lanes-yard.tsx';

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
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Lanes yard fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

test('the Lanes yard: one state per Lane, grouped by Item, waits named, axe and widths in both themes', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-lanes-yard-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch(launchOptions);
  async function open(t, viewport, query = '', path = '/yard.html', ready = '.yard .ln') {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname === '/yard.html' || url.pathname.startsWith('/-/'))
        return route.fulfill({ contentType: 'text/html', body: html });
      const file = join(out, url.pathname.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto(`https://forge.test${path}${query}`);
    await page
      .locator(ready)
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, [], 'no page errors');
    });
    return page;
  }
  const rows = page =>
    page.locator('.yard .ln').evaluateAll(nodes =>
      nodes.map(node => ({
        title: node.querySelector('.ttl')?.textContent,
        meta: node.querySelector('.meta')?.textContent,
        word: node.querySelector('.actn .st')?.textContent,
        why: node.querySelector('.actn .why')?.textContent,
      })),
    );
  try {
    await t.test(
      '5a7d57a3: the yard reports four checking and six amber Lanes waiting their turn',
      async t => {
        for (const width of [1440, 390]) {
          const page = await open(t, { width, height: 1000 }, '?stall');
          const queue = page.getByRole('list', { name: 'In the landing queue' });
          assert.match(await queue.locator('.band').textContent(), /Checking 4 · 6 passed, waiting/);
          const waiting = queue.locator('.actn .st[data-st="waiting"]');
          assert.deepEqual(await waiting.allTextContents(), Array(6).fill('Waiting its turn'));
        }
      },
    );

    await t.test('held for approval, replaced Lanes below the live one, and the wait named', async t => {
      const page = await open(t, DESK);
      const all = await rows(page);
      const pages = all.filter(row => row.title.startsWith('Public pages'));
      assert.deepEqual(
        pages.map(row => [row.word, row.why]),
        [
          ['Needs you', 'waiting for approval'],
          ['Saved', 'replaced by 9e8e8826'],
          ['Saved', 'replaced by 9e8e8826'],
        ],
      );
      assert.equal(new Set(pages.map(row => row.meta)).size, 3, 'three rows of one Item never look the same');
      assert.match(pages[0].meta, /^9e8e8826 · 3 Lanes · Codex, seen .+$/);
      const alone = all.find(row => row.title.startsWith('Stamp every save'));
      assert.match(alone.meta, /^seen [^·]+$/, 'a Lane alone needs no Lane mark');
      assert.ok(!all.some(row => row.word === 'Check failed'), 'nothing here failed a check');
      const waiting = all.find(row => row.title.startsWith('Stamp every save'));
      assert.deepEqual(
        [waiting.word, waiting.why],
        [
          'Waiting its turn',
          'waits for #1: its check restarted 3 times because main moved longer than a usual check',
        ],
      );
      const account = all.filter(row => row.title.startsWith('Account Projects'));
      assert.equal(account.length, 3);
      assert.ok(
        account.every(row => !row.why.startsWith('replaced')),
        'busy Lanes of one Item are only grouped',
      );
      assert.ok(
        account.some(
          row => row.why === 'parked for @devon 40 min ago Waits for devon to pick the empty-state copy.',
        ),
        'e1633718: a parked Lane names who it waits on and since when, with the reason under it',
      );
    });

    await t.test(
      'who waits on whom traces a Lane further back to the front of the queue (9e748e41)',
      async t => {
        const page = await open(t, DESK);
        const lines = await page
          .locator('.lanes-wait')
          .evaluateAll(nodes => nodes.map(node => node.textContent.replace(/\s+/g, ' ').trim()));
        assert.equal(lines.length, 3);
        assert.match(lines[0], /^Public pages.* waits on a person/);
        const back = lines.find(line => line.startsWith('Account Projects'));
        assert.match(back, /waits on Stamp every save and landing with who made it/);
        assert.match(
          back,
          /2 Lanes ahead; the queue moves when Hosted CLI and agent workflow papercuts lands \(its check restarted 3 times because main moved\)/,
        );
        const next = lines.find(line => line.startsWith('Stamp every save'));
        assert.doesNotMatch(next, /Lanes ahead/, 'directly behind the front, the one hop is the whole path');
      },
    );

    await t.test(
      'dense yard: the Lane mark and the Item count are drawn, not cut (Item 1dd4e095)',
      async t => {
        for (const viewport of [DESK, PHONE]) {
          const page = await open(t, viewport, '?dense=1');
          const pair = (await rows(page)).filter(row => row.title.startsWith('Landing check'));
          assert.deepEqual(
            pair.map(row => row.why),
            ['saved 21 h ago', 'replaced by c908b679'],
            'the resolution Lane first, the Lane it resolves below it',
          );
          // textContent holds the whole line even when the row cuts it: measure what is drawn.
          const cut = await page.locator('.yard .ln .meta').evaluateAll(nodes =>
            nodes.flatMap(meta => {
              const box = meta.getBoundingClientRect();
              const mark = meta.querySelector('.mk');
              const lanes = [...meta.childNodes].find(
                node => node.nodeType === 3 && /Lanes/.test(node.textContent),
              );
              const range = document.createRange();
              if (lanes) range.selectNodeContents(lanes);
              const ends = [
                mark?.getBoundingClientRect().right,
                lanes ? range.getBoundingClientRect().right : undefined,
              ];
              return ends.some(end => end !== undefined && end > box.right + 0.5) ? [meta.textContent] : [];
            }),
          );
          assert.deepEqual(cut, [], `no Lane mark or Lane count cut at ${viewport.width}`);
        }
      },
    );

    await t.test('f787005c: a sharing row says what it shares, linked to Who is touching what', async t => {
      for (const [viewport, query] of [
        [DESK, ''],
        [PHONE, '?dense=1'],
      ]) {
        const page = await open(t, viewport, query);
        const lines = await page.locator('.yard [role="listitem"]').evaluateAll(items =>
          items.flatMap(item => {
            const link = item.querySelector('.ln-sh a');
            if (!link) return [];
            return [
              {
                title: item.querySelector('.ln .ttl')?.textContent,
                shown: link.textContent.replace(item.querySelector('.ln-sh .sr')?.textContent ?? '', ''),
                href: link.getAttribute('href'),
                nested: Boolean(link.parentElement.closest('a')),
                below:
                  link.getBoundingClientRect().top >=
                  item.querySelector('.ln').getBoundingClientRect().bottom - 0.5,
              },
            ];
          }),
        );
        assert.equal(lines.length, 3, `only the three sharing Lanes get a line at ${viewport.width}`);
        assert.ok(lines.every(line => line.title.startsWith('Account Projects')));
        assert.deepEqual(lines.map(line => line.shown).sort(), [
          'shares 1 file with 2 Lanes',
          'shares 2 files with 2 Lanes',
          'shares 2 files with 2 Lanes',
        ]);
        assert.ok(
          lines.every(line => line.href.startsWith('#touching-')),
          'each links to the pair view for its Lane',
        );
        assert.ok(
          lines.every(line => !line.nested && line.below),
          'a link of its own, under the row',
        );
        const name = await page
          .locator('.ln-sh a')
          .first()
          .evaluate(link => link.textContent);
        assert.match(
          name,
          /^Account Projects page in the redesign: shares /,
          'the link names its Lane to a screen reader',
        );
      }
    });

    await t.test('Lane and identity links have separate targets, including on a phone', async t => {
      const page = await open(t, PHONE, '?history');
      const row = page.locator('.yard .ln').filter({ hasText: 'Public pages' }).first();
      assert.match(
        await row.getByRole('link', { name: 'quiet-otter' }).getAttribute('href'),
        /lanes\/sessions\/mara\/quiet-otter$/,
      );
      assert.equal(await row.getByRole('link', { name: '@mara' }).getAttribute('href'), '/-/mara');
      assert.match(await row.getByRole('link', { name: /Public pages/ }).getAttribute('href'), /^#/);
      assert.equal(await row.locator('a a').count(), 0);
      if (shots) {
        for (const viewport of [DESK, PHONE]) {
          await page.setViewportSize(viewport);
          for (const theme of ['dark', 'light']) {
            await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
            await page
              .locator('.row.hv')
              .first()
              .locator('..')
              .screenshot({ path: join(shots, `history-byline-${viewport.width}-${theme}.png`) });
          }
        }
      }
    });

    const LANES = '/-/sample-owner/sample-project/lanes';
    const FAILED = 'f41ed0a2-3b6c-4d1e-9a7f-2c8e5b0d4f19';
    await t.test(
      'e317b6ea: the overview links Sessions, each Lane and a failed check to their own screens; Back returns',
      async t => {
        for (const viewport of [PHONE, DESK]) {
          const page = await open(t, viewport, '', LANES);
          const screen = () => page.locator('main').getAttribute('data-screen');
          assert.equal(await screen(), 'lanes#0', 'the overview is the Lanes place itself');
          assert.equal(
            await page.evaluate(() => window.forgeReads.adds),
            5,
            "the frame's Needs me read, then Lanes, queue, shared files and the project's Item counts: one read each, none per row or per link",
          );
          assert.equal(
            await page.evaluate(() => window.forgeLive('projectNeedsMe:read')),
            1,
            "Needs you shares the frame's Needs me subscription",
          );
          const failed = page.locator('.yard .ln').filter({ hasText: 'Stream parser' });
          assert.equal(await failed.locator('.actn .st').textContent(), 'Check failed');
          const routes = [
            [page.getByRole('link', { name: 'Sessions', exact: true }), `${LANES}/sessions`, 'sessions#0'],
            [
              failed.getByRole('link', {
                name: /^Stream parser: handle split UTF-8, Lane f41ed0a2, open its check$/,
              }),
              `${LANES}/${FAILED}/check`,
              'check#0',
            ],
            [
              page.locator('.yard .ln').filter({ hasText: 'Public pages' }).first().locator('a.ln-open'),
              `${LANES}/9e8e8826-db5d-40d1-9199-328383d25641`,
              'lane#0',
            ],
          ];
          for (const [link, href, owner] of routes) {
            assert.equal(await link.getAttribute('href'), href);
            await link.click();
            await page.waitForURL(`**${href}`);
            assert.equal(await screen(), owner, `${href} opens its own screen`);
            await page.goBack();
            await page.waitForURL(`**${LANES}`);
            await page.locator('.yard .ln').first().waitFor();
            assert.equal(await screen(), 'lanes#0', `Back from ${href} at ${viewport.width}`);
          }
          // Lanes with no failed check keep opening the Lane; Held stays one count with the failed Lane in it.
          const checks = await page
            .locator('.yard a.ln-open')
            .evaluateAll(links =>
              links.map(link => link.getAttribute('href')).filter(href => href.endsWith('/check')),
            );
          assert.deepEqual(checks, [`${LANES}/${FAILED}/check`]);
          // 48049998: the approval waits on this reader; the failed check is its agent's next step.
          const needs = page.getByRole('list', { name: 'Needs you' });
          const held = page.getByRole('list', { name: 'Held' });
          assert.equal(await needs.locator('[role="listitem"]').count(), 1);
          assert.equal(await held.locator('[role="listitem"]').count(), 1);
          assert.match(
            await page.locator('.head .sit').textContent(),
            /^1 Lane needs you\. 1 more is held\./,
          );
        }
      },
    );

    await t.test(
      'e317b6ea mock check: stops head the yard, rows act at the right, keys open them, the queue chip',
      async t => {
        for (const viewport of [DESK, PHONE]) {
          const page = await open(t, viewport, '', LANES);
          const stops = await page.locator('.yard .zones .zs span').allTextContents();
          assert.deepEqual(
            stops.map(text => text.replace(/\s+/g, ' ').trim()),
            ['Editing 1', 'Saved 6', 'In queue 0', 'Checking 1 · 2 passed', 'main'],
            'the top bar counts per stop (a failed check apart, passed said), then main',
          );
          const review = page.locator('.yard .ln').filter({ hasText: 'Public pages' }).first();
          const action = review.locator('.actn a.btn');
          assert.equal(await action.locator('span').first().textContent(), 'Review');
          assert.equal(await action.locator('kbd').textContent(), '↵', 'the row Return opens shows the key');
          assert.equal(await action.getAttribute('href'), `${LANES}/9e8e8826-db5d-40d1-9199-328383d25641`);
          const retry = page.locator('.yard .ln').filter({ hasText: 'Stream parser' }).locator('.actn a.btn');
          assert.equal(await retry.locator('span').first().textContent(), 'Open check');
          assert.equal(await retry.locator('kbd').count(), 0, 'no key of its own');
          assert.equal(await retry.getAttribute('href'), `${LANES}/${FAILED}/check`);
          assert.equal(
            await page.locator('.yard .actn a.btn').count(),
            2,
            'only rows a reader can move on act',
          );
          assert.equal(await review.locator('.lab > .av').count(), 1, 'who holds it is the mark at left');
          // The keys: Return on the page itself opens the first Review; on a control it is that control's.
          await page.locator('body').press('r');
          assert.match(page.url(), /\/lanes$/, 'r is not a yard key');
          const chipKey = page.locator('button.cli');
          await chipKey.focus();
          await chipKey.press('Enter');
          assert.match(page.url(), /\/lanes$/, 'Return on the chip toggles the chip');
          assert.equal(await chipKey.getAttribute('aria-expanded'), 'true');
          await chipKey.press('Enter');
          await page.evaluate(() => document.activeElement?.blur());
          await page.locator('body').press('Enter');
          await page.waitForURL(`**${LANES}/9e8e8826-db5d-40d1-9199-328383d25641`);
          await page.goBack();
          await page.waitForURL(`**${LANES}`);
          await page.locator('.yard .ln').first().waitFor();
          // The command chip shows what an agent gets, from the queue read already here.
          const reads = await page.evaluate(() => window.forgeReads.adds);
          const chip = page.locator('button.cli');
          assert.equal(await chip.getAttribute('aria-expanded'), 'false');
          assert.equal(await page.locator('#lanes-cli').isVisible(), false);
          await chip.click();
          assert.equal(await chip.getAttribute('aria-expanded'), 'true');
          const reply = await page.locator('#lanes-cli').textContent();
          assert.match(reply, /^\$ nforge agent \. queue\n2 in the queue, 2 held\n/);
          assert.match(reply, /\n1 {5}Hosted CLI and agent workflow papercuts {6}Checking\n/);
          assert.match(
            reply,
            /\nheld  Public pages: share cards, sitemap and page… Needs you, waiting for approval\n/,
          );
          // Where the project stands: the project's Item counts (projectPlanCounts:read, as Needs me and Plan), with
          // the open Lanes and those that need the reader beside In progress (lead mock check 2026-11-22, d3357f40).
          const stands = page.getByRole('navigation', { name: 'Where the project stands' });
          const said = (await stands.textContent()).replace(/\s+/g, ' ');
          assert.match(said, /Done31ItemsIn progress/);
          assert.match(said, /In progress4Items· 11 Lanes open, 1 needs you/);
          assert.match(said, /Left9Items· 2 proposed/);
          assert.doesNotMatch(said, /not reported/);
          assert.equal(
            await page.evaluate(() => window.forgeReads.adds),
            reads,
            'the chip and the strip add no read',
          );
        }
      },
    );

    await t.test(
      'e317b6ea: an address under Lanes that no screen serves says so and links the overview',
      async t => {
        const page = await open(t, PHONE, '', `${LANES}/not/a/lane`, '.head');
        assert.equal(await page.locator('main').getAttribute('data-screen'), 'lanes#0');
        assert.equal(
          await page.locator('.head .sit').textContent(),
          'Forge has no Lanes screen at this address.',
        );
        await page.getByRole('link', { name: 'Open Lanes' }).click();
        await page.waitForURL(`**${LANES}`);
        await page.locator('.yard .ln').first().waitFor();
        await page.goBack();
        await page.waitForURL('**/not/a/lane');
        assert.equal(
          await page.getByRole('link', { name: 'Open Lanes' }).count(),
          1,
          'Back keeps the address',
        );
      },
    );

    await t.test('axe and widths: both themes, desk and phone, plain and dense', async t => {
      const states = [
        ['', '.yard .ln'],
        ['?state=empty', '.empty'],
        ['?state=loading', '.sk-rows'],
        ['?state=failed', '.yard .ln'],
        ['?state=worst', '.yard .ln'],
        ['?state=nocounts', '.yard .ln'],
      ];
      for (const [viewport, query, path, ready] of [
        [DESK, ''],
        [PHONE, ''],
        [DESK, '?dense=1'],
        [PHONE, '?dense=1'],
        ...states.flatMap(([q, r]) => [
          [DESK, q, LANES, r],
          [PHONE, q, LANES, r],
        ]),
      ]) {
        const page = await open(t, viewport, query, path, ready);
        if (query === '?state=nocounts')
          assert.equal(
            await page.getByRole('navigation', { name: 'Where the project stands' }).count(),
            0,
            'with no Item counts the strip is not drawn, never "not reported" three times',
          );
        // Keyboard: every link and control is reached by Tab and shows a focus ring.
        if (path) {
          await page.keyboard.press('Tab');
          const focused = await page.evaluate(() => document.activeElement?.tagName);
          assert.ok(['A', 'BUTTON'].includes(focused), `Tab reaches a control at ${viewport.width} ${query}`);
        }
        await page.addScriptTag({ path: axePath });
        for (const theme of ['dark', 'light']) {
          await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
          const [scroll, inner] = await page.evaluate(() => [
            document.documentElement.scrollWidth,
            innerWidth,
          ]);
          assert.ok(
            scroll <= inner,
            `no sideways scroll at ${viewport.width} ${theme}: ${scroll} > ${inner}`,
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
          assert.deepEqual(violations, [], `axe at ${viewport.width} ${theme}`);
          if (shots)
            await page.screenshot({
              path: join(
                shots,
                `lanes-${path ? `overview${query ? `-${query.split('=')[1]}` : ''}` : 'yard'}-${viewport.width}-${theme}${!path && query ? '-dense' : ''}.png`,
              ),
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

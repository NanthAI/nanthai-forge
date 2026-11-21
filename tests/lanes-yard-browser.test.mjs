// SPDX-License-Identifier: Apache-2.0
// The Lanes yard in a real browser (Items 29671737, d9e1ac62, d4b68402), on synthetic data through its real model and
// row (tests/browser/lanes-yard.tsx): a Lane held for approval reads Needs you, never Check failed; two rows of one
// Item never look the same and a left-behind one says what replaced it, below the live one; a Ready Lane behind
// another says what it waits on; a Lane further back is traced to the front of the queue (9e748e41); in the dense
// yard the Lane mark is never cut (real case: Item 1dd4e095, whose two Lanes read the same once the meta line was
// cut); axe is clean with no sideways scroll at desk and phone width in both themes, plain and dense; a parked Lane
// names who it waits on and why (Item e1633718); a row that shares saved files says how many with how many Lanes, in
// a link of its own to Who is touching what, never nested in the row's link (Item f787005c). Set
// FORGE_LANE_SHOTS to a folder to also save the screenshots.
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
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-lanes-yard-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch();
  async function open(t, viewport, query = '') {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname === '/yard.html') return route.fulfill({ contentType: 'text/html', body: html });
      const file = join(out, url.pathname.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto(`https://forge.test/yard.html${query}`);
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
      assert.match(pages[0].meta, /^9e8e8826 · 3 Lanes$/);
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

    await t.test('axe and widths: both themes, desk and phone, plain and dense', async t => {
      for (const [viewport, query] of [
        [DESK, ''],
        [PHONE, ''],
        [DESK, '?dense=1'],
        [PHONE, '?dense=1'],
      ]) {
        const page = await open(t, viewport, query);
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
              path: join(shots, `lanes-yard-${viewport.width}-${theme}${query ? '-dense' : ''}.png`),
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

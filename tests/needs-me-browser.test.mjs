// SPDX-License-Identifier: Apache-2.0
// Needs me in a real browser (Item 48049998), on synthetic data through the real shell frame, screen and model
// (tests/browser/needs-me.tsx): the shell's Needs you count equals the page's; an agent's conflict and a refusal are
// FYI rows, never Needs you; a protected-path approval and a question stay in Needs you; Dismiss and Clear all write
// once, on the click; a Lane parked for the reader is in Needs you, one parked with no one named only after 4 h idle
// (Item e1633718); Loose ends is open by default (77d2e8bc), says "No loose ends." on one line when it has no rows,
// and a reader's fold is kept and reads nothing; nothing on the page sets a timer; axe is
// clean with no sideways scroll at desk and phone width in both themes, busy and first-day. Set FORGE_NEEDS_SHOTS to a
// folder to also save the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';
import { checkDesktopDock, checkPhoneDock } from './browser/needs-me-dock.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_NEEDS_SHOTS || null;
const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const FIXTURES = {
  '/needs.html': 'tests/browser/needs-me.tsx',
  '/dock-subscription.html': 'tests/browser/dock-subscription.tsx',
  '/progress.html': 'tests/browser/progress-parity.tsx',
};

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
        input: Object.fromEntries(
          Object.entries(FIXTURES).map(([url, file]) => [url.slice(1, -5), join(root, file)]),
        ),
      },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const chunks = new Map(output.map(item => [item.fileName, item]));
  return Object.fromEntries(
    Object.entries(FIXTURES).map(([url, path]) => {
      const entry = output.find(item => item.isEntry && item.facadeModuleId?.endsWith(path));
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
      const html = `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Needs me fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
      return [url, html];
    }),
  );
}

test('Needs me: what waits on you, FYI and loose ends; counts agree; axe and widths in both themes', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-needs-me-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch(launchOptions);
  async function open(
    t,
    viewport,
    data = 'busy',
    theme = 'dark',
    {
      engine = browser,
      hasTouch = false,
      fixture = '/needs.html',
      query = {},
      locale,
      ready = '.dock[data-dock] .region',
    } = {},
  ) {
    const context = await engine.newContext({ viewport, hasTouch, locale });
    await context.addInitScript(() => {
      // Idle costs nothing: count every repeating timer the page sets.
      window.intervals = 0;
      window.dockWrites = [];
      for (const [method, kind] of [
        ['setItem', 'set'],
        ['removeItem', 'remove'],
      ]) {
        const write = Storage.prototype[method];
        Storage.prototype[method] = function (key, ...args) {
          if (this === localStorage && key.startsWith('forge.dock.')) window.dockWrites.push(kind);
          return write.call(this, key, ...args);
        };
      }
      const original = window.setInterval;
      window.setInterval = (...args) => {
        window.intervals++;
        return original(...args);
      };
      try {
        localStorage.setItem('forge.firstRun.lane', '1');
      } catch {}
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'forge.test') return route.abort();
      if (html[url.pathname]) return route.fulfill({ contentType: 'text/html', body: html[url.pathname] });
      const file = join(out, url.pathname.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    const search = new URLSearchParams({ data, theme, ...query });
    await page.goto(`https://forge.test${fixture}?${search}`);
    // The dock fixture is ready when its grips attach; other fixtures supply their own ready marker.
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
  const region = (page, name) => page.locator(`section.region[aria-label="${name}"]`);
  try {
    for (const { name, query, count, unit } of [
      { name: 'exact', query: {}, count: ['1,207', '1', '5'], unit: 'Item' },
      {
        name: 'capped',
        query: { capped: '1' },
        count: ['989+', '1+', '5+'],
        unit: 'Items',
      },
    ]) {
      await t.test(
        `3fa3187d: Needs me and Plan render the same ${name} project counts with an Initiative filter`,
        async t => {
          const initiative = '00000000-0000-4000-8000-000000000001';
          // The stacked bar is drawn once the project counts arrive.
          const options = {
            fixture: '/progress.html',
            locale: 'en-US',
            ready: '.pstate .roll',
          };
          const needs = await open(t, DESK, 'needs', 'dark', { ...options, query });
          const plan = await open(t, DESK, 'plan', 'dark', { ...options, query: { ...query, initiative } });
          const standing = async page => {
            const scope = page.getByRole('navigation', { name: 'Where the project stands' });
            // The bar is the strip's first part and names itself for readers (mock 02-plan-board: no label line).
            assert.match(await scope.getByRole('img').getAttribute('aria-label'), /^Items in this project: /);
            assert.equal(await scope.getByText('Items in this project', { exact: true }).count(), 0);
            assert.equal(
              await scope.locator('.roll').evaluate(roll => {
                const edge = roll.getBoundingClientRect().right;
                return [...roll.children].every(tick => tick.getBoundingClientRect().right <= edge + 0.5);
              }),
              true,
              'the roll fits beside the scoped counts',
            );
            return scope
              .locator('.ps')
              .evaluateAll(cells =>
                cells.map(cell => [...cell.children].map(part => part.textContent.trim())),
              );
          };
          const expected = [
            ['Done', count[0], 'Items'],
            ['In progress', count[1], unit],
            ['Left', count[2], 'Items'],
          ];
          assert.deepEqual(await standing(needs), expected, 'Needs me project labels, units and figures');
          // Plan names its next Item beside Left (mock 02-plan-board, d3357f40); Left already counts the proposals.
          const planned = await standing(plan);
          assert.ok(planned[2].at(-1).startsWith('· next: '), planned[2].at(-1));
          assert.deepEqual(
            planned.map((cell, i) => (i === 2 ? cell.slice(0, -1) : cell)),
            expected,
            'Plan project labels, units and figures',
          );
          const header = plan.locator('.plan-gh').filter({ hasText: 'Parser release' });
          const detail = await open(t, DESK, 'initiative', 'dark', {
            ...options,
            query,
            ready: '.plan-ini .plan-bd',
          });
          const progress = detail.getByRole('region', { name: 'Initiative progress', exact: true });
          const plus = name === 'capped' ? '+' : '';
          const total = `6${plus} Items`;
          const breakdown = `4${plus} done · 1 in progress · 0 open · 1${plus} removed`;
          assert.equal(await header.locator('.cnt').textContent(), total);
          assert.equal(await progress.getByText(total, { exact: false }).isVisible(), true);
          for (const part of [header.locator('.plan-bd'), progress.locator('.plan-bd')]) {
            assert.equal((await part.innerText()).replace(/\s+/g, ' ').trim(), breakdown);
          }
          assert.equal(await plan.getByText('Write the changelog', { exact: true }).count(), 0);
        },
      );
    }
    for (const type of [chromium, webkit, firefox]) {
      if (type !== chromium && !existsSync(type.executablePath())) {
        t.diagnostic(`Playwright ${type.name()} is absent; the hosted cache supplies Chromium.`);
        continue;
      }
      await t.test(`Dock: ${type.name()} mouse drops, persistence, menu, Undo and Reset`, async t => {
        const engine = type === chromium ? browser : await type.launch();
        if (engine !== browser) t.after(() => engine.close());
        const page = await open(t, { ...DESK, height: 1500 }, 'busy', 'dark', { engine });
        await checkDesktopDock(page);
      });
    }
    await t.test('Dock: moving Loose ends keeps the active query and its open content', async t => {
      const page = await open(t, DESK, 'busy', 'dark', { fixture: '/dock-subscription.html' });
      const changes = () => page.evaluate(() => window.dockSubscriptions);
      const initial = ['subscribe projectLooseEnds:read'];
      assert.deepEqual(
        await changes(),
        initial,
        'one subscription across first paint and behaviour attachment',
      );
      await page.getByText('Checked items', { exact: true }).click();
      await region(page, 'Loose ends').getByRole('button', { name: 'Move Loose ends' }).click();
      await page.getByRole('menuitem', { name: 'Into the right column' }).click();
      const moved = page.locator('[data-zone=b]').getByRole('region', { name: 'Loose ends' });
      await moved.waitFor();
      assert.ok(await moved.getByText('Checked for a holder.').isVisible(), 'the open disclosure stays open');
      assert.deepEqual(
        await changes(),
        initial,
        'moving the active region does not replace its query subscription',
      );
    });

    await t.test(
      'Dock: a region can measure its real width on first mount with a cold or warm layer',
      async t => {
        for (const data of ['cold', 'warm']) {
          const page = await open(t, DESK, data, 'dark', { fixture: '/dock-subscription.html' });
          const firstWidth = await region(page, 'Loose ends')
            .locator('details')
            .getAttribute('data-first-width');
          assert.ok(Number(firstWidth) > 0, `${data} layer: the region is connected and measurable at mount`);
        }
      },
    );

    await t.test('Dock: at phone width the keyboard carries within the flat Needs me layout', async t => {
      const page = await open(t, PHONE);
      await region(page, 'Needs you').getByRole('button', { name: 'Move Needs you', exact: true }).focus();
      await page.keyboard.press('Enter');
      const dock = page.locator('.dock[data-dock]');
      await page.locator('.dock[data-carrying]').waitFor();
      assert.deepEqual(await dock.locator('.zone-empty:visible').allTextContents(), []);

      const target = dock.getByText('Needs you, full-width row, 2nd', { exact: true });
      for (let i = 0; i < 4 && !(await target.isVisible()); i++) await page.keyboard.press('ArrowDown');
      assert.ok(await target.isVisible(), 'the drop line is between regions in the original column');
      await page.keyboard.press('Enter');
      await dock
        .getByText('Moved Needs you to the full-width row, position 2 of 4.', { exact: true })
        .waitFor();
      assert.deepEqual(await page.evaluate(() => window.dockWrites), ['set']);
    });

    await t.test('Dock: touch menu changes the drawn phone order, and reset restores it', async t => {
      const page = await open(t, PHONE, 'busy', 'dark', { hasTouch: true });
      await checkPhoneDock(page);
    });

    await t.test('a workflow hold opens the approval page for the exact submission', async t => {
      const page = await open(t, DESK, 'review');
      const needs = region(page, 'Needs you');
      const link = needs.getByRole('link', { name: 'Open approval' });
      assert.equal(
        await link.getAttribute('href'),
        '/approve?project=synthetic&submission=5d1c7a0e-0000-4000-8000-000000000501',
      );
      assert.match(await needs.locator('.why').textContent(), /\.github\/workflows\/ci\.yml/);
    });

    // Item 0a99ab23 line 1: a held landing's decline takes an optional typed reason, as the old /approve page did.
    await t.test(
      '0a99ab23: declining a held landing sends its attempt and the typed reason, or none',
      async t => {
        for (const viewport of [DESK, PHONE]) {
          const typed = await open(t, viewport, 'review');
          const row = region(typed, 'Needs you').locator('.dec', {
            hasText: 'Stream parser: handle split UTF-8',
          });
          await row.getByRole('button', { name: 'Decline', exact: true }).click();
          const why = row.getByRole('textbox', { name: /^Why/ });
          await why.fill('Touches CI; ask in the Lane first.');
          assert.match(await row.textContent(), /34\/500/);
          await row.getByRole('button', { name: 'Decline', exact: true }).click();
          const [write] = await typed.evaluate(() => window.writes);
          assert.equal(write[0], 'decide');
          assert.equal(write[1].decision, 'decline');
          assert.equal(write[1].landing.submissionId, '5d1c7a0e-0000-4000-8000-000000000501');
          assert.equal(write[1].reason, 'Touches CI; ask in the Lane first.');

          const plain = await open(t, viewport, 'review');
          const bare = region(plain, 'Needs you').locator('.dec', {
            hasText: 'Stream parser: handle split UTF-8',
          });
          await bare.getByRole('button', { name: 'Decline', exact: true }).click();
          await bare.getByRole('button', { name: 'Decline', exact: true }).click();
          const [none] = await plain.evaluate(() => window.writes);
          assert.equal(none[1].decision, 'decline');
          assert.equal('reason' in none[1], false, 'an empty reason is a plain decline');
        }
      },
    );

    await t.test(
      '0a99ab23: axe with the decline form open on Needs me: both themes, desk and phone',
      async t => {
        for (const viewport of [DESK, PHONE]) {
          const page = await open(t, viewport, 'review');
          const row = region(page, 'Needs you').locator('.dec', {
            hasText: 'Stream parser: handle split UTF-8',
          });
          await row.getByRole('button', { name: 'Decline', exact: true }).click();
          await row.getByRole('textbox', { name: /^Why/ }).fill('Touches CI; ask in the Lane first.');
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
            assert.ok(scroll <= inner, `no sideways scroll at ${viewport.width} ${theme}`);
            await page.evaluate(() => scrollTo(0, 0));
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
          }
        }
      },
    );

    await t.test('Needs you holds what waits on a person; agent conflicts and refusals are FYI', async t => {
      const page = await open(t, DESK);
      const shell = await page.locator('header.top a.needs .cnt').textContent();
      const own = await region(page, 'Needs you').locator('.ph .cnt').textContent();
      assert.equal(shell, own, 'the shell count is the page count');
      assert.equal(
        own,
        '4',
        'the protected-path approval, a question, a Lane parked for the reader and one parked with no one named, idle 5 h',
      );
      const needs = await region(page, 'Needs you').locator('h3').allTextContents();
      assert.ok(
        needs.some(text => text.startsWith('CI: drop Node 18')),
        'protected-path approval stays',
      );
      assert.ok(
        needs.some(text => text.startsWith('The adapter tests can run')),
        'the question stays',
      );
      assert.ok(needs.includes('Docs: queue limits page is parked for you.'), 'named to the reader: at once');
      assert.ok(
        needs.includes('Bench: replay the 12-Lane run is parked, no one named.'),
        'no one named, idle 5 h: in the starter’s Needs me',
      );
      assert.ok(!needs.some(text => text.startsWith('Parked an hour ago')), 'idle 1 h: not yet');
      assert.ok(!needs.some(text => text.includes('retry budget')), "an agent's conflict is not Needs you");
      assert.ok(!needs.some(text => text.includes('Release notes')), 'a refusal is not Needs you');
      const fyi = await region(page, 'FYI').locator('.fyi-row .ttl').allTextContents();
      assert.ok(
        fyi.some(text => text.includes('Adapter: retry budget for fetch conflicts with another change')),
      );
      assert.ok(fyi.some(text => /Forge refused the landing of Release notes for 3\.2/.test(text)));
      assert.ok(fyi.some(text => text.includes('next: sample-one/copper-moth reads why and lands again')));
      // A person's own failed check is theirs to fix, not a decision: FYI, by its real cause, never titled by a raw id.
      assert.ok(
        fyi.some(
          text => text.startsWith('Check failed') && text.includes('Lane 5d1c7a0e: its check failed.'),
        ),
      );
      const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
      assert.ok(![...needs, ...fyi].some(text => uuid.test(text)), 'no raw id as a title, anywhere');
      // Owner 2026-11-23 14:16Z: the FYI tile row is gone (its figures duplicated the Now tiles in a different, capped window).
      assert.equal(await region(page, 'FYI').locator('.nums').count(), 0);
      assert.doesNotMatch(
        await region(page, 'FYI').innerText(),
        /\b\d[\d,]*\+(?!\w)/,
        'no lower-bound "N+" count in FYI',
      );
      assert.equal(await page.locator('section.region[aria-label="Moving without you"]').count(), 0);
      assert.equal(await page.locator('section.region[aria-label="Also here"]').count(), 0);
      assert.equal(await page.evaluate(() => window.intervals), 0, 'no repeating timer: idle costs nothing');
    });

    await t.test('a hand-back and an asked-ahead question are actionable in Needs you', async t => {
      const page = await open(t, PHONE, 'conversation');
      const needs = region(page, 'Needs you');
      const handBack = needs.locator('.dec', { hasText: 'Tried both clients' });
      assert.match(await handBack.textContent(), /Decide which client ships/);
      assert.equal(
        await handBack.getByRole('link', { name: 'Open the thread' }).getAttribute('href'),
        '/sample-one/tidepool/lanes/5d1c7a0e-0000-4000-8000-000000000004/thread',
      );
      const ahead = needs.locator('.grp', { has: page.getByText('Asked ahead', { exact: true }) });
      assert.equal(await ahead.getByRole('button', { name: 'Use it', exact: true }).count(), 1);
      // Item 0a99ab23: a Lane request asked ahead opens its Lane page, which decides it on the Lane's current save.
      const request = page.locator('details.sumdec', { hasText: 'Touches the billing migration' });
      await request.locator('summary').click();
      assert.equal(
        await request.getByRole('link', { name: 'Review the Lane' }).getAttribute('href'),
        '/sample-one/tidepool/lanes/5d1c7a0e-0000-4000-8000-000000000009',
      );
      assert.equal(await request.getByRole('button', { name: 'Approve', exact: true }).count(), 0);
      assert.match(await needs.locator('.dec').first().textContent(), /Tried both clients/);
      await handBack.getByRole('textbox', { name: 'Reason (optional)' }).fill('I can finish this.');
      await handBack.getByRole('button', { name: 'Decline' }).click();
      assert.deepEqual(await page.evaluate(() => window.writes), [
        ['answer', '5d1c7a0e-0000-4000-8000-000000000071', 'Decline', 'I can finish this.'],
      ]);
    });

    await t.test(
      '4f1f7984: Asked ahead lists a requested Lane request, never a granted or declined one; axe in both themes at 390 and 1440',
      async t => {
        for (const viewport of [PHONE, DESK]) {
          const page = await open(t, viewport, 'conversation');
          const needs = region(page, 'Needs you');
          const ahead = needs.locator('.grp', { has: page.getByText('Asked ahead', { exact: true }) });
          assert.equal(
            await page.locator('details.sumdec', { hasText: 'Touches the billing migration' }).count(),
            1,
            `a requested one is listed at ${viewport.width}`,
          );
          assert.equal(await page.getByText('Granted two weeks ago', { exact: false }).count(), 0);
          assert.equal(await page.getByText('Declined last week', { exact: false }).count(), 0);
          assert.equal(await ahead.locator('details.sumdec').count(), 1, 'one request row, not three');
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
            assert.ok(scroll <= inner, `no sideways scroll at ${viewport.width} ${theme}`);
            await page.evaluate(() => scrollTo(0, 0));
            const violations = await page.evaluate(async () => {
              const result = await window.axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
              });
              return result.violations
                .filter(v => v.id !== 'label-content-name-mismatch')
                .map(
                  v =>
                    `${v.id}: ${v.nodes.map(n => `${n.target.join(' ')} ${JSON.stringify(n.any[0]?.data ?? '')}`).join(', ')}`,
                );
            });
            assert.deepEqual(violations, [], `axe at ${viewport.width} ${theme} asked ahead`);
            if (shots)
              await page.screenshot({
                path: join(shots, `needs-me-asked-ahead-${viewport.width}-${theme}.png`),
                fullPage: true,
              });
          }
        }
      },
    );

    await t.test(
      'filters, Dismiss and Clear all write once on the click; Loose ends is open by default',
      async t => {
        const page = await open(t, DESK);
        const fyi = region(page, 'FYI');
        await fyi.getByRole('radio', { name: /^Outside the code/ }).click();
        assert.equal(await fyi.locator('.fyi-row').count(), 2, 'a settings change and an invitation');
        await fyi.getByRole('radio', { name: /^All/ }).click();
        assert.deepEqual(await page.evaluate(() => window.writes), [], 'viewing and filtering write nothing');
        await fyi.locator('.fyi-x').first().click();
        await fyi.getByRole('button', { name: 'Clear all' }).click();
        const writes = await page.evaluate(() => window.writes);
        assert.equal(writes.length, 2);
        assert.equal(writes[0][0], 'dismiss');
        assert.match(writes[0][1].keys[0], /^[a-z]+:.+@.+$/, 'a dismissal names the row version');
        assert.deepEqual(writes[1], ['dismiss', { clearAll: true }]);
        const loose = region(page, 'Loose ends');
        const fold = loose.getByRole('button', { name: 'Loose ends', exact: true });
        assert.equal(await fold.getAttribute('aria-expanded'), 'true', 'open by default');
        assert.equal(await loose.locator('.loose-row').count(), 1);
        // Only groups with rows are listed; the groups not reported yet are named on hover, not as bands.
        assert.deepEqual(
          await loose
            .locator('.band')
            .allTextContents()
            .then(t => t.map(x => x.split(/\d/)[0])),
          ['Lanes nobody holds'],
        );
        assert.match(
          await loose.getByRole('link', { name: 'All loose ends, with picking many' }).getAttribute('title'),
          /^Not reported yet: .*leftover projects/,
        );
        await loose.getByRole('button', { name: 'Ask an agent to tidy up' }).click();
        const copied = (await page.evaluate(() => window.writes)).at(-1);
        assert.equal(copied[0], 'copy');
        assert.match(copied[1], /nforge agent \. lanes '\{"view":"loose-ends"\}'/);
        assert.match(copied[1], /groups\.stopped\.continueCursor.*"cursor".*all stopped rows/);
        // A reader who folds it is remembered: the next visit starts folded and reads nothing.
        await fold.click();
        await page.reload();
        await region(page, 'Loose ends').waitFor();
        assert.equal(
          await region(page, 'Loose ends')
            .getByRole('button', { name: 'Loose ends', exact: true })
            .getAttribute('aria-expanded'),
          'false',
        );
        assert.equal(
          await region(page, 'Loose ends').locator('.loose-row, .quietline').count(),
          0,
          'folded: nothing read',
        );
      },
    );

    await t.test('with no loose ends, the open panel says so on one line', async t => {
      for (const [viewport, width] of [
        [DESK, 1440],
        [PHONE, 390],
      ])
        for (const theme of ['dark', 'light']) {
          const page = await open(t, viewport, 'first', theme);
          const loose = region(page, 'Loose ends');
          assert.equal(
            await loose
              .getByRole('button', { name: 'Loose ends', exact: true })
              .getAttribute('aria-expanded'),
            'true',
          );
          const line = loose.locator('.quietline');
          assert.equal((await line.textContent()).trim(), 'No loose ends.');
          // One line: the words' boxes share one top (and the line is laid out: anything else fails with what was seen).
          const seen = await line.evaluate(element => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const rects = [...range.getClientRects()];
            const box = element.getBoundingClientRect();
            return {
              lines: new Set(rects.map(rect => Math.round(rect.top))).size,
              rects: rects.length,
              box: [Math.round(box.width), Math.round(box.height)],
            };
          });
          assert.equal(seen.lines, 1, `one line at ${width} ${theme}: ${JSON.stringify(seen)}`);
          assert.equal(await loose.locator('.band').count(), 0, 'no "not reported" bands');
          if (shots) await loose.screenshot({ path: join(shots, `needs-loose-empty-${width}-${theme}.png`) });
          if (shots)
            await page.screenshot({ path: join(shots, `needs-first-${width}-${theme}.png`), fullPage: true });
        }
    });

    // Item c63c2171: an agent's GitHub connect is a Forge decision in the agent's words; Allow goes on to GitHub.
    await t.test(
      'an agent GitHub connect asks in its words; Allow opens the GitHub authorization',
      async t => {
        const page = await open(t, PHONE, 'connect');
        const row = page.locator('details.sumdec');
        assert.equal(await row.count(), 1);
        assert.equal(
          (await row.locator('summary .ttl').textContent()).trim(),
          'Mirror main to synthetic/repo so reviewers on GitHub see each landing.',
        );
        assert.match(await row.locator('summary').textContent(), /GitHub/);
        await row.locator('summary').click();
        const allow = row.getByRole('button', { name: 'Allow on GitHub' });
        await allow.waitFor();
        await page.route('https://github.com/**', route =>
          route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>GitHub</title>' }),
        );
        await Promise.all([
          page.waitForURL(/^https:\/\/github\.com\/login\/oauth\/authorize/),
          allow.click(),
        ]);
        assert.equal(new URL(page.url()).searchParams.get('state'), 'synthetic');
      },
    );

    await t.test('axe and widths: busy and first day, both themes, desk and phone', async t => {
      for (const data of ['busy', 'first', 'connect'])
        for (const viewport of [DESK, PHONE]) {
          const page = await open(t, viewport, data); // Loose ends is open by default
          await page.addScriptTag({ path: axePath });
          for (const theme of ['dark', 'light']) {
            await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
            // A button eases its colours into the new theme; jump every transition to its end so axe reads the settled page.
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
            assert.ok(
              scroll <= inner,
              `no sideways scroll at ${viewport.width} ${theme} ${data}: ${scroll} > ${inner}`,
            );
            // Axe reads from the top, where the shell's sticky bar covers nothing.
            await page.evaluate(() => scrollTo(0, 0));
            const violations = await page.evaluate(async () => {
              const result = await window.axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
              });
              return (
                result.violations
                  // The shared top bar's line has one known finding the shell Lane owns (brief C2).
                  .filter(v => v.id !== 'label-content-name-mismatch')
                  .map(
                    v =>
                      `${v.id}: ${v.nodes.map(n => `${n.target.join(' ')} ${JSON.stringify(n.any[0]?.data ?? '')}`).join(', ')}`,
                  )
              );
            });
            assert.deepEqual(violations, [], `axe at ${viewport.width} ${theme} ${data}`);
            if (shots)
              await page.screenshot({
                path: join(shots, `needs-me-${data}-${viewport.width}-${theme}.png`),
                fullPage: true,
              });
          }
        }
    });
  } finally {
    await browser.close();
  }
});

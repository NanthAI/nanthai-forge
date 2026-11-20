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
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_NEEDS_SHOTS || null;
const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const FIXTURE = 'tests/browser/needs-me.tsx';

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

test('Needs me: what waits on you, FYI and loose ends; counts agree; axe and widths in both themes', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-needs-me-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch();
  async function open(t, viewport, data = 'busy', theme = 'dark') {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      // Idle costs nothing: count every repeating timer the page sets.
      window.intervals = 0;
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
      if (url.pathname === '/needs.html') return route.fulfill({ contentType: 'text/html', body: html });
      const file = join(out, url.pathname.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto(`https://forge.test/needs.html?data=${data}&theme=${theme}`);
    // The behaviour layer's Dock (data-dock) replaces the static one and remounts every region: wait for it, so a
    // test never holds a node the swap is about to detach.
    await page
      .locator('.dock[data-dock] .region')
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
      const tiles = await region(page, 'FYI').locator('.nums > div').allTextContents();
      assert.deepEqual(tiles, ['4landed', '0broke main', '1check redone', '4 minCI time thrown away']);
      assert.equal(await page.locator('section.region[aria-label="Moving without you"]').count(), 0);
      assert.equal(await page.locator('section.region[aria-label="Also here"]').count(), 0);
      assert.equal(await page.evaluate(() => window.intervals), 0, 'no repeating timer: idle costs nothing');
    });

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
    rmSync(out, { recursive: true, force: true });
  }
});

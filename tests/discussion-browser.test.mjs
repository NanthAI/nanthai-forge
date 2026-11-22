// SPDX-License-Identifier: Apache-2.0
// The Plan Item page with its discussion in a real browser (Item 9a3d6f5f), on synthetic data through its real
// components (tests/browser/discussion.tsx): the comments load on their own chunk with four reads and nothing on a
// clock, member HTML never runs, a reader of a public project sees no people and no composer, a typed label is marked
// as not verified, a comment posts once with the server choosing its writer, and axe is clean with no sideways scroll
// at desk and phone width in both themes. Set FORGE_DISCUSSION_SHOTS to a folder to also save the screenshots.
import test from 'node:test';
import { chromiumLaunchOptions, settleBrowserPage } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_DISCUSSION_SHOTS || null;
const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const fixture = join(root, 'tests/browser/discussion.tsx');

/** Build the fixture module as a page script, linking only the stylesheets its own chunks import. */
async function buildFixture(out) {
  const { build } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: { fixture } } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const entry = output.find(
    item => item.isEntry && item.facadeModuleId?.endsWith('tests/browser/discussion.tsx'),
  );
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
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Discussion fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

test('the Item page discussion: lazy reads, inert member HTML, readers, posting, axe and widths', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-discussion-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch(launchOptions);
  async function open(t, viewport, query = '') {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    page.on('dialog', dialog => errors.push(`dialog ${dialog.message()}`));
    page.on('requestfailed', request => {
      // The member text's outside image must never be requested; anything else failing is an error.
      errors.push(`failed ${request.url().slice(0, 80)}`);
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname === '/discussion.html') return route.fulfill({ contentType: 'text/html', body: html });
      const file = join(out, url.pathname.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto(`https://forge.test/discussion.html?${query}`);
    await page
      .locator('section[aria-label="Comments"] article')
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, [], 'no page errors, no outside requests');
    });
    return page;
  }
  const shot = async (page, name) => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  };

  try {
    await t.test(
      'a writer sees threads, decisions and reactions; the four scoped reads are on load',
      async t => {
        const page = await open(t, DESK);
        const section = page.locator('section[aria-label="Comments"]');
        assert.equal(await section.locator('.band .cnt').textContent(), '4');
        assert.equal(await section.locator('article').count(), 4);
        assert.equal(await section.locator('article.re').count(), 1, 'the reply sits under its root');
        assert.match(
          await section.locator('article').nth(2).locator('.by').textContent(),
          /keen-impala.*model not declared.*@sample-one/,
        );
        assert.match(
          await section.locator('article').nth(3).locator('.by').textContent(),
          /sample-threenot verified/,
        );
        assert.equal(await section.locator('img, script').count(), 0, 'member HTML never becomes elements');
        assert.equal(
          await section.getByRole('link', { name: 'the guide' }).getAttribute('title'),
          'Opens docs.example.com',
        );
        // Distinct subscriptions (a re-render re-attaches a watch to the same query; the client shares it).
        assert.deepEqual([...new Set(await page.evaluate(() => window.__calls))].sort(), [
          'planningReactions:forItem',
          'projectDiscussionThread:read',
          'projectWorkIndex:records',
          'projectWorkIndex:workspace',
        ]);
        await section.getByRole('textbox', { name: 'Comment' }).fill('Ship the guide **today**.');
        await section.getByRole('button', { name: /^Comment/ }).click();
        await page.waitForFunction(() => window.__writes.length === 1);
        const [[name, args]] = await page.evaluate(() => window.__writes);
        assert.equal(name, 'projectWorkCommand:command');
        const command = JSON.parse(args.command);
        assert.equal(command.action, 'comment-planning-item');
        assert.equal(command.operationId, args.operationId);
        assert.equal(command.text, 'Ship the guide **today**.');
        assert.equal(
          'authorLabel' in command,
          false,
          'the page sends no name: the server records the writer',
        );
        await shot(page, 'discussion-1440-dark');
      },
    );

    await t.test(
      'a new landing refreshes the older capsule page without dropping its boundary note',
      async t => {
        const page = await open(t, DESK, 'notePages=1');
        const section = page.locator('section[aria-label="Comments"]');
        const count = 'section[aria-label="Comments"] .band .cnt';
        await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '51', count);
        await page.evaluate(() => window.addLandingNote());
        await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '52', count);
        await section.getByRole('button', { name: /^Show .* earlier$/ }).click();
        await section.getByRole('button', { name: /^Show .* earlier$/ }).click();
        assert.equal(await section.getByText('Landing note 2', { exact: true }).count(), 1);
      },
    );

    await t.test('a reader of a public project sees no people, no composer and no reaction keys', async t => {
      const page = await open(t, DESK, 'viewer=reader');
      const section = page.locator('section[aria-label="Comments"]');
      assert.equal(await section.getByText('A member').count(), 0, 'never "A member" (Item 2fb69177)');
      assert.ok((await section.getByText('a person', { exact: true }).count()) >= 2, 'a person, unnamed');
      assert.ok(
        (await section.getByText('keen-impala', { exact: true }).count()) >= 1,
        'the agent run stays',
      );
      assert.equal(await section.getByText(/sample-(one|two)/).count(), 0, 'no person is named');
      assert.equal(await section.locator('textarea').count(), 0);
      assert.equal(await section.getByRole('button', { name: /React|Reply/ }).count(), 0);
      assert.equal(
        await section.locator('.who a').count(),
        0,
        'no hidden person or run gets an identity link',
      );
    });

    await t.test(
      'an Item question answers in place and a stopped agent has a copyable resume prompt',
      async t => {
        const page = await open(t, DESK, 'thread=1#discussion');
        const section = page.locator('section[aria-label="Comments"]');
        await page.waitForFunction(() => document.activeElement?.id === 'discussion');
        const pending = section.locator('[data-pinned]');
        assert.match(await section.locator('article').first().textContent(), /Which endpoint should we use/);
        await pending.getByRole('textbox', { name: 'Reason (optional)' }).fill('Both clients support it.');
        await pending.getByRole('button', { name: 'The new endpoint' }).click();
        await pending.getByRole('status').getByText('Answered “The new endpoint”.').waitFor();
        const [[name, { operationId, command }]] = await page.evaluate(() => window.__writes);
        assert.equal(name, 'projectCoordination:publish');
        assert.match(operationId, /^[a-f0-9-]{36}$/);
        assert.equal(command.kind, 'ack');
        assert.equal(command.choice, 'The new endpoint');
        assert.equal(command.text, 'Both clients support it.');
        await section.getByText('Resume prompt', { exact: true }).click();
        await section.getByText('Resume the release after reading the recorded answer.').waitFor();
        await page
          .context()
          .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://forge.test' });
        await section.getByRole('button', { name: 'Give this to your agent' }).click();
        await section.getByText('Resume prompt copied.').waitFor();
        assert.equal(
          await page.evaluate(() => navigator.clipboard.readText()),
          'Resume the release after reading the recorded answer.',
        );
      },
    );

    await t.test(
      'opened history follows answers and restarts at the current boundary after new messages',
      async t => {
        const page = await open(t, DESK, 'pages=1');
        const section = page.locator('section[aria-label="Comments"]');
        await section.getByRole('button', { name: 'Show 20 earlier' }).click();
        await section.getByRole('button', { name: 'Pick A' }).waitFor();
        await page.evaluate(() => window.changeThread('answer'));
        await section.getByText('Chosen elsewhere').waitFor();
        assert.equal(await section.getByRole('button', { name: 'Pick A' }).count(), 0);
        await page.evaluate(() => window.changeThread('append'));
        await section.getByText('Message 4', { exact: true }).waitFor();
        await section.getByRole('button', { name: 'Show 20 earlier' }).click();
        await section.getByText('Message 2', { exact: true }).waitFor();
        assert.equal(await section.getByText('Chosen elsewhere').count(), 1);
      },
    );

    await t.test('axe and widths: both themes, desk and phone', async t => {
      for (const viewport of [DESK, PHONE])
        for (const query of ['', 'viewer=reader', 'review=1', 'thread=1']) {
          const page = await open(t, viewport, query);
          await page.addScriptTag({ path: axePath });
          for (const theme of ['dark', 'light']) {
            await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
            // Colour transitions finish before axe reads the colours.
            await settleBrowserPage(page);
            const [scroll, inner] = await page.evaluate(() => [
              document.documentElement.scrollWidth,
              innerWidth,
            ]);
            assert.ok(
              scroll <= inner,
              `no sideways scroll at ${viewport.width} ${query} ${theme}: ${scroll} > ${inner}`,
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
            assert.deepEqual(violations, [], `axe at ${viewport.width} ${query} ${theme}`);
            if (!query || query === 'thread=1')
              await shot(page, `discussion${query ? '-thread' : ''}-${viewport.width}-${theme}`);
            if (query === 'review=1') {
              const section = page.locator('section[aria-label="Comments"]');
              assert.equal(await section.locator('article').count(), 5);
              assert.match(await section.textContent(), /Review · 2 findings/);
              assert.match(await section.textContent(), /R2 · nit · declined/);
              const record = section.getByText('Exact review record', { exact: true });
              await record.focus();
              const article = record.locator('xpath=ancestor::article');
              const by = await article.locator('.by').boundingBox();
              const actions = await article.locator('.acts').boundingBox();
              assert.ok(actions.y >= by.y + by.height, 'keyboard-visible actions never cover the writer');
              await page.keyboard.press('Enter');
              assert.equal(await section.locator('details').getAttribute('open'), '');
              assert.match(await section.locator('details pre').textContent(), /"head": "b{64}"/);
              await page.keyboard.press('Enter');
              await shot(page, `review-${viewport.width}-${theme}`);
            }
          }
        }
    });
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});

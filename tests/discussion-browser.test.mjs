// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
// A one-pixel picture: what the download route answers for an attachment the page asks to show.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Build the fixture module as a page script, linking only the stylesheets its own chunks import. */
async function buildFixture(out) {
  const { build } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    // The page reads its sign-in token from the auth package; the fixture has no sign-in, so it gets a fixed one.
    resolve: { alias: { '@convex-dev/auth/react': join(root, 'tests/browser/auth-stub.ts') } },
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
  async function open(t, viewport, query = '', handle = null, expected = []) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on(
      'console',
      message =>
        message.type() === 'error' &&
        !expected.some(pattern => pattern.test(message.text())) &&
        errors.push(message.text()),
    );
    page.on('dialog', dialog => errors.push(`dialog ${dialog.message()}`));
    page.on('requestfailed', request => {
      // Chromium reports the CORS preflight of a fulfilled cross-origin PUT as aborted; the PUT itself is checked.
      if (request.method() === 'OPTIONS') return;
      // The member text's outside image must never be requested; anything else failing is an error.
      errors.push(`failed ${request.url().slice(0, 80)} ${request.failure()?.errorText}`);
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (handle && (await handle(route, url))) return;
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname === '/discussion/attachment')
        return route.fulfill({ status: 200, contentType: 'image/png', body: png });
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
        // Item 686ecdde: an open reads one page, the newest 50 notes; the older page is read only when asked.
        await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '50', count);
        assert.match(await section.locator('.band').textContent(), /loaded so far/);
        await section.getByRole('button', { name: /^Show .* earlier$/ }).click();
        await section.getByRole('button', { name: /^Show .* earlier$/ }).click();
        await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '51', count);
        // A new landing moves the first page's boundary; the older page re-reads from the new cut.
        await page.evaluate(() => window.addLandingNote());
        await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '52', count);
        assert.equal(await section.getByText('Landing note 2', { exact: true }).count(), 1);
        assert.equal(await section.getByText('Landing note 1', { exact: true }).count(), 1);
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

    await t.test(
      '686ecdde: Versions reads the newest 100 on open and older ones only when asked',
      async t => {
        for (const viewport of [DESK, PHONE]) {
          const page = await open(t, viewport, 'versions=150');
          const reads = () =>
            page.evaluate(() =>
              [...new Set(window.__versionReads.map(read => JSON.stringify(read)))].map(JSON.parse),
            );
          assert.deepEqual(await reads(), [], 'an Item page reads no versions until the sheet opens');
          await page.getByRole('button', { name: 'Versions', exact: true }).click();
          const sheet = page.getByRole('dialog', { name: 'Version 149 beside version 150' });
          await sheet.waitFor();
          const first = await reads();
          assert.equal(first.length, 1, 'one page on open');
          assert.equal(first[0].newestFirst, true);
          assert.deepEqual(first[0].paginationOpts, { cursor: null, numItems: 100 });
          assert.equal(await sheet.getByLabel('Older').locator('option').count(), 100);
          await page.addScriptTag({ path: axePath });
          for (const theme of ['dark', 'light']) {
            await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
            await settleBrowserPage(page);
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
                v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`,
              );
            });
            assert.deepEqual(violations, [], `axe on Versions at ${viewport.width} ${theme}`);
            await shot(page, `versions-${viewport.width}-${theme}`);
          }
          await sheet.getByRole('button', { name: 'Read older versions' }).click();
          await sheet.getByLabel('Older').locator('option').nth(149).waitFor({ state: 'attached' });
          const all = await reads();
          assert.equal(all.length, 2, 'asking reads exactly one more page');
          assert.equal(all[1].paginationOpts.cursor, '51');
          assert.equal(await sheet.getByRole('button', { name: 'Read older versions' }).count(), 0);
        }
      },
    );

    await t.test(
      'attachments: inline images by need, forced downloads, the daily-limit message, and an upload that posts once',
      async t => {
        const reads = [];
        const puts = [];
        let limited = false;
        const page = await open(
          t,
          DESK,
          'files=1',
          async (route, url) => {
            if (url.pathname.startsWith('/r2-put/')) {
              puts.push({
                method: route.request().method(),
                bytes: route.request().postDataBuffer()?.length,
                header: await route.request().headerValue('x-amz-checksum-sha256'),
              });
              await route.fulfill({
                status: 200,
                body: '',
              });
              return true;
            }
            if (url.pathname !== '/discussion/attachment') return false;
            const id = url.searchParams.get('attachmentId');
            reads.push({ id, auth: await route.request().headerValue('authorization') });
            if (limited)
              await route.fulfill({
                status: 429,
                contentType: 'application/json',
                body: JSON.stringify({
                  code: 'ATTACHMENT_DOWNLOAD_LIMIT',
                  message:
                    "Forge's daily attachment download limit for this project (2 GB) is used up. Downloads resume at 00:00 UTC.",
                }),
              });
            else if (id === 'att-html')
              await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: '<script>window.ran = true</script>',
              });
            else await route.fulfill({ status: 200, contentType: 'image/png', body: png });
            return true;
          },
          [/status of 429/],
        );
        const section = page.locator('section[aria-label="Comments"]');
        const card = section.locator('article', { hasText: 'Screenshots and the notes' });
        // The small image shows by itself; the 2 MB one waits for a click, so opening an Item spends nothing on it.
        await card.locator('img[alt="shot.png"]').waitFor();
        assert.match(await card.locator('img[alt="shot.png"]').getAttribute('src'), /^blob:/);
        assert.deepEqual(
          reads.map(read => read.id),
          ['att-small'],
          'one read on open: only the small image, signed in',
        );
        assert.equal(reads[0].auth, 'Bearer fixture-token');
        assert.equal(await card.locator('img[alt="big.png"]').count(), 0);
        await card.getByRole('button', { name: 'Show big.png (2.0 MB)' }).click();
        await card.locator('img[alt="big.png"]').waitFor();
        assert.deepEqual(
          reads.map(read => read.id),
          ['att-small', 'att-big'],
        );
        // A file name is text: its markup never becomes an element, and a file is never drawn as a page.
        assert.equal(await card.locator('b, script, iframe, object, embed').count(), 0);
        const html = card.getByRole('button', { name: 'page.html (1 KB)' });
        const [download] = await Promise.all([page.waitForEvent('download'), html.click()]);
        assert.equal(download.suggestedFilename(), 'page.html');
        assert.equal(await page.evaluate(() => window.ran), undefined, 'downloaded HTML never runs');
        assert.equal(await card.locator('iframe').count(), 0);
        // Past the daily allowance the route's own message is shown, with the reset time.
        limited = true;
        await card.getByRole('button', { name: /notes <b>bold<\/b>\.pdf/ }).click();
        assert.match(
          await card.getByRole('alert').textContent(),
          /daily attachment download limit for this project \(2 GB\) is used up\. Downloads resume at 00:00 UTC\./,
        );
        // The composer: choose files, see them, remove one, and be told when one is over its limit.
        const composer = section.locator('form.compose').last();
        await composer.locator('input[type=file]').setInputFiles([
          { name: 'a.png', mimeType: 'image/png', buffer: png },
          { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('plain') },
        ]);
        assert.equal(await composer.locator('.attached li').count(), 2);
        await composer.getByRole('button', { name: 'Remove b.txt' }).click();
        assert.equal(await composer.locator('.attached li').count(), 1);
        await composer.locator('input[type=file]').setInputFiles({
          name: 'huge.png',
          mimeType: 'image/png',
          buffer: Buffer.alloc(10_000_001),
        });
        assert.match(
          await composer.getByRole('alert').textContent(),
          /huge\.png is over the 10 MB limit for images/,
        );
        assert.equal(await composer.locator('.attached li').count(), 1, 'a refused file is not added');
        await composer.getByRole('textbox', { name: 'Comment' }).fill('Here is the shot.');
        await composer.getByRole('button', { name: /^Comment/ }).click();
        await page.waitForFunction(() => window.__writes.length === 3);
        const [[prepare, args], [commit, commitArgs], [command, posted]] = await page.evaluate(
          () => window.__writes,
        );
        assert.equal(prepare, 'discussionAttachmentUpload:prepare');
        assert.deepEqual(
          { name: args.name, size: args.size, contentType: args.contentType },
          { name: 'a.png', size: png.length, contentType: 'image/png' },
        );
        assert.match(args.digest, /^[0-9a-f]{64}$/);
        assert.equal(commit, 'discussionAttachmentUpload:commit');
        assert.equal(commitArgs.commentId, args.commentId, 'the file is bound to the comment it will join');
        assert.equal(command, 'projectWorkCommand:command');
        const body = JSON.parse(posted.command);
        assert.equal(posted.operationId, args.commentId);
        assert.deepEqual(body.attachments, [
          { id: commitArgs.attachmentId, name: 'a.png', size: png.length, contentType: 'image/png' },
        ]);
        assert.deepEqual(puts, [{ method: 'PUT', bytes: png.length, header: 'AAAA' }]);
      },
    );

    await t.test('axe and widths: both themes, desk and phone', async t => {
      for (const viewport of [DESK, PHONE])
        for (const query of ['', 'viewer=reader', 'review=1', 'thread=1', 'files=1']) {
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

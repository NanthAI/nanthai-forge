// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Secrets page (Item 41a0df87, slice 4), drawn from synthetic overview data in the real project frame: the words
// follow the design, no value or key has any surface, commands carry the full proposal id, the page reads names only
// once (never a subscription), and every state holds at 1440 and 390 px in both themes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';
import { moduleUrl } from './convex-module.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const model = await import(moduleUrl('../web/src/app/secrets/secrets-model.ts'));

test('the page words follow the design copy and each command is one value-free line with the full id', () => {
  const set = patch => ({
    kind: 1,
    sharing: 'automatic',
    headVersion: 1,
    takeOut: [],
    proposals: [],
    rotate: { total: 0, page: [], next: null },
    names: { total: 18, page: [], next: null },
    ...patch,
  });
  const read = (...sets) => ({ status: 'ok', now: 0, needs: 0, sets });
  const rotating = {
    rotate: {
      total: 3,
      page: [{ name: 'A', kind: 1, version: 1, devices: [{ code: 'R2PA-9XNE', handle: 'dana' }], more: 0 }],
      next: null,
    },
  };
  const proposal = { id: 'a'.repeat(32), op: 2, name: 'N', kind: 1, from: 'X', handle: null, at: 1 };
  assert.deepEqual(model.sentence(read(set({ ...rotating, proposals: [proposal, proposal] }))), {
    lead: '3 secrets need a new value',
    rest: ' after @dana left. 2 proposals wait for a person.',
  });
  assert.equal(
    model.sentence(
      read(
        set({
          rotate: {
            total: 1,
            page: [{ name: 'A', kind: 1, version: 1, devices: [{ code: 'X', handle: null }], more: 0 }],
            next: null,
          },
        }),
      ),
    ).rest,
    ' after a computer was removed.',
  );
  assert.deepEqual(model.sentence(read(set({ proposals: [proposal] }))), {
    lead: '1 proposal waits for a person.',
    rest: ' 18 secrets in 1 set.',
  });
  assert.equal(
    model.sentence(read(set({ takeOut: [{ handle: 'dana', left: true, at: 1, codes: ['K7QD-2MWX'] }] })))
      .lead,
    '1 removed computer still holds Development.',
  );
  assert.deepEqual(
    model.sentence(read(set({}), set({ kind: 2, names: { total: 0, page: [], next: null } }))),
    {
      lead: '18 secrets in 2 sets.',
      rest: ' Nothing needs you.',
    },
  );
  assert.equal(model.sentence(read()).lead, 'This project has no secrets yet.');
  const id = '3f9a12c04b7e5d1a9c2e8f60b3d417aa';
  assert.equal(model.applyCommand(id), `nforge secret apply ${id}`);
  assert.equal(model.rejectCommand(id), `nforge secret reject ${id}`);
  assert.equal(model.setCommand('SIGNING_KEY.pem', 2), 'nforge secret set SIGNING_KEY.pem --file');
  assert.equal(model.setCommand("x' ; $(false)", 1), "nforge secret set 'x'\\'' ; $(false)'");
  assert.equal(model.setCommand('API_TOKEN', 1, 2), 'nforge secret set API_TOKEN --set checks');
  assert.equal(model.setCommand('KEY.pem', 2, 2), 'nforge secret set KEY.pem --set checks --file');
  assert.equal(model.setCommand('API_TOKEN', 1, 3), null, 'Production has no CLI selector, so no command');
  assert.equal(model.relative(1000, 1000 + 12 * 60_000), '12 min ago');
  assert.equal(model.relative(0, 3 * 86_400_000), '3 d ago');
  assert.equal(model.relative(0, 86_400_000 + 5), 'yesterday');
});

test('guard: the page reads names once, one-shot; it never references a value, ciphertext or proposal read', () => {
  const dir = join(root, 'web/src/app/secrets');
  const source = readdirSync(dir)
    .filter(file => /\.tsx?$/.test(file))
    .map(file => readFileSync(join(dir, file), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /sealedSecrets\.(read|proposals|write|join|link|propose|reject)\b/);
  assert.doesNotMatch(source, /sealedSecrets:(?!overview)/);
  assert.doesNotMatch(
    source,
    /\buseQuery\b|\buseMutation\b|\buseAction\b|\bsetInterval\b|\.subscribe\b|onUpdate/,
  );
  assert.equal(
    [...source.matchAll(/api\.sealedSecrets\.(\w+)/g)].every(m => m[1] === 'overview'),
    true,
  );
  assert.match(source, /convex\.query\(api\.sealedSecrets\.overview/);
  assert.doesNotMatch(source, /<input|<textarea|contentEditable/);
  // The whole web bundle: no module reads a sealed value or proposal bytes (those are the CLI's alone).
  const walk = folder =>
    readdirSync(folder, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? walk(join(folder, entry.name)) : [join(folder, entry.name)],
    );
  for (const file of walk(join(root, 'web/src')).filter(file => /\.tsx?$/.test(file)))
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /sealedSecrets[.:](read|proposals|write|join|link|propose|reject)\b/,
      file,
    );
});

test('slice 4 review: a Show-the-next page joins only the snapshot that asked for it; a denial clears the page', () => {
  const page = (names, extra = {}) => ({
    total: 3,
    page: names.map(name => ({ name })),
    next: null,
    ...extra,
  });
  const data = {
    status: 'ok',
    now: 0,
    needs: 0,
    sets: [
      { kind: 1, headVersion: 4, rotate: page(['A', 'B'], { next: 'B' }) },
      { kind: 2, headVersion: 9, rotate: page(['Z'], { total: 1 }) },
    ],
  };
  const reply = (kind, headVersion, rotate) => ({ status: 'ok', sets: [{ kind, headVersion, rotate }] });
  // The same head and total: the page joins, and other sets are untouched.
  const joined = model.appendPage(data, 1, 'rotate', reply(1, 4, page(['C'])));
  assert.equal(joined.to, 'ready');
  assert.deepEqual(
    joined.data.sets[0].rotate.page.map(r => r.name),
    ['A', 'B', 'C'],
  );
  assert.equal(joined.data.sets[1], data.sets[1]);
  assert.equal(joined.data.sets[0].rotate.next, null);
  // Someone rotated 2 of 3 meanwhile: the reply is one name of a total of one. Old rows are not kept.
  assert.deepEqual(model.appendPage(data, 1, 'rotate', reply(1, 4, page(['C'], { total: 1 }))), {
    to: 'again',
  });
  // A new head with an unchanged total is also another snapshot.
  assert.deepEqual(model.appendPage(data, 1, 'rotate', reply(1, 5, page(['C']))), { to: 'again' });
  // A reply for another set, or without the part, never joins.
  assert.deepEqual(model.appendPage(data, 1, 'rotate', reply(2, 4, page(['C']))), { to: 'again' });
  assert.deepEqual(model.appendPage(data, 1, 'rotate', { status: 'ok', sets: [] }), { to: 'again' });
  // A reader reply is an access denial.
  assert.deepEqual(model.appendPage(data, 1, 'rotate', { status: 'reader' }), { to: 'reader' });
  for (const code of ['AUTH_REQUIRED', 'AUTH_REVOKED', 'AUTH_SCOPE_DENIED', 'PROJECT_UNAVAILABLE'])
    assert.equal(model.accessDenied(code), true, code);
  for (const code of [undefined, 'RATE_LIMITED', 'SECRETS_NOT_ALLOWED'])
    assert.equal(model.accessDenied(code), false, String(code));
});

test('Secrets: value-free screen, honest states, accessible themes, no sideways scroll', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const server = await createServer({
    root: join(root, 'web'),
    configFile: false,
    logLevel: 'silent',
    cacheDir: join(root, 'node_modules/.cache/secrets-vite'),
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    plugins: [
      {
        name: 'secrets-test-only',
        configureServer(s) {
          s.middlewares.use('/fixture.html', (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(
              `<html lang="en"><head><title>Secrets fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="/@fs/${root}tests/browser/secrets.tsx"></script></body></html>`,
            );
          });
        },
      },
    ],
  });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch(launchOptions);
  t.after(() => browser.close());
  const context = await browser.newContext({
    locale: 'en-US',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const errors = [];
  const unexpected = [];
  page.on('pageerror', () => errors.push('pageerror'));
  page.on('request', req => {
    if (req.method() !== 'GET' || !req.url().startsWith(base))
      unexpected.push(`${req.method()} ${req.url()}`);
  });
  const open = async (state = 'calm', theme = 'dark') => {
    await page.goto(`${base}/fixture.html?state=${state}&theme=${theme}`);
    await page.locator('.secrets-screen .head').waitFor();
    await page.evaluate(() => document.fonts.ready);
  };
  const show = name =>
    page.evaluate(name => window.secretsFixture.show(window.secretsFixture.state(name)), name);
  const shots = process.env.FORGE_SECRETS_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const capture = async name => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  };
  const sentence = () => page.locator('.secrets-screen .sit').innerText();

  await t.test(
    'after a removal: three bands in order, the same count everywhere, full ids in the commands',
    async () => {
      await open('removal');
      assert.equal(
        await sentence(),
        '3 secrets need a new value after @dana left. 2 proposals wait for a person.',
      );
      const needs = page.getByRole('region', { name: 'Needs you', exact: true });
      assert.deepEqual(await needs.locator('.band > span:first-child').allInnerTexts(), [
        'Take out removed computers',
        'To rotate',
        'Proposals',
      ]);
      assert.equal(await needs.locator('.secret-need').count(), 6);
      assert.equal((await needs.locator('.ph .cnt').innerText()).trim(), '6');
      await needs.getByRole('button', { name: 'Copy: nforge secret unshare --marked' }).click();
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        'nforge secret unshare --marked',
      );
      await needs.getByRole('button', { name: 'Copy apply' }).first().click();
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        'nforge secret apply 3f9a12c04b7e5d1a9c2e8f60b3d417aa',
      );
      await needs.getByRole('button', { name: 'Copy reject' }).nth(1).click();
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        'nforge secret reject a81c0e5f92d34b07e6a1c9d8f2b4e0c3',
      );
      assert.match(await needs.innerText(), /change\s+API_TOKEN\s+\(env\)/);
      assert.match(await needs.innerText(), /remove\s+LEGACY_WEBHOOK_SECRET\s+\(removal\)/);
      assert.match(await needs.innerText(), /fp R2PA-9XNE \(@dana\) could open v7/);
      await page.getByRole('button', { name: 'Copy command' }).nth(1).click();
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        'nforge secret set SIGNING_KEY.pem --file',
      );
      // Names carry the facts, not the commands (rule 9).
      const names = page.getByRole('region', { name: 'Names', exact: true });
      assert.equal(await names.getByText('To rotate', { exact: true }).count(), 3);
      assert.equal(await names.getByText('1 proposal waits').count(), 1);
      assert.equal(await names.getByRole('button').count(), 0);
      assert.equal(await page.locator('input:not([type=radio]),textarea,[contenteditable=true]').count(), 0);
      await capture('removal');
    },
  );

  await t.test('nothing needs you: no Needs you region and no orange anywhere', async () => {
    await open('calm');
    assert.equal(await sentence(), '6 secrets in 2 sets. Nothing needs you.');
    assert.equal(await page.getByRole('region', { name: 'Needs you', exact: true }).count(), 0);
    assert.equal(await page.locator('.cnt.hot, [data-st=waiting]').count(), 0);
    assert.match(await page.getByRole('region', { name: 'Names' }).innerText(), /new computers: Automatic/);
    // The viewer's own computers show their name; no other person's name ever appears.
    const holders = await page.getByRole('region', { name: 'Who can open them' }).innerText();
    assert.match(holders, /desk machine/);
    assert.equal((holders.match(/“/g) ?? []).length, 3);
    await capture('calm');
  });

  await t.test(
    'empty, loading, reader, failed and nobody states say what happened and keep what was shown',
    async () => {
      await open('empty');
      assert.equal(await sentence(), 'This project has no secrets yet.');
      await page.getByRole('button', { name: 'Copy: nforge secret set NAME' }).waitFor();
      assert.equal(await page.getByText('Proposed', { exact: true }).count(), 1);
      await show('loading');
      assert.equal(await sentence(), 'Loading secrets…');
      await show('reader');
      assert.equal(await sentence(), 'Secrets are for people who can write.');
      assert.equal(await page.getByRole('region', { name: 'Names' }).count(), 0);
      await show('failed');
      assert.equal(await sentence(), 'Secrets could not be loaded. Nothing was changed.');
      assert.equal(await page.locator('.row.secret-name').count(), 6);
      assert.match(
        await page.locator('.notice').innerText(),
        /Below is what this page last showed, at \d\d:\d\d\./,
      );
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      assert.equal(await page.evaluate(() => window.secretsFixture.refreshes), 1);
      await show('failed-empty');
      await page.getByText('No secret names were returned.', { exact: true }).waitFor();
      await show('nobody');
      await page.getByText('No value', { exact: true }).waitFor();
      assert.match(
        await page.locator('.quietline').innerText(),
        /Nobody can open Checks\. Its 4 names stay listed/,
      );
    },
  );

  await t.test(
    'worst case: long, one-letter and emoji handles, 787 to rotate, 32 proposals, paged names and people',
    async () => {
      await open('worst');
      assert.equal(await page.locator('.secret-need').count(), 1 + 100 + 32);
      assert.match(
        await page.getByRole('region', { name: 'Needs you' }).innerText(),
        /100 of 787 to rotate shown/,
      );
      assert.match(
        await page.getByRole('region', { name: 'Needs you' }).innerText(),
        /the most Development holds/,
      );
      assert.equal(await page.getByRole('button', { name: 'Show the next 100' }).count(), 2);
      assert.equal(await page.getByRole('button', { name: 'Show the next 25' }).count(), 1);
      await page.getByRole('button', { name: 'Show the next 25' }).click();
      assert.deepEqual(await page.evaluate(() => window.secretsFixture.more), ['1:people']);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await capture('worst');
    },
  );

  await t.test(
    'the container: a denial clears the page, a stale reply is dropped, a page of another snapshot restarts the read',
    async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      const container = async () => {
        await page.goto(`${base}/fixture.html?container=1&theme=dark`);
        await page.evaluate(() => window.secretsContainer.overview(0));
        await page.getByRole('region', { name: 'Needs you' }).waitFor();
      };
      const call = (fn, ...args) =>
        page.evaluate(([fn, args]) => window.secretsContainer[fn](...args), [fn, args]);
      const asked = () => page.evaluate(() => window.secretsContainer.queries().length);
      const rows = () => page.locator('.secret-need').count();
      const more = () =>
        page.getByRole('region', { name: 'Needs you' }).getByRole('button', { name: 'Show the next 100' });
      const version = () => page.evaluate(() => window.secretsContainer.headVersion);
      // A reader reply to a page is an access denial: nothing the page showed stays.
      await container();
      const before = await rows();
      await more().click();
      await call('reader', 1);
      await page.getByText('Secrets are for people who can write.').waitFor();
      assert.equal(await page.locator('.secret-need, .row.secret-name').count(), 0);
      // An authorization error clears it too; any other failure keeps the last snapshot.
      await container();
      await more().click();
      await call('fail', 1, 'AUTH_REVOKED');
      await page.getByText('No secret names were returned.').waitFor();
      assert.equal(await page.locator('.secret-need, .row.secret-name').count(), 0);
      await container();
      await more().click();
      await call('fail', 1);
      await page.getByText(/Below is what this page last showed/).waitFor();
      assert.equal(await rows(), before);
      // The first read's error, a lost grant: no snapshot to keep.
      await container();
      await page.getByRole('button', { name: 'Refresh' }).click();
      await call('fail', 1, 'PROJECT_UNAVAILABLE');
      await page.getByText('No secret names were returned.').waitFor();
      // Refresh while a page is out: the page's reply is dropped, then the fresh overview replaces the rows.
      await container();
      await more().click();
      await page.getByRole('button', { name: 'Refresh' }).click();
      assert.equal(await asked(), 3);
      await call('page', 1, 'rotate', 787, await version(), ['LATE_ROW']);
      assert.equal(await rows(), before, 'a superseded reply changes nothing');
      await call('overview', 2);
      await page.getByRole('button', { name: 'Refresh' }).waitFor();
      assert.equal(await page.getByText('LATE_ROW').count(), 0);
      // The set moved on before the page came back (a total of 1): the old rows are not combined with it.
      await container();
      await more().click();
      await call('page', 1, 'rotate', 1, await version(), ['LAST_ROW']);
      await page.waitForFunction(() => window.secretsContainer.queries().length === 3);
      assert.equal(await page.getByText('LAST_ROW').count(), 0);
      assert.equal(await rows(), before, 'the rows stay as shown until the new read arrives');
      await call('overview', 2);
      await page.getByRole('button', { name: 'Refresh' }).waitFor();
      // An unchanged snapshot takes the page: 100 shown, 787 to rotate, one more row.
      await container();
      await more().click();
      await call('page', 1, 'rotate', 787, await version(), ['NEXT_ROW']);
      await page.getByText('NEXT_ROW').waitFor();
      assert.equal(await rows(), before + 1);
      assert.equal(await asked(), 2, 'a page costs one read, nothing restarts');
    },
  );

  await t.test('all states: axe and no horizontal overflow at 1440 and 390, in both themes', async () => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const theme of ['dark', 'light']) {
        await open('calm', theme);
        await page.addScriptTag({ path: createRequire(import.meta.url).resolve('axe-core/axe.min.js') });
        for (const name of [
          'calm',
          'removal',
          'takeout',
          'proposals',
          'empty',
          'reader',
          'failed',
          'failed-empty',
          'nobody',
          'worst',
        ]) {
          await show(name);
          await page.evaluate(() => new Promise(requestAnimationFrame));
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `no overflow: ${width} ${theme} ${name}`,
          );
          const violations = await page.evaluate(async () =>
            (
              await window.axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
              })
            ).violations.map(v => v.id),
          );
          assert.deepEqual(violations, [], `axe: ${width} ${theme} ${name}`);
          if (['calm', 'removal', 'empty', 'worst'].includes(name))
            await capture(`${name}-${width}-${theme}`);
        }
      }
    }
  });

  await t.test('an idle screen schedules no calls, timers or storage writes', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open('removal');
    const before = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }));
    await page.clock.install();
    await page.clock.fastForward(600_000);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward(600_000);
    assert.deepEqual(
      await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })),
      before,
    );
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
  });
});

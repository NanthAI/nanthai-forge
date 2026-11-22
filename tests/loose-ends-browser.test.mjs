// SPDX-License-Identifier: Apache-2.0
// Needs me › Loose ends (Item fc1831eb) in a real browser, on synthetic data through the real shell frame and route
// screen (tests/browser/loose-ends.tsx): route entry subscribes once to the details read and nothing runs while idle;
// a hidden tab drops it and catches up with one subscription; each Show 25 more is one call with the group's cursor,
// an empty continued page keeps going, and a failed page retries only itself; dated checks link to their Item; a Lane
// saved meanwhile is skipped and named, and retry repeats only the Lane whose call failed; selection works from the
// keyboard with a mixed group tick and Esc; Hand to an agent copies one prompt and calls nothing; Undo brings back
// the Lanes set aside and restores projects moved to the trash at their pinned versions; a project changed meanwhile
// is skipped and named and a failed trash call alone retries; axe is clean with no sideways scroll at desk and phone
// width in both themes for demo, worst case, one, empty, loading, failed and a partial result. Set FORGE_LOOSE_SHOTS
// to a folder to keep screenshots.
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
const shots = process.env.FORGE_LOOSE_SHOTS || null;
const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const FIXTURE = 'tests/browser/loose-ends.tsx';
const READ = 'projectLooseEnds:read';
const SET_ASIDE = 'projectHostedDormant:abandon';
const TRASH = 'projectLifecycle:trash';
const RESTORE = 'projectLifecycle:restore';
const laneId = n => `5d1c7a0e-0000-4000-8000-${String(n).padStart(12, '0')}`;

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
      rolldownOptions: { input: { 'loose-ends': join(root, FIXTURE) } },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const chunks = new Map(output.map(item => [item.fileName, item]));
  const entry = output.find(item => item.isEntry && item.facadeModuleId?.endsWith(FIXTURE));
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
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Loose ends fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

test('Loose ends page: one details read, paged groups, set-aside results and retry, axe and widths', async t => {
  const launchOptions = chromiumLaunchOptions(t);
  if (!launchOptions) return;
  const out = mkdtempSync(join(tmpdir(), 'forge-loose-ends-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch(launchOptions);
  async function open(t, viewport, query = {}, ready = '.loose-ends .row.le') {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      // Idle costs nothing: count every repeating timer the page sets.
      window.intervals = 0;
      const original = window.setInterval;
      window.setInterval = (...args) => (window.intervals++, original(...args));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname === '/loose-ends.html') return route.fulfill({ contentType: 'text/html', body: html });
      const file = join(out, url.pathname.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto(`https://forge.test/loose-ends.html?${new URLSearchParams({ data: 'demo', ...query })}`);
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
  const calls = page => page.evaluate(() => [...window.calls]);
  const group = (page, name) => page.getByRole('group', { name, exact: true });
  const said = page => page.locator('[data-announce]').textContent();
  try {
    await t.test(
      'route entry reads the details once; idle reads nothing; a hidden tab catches up once',
      async t => {
        const page = await open(t, DESK);
        assert.deepEqual(await calls(page), [`subscribe ${READ} {"details":true}`]);
        assert.equal(await page.evaluate(() => window.intervals), 0, 'nothing on the page sets a timer');
        await page.evaluate(() => window.reads.sleep());
        await page.evaluate(() => window.reads.wake());
        assert.deepEqual(await calls(page), [
          `subscribe ${READ} {"details":true}`,
          `unsubscribe ${READ}`,
          `subscribe ${READ} {"details":true}`,
        ]);
        assert.equal(
          await page.locator('.row.le').count(),
          9,
          'the rows stay while asleep and after the catch-up',
        );
      },
    );

    await t.test('the five groups in order, with their evidence and dated Item links', async t => {
      const page = await open(t, DESK);
      const bands = await page.locator('.le-group > .band > span:first-of-type').allTextContents();
      assert.deepEqual(bands, [
        'Lanes nobody holds',
        'Checked, never landed',
        'Stopped mid-task',
        'Leftover projects',
        'Waiting for a date',
      ]);
      // Lead mock check (c): the row details come from fields stored on the rows, in the mock's words.
      assert.match(
        await group(page, 'Checked, never landed').locator('.row.le').textContent(),
        /Docs: typo sweep.*mara\/still-heron.*passed its check 3 days ago; landing was never asked for.*3 days.*Hand to an agent/,
      );
      const idleRows = group(page, 'Lanes nobody holds').locator('.row.le');
      assert.match(await idleRows.nth(0).textContent(), /3 saves, 2 files, never landed.*6 days/);
      assert.match(await idleRows.nth(1).textContent(), /1 save, 7 files, never landed.*3 days/);
      assert.match(await idleRows.nth(2).textContent(), /1 save, 1 file, landed before/);
      const dated = group(page, 'Waiting for a date');
      const link = dated.getByRole('link', { name: 'Open the Item' }).first();
      assert.equal(
        await link.getAttribute('href'),
        '/-/sample-one/tidepool/plan/0e6c1f2a-0000-4000-8000-000000000001',
      );
      assert.match(
        await dated.locator('.row.le').first().textContent(),
        /Done-when line 3 on the Item “v3 release”.*due 1 December/,
      );
      assert.match(await dated.locator('.row.le').nth(1).textContent(), /was due 20 November/);
      const projects = group(page, 'Leftover projects');
      assert.match(
        await projects.locator('.row.le').nth(1).textContent(),
        /tidepool-import-test.*@sample-one.*310 MB, 0 open Lanes.*never landed.*Move to the trash/,
      );
      assert.match(
        await projects.locator('.row.le').nth(0).textContent(),
        /mara-scratch.*12 MB, 0 open Lanes/,
      );
      // Lead mock check (d): owner, Move to the trash, and the projects waiting for a permanent-delete approval.
      const wait = projects.getByRole('link', { name: /40 projects in the trash wait for you/ });
      assert.equal(await wait.getAttribute('href'), '/-/account?request=req-1');
      assert.match(await wait.textContent(), /an agent or device asked to delete them for good/);
      const stopped = group(page, 'Stopped mid-task');
      assert.match(
        await stopped.locator('.row.le').textContent(),
        /jun\/copper-moth.*3 saves not landed\. Why it stopped: not reported.*not seen for 3 h.*Hand to an agent/,
      );
      // (b) identities read whole, as owner/lane; (f) a dated row names its Item's owner and says proposed.
      assert.match(
        await group(page, 'Lanes nobody holds').locator('.row.le').nth(1).textContent(),
        /mara\/salt-wren/,
      );
      assert.match(
        await dated.locator('.row.le').first().locator('.le-what').textContent(),
        /@mara.*proposed/,
      );
      assert.equal(await dated.locator('.row.le').nth(1).locator('.prop').count(), 0);
      // (e) every actionable group has its tick; dated checks only open their Item.
      for (const name of ['Lanes nobody holds', 'Stopped mid-task', 'Leftover projects'])
        assert.equal(await group(page, name).locator('.band input[type=checkbox]').count(), 1, name);
      assert.equal(await dated.locator('input[type=checkbox]').count(), 0);
      // (a) the mock sentence; a group not reported says so only on its band.
      const head = await page.locator('.head').textContent();
      assert.match(
        head,
        /9 or more loose ends, 1 urgent\. The oldest is a Lane with no save for 6 days\. Setting a Lane aside keeps every save; a project in the trash can be restored for 90 days\./,
      );
      assert.doesNotMatch(head, /not reported/);
    });

    await t.test(
      'Select all reads the rest of Lanes nobody holds, one call per page, and picks every one',
      async t => {
        const page = await open(t, DESK, { data: 'worst' });
        const idle = group(page, 'Lanes nobody holds');
        // Lanes written before the counts existed say "not recorded"; none shows an invented number.
        assert.match(
          await idle.locator('.row.le').nth(2).textContent(),
          /saves not recorded, no files yet(?!, never)/,
        );
        assert.match(
          await idle.locator('.row.le').first().textContent(),
          /1,284 saves, 12,840 files, never landed/,
        );
        await idle.getByRole('checkbox').nth(1).check();
        const bulk = page.getByRole('region', { name: 'Selected' });
        await bulk.getByRole('button', { name: 'Select all 25 or more Lanes nobody holds' }).click();
        await bulk.getByText('26 selected').waitFor();
        assert.deepEqual((await calls(page)).slice(1), [`query ${READ} idle-p2`]);
        assert.equal(await bulk.getByRole('button', { name: /Select all/ }).count(), 0, 'all are picked');
        assert.match(await bulk.textContent(), /Set aside 26/);
        const projects = group(page, 'Leftover projects');
        assert.match(await projects.locator('.row.le').nth(0).textContent(), /1\.2 TB, 37 open Lanes/);
        assert.match(
          await projects.locator('.row.le').nth(1).textContent(),
          /size not recorded, open Lanes not recorded/,
        );
        assert.match(await projects.locator('.row.le').nth(2).textContent(), /0 MB, 0 open Lanes/);
      },
    );

    await t.test('Hand to an agent copies one prompt for the picked Lanes and calls nothing', async t => {
      const page = await open(t, DESK);
      await group(page, 'Lanes nobody holds').getByRole('checkbox').nth(1).check();
      await group(page, 'Stopped mid-task').getByRole('checkbox').first().check();
      const bulk = page.getByRole('region', { name: 'Selected' });
      assert.match(await bulk.textContent(), /2 selected.*Set aside 1.*Hand to an agent/);
      await bulk.getByRole('button', { name: 'Hand to an agent' }).click();
      await page
        .locator('.toasts')
        .getByText(/Copied one prompt that hands 2 Lanes to an agent/)
        .waitFor();
      const [text] = await page.evaluate(() => window.copied);
      assert.match(text, /start --open .*"takeover":true/);
      assert.match(
        text,
        /of the Forge project "tidepool" \(project ID fixture-project\)/,
        'the prompt names its project',
      );
      assert.ok(text.includes(laneId(1)) && text.includes(laneId(4)), 'both picked Lanes are in the prompt');
      assert.equal(await page.locator('.toasts').getByRole('button', { name: 'Undo' }).count(), 0);
      await group(page, 'Stopped mid-task').getByRole('button', { name: 'Hand to an agent' }).click();
      await page
        .locator('.toasts')
        .getByText(/Copied a prompt that hands this Lane/)
        .waitFor();
      assert.deepEqual((await calls(page)).slice(1), [], 'copying a prompt calls nothing');
    });

    await t.test(
      'Undo brings back the Lanes the last set-aside changed, pinned to their versions',
      async t => {
        const page = await open(t, DESK);
        const idle = group(page, 'Lanes nobody holds');
        await idle.getByRole('checkbox', { name: 'Select Fix flaky retry timer' }).check();
        await idle.getByRole('checkbox', { name: 'Select Revert the parser rewrite' }).check();
        await page
          .getByRole('region', { name: 'Selected' })
          .getByRole('button', { name: 'Set aside 2' })
          .click();
        const toast = page.locator('.toasts');
        await toast.getByText('Set aside 2 Lanes. Every save is kept.').waitFor();
        await page.waitForFunction(() => document.querySelectorAll('.row.le').length === 7);
        await toast.getByRole('button', { name: 'Undo' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.row.le').length === 9);
        assert.match(await said(page), /Brought back 2 Lanes\. The Lanes are open again\./);
        assert.deepEqual(
          (await calls(page)).filter(call => call.startsWith('mutation')),
          [
            `mutation ${SET_ASIDE} ${JSON.stringify([laneId(1), laneId(3)])}`,
            `mutation ${SET_ASIDE} reopen ${JSON.stringify([
              { laneId: laneId(1), version: 5 },
              { laneId: laneId(3), version: 5 },
            ])}`,
          ],
        );
      },
    );

    await t.test(
      'a partial result offers See what is left and Undo, and Undo touches only what changed',
      async t => {
        const page = await open(t, DESK);
        const idle = group(page, 'Lanes nobody holds');
        await idle.getByRole('checkbox', { name: 'Select the 3 shown in Lanes nobody holds' }).check();
        await page
          .getByRole('region', { name: 'Selected' })
          .getByRole('button', { name: 'Set aside 3' })
          .click();
        const notice = page.getByRole('alert');
        await notice.getByText(/1 could not be set aside/).waitFor();
        assert.match(
          await notice.textContent(),
          /2 Lanes were set aside in your last try\. “Try streaming decoder” skipped: it was saved meanwhile\. Every save is kept\./,
        );
        await notice.getByRole('button', { name: 'Undo' }).click();
        await page.waitForFunction(() =>
          document.querySelector('[data-announce]')?.textContent.includes('Brought back 2'),
        );
        assert.equal(
          (await calls(page)).at(-1),
          `mutation ${SET_ASIDE} reopen ${JSON.stringify([
            { laneId: laneId(1), version: 5 },
            { laneId: laneId(3), version: 5 },
          ])}`,
          'the skipped Lane is not part of Undo',
        );
        // See what is left names every row left alone; the notice stays until the next action.
        await notice.getByRole('button', { name: 'See what is left' }).click();
        assert.equal(await notice.getByRole('button', { name: 'See what is left' }).count(), 0);
        assert.match(await notice.textContent(), /“Try streaming decoder” skipped: it was saved meanwhile/);
      },
    );

    await t.test('the project this page belongs to is not moved to the trash from its own page', async t => {
      const page = await open(t, DESK, { here: 'p2' });
      const projects = group(page, 'Leftover projects');
      const own = projects.locator('.row.le').nth(1);
      const button = own.getByRole('button', { name: 'Move to the trash' });
      assert.equal(await button.isDisabled(), true);
      assert.match(await button.getAttribute('title'), /Open another project to move it to the trash/);
      assert.equal(await own.getByRole('checkbox').count(), 0, 'no tick for it either');
      await projects.getByRole('checkbox', { name: 'Select the 1 shown in Leftover projects' }).check();
      await page
        .getByRole('region', { name: 'Selected' })
        .getByRole('button', { name: 'Move 1 to the trash' })
        .click();
      await page
        .locator('.toasts')
        .getByText(/mara-scratch moved to the trash/)
        .waitFor();
      assert.deepEqual(
        (await calls(page)).filter(call => call.startsWith('mutation')),
        ['mutation projectLifecycle:trash p1 11'],
        'only the other project',
      );
    });

    await t.test(
      'trash: a project changed meanwhile is skipped and named, a failed call alone retries, Undo restores',
      async t => {
        const page = await open(t, DESK, { fail: 'trash' });
        const projects = group(page, 'Leftover projects');
        await projects.getByRole('checkbox', { name: 'Select the 2 shown in Leftover projects' }).check();
        await page
          .getByRole('region', { name: 'Selected' })
          .getByRole('button', { name: 'Move 2 to the trash' })
          .click();
        const notice = page.getByRole('alert');
        await notice.getByText(/2 could not be moved to the trash/).waitFor();
        assert.match(
          await notice.textContent(),
          /“mara-scratch” could not be reached; “tidepool-import-test” skipped: it changed meanwhile/,
        );
        await notice.getByRole('button', { name: 'Retry 1 that failed' }).click();
        await notice.getByText(/^1 could not be moved to the trash/).waitFor();
        await notice.getByRole('button', { name: 'Undo' }).click();
        await page.waitForFunction(() =>
          document.querySelector('[data-announce]')?.textContent.includes('Restored 1 project'),
        );
        assert.deepEqual(
          (await calls(page)).filter(call => call.startsWith('mutation')),
          [
            `mutation ${TRASH} p1 11`,
            `mutation ${TRASH} p2 12`,
            `mutation ${TRASH} p1 11`,
            `mutation ${RESTORE} p1 12`,
          ],
          'one call per project; the retry carries only the failed one; Undo restores at the next revision',
        );
        await projects.getByText('mara-scratch').waitFor();
      },
    );

    await t.test('each Show 25 more is one call with its cursor; an empty page keeps going', async t => {
      const page = await open(t, DESK);
      const dated = group(page, 'Waiting for a date');
      await dated.getByRole('button', { name: 'Show 25 more' }).click();
      await page.waitForFunction(() =>
        document.querySelector('[data-announce]')?.textContent.includes('more remain'),
      );
      assert.equal(await dated.locator('.row.le').count(), 2, 'an empty page adds nothing');
      await dated.getByRole('button', { name: 'Show 25 more' }).click();
      await dated.locator('.row.le').nth(2).waitFor();
      assert.equal(
        await dated.getByRole('button', { name: 'Show 25 more' }).count(),
        0,
        'the last page ends the group',
      );
      const idle = group(page, 'Lanes nobody holds');
      await idle.getByRole('button', { name: 'Show 25 more' }).click();
      await idle.getByText('Older experiment').waitFor();
      assert.equal(
        await group(page, 'Stopped mid-task').locator('.row.le').count(),
        1,
        'an idle page leaves stopped alone',
      );
      assert.deepEqual((await calls(page)).slice(1), [
        `query ${READ} dated-p2`,
        `query ${READ} dated-p3`,
        `query ${READ} idle-p2`,
      ]);
    });

    await t.test('a failed page says so; Try again repeats only that page', async t => {
      const page = await open(t, DESK, { fail: 'page' });
      const projects = group(page, 'Leftover projects');
      await projects.getByRole('button', { name: 'Show 25 more' }).click();
      await projects.getByText('Could not load the next page. Nothing changed.').waitFor();
      assert.match(await said(page), /Could not load more\. Nothing changed\./);
      await projects.getByRole('button', { name: 'Try again' }).click();
      await projects.getByText('tidepool-docs-old').waitFor();
      assert.deepEqual((await calls(page)).slice(1), [
        `query ${READ} projects-p2`,
        `query ${READ} projects-p2`,
      ]);
    });

    await t.test('a cursor the Plan outdated restarts its group from the live first page', async t => {
      const page = await open(t, DESK, { fail: 'stale' });
      const dated = group(page, 'Waiting for a date');
      await dated.getByRole('button', { name: 'Show 25 more' }).click();
      await page.waitForFunction(() =>
        document.querySelector('[data-announce]')?.textContent.includes('starts again'),
      );
      assert.equal(await dated.getByText('Could not load the next page', { exact: false }).count(), 0);
      assert.equal(await dated.locator('.row.le').count(), 2);
      await dated.getByRole('button', { name: 'Show 25 more' }).click();
      await page.waitForFunction(() =>
        document.querySelector('[data-announce]')?.textContent.includes('more remain'),
      );
      assert.deepEqual((await calls(page)).slice(1), [`query ${READ} dated-p2`, `query ${READ} dated-p2`]);
    });

    await t.test(
      'a Lane saved meanwhile is skipped and named; retry repeats only the failed Lane',
      async t => {
        const page = await open(t, DESK, { fail: 'set' });
        const idle = group(page, 'Lanes nobody holds');
        const row = n => idle.locator('.row.le').nth(n);
        await row(0).getByRole('button', { name: 'Set aside' }).click();
        await row(0).getByText('Could not set aside').waitFor();
        await row(1).getByRole('checkbox').check();
        await row(2).getByRole('checkbox').check();
        await page
          .getByRole('region', { name: 'Selected' })
          .getByRole('button', { name: 'Set aside 2' })
          .click();
        // Both leave the live read at once; the one saved meanwhile is still named, from its title at submission.
        const notice = page.getByRole('alert');
        await notice.getByText(/2 could not be set aside/).waitFor();
        await page.waitForFunction(() => document.querySelectorAll('.row.le').length === 7);
        assert.match(
          await notice.textContent(),
          /1 Lane was set aside in your last try\. “Try streaming decoder” skipped: it was saved meanwhile; “Fix flaky retry timer” could not be reached\. Every save is kept\./,
        );
        await notice.getByRole('button', { name: 'Retry 1 that failed' }).click();
        await notice.getByText(/^1 could not be set aside/).waitFor();
        assert.equal(
          await notice.getByRole('button', { name: /Retry/ }).count(),
          0,
          'nothing failed is left',
        );
        await notice.getByRole('button', { name: 'See what is left' }).click();
        assert.equal(await notice.getByRole('button', { name: 'See what is left' }).count(), 0);
        assert.match(await notice.textContent(), /“Try streaming decoder” skipped/);
        assert.deepEqual(
          (await calls(page)).filter(call => call.startsWith('mutation')),
          [
            `mutation ${SET_ASIDE} ${JSON.stringify([laneId(1)])}`,
            `mutation ${SET_ASIDE} ${JSON.stringify([laneId(2), laneId(3)])}`,
            `mutation ${SET_ASIDE} ${JSON.stringify([laneId(1)])}`,
          ],
          'one call per action, and the retry carries only the failed Lane',
        );
      },
    );

    await t.test(
      'selection from the keyboard: a mixed group tick, Esc clears; a member picks nothing',
      async t => {
        const page = await open(t, DESK);
        const idle = group(page, 'Lanes nobody holds');
        await idle.getByRole('checkbox', { name: 'Select Fix flaky retry timer' }).focus();
        await page.keyboard.press('Space');
        const bulk = page.getByRole('region', { name: 'Selected' });
        assert.match(await bulk.textContent(), /1 selected/);
        const all = idle.getByRole('checkbox', { name: 'Select the 3 shown in Lanes nobody holds' });
        assert.equal(await all.evaluate(box => box.indeterminate), true);
        await page.keyboard.press('Escape');
        assert.equal(await bulk.count(), 0);
        await all.focus();
        await page.keyboard.press('Space');
        assert.match(await bulk.textContent(), /3 selected/);
        await page.keyboard.press('Tab');
        assert.equal(
          await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
          'Select Fix flaky retry timer',
        );
        const member = await open(t, DESK, { owner: '0' });
        for (const name of ['Lanes nobody holds', 'Stopped mid-task'])
          assert.equal(await group(member, name).locator('input[type=checkbox]').count(), 0, name);
        assert.equal(await member.getByRole('button', { name: 'Set aside' }).count(), 0);
      },
    );

    await t.test('empty, loading and a failed read that retries', async t => {
      const empty = await open(t, PHONE, { data: 'empty' }, '.loose-ends .quietline');
      assert.match(await empty.locator('.head').textContent(), /Nothing is left lying around\./);
      assert.match(await empty.locator('.quietline').first().textContent(), /^No loose ends\./);
      assert.equal(
        await group(empty, 'Checked, never landed').count(),
        0,
        'a group with nothing is not drawn',
      );
      const loading = await open(t, PHONE, { data: 'loading' }, '.loose-ends [aria-busy=true]');
      assert.equal(await loading.locator('.skrow').count(), 6);
      const failed = await open(t, PHONE, { data: 'error' }, '.loose-ends .notice');
      assert.match(
        await failed.getByRole('alert').textContent(),
        /Could not load.*Nothing was set aside or moved\./,
      );
      await failed.getByRole('button', { name: 'Try again' }).click();
      await failed.locator('.row.le').first().waitFor();
      assert.equal(await failed.getByRole('alert').count(), 0);
      assert.deepEqual(
        (await calls(failed)).slice(1),
        [`unsubscribe ${READ}`, `subscribe ${READ} {"details":true}`],
        'Try again subscribes afresh; a one-shot read would return the cached failure',
      );
      const worst = await open(t, PHONE, { data: 'worst' });
      assert.match(
        await group(worst, 'Waiting for a date').textContent(),
        /Dated checks may be incomplete\./,
      );
    });

    await t.test('axe and widths: every state, both themes, desk and phone', async t => {
      for (const [state, ready] of [
        ['demo'],
        ['worst'],
        ['one'],
        ['empty', '.loose-ends .quietline'],
        ['loading', '.loose-ends [aria-busy=true]'],
        ['error', '.loose-ends .notice'],
        ['partial'],
      ])
        for (const viewport of [DESK, PHONE]) {
          const data = state === 'partial' ? 'demo' : state;
          const page = await open(t, viewport, { data }, ready);
          const idle = group(page, 'Lanes nobody holds');
          // As the approved page's "Some selected": the first two Lanes nobody holds are picked.
          if (data === 'demo') for (const n of [1, 2]) await idle.getByRole('checkbox').nth(n).check();
          if (state === 'partial') {
            await page
              .getByRole('region', { name: 'Selected' })
              .getByRole('button', { name: 'Set aside 2' })
              .click();
            await page
              .getByRole('alert')
              .getByText(/could not be set aside/)
              .waitFor();
          }
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
            assert.ok(
              scroll <= inner,
              `no sideways scroll at ${viewport.width} ${theme} ${state}: ${scroll} > ${inner}`,
            );
            await page.evaluate(() => scrollTo(0, 0));
            const violations = await page.evaluate(async () => {
              const result = await window.axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
              });
              return (
                result.violations
                  // The shared top bar's line has one known finding the shell Lane owns (brief C2).
                  .filter(v => v.id !== 'label-content-name-mismatch')
                  .map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)
              );
            });
            assert.deepEqual(violations, [], `axe at ${viewport.width} ${theme} ${state}`);
            if (shots)
              await page.screenshot({
                path: join(shots, `loose-${state}-${viewport.width}-${theme}.png`),
                fullPage: true,
              });
          }
        }
    });
  } finally {
    await browser.close();
  }
});

// SPDX-License-Identifier: Apache-2.0
// Trash and Move to trash as real components with synthetic rows (Items 8fba39a4, SPEC-01-trash): the Trash lists soonest
// first with one row form per phase; Restore is one press with an Undo; Delete forever needs the typed name; only owners
// get the "…" key in Projects; Move to trash is always a sheet that starts on "Keep it". Every state passes axe with no
// sideways scroll at 1440 and 390 in both themes. Set FORGE_TRASH_SHOTS to a folder to save screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { root, testBrowser, viewFixture } from './app-view-fixture.mjs';

const shots = process.env.FORGE_TRASH_SHOTS;
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TrashView } from ${JSON.stringify(join(root, 'web/src/app/trash/Trash.tsx'))};
import { ProjectsView } from ${JSON.stringify(join(root, 'web/src/app/projects/Projects.tsx'))};
import { AccountFrame } from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const now = Date.parse('2026-11-22T12:00:00Z');
const day = 86400000;
const tr = (id, fields = {}) => ({ id, key: id + '-key', handle: 'sample-owner', slug: id, name: id, currentBackup: null, revision: 3, removal: 'trash',
  removedAt: now - 12 * day, retention: { purgeAt: now + 78 * day, retainedBytes: 1.2 * 1024 ** 3, retainedObjects: 40, measured: true }, ...fields });
const left = (n, extra = {}) => ({ purgeAt: now + n * day, retainedBytes: 48 * 1024 ** 2, retainedObjects: 1, measured: true, ...extra });
const sample = [
  tr('tidepool-bench-zoo-07', { retention: left(2) }),
  tr('tidepool-site-old'),
  tr('kelp-fork', { retention: left(90, { revoking: true, retainedBytes: 310 * 1024 ** 2 }) }),
];
const LONG = 'tidepool-benchmark-streaming-backpressure-integration-fixtures-zoo-n10-rerun-2';
const worst = [
  tr(LONG, { retention: left(0) }),
  tr('x', { retention: left(1, { retainedBytes: 0 }) }),
  tr('ストリームパーサー検証用プロジェクト', { slug: 'stream-parser-kensho', retention: { ...left(73), measured: false } }),
  tr('مشروع محلل التدفق', { slug: 'stream' }),
  tr('🦀 crab-bench', { removal: 'deleting', purgeBlocked: 'R2_PURGE_RETRY_EXHAUSTED', retention: undefined }),
  tr('tidepool-bench-2025', { removal: 'deleted', retention: undefined, removedAt: now - 260 * day }),
  tr('being-deleted', { removal: 'deleting', retention: undefined }),
  ...Array.from({ length: 20 }, (_, i) => tr('tidepool-bench-zoo-' + String(i + 1).padStart(2, '0'), { retention: left(83) })),
];
const query = new URLSearchParams(location.search);
const s = query.get('s') || 'trash';
window.calls = [];
const call = name => async (...args) => { window.calls.push({ name, id: args[0]?.id ?? args[0]?.name }); };
const actions = {
  restore: async project => { window.calls.push({ name: 'restore', id: project.id }); return async () => { if (query.get('undo') === 'refused') throw new Error('The project changed after you restored it, so Undo left it alone.'); window.calls.push({ name: 'undo', id: project.id }); }; },
  forever: async (project, typed) => { window.calls.push({ name: 'forever', id: project.id, typed }); },
  retry: call('retry'),
  empty: call('empty'),
};
const c = (n, atLeast = false) => ({ n, atLeast });
const proj = (id, role, fields = {}) => ({ id, name: id, handle: 'sample-owner', slug: id, revision: 4, role, visibility: 'private', activityAt: now - 3600000,
  held: c(0), lanes: c(2), main: null, items: null, ...fields });
const projects = [proj('docs-site', 'owner'), proj('stream-parser', 'owner', { held: c(1) }), proj('shared-tools', 'write'), proj('reading-room', 'read')];
const view = s === 'projects'
  ? <ProjectsView read={{ state: 'ok', data: { projects, more: false } }} retry={() => {}} now={now}
      moveToTrash={async row => { window.calls.push({ name: 'trash', id: row.id, revision: row.revision }); }} />
  : <TrashView
      read={s === 'loading' ? { state: 'loading' } : s === 'none' ? { state: 'ok', data: { projects: [], more: false } }
        : s === 'error' ? { state: 'failed', at: now - 120000, last: { projects: sample, more: false } }
        : { state: 'ok', data: { projects: s === 'worst' ? worst : sample, more: s === 'worst' } }}
      retry={() => { window.calls.push({ name: 'reread' }); }} showMore={() => { window.calls.push({ name: 'more' }); }} now={now} actions={actions} />;
createRoot(document.getElementById('root')).render(
  <AccountFrame place="projects" back={null} controls={{ viewerHandle: 'sample-owner', onPalette() {}, onKeys() {} }}>{view}</AccountFrame>,
);
`;

test('trash: forms per phase, restore with Undo, typed delete, owner-only menu and the Move sheet, and every state passes axe', async t => {
  const executablePath = testBrowser(t);
  if (!executablePath) return;
  const browser = await chromium.launch({ executablePath });
  const fx = await viewFixture(t, fixture, 'Trash', browser);
  const { open, check } = fx;
  if (shots) mkdirSync(shots, { recursive: true });
  {
    const { page, errors, context } = await open(1440, 'light', 's=trash');
    const main = page.locator('main');
    assert.match(
      await main.locator('.head').textContent(),
      /3 projects in the trash, 1\.5 GB\. tidepool-bench-zoo-07 is deleted for good in 2 days\./,
    );
    assert.deepEqual(
      await main.locator('.row.tr .ttl').allTextContents(),
      ['tidepool-bench-zoo-07', 'tidepool-site-old', 'kelp-fork'],
      'soonest first',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Restore' }).nth(2).isDisabled(),
      true,
      'restore waits while access is being removed',
    );
    assert.equal(await page.getByRole('link', { name: 'Trash' }).getAttribute('aria-current'), 'page');
    await page.getByRole('button', { name: 'Restore' }).first().click();
    await page
      .getByText(
        /Restored tidepool-bench-zoo-07\. Other people.s access, runners and tokens did not come back\./,
      )
      .waitFor();
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.waitForFunction(() => window.calls.some(call => call.name === 'undo'));
    assert.deepEqual(
      (await page.evaluate(() => window.calls)).map(call => call.name),
      ['restore', 'undo'],
    );
    await context.close();
  }
  {
    // An Undo the server refuses (someone joined after the restore) says so; it never vanishes silently.
    const { page, context } = await open(1440, 'light', 's=trash&undo=refused');
    await page.getByRole('button', { name: 'Restore' }).first().click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('The project changed after you restored it, so Undo left it alone.').waitFor();
    assert.equal(
      (await page.evaluate(() => window.calls)).some(call => call.name === 'undo'),
      false,
    );
    await context.close();
  }
  {
    const { page, errors, context } = await open(1440, 'light', 's=trash');
    // The sheet: the Delete forever key stays off until the exact name is typed; Esc keeps the project.
    await page.getByRole('button', { name: 'Delete forever' }).nth(1).click();
    const dialog = page.getByRole('dialog');
    const field = dialog.getByRole('textbox');
    assert.equal(await field.evaluate(e => e === document.activeElement), true, 'focus starts in the field');
    const go = dialog.getByRole('button', { name: 'Delete forever' });
    assert.equal(await go.isDisabled(), true);
    await field.fill('tidepool-site');
    assert.equal(await go.isDisabled(), true, 'a near miss does not enable it');
    await field.fill('tidepool-site-old');
    assert.equal(await go.isDisabled(), false);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(
      (await page.evaluate(() => window.calls)).some(call => call.name === 'forever'),
      false,
      'Esc deletes nothing',
    );
    await page.getByRole('button', { name: 'Delete forever' }).nth(1).click();
    await page.getByRole('dialog').getByRole('textbox').fill('tidepool-site-old');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete forever' }).click();
    await page.waitForFunction(() => window.calls.some(call => call.name === 'forever'));
    assert.deepEqual((await page.evaluate(() => window.calls)).at(-1), {
      name: 'forever',
      id: 'tidepool-site-old',
      typed: 'tidepool-site-old',
    });
    await page.keyboard.press('c');
    assert.match(await page.locator('.cli-out').textContent(), /nforge host \. --delete-projects --trash/);
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const { page, context } = await open(390, 'dark', 's=worst');
    const text = await page.locator('main').textContent();
    assert.match(text, /At least 27 projects in the trash/);
    assert.match(text, /No time left/);
    assert.match(text, /Could not delete/);
    assert.match(text, /Retry/);
    assert.match(text, /Removal was never confirmed/);
    assert.match(text, /not reported/);
    assert.match(text, /1 day left/);
    assert.doesNotMatch(text, /1 days/);
    assert.match(text, /Deleting/);
    assert.match(text, /shown; the trash has more\./);
    await context.close();
  }
  {
    // Projects: only rows the person owns get the "…" key; the Move sheet starts on "Keep it" and names what is lost.
    const { page, context } = await open(1440, 'light', 's=projects');
    assert.equal(await page.getByRole('button', { name: /^More for / }).count(), 2);
    assert.equal(
      await page.getByRole('button', { name: 'More for shared-tools' }).count(),
      0,
      'a write member has no key',
    );
    assert.equal(
      await page.getByRole('button', { name: 'More for reading-room' }).count(),
      0,
      'a reader has no key',
    );
    await page.getByRole('button', { name: 'More for docs-site' }).click();
    assert.equal(
      await page.getByRole('menuitem', { name: 'Project settings' }).getAttribute('href'),
      '/sample-owner/docs-site/settings/project',
    );
    await page.getByRole('menuitem', { name: 'Move to trash' }).click();
    const sheet = page.getByRole('dialog');
    assert.match(await sheet.textContent(), /Move docs-site to the trash\?/);
    assert.match(
      await sheet.textContent(),
      /Everyone loses access now, you included\. Its 2 open Lanes stop where they are; every save is kept\./,
    );
    assert.match(await sheet.textContent(), /Other people.s access, invitations, runners and tokens\./);
    assert.match(await sheet.textContent(), /20 February 2027/);
    assert.equal(
      await sheet.getByRole('button', { name: /Keep it/ }).evaluate(e => e === document.activeElement),
      true,
      'focus starts on Keep it',
    );
    await sheet.getByRole('button', { name: 'Move to trash' }).click();
    await page
      .getByText('Moved docs-site to the trash. It can be restored until 20 February 2027.')
      .waitFor();
    assert.deepEqual((await page.evaluate(() => window.calls)).at(-1), {
      name: 'trash',
      id: 'docs-site',
      revision: 4,
    });
    assert.equal(
      await page.getByRole('button', { name: 'More for docs-site' }).count(),
      0,
      'the row left Projects',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Undo' }).count(),
      0,
      'no Undo: restore does not bring access back',
    );
    await context.close();
  }
  for (const state of ['trash', 'worst', 'none', 'loading', 'error', 'projects'])
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark']) {
        const { page, errors, context } = await open(width, theme, `s=${state}`);
        await check(page, `${state} ${width} ${theme}`);
        if (state === 'trash') {
          await page.getByRole('button', { name: 'Delete forever' }).first().click();
          await page.getByRole('dialog').waitFor();
          await check(page, `delete sheet ${width} ${theme}`);
        }
        if (state === 'projects') {
          await page.getByRole('button', { name: 'More for docs-site' }).click();
          await page.getByRole('menuitem', { name: 'Move to trash' }).click();
          await page.getByRole('dialog').waitFor();
          await check(page, `move sheet ${width} ${theme}`);
        }
        if (shots)
          await page.screenshot({
            path: join(shots, `trash-${state}-${width}-${theme}.png`),
            fullPage: true,
          });
        assert.deepEqual(errors, []);
        await context.close();
      }
});

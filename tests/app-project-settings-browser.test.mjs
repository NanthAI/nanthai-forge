// SPDX-License-Identifier: Apache-2.0
// Settings > Project as real components with synthetic data (Item 966cb821): the facts, the owner's rename (one operation
// kept across a failed save), Move to trash, backups with Download and the recovery request, storing an archive, and
// removing an import. A member who is not the owner sees the facts and none of the controls. Every state passes axe with
// no sideways scroll at 1440 and 390 in both themes. Set FORGE_PROJECT_SETTINGS_SHOTS to save screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { root, testBrowser, viewFixture } from './app-view-fixture.mjs';

const shots = process.env.FORGE_PROJECT_SETTINGS_SHOTS;
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectSettingsView } from ${JSON.stringify(join(root, 'web/src/app/project-settings/ProjectSettingsView.tsx'))};
import { BackupsView } from ${JSON.stringify(join(root, 'web/src/app/project-settings/BackupsView.tsx'))};
import { ImportsView } from ${JSON.stringify(join(root, 'web/src/app/project-settings/Imports.tsx'))};
import { ProjectFrame } from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const now = Date.parse('2026-11-22T12:00:00Z');
const q = new URLSearchParams(location.search);
const owner = q.get('who') !== 'member';
const worst = q.get('data') === 'worst';
window.calls = [];
const facts = { name: worst ? 'A very long project name that keeps going well past any sensible width for a settings row' : 'Docs site', slug: worst ? 'a-very-long-project-name-that-keeps-going-well-past-any-sensible-width-for-a-settings-row' : 'docs-site', handle: 'sample-owner', visibility: q.get('vis') === 'private' ? 'private' : 'public', createdAt: now - 400 * 86400000, revision: 5, removal: undefined };
const preview = (revision, format = 'native') => ({ format, head: 'b'.repeat(40), revision, intents: 12, lanes: 3, views: 4, runs: 20, files: 310, unavailable: 0, channels: [{ name: 'main', head: 'c'.repeat(40) }] });
const backups = [
  { id: 'b1', operationId: 'op1', projectId: 'p', name: 'Docs site', status: 'stored', digest: 'd'.repeat(64), size: 5 * 1024 * 1024, preview: preview(41), previous: 'b2', current: true, at: now - 3600000, transport: 'objects', objectManifest: { digest: 'e'.repeat(64), size: 900000 } },
  { id: 'b2', operationId: 'op2', projectId: 'p', name: 'Docs site', status: 'stored', digest: 'f'.repeat(64), size: 4 * 1024 * 1024, preview: preview(30), previous: null, current: false, at: now - 9 * 86400000 },
  { id: 'b3', operationId: 'op3', projectId: 'p', name: 'Docs site', status: 'uploading', digest: 'a'.repeat(64), size: 3 * 1024 * 1024, preview: preview(20), previous: null, current: false, at: now - 20 * 86400000 },
];
const imports = [{ id: 'i1', repository: 'sample/parser', ref: 'main', phase: 'ready', createdAt: now - 5 * 86400000 }, { id: 'i2', repository: 'sample/' + 'x'.repeat(70), ref: 'release/2026', phase: 'ready', createdAt: now - 50 * 86400000 }];
const noop = () => {};
const trail = [{ label: 'Docs site', href: '/sample-owner/docs-site' }, { label: 'Settings', href: '/sample-owner/docs-site/settings' }, { label: 'Project' }];
let failOnce = q.get('fail') === '1';
const extra = (
  <>
    <BackupsView backups={q.get('data') === 'empty' ? [] : backups} failed={false} more={worst} showMore={noop} retry={noop} owner={owner} busy={false} message="" error="" selected={null} upload={null}
      choose={file => window.calls.push({ name: 'choose', file: file?.name })} download={b => window.calls.push({ name: 'download', id: b.id })} recovery={b => window.calls.push({ name: 'recovery', id: b.id })} reconcileOne={noop} resume={noop} start={noop} resumeOriginal={noop} dropOriginal={noop} ready />
    {owner ? <ImportsView rows={imports} failed={false} more={false} showMore={noop} retry={noop} remove={async row => { window.calls.push({ name: 'remove', id: row.id }); }} /> : null}
  </>
);
createRoot(document.getElementById('root')).render(
  <ProjectFrame route={{ frame: 'project', handle: 'sample-owner', project: 'docs-site', place: 'settings', section: 'project', rest: '' }} name="Docs site" feed={undefined} needs={undefined} projects={null}
    controls={{ viewerHandle: owner ? 'sample-owner' : 'sample-peer', onPicker() {}, onPalette() {}, onKeys() {} }}>
    <ProjectSettingsView facts={facts} owner={owner} trail={trail} lanes={{ n: 3, atLeast: false }} now={now}
      rename={async input => { window.calls.push({ ...input, name: 'rename' }); if (failOnce) { failOnce = false; throw new Error('The project changed. Reload and try again.'); } }}
      moveToTrash={async () => { window.calls.push({ name: 'trash' }); }}
      setVisibility={async change => { window.calls.push({ name: 'visibility', visibility: change.visibility, confirm: change.confirm, op: change.operationId, rev: change.expectedRevision }); if (q.get('visfail') === '1') throw new Error('Only the owner person can change who can see the project; open Forge in a browser.'); }} extra={extra} />
  </ProjectFrame>,
);
`;

test('settings project: facts, rename keeps one operation across a failed save, trash sheet, backups, imports, member sees no controls, axe', async t => {
  const executablePath = testBrowser(t);
  if (!executablePath) return;
  const browser = await chromium.launch({ executablePath });
  const fx = await viewFixture(t, fixture, 'Project settings', browser);
  const { open, check } = fx;
  if (shots) mkdirSync(shots, { recursive: true });
  const path = '/sample-owner/docs-site/settings/project';
  {
    const { page, errors, context } = await open(1440, 'light', 'who=owner&fail=1', path);
    const main = page.locator('main');
    for (const word of ['Docs site', 'sample-owner/docs-site', 'Public', '@sample-owner', '18 October 2025'])
      assert.match(await main.textContent(), new RegExp(word));
    await page.getByRole('textbox', { name: 'Project name' }).fill('Docs');
    await page.getByRole('textbox', { name: /^Address/ }).fill('docs');
    await page.getByRole('button', { name: 'Save name and address' }).click();
    await page
      .getByText(/The project changed\. Reload and try again\. Save again to retry the same change\./)
      .waitFor();
    assert.equal(
      await page.getByRole('textbox', { name: 'Project name' }).isDisabled(),
      true,
      'the attempt is locked while it is unresolved',
    );
    await page.getByRole('button', { name: 'Retry the same change' }).click();
    await page.getByText('Saved.').waitFor();
    const renames = (await page.evaluate(() => window.calls)).filter(call => call.name === 'rename');
    assert.equal(renames.length, 2);
    assert.equal(renames[0].operationId, renames[1].operationId, 'a retry reuses the original operation id');
    await page.getByRole('button', { name: 'Download' }).first().click();
    await page.getByRole('button', { name: 'Recovery request' }).first().click();
    assert.deepEqual(
      (await page.evaluate(() => window.calls))
        .filter(call => call.name === 'download' || call.name === 'recovery')
        .map(call => `${call.name}:${call.id}`),
      ['download:b1', 'recovery:b1'],
    );
    assert.match(await main.textContent(), /Current backup/);
    assert.match(await main.textContent(), /Upload pending/);
    // The archive picker is the design system's button and the chosen name, never the browser's own input (OS language).
    const store = page.locator('.store');
    assert.equal(await store.locator('input[type=file]').isVisible(), false, 'the native input stays hidden');
    assert.match(await store.textContent(), /No file chosen/);
    await store.locator('input[type=file]').setInputFiles({
      name: 'docs-site-work.tar.gz',
      mimeType: 'application/gzip',
      buffer: Buffer.from('synthetic'),
    });
    await store.getByText('docs-site-work.tar.gz').waitFor();
    assert.deepEqual(
      (await page.evaluate(() => window.calls)).filter(call => call.name === 'choose').map(call => call.file),
      ['docs-site-work.tar.gz'],
    );
    assert.equal(await store.getByRole('button', { name: 'Choose archive' }).isEnabled(), true);
    await check(page, 'archive picker with a chosen file 1440 light');
    await page.getByRole('button', { name: 'Remove sample/parser' }).click();
    assert.match(await page.getByRole('dialog').textContent(), /GitHub repository is\s+untouched/);
    await page.getByRole('dialog').getByRole('button', { name: 'Remove analysis' }).click();
    await page.waitForFunction(() => window.calls.some(call => call.name === 'remove'));
    await page.getByRole('button', { name: 'Move to trash' }).click();
    const sheet = page.getByRole('dialog');
    assert.match(await sheet.textContent(), /Its 3 open Lanes stop where they are/);
    await sheet.getByRole('button', { name: 'Move to trash' }).click();
    await page.waitForFunction(() => window.calls.some(call => call.name === 'trash'));
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const { page, context } = await open(390, 'dark', 'who=member', path);
    const text = await page.locator('main').textContent();
    assert.match(text, /Only the owner can rename it, change who can see it, or move it to the trash\./);
    assert.equal(
      await page.getByRole('button', { name: /Make (public|private)/ }).count(),
      0,
      'a member cannot change visibility',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Move to trash' }).count(),
      0,
      'a member cannot trash',
    );
    assert.equal(
      await page.getByRole('textbox', { name: 'Project name' }).count(),
      0,
      'a member cannot rename',
    );
    assert.equal(await page.getByRole('button', { name: 'Remove sample/parser' }).count(), 0);
    assert.equal(
      await page.getByRole('button', { name: 'Reconcile upload' }).count(),
      0,
      'a member cannot reconcile or resume an upload',
    );
    await context.close();
  }
  for (const query of [
    'who=owner',
    'who=owner&vis=private',
    'who=owner&data=worst',
    'who=owner&data=empty',
    'who=member',
  ])
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark']) {
        const { page, errors, context } = await open(width, theme, query, path);
        await check(page, `${query} ${width} ${theme}`);
        if (query.startsWith('who=owner')) {
          if (shots && query === 'who=owner') {
            const store = page.locator('.store');
            await store.locator('input[type=file]').setInputFiles({
              name: 'docs-site-work.tar.gz',
              mimeType: 'application/gzip',
              buffer: Buffer.from('synthetic'),
            });
            await store.getByText('docs-site-work.tar.gz').waitFor();
            await store.screenshot({ path: join(shots, `picker-${width}-${theme}.png`) });
          }
          await page.getByRole('button', { name: 'Move to trash' }).click();
          await page.getByRole('dialog').waitFor();
          await check(page, `trash sheet ${width} ${theme}`);
          await page.keyboard.press('Escape');
          await page.getByRole('dialog').waitFor({ state: 'detached' });
          await page.getByRole('button', { name: /^Make (public|private)$/ }).click();
          await page.getByRole('dialog').waitFor();
          await check(page, `visibility sheet ${query} ${width} ${theme}`);
          if (shots)
            await page.screenshot({
              path: join(shots, `visibility-sheet-${query.replace(/\W/g, '-')}-${width}-${theme}.png`),
            });
        }
        if (shots)
          await page.screenshot({
            path: join(shots, `project-${query.replace(/\W/g, '-')}-${width}-${theme}.png`),
            fullPage: true,
          });
        assert.deepEqual(errors, []);
        await context.close();
      }
});

test('settings project: visibility needs the typed name to go public, one button to go private, and keeps one operation on a refusal', async t => {
  const executablePath = testBrowser(t);
  if (!executablePath) return;
  const browser = await chromium.launch({ executablePath });
  const fx = await viewFixture(t, fixture, 'Project settings', browser);
  const path = '/-/sample-owner/docs-site/settings/project';
  {
    const { page, errors, context } = await fx.open(1440, 'light', 'who=owner&vis=private', path);
    assert.match(await page.locator('main').textContent(), /Private/);
    await page.getByRole('button', { name: 'Make public' }).click();
    const sheet = page.getByRole('dialog');
    const go = sheet.getByRole('button', { name: 'Make public' });
    assert.equal(await go.isDisabled(), true, 'public stays off until the name is typed');
    await sheet.getByRole('textbox').fill('docs');
    assert.equal(await go.isDisabled(), true, 'a partial name is not enough');
    await sheet.getByRole('textbox').fill('Docs site');
    await go.click();
    await page.waitForFunction(() => window.calls.some(call => call.name === 'visibility'));
    const [call] = (await page.evaluate(() => window.calls)).filter(call => call.name === 'visibility');
    assert.deepEqual(
      [call.visibility, call.confirm, call.rev, typeof call.op],
      ['public', 'Docs site', 5, 'string'],
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const { page, errors, context } = await fx.open(390, 'dark', 'who=owner&vis=public', path);
    await page.getByRole('button', { name: 'Make private' }).click();
    const sheet = page.getByRole('dialog');
    assert.equal(await sheet.getByRole('textbox').count(), 0, 'going private takes no typing');
    await sheet.getByRole('button', { name: 'Make private' }).click();
    await page.waitForFunction(() => window.calls.some(call => call.name === 'visibility'));
    const [call] = (await page.evaluate(() => window.calls)).filter(call => call.name === 'visibility');
    assert.deepEqual([call.visibility, call.confirm, call.rev], ['private', undefined, 5]);
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const { page, context } = await fx.open(1440, 'light', 'who=owner&vis=public&visfail=1', path);
    await page.getByRole('button', { name: 'Make private' }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'Make private' }).click();
    await sheet.getByRole('alert').waitFor();
    assert.match(await sheet.getByRole('alert').textContent(), /open Forge in a browser/);
    assert.equal(
      await sheet.getByRole('button', { name: 'Make private' }).isEnabled(),
      true,
      'the person can retry',
    );
    await context.close();
  }
});

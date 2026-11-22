// SPDX-License-Identifier: Apache-2.0
// Settings > Agents as real components with synthetic data (Item f2ee8381): the project text and the person's own text,
// each saved on its own with one operation id kept across a failed save; a reader who may not edit sees the project text
// read-only and no Save for it. Every state passes axe with no sideways scroll at 1440 and 390 in both themes. Set
// FORGE_AGENT_GUIDANCE_SHOTS to save screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { root, testBrowser, viewFixture } from './app-view-fixture.mjs';

const shots = process.env.FORGE_AGENT_GUIDANCE_SHOTS;
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentGuidanceView } from ${JSON.stringify(join(root, 'web/src/app/agents/AgentGuidanceView.tsx'))};
import { ProjectFrame } from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const q = new URLSearchParams(location.search);
const editable = q.get('who') !== 'reader';
const worst = q.get('data') === 'worst';
const empty = q.get('data') === 'empty';
window.calls = [];
let failOnce = q.get('fail') === '1';
const long = 'Keep changes small and run the targeted tests before finishing. '.repeat(60).slice(0, 3990) + 'u'.repeat(10);
const guidance = {
  project: empty ? '' : worst ? long : 'Keep changes small. Run npm run verify before finishing.',
  personal: empty ? '' : worst ? 'x'.repeat(200) + ' ' + 'y'.repeat(120) : 'Explain what you changed in plain words.',
  projectEditable: editable,
};
const trail = [{ label: 'Docs site', href: '/-/sample-owner/docs-site' }, { label: 'Settings', href: '/-/sample-owner/docs-site/settings' }, { label: 'Agents' }];
createRoot(document.getElementById('root')).render(
  <ProjectFrame route={{ frame: 'project', handle: 'sample-owner', project: 'docs-site', place: 'settings', section: 'agents', rest: '' }} name="Docs site" feed={undefined} needs={undefined} projects={null}
    controls={{ viewerHandle: 'sample-owner', onPicker() {}, onPalette() {}, onKeys() {} }}>
    <AgentGuidanceView guidance={guidance} trail={trail}
      save={async input => { window.calls.push({ ...input, name: 'save' }); if (failOnce) { failOnce = false; throw new Error('The project changed. Reload and try again.'); } }} />
  </ProjectFrame>,
);
`;

test('settings agents: project and personal guidance save separately, a failed save keeps one operation, a reader sees no Save, axe', async t => {
  const executablePath = testBrowser(t);
  if (!executablePath) return;
  const browser = await chromium.launch({ executablePath });
  const fx = await viewFixture(t, fixture, 'Agent guidance', browser);
  const { open, check } = fx;
  if (shots) mkdirSync(shots, { recursive: true });
  const path = '/-/sample-owner/docs-site/settings/agents';
  {
    const { page, errors, context } = await open(1440, 'light', 'who=owner&fail=1', path);
    const project = page.getByRole('textbox', { name: 'For this project' });
    const mine = page.getByRole('textbox', { name: 'Just for me' });
    assert.equal(await project.inputValue(), 'Keep changes small. Run npm run verify before finishing.');
    assert.equal(await mine.inputValue(), 'Explain what you changed in plain words.');
    assert.equal(
      await page.getByRole('button', { name: 'Save' }).first().isDisabled(),
      true,
      'nothing to save until the text changes',
    );
    await project.fill('Keep changes small. Never touch generated files.');
    await page.getByRole('button', { name: 'Save' }).first().click();
    await page
      .getByText(/The project changed\. Reload and try again\. Save again to retry the same change\./)
      .waitFor();
    await page.getByRole('button', { name: 'Retry the same change' }).click();
    await page.getByText('Saved.').waitFor();
    const saves = (await page.evaluate(() => window.calls)).filter(call => call.name === 'save');
    assert.equal(saves.length, 2);
    assert.equal(saves[0].operationId, saves[1].operationId, 'a retry reuses the original operation id');
    assert.deepEqual(
      saves.map(call => call.scope),
      ['project', 'project'],
    );
    await mine.fill('Ask before deleting files.');
    await page.getByRole('button', { name: 'Save' }).last().click();
    await page.waitForFunction(() => window.calls.length === 3);
    const personal = (await page.evaluate(() => window.calls))[2];
    assert.equal(personal.scope, 'personal');
    assert.equal(personal.text, 'Ask before deleting files.');
    assert.notEqual(personal.operationId, saves[0].operationId, 'a new change is a new operation');
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const { page, context } = await open(390, 'dark', 'who=reader', path);
    const project = page.getByRole('textbox', { name: 'For this project' });
    assert.equal(await project.getAttribute('readonly'), '', 'a reader cannot edit the project text');
    assert.equal(
      await page.getByRole('button', { name: 'Save' }).count(),
      1,
      'only the personal Save remains',
    );
    assert.match(
      await page.locator('main').textContent(),
      /Only the owner or a guidance maintainer can change this\./,
    );
    assert.equal(await page.getByRole('textbox', { name: 'Just for me' }).getAttribute('readonly'), null);
    await context.close();
  }
  for (const query of ['who=owner', 'who=owner&data=worst', 'who=owner&data=empty', 'who=reader'])
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark']) {
        const { page, errors, context } = await open(width, theme, query, path);
        await check(page, `${query} ${width} ${theme}`);
        if (shots)
          await page.screenshot({
            path: join(shots, `agents-${query.replace(/\W/g, '-')}-${width}-${theme}.png`),
            fullPage: true,
          });
        assert.deepEqual(errors, []);
        await context.close();
      }
});

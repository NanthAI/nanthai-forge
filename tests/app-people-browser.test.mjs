// SPDX-License-Identifier: Apache-2.0
// Real People and invitation components with a synthetic transport: pending,
// expired and accepted states, explicit recipient acceptance and keyboard controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url),
  root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.FORGE_PEOPLE_SHOTS;

test('People and recipient invitations: states, explicit acceptance and keyboard controls at desktop and phone widths', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-people-ui-')),
    out = join(temp, 'out');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const data = {
    name: 'Synthetic project',
    visibility: 'private',
    role: 'owner',
    owner: 'olive',
    withoutCheck: 'owner',
    answers: {},
    write: { rows: [{ person: 'wren', at: 1 }], more: false },
    read: { rows: [{ person: 'r', at: 1 }], more: false },
    invitationCursor: null,
    invited: [
      {
        id: 'pending',
        email: 'pending@example.test',
        role: 'read',
        at: 1,
        state: 'pending',
        expiresAt: 1900000000000,
        operationId: 'pending-op',
        mail: { status: 'failed', sends: 1, at: 1, code: 'HTTP 502' },
      },
      { id: 'expired', email: '@expired-person', role: 'write', at: 1, state: 'expired', expiresAt: 1 },
      {
        id: 'accepted',
        email: '@accepted-person',
        role: 'read',
        at: 1,
        state: 'accepted',
        expiresAt: 1900000000000,
      },
    ],
  };
  writeFileSync(
    join(temp, 'transport.ts'),
    `
export * from ${JSON.stringify(require.resolve('convex/react'))};
import { useSyncExternalStore } from ${JSON.stringify(require.resolve('react'))};
import { getFunctionName } from ${JSON.stringify(require.resolve('convex/server'))};
let version=0; const listeners=new Set(); const emit=()=>{version++;listeners.forEach(fn=>fn());};
const people=${JSON.stringify(data)};
let olderInvitation={id:'old-handle',email:'@older-person',state:'pending'};
let rows=[{ invitationId:'recipient', projectName:'Compiler tools and documentation', inviterHandle:'olive', role:'read', state:'pending', expiresAt:Date.now()+5*86400000, href:'/-/olive/tools' },
{ invitationId:'old', projectName:'Old project', inviterHandle:'wren', role:'write', state:'expired', expiresAt:Date.now()-2*86400000, href:'/-/wren/old' }];
export function useQuery(ref,args){useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>version); const name=getFunctionName(ref);
if(args==='skip')return undefined;
if(name==='projectContributors:list')return [];
if(name==='projectAccess:people'&&args.limit===1){
  if(args.invitationCursor==='older')return {...people,invited:[olderInvitation]};
  if(args.invitationCursor==='ended')return {...people,invited:[people.invited[1]],invitationCursor:'older'};
  return {...people,invited:[people.invited[0]],invitationCursor:'ended'};
}
if(name==='projectAccess:people')return people;
if(name==='projectInvitationInbox:inbox')return {rows:args.kind==='handle'?rows:[],cursor:null};
if(name==='projectInvitationInbox:blocked')return {rows:[],cursor:null};
return undefined;}
const mutation=async(ref,args)=>{
  const name=getFunctionName(ref);
  window.calls??=[];
  window.calls.push({name,args});
  if(args.choice)rows=rows.filter(row=>row.invitationId!==args.invitationId);
  if(name==='projectContributors:cancelInvite'&&args.id===olderInvitation.id)
    olderInvitation={...olderInvitation,state:'cancelled'};
  emit();
};
export function useMutation(ref){return args=>mutation(ref,args);}
export function useConvex(){return {mutation};}
export const useAction=useMutation;
`,
  );
  const html = join(temp, 'fixture.html');
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>People · Forge</title><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
  );
  writeFileSync(
    join(temp, 'fixture.tsx'),
    `
import React from 'react'; import {createRoot} from 'react-dom/client';
import People from ${JSON.stringify(join(root, 'web/src/app/people/PeopleAccess.tsx'))};
import LegacyPeople from ${JSON.stringify(join(root, 'web/src/ProjectContributors.tsx'))};
import Home from ${JSON.stringify(join(root, 'web/src/app/people/InvitationHome.tsx'))};
import {ProjectFrame,AccountFrame} from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const route={frame:'project',handle:'olive',project:'tools',place:'settings',section:'',rest:''};
const owner=location.pathname.endsWith('/owner');
const legacy=location.pathname.endsWith('/legacy');
const controls={viewerHandle:owner?'olive':'wren',onPicker(){},onPalette(){},onKeys(){}};
const root=createRoot(document.getElementById('root'));
if(legacy){
  Promise.all([
    import(${JSON.stringify(join(root, 'web/src/legacy.css'))}),
    import(${JSON.stringify(join(root, 'web/src/settings/settings.css'))}),
  ]).then(()=>root.render(<main className="fx fx-settings-existing"><LegacyPeople projectId="project" /></main>));
}else root.render(owner?
<ProjectFrame route={route} name="Synthetic project" feed={undefined} projects={null} controls={controls}><People route={route} projectId="project" projectName="Synthetic project" viewerHandle="olive" /></ProjectFrame>:
<AccountFrame place="people" back={null} controls={controls}><Home handle="wren" leave={()=>undefined} /></AccountFrame>);
`,
  );
  const { build } = await import('vite');
  await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: temp,
    base: '/',
    envDir: false,
    logLevel: 'error',
    resolve: {
      alias: {
        'convex/react': join(temp, 'transport.ts'),
        react: dirname(require.resolve('react/package.json')),
        'react-dom': dirname(require.resolve('react-dom/package.json')),
      },
    },
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: html } },
  });
  if (shots) mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());
  for (const width of [1440, 390])
    for (const theme of ['dark', 'light'])
      for (const mode of ['owner', 'recipient', 'legacy']) {
        const context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 1000 },
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.hostname !== 'forge.test') return route.abort();
          const path = url.pathname.slice(1),
            file = path.startsWith('fonts/') ? join(root, 'web/public', path) : join(out, path);
          const asset = path && existsSync(file) && !file.endsWith('/');
          return route.fulfill({
            contentType: !asset
              ? 'text/html'
              : file.endsWith('.js')
                ? 'text/javascript'
                : file.endsWith('.css')
                  ? 'text/css'
                  : 'application/octet-stream',
            body: readFileSync(asset ? file : join(out, 'fixture.html')),
          });
        });
        await page.goto(`https://forge.test/${mode}`);
        if (mode === 'legacy') await page.getByRole('list', { name: 'Pending invitations' }).waitFor();
        else
          await page
            .getByRole('heading', { name: mode === 'owner' ? 'Who can do what' : 'Home', exact: true })
            .waitFor();
        await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
        if (mode === 'owner') {
          for (const state of ['Pending', 'Expired', 'Accepted'])
            assert.match(await page.locator('main').textContent(), new RegExp(state));
          assert.equal(await page.getByRole('button', { name: 'Resend', exact: true }).count(), 1);
        } else if (mode === 'recipient') {
          await page.getByRole('button', { name: 'Decline', exact: true }).waitFor();
          await page.getByRole('button', { name: 'Decline and block inviter', exact: true }).waitFor();
          assert.equal(
            await page.getByRole('button', { name: 'Accept', exact: true }).count(),
            1,
            'expired invitations cannot be accepted',
          );
          const title = await page.locator('.people-invitation .nm > b').first().boundingBox();
          const detail = await page.locator('.people-invitation .nm > .sub').first().boundingBox();
          assert.ok(
            title && detail && detail.y >= title.y + title.height,
            'the invitation title and details occupy separate readable lines',
          );
        }
        await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
        const result = await page.evaluate(() =>
          window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }),
        );
        // The shared shell's known top-bar label issue is outside this screen's scope.
        assert.deepEqual(
          result.violations
            .filter(v => v.id !== 'label-content-name-mismatch')
            .map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
          [],
          `${mode} ${width} ${theme}: axe`,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${mode} ${width} ${theme}: no horizontal scroll`,
        );
        if (shots)
          await page.screenshot({ path: join(shots, `${mode}-${width}-${theme}.png`), fullPage: true });
        if (mode === 'recipient') {
          const accept = page.getByRole('button', { name: 'Accept', exact: true });
          await accept.focus();
          await page.keyboard.press('Enter');
          await page.getByText('Invitation accepted.').waitFor();
          assert.equal(await page.getByRole('button', { name: 'Accept', exact: true }).count(), 0);
          assert.equal(
            await page.getByRole('link', { name: 'Open the project', exact: true }).getAttribute('href'),
            '/-/olive/tools',
          );
        }
        if (mode === 'legacy') {
          const more = page.getByRole('button', { name: 'More invitations', exact: true });
          await more.click();
          await page.getByRole('list', { name: 'Pending invitations' }).waitFor({ state: 'hidden' });
          await more.click();
          await page.getByText('@older-person', { exact: false }).waitFor();
          assert.equal(await more.count(), 0);
          await page.getByRole('button', { name: 'Cancel invitation', exact: true }).click();
          assert.deepEqual(await page.evaluate(() => window.calls), [
            { name: 'projectContributors:cancelInvite', args: { projectId: 'project', id: 'old-handle' } },
          ]);
          await page.getByText('@older-person', { exact: false }).waitFor({ state: 'hidden' });
          await page.getByRole('button', { name: 'Newest invitations', exact: true }).click();
          await page.getByText('pending@example.test', { exact: false }).waitFor();
        }
        assert.deepEqual(errors, [], 'no framework/runtime errors');
        await context.close();
      }
});

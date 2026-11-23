// SPDX-License-Identifier: Apache-2.0
// Real People and invitation components with a synthetic transport: pending,
// expired and accepted states, explicit recipient acceptance and keyboard controls, and the owner's linked teams
// (Item b6588425, 4d): read once per open, link / change / unlink with the revision, no read per change beyond one.
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
let rows=[{ invitationId:'recipient', projectName:'Compiler tools and documentation', inviterHandle:'olive', role:'read', state:'pending', expiresAt:Date.now()+5*86400000, href:'/olive/tools' },
{ invitationId:'old', projectName:'Old project', inviterHandle:'wren', role:'write', state:'expired', expiresAt:Date.now()-2*86400000, href:'/wren/old' }];
let teamRows=[{ invitationId:'team-invite', teamName:'Documentation team', inviterHandle:'olive', state:'pending', href:'/account/people' }];
export function useQuery(ref,args){useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>version); const name=getFunctionName(ref);
if(args==='skip')return undefined;
if(name==='projectContributors:list')return [];
if(name==='projectAccess:people'&&args.limit===1){
  if(args.invitationCursor==='older')return {...people,invited:[olderInvitation]};
  if(args.invitationCursor==='ended')return {...people,invited:[people.invited[1]],invitationCursor:'older'};
  return {...people,invited:[people.invited[0]],invitationCursor:'ended'};
}
if(name==='projectAccess:people')return people;
if(name==='projectInvitationInbox:inbox'){
  const team=location.pathname.endsWith('/team-recipient');
  return {rows:team?(args.kind==='email'&&args.includeTeams?teamRows:[]):(args.kind==='handle'?rows:[]),cursor:null};
}
if(name==='projectInvitationInbox:blocked')return {rows:[],cursor:null};
return undefined;}
let teamLinks={revision:1,teams:[{teamId:'t-docs',name:'Documentation team',role:'read'},{teamId:'t-core',name:'Core maintainers with a very long team name that has to wrap on a phone screen',role:'write'}]};
const ownedTeams=[{id:'t-docs',name:'Documentation team',role:'owner'},{id:'t-core',name:'Core maintainers with a very long team name that has to wrap on a phone screen',role:'owner'},{id:'t-new',name:'Release team',role:'owner'},{id:'t-two',name:'Docs review team',role:'owner'},{id:'t-else',name:'Someone else team',role:'member'}];
window.bump=id=>{teamLinks={revision:teamLinks.revision+1,teams:[...teamLinks.teams,{teamId:id,name:ownedTeams.find(t=>t.id===id).name,role:'read'}]};};
const query=async(ref,args)=>{
  const name=getFunctionName(ref);
  window.reads??=[];
  window.reads.push(name);
  if(name==='projectTeamAccess:list')return JSON.parse(JSON.stringify(teamLinks));
  if(name==='accountTeams:list')return {page:ownedTeams,isDone:true,continueCursor:''};
  throw new Error('unexpected read '+name);
};
const mutation=async(ref,args)=>{
  const name=getFunctionName(ref);
  window.calls??=[];
  if(name==='projectTeamAccess:set'){
    window.calls.push({name,args});
    if(args.revision!==teamLinks.revision)throw {data:{message:'This team access changed since you read it.'}};
    const rest=teamLinks.teams.filter(row=>row.teamId!==args.teamId);
    const old=teamLinks.teams.find(row=>row.teamId===args.teamId);
    teamLinks={revision:teamLinks.revision+1,teams:args.role===null?rest:old?teamLinks.teams.map(row=>row.teamId===args.teamId?{...row,role:args.role}:row):[...rest,{teamId:args.teamId,name:ownedTeams.find(t=>t.id===args.teamId).name,role:args.role}]};
    return null;
  }
  window.calls.push({name,args});
  if(args.choice){
    rows=rows.filter(row=>row.invitationId!==args.invitationId);
    teamRows=teamRows.filter(row=>row.invitationId!==args.invitationId);
  }
  if(name==='projectContributors:cancelInvite'&&args.id===olderInvitation.id)
    olderInvitation={...olderInvitation,state:'cancelled'};
  emit();
};
export function useMutation(ref){return args=>mutation(ref,args);}
const client={mutation,query};
export function useConvex(){return client;}
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
      for (const mode of ['owner', 'recipient', 'team-recipient', 'legacy']) {
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
        if (mode === 'owner') {
          // Linked teams: one read of the links on open, none of the owner's own teams until the form opens.
          const teams = page.getByRole('region', { name: 'Teams', exact: true });
          await teams.getByText('Documentation team', { exact: true }).waitFor();
          await teams.getByText('team · write', { exact: true }).waitFor();
          assert.deepEqual(await page.evaluate(() => window.reads), ['projectTeamAccess:list']);
          await teams.getByRole('button', { name: 'Link a team', exact: true }).click();
          const choose = teams.getByRole('combobox', { name: 'Your team' });
          await choose.waitFor();
          assert.deepEqual(
            await choose.locator('option').allTextContents(),
            ['Choose a team', 'Release team', 'Docs review team'],
            'only teams the owner owns and has not linked are offered',
          );
          await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
          const open = await page.evaluate(() =>
            window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }),
          );
          assert.deepEqual(
            open.violations
              .filter(v => v.id !== 'label-content-name-mismatch')
              .map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
            [],
            `owner ${width} ${theme}: axe with the link form open`,
          );
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          if (shots)
            await page.screenshot({ path: join(shots, `owner-link-${width}-${theme}.png`), fullPage: true });
          // Another tab links the chosen team first: this screen's revision is stale, so the link is refused, the
          // picker drops that team and leaves nothing chosen, and a second Link sends nothing (never the next team).
          await choose.selectOption({ label: 'Docs review team' });
          await page.evaluate(() => window.bump('t-two'));
          await teams.getByRole('button', { name: 'Link', exact: true }).click();
          await page.getByRole('alert').getByText('changed since you read it', { exact: false }).waitFor();
          await teams.getByText('Docs review team', { exact: true }).waitFor();
          assert.equal(await choose.inputValue(), '', 'no team stays chosen after the choices changed');
          await teams.getByRole('button', { name: 'Link', exact: true }).click();
          await choose.selectOption({ label: 'Release team' });
          await teams.getByRole('button', { name: 'Write', exact: true }).click();
          await teams.getByRole('button', { name: 'Link', exact: true }).click();
          await teams.getByText('Release team', { exact: true }).waitFor();
          await teams.getByRole('switch', { name: 'Documentation team, write' }).click();
          await page.getByText('team · write', { exact: true }).nth(2).waitFor();
          const core = 'Core maintainers with a very long team name that has to wrap on a phone screen';
          await teams.getByRole('button', { name: `More for ${core}` }).click();
          await page.getByRole('menuitem', { name: 'Unlink from the project', exact: true }).click();
          await teams.getByRole('switch', { name: `${core}, write` }).waitFor({ state: 'hidden' });
          await teams.getByRole('button', { name: 'Undo', exact: true }).click();
          await teams.getByRole('switch', { name: `${core}, write` }).waitFor();
          const setCall = (teamId, role, revision) => ({
            name: 'projectTeamAccess:set',
            args: { projectId: 'project', teamId, role, revision },
          });
          assert.deepEqual(await page.evaluate(() => window.calls), [
            setCall('t-two', 'read', 1),
            setCall('t-new', 'write', 2),
            setCall('t-docs', 'write', 3),
            setCall('t-core', null, 4),
            setCall('t-core', 'write', 5),
          ]);
          assert.equal(
            (await page.evaluate(() => window.reads)).filter(name => name === 'projectTeamAccess:list')
              .length,
            6,
            'one read on open, one after the refusal and one after each of the four changes',
          );
        }
        if (mode === 'recipient') {
          const accept = page.getByRole('button', { name: 'Accept', exact: true });
          await accept.focus();
          await page.keyboard.press('Enter');
          await page.getByText('Invitation accepted.').waitFor();
          assert.equal(await page.getByRole('button', { name: 'Accept', exact: true }).count(), 0);
          assert.equal(
            await page.getByRole('link', { name: 'Open the project', exact: true }).getAttribute('href'),
            '/olive/tools',
          );
        }
        if (mode === 'team-recipient') {
          await page.getByText('Documentation team', { exact: true }).waitFor();
          await page.getByText('join this team', { exact: false }).waitFor();
          await page.getByRole('button', { name: 'Accept', exact: true }).click();
          await page.getByRole('link', { name: 'Open People and teams', exact: true }).waitFor();
          assert.deepEqual(
            await page.evaluate(() =>
              window.calls.map(({ name, args }) => [name, args.invitationId, args.choice]),
            ),
            [['teamActions:answerInvitation', 'team-invite', 'accept']],
          );
          assert.equal(await page.getByRole('button', { name: 'Accept', exact: true }).count(), 0);
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

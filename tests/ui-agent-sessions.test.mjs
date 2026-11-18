// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.FORGE_C1_SHOTS;

test('C1 agent sessions and holder: real components preserve names, keyboard paths and accessibility in both themes and widths', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-c1-ui-'));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in and devices · Forge</title><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
  );
  writeFileSync(
    join(temp, 'fixture.tsx'),
    `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SessionsView } from ${JSON.stringify(join(root, 'web/src/app/sessions/Sessions.tsx'))};
import { HolderView } from ${JSON.stringify(join(root, 'web/src/app/sessions/Holder.tsx'))};
import { AgentView } from ${JSON.stringify(join(root, 'web/src/app/sessions/Agent.tsx'))};
import { ProjectFrame } from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') || 'dark';
const now=1794873600000;
const route={frame:'project',handle:'example-builder',project:'synthetic',place:'lanes',section:'sessions',rest:''};
const data={ observedAt:now,continueCursor:'',isDone:true,rows:[{person:'example-builder',name:'amber-fox',sessionId:'a'.repeat(64),laneId:'lane-a',intentId:'item-a',title:'Stream parser: preserve split bytes across reads',lastSeen:now-20000,startedAt:now-3600000,app:'synthetic-app',identityFrom:'declared',device:{id:'device-a',code:'dv-synthetic',approvedAt:now-86400000,name:'Build laptop'}},{person:'peer-builder',name:'still-heron',sessionId:'b'.repeat(64),laneId:'lane-b',intentId:'item-b',title:'Document the parser interface and its recovery paths',lastSeen:now-600000,startedAt:now-7200000,app:'other-app',identityFrom:'app-thread',device:{id:'device-b',code:'dv-other',approvedAt:now-86400000}}]};
const holder={laneId:'lane-a',title:data.rows[0].title,head:'a'.repeat(64),version:2,state:'active',authorityEpoch:1,at:now,canTake:true,needsReason:true,browserSessionId:'c'.repeat(64),enabled:true,holder:{actor:'example-builder',agent:'amber-fox',sessionId:'a'.repeat(64),since:now-3600000,lastSeen:now-20000,change:{by:'example-builder',kind:'takeover',previous:{actor:'example-builder',agent:'still-heron',since:now-7200000},reason:'Continue the saved parser change',savedHead:'a'.repeat(64)}},events:[],continueCursor:'',isDone:true};
const agentRun={schema:1,person:'example-builder',run:'amber-fox',model:'synthetic-model-1',app:'synthetic-app',device:'dv-synthetic',identityFrom:'declared',continueCursor:'c',isDone:false,lanes:[{laneId:'lane-a',title:'Stream parser: preserve split bytes across reads',open:true,first:now-3600000,last:now-20000,landed:null,saves:7},{laneId:'lane-b',title:'Types: narrow the read result so callers stop checking for a missing value that can no longer happen',open:false,first:now-86400000,last:now-80000000,landed:{at:new Date(now-80000000).toISOString(),receiptId:'00000000-0000-4000-8000-000000000001'},saves:5},{laneId:'lane-c',title:'Retry: jitter the first attempt',open:false,first:now-172800000,last:now-170000000,landed:null,saves:1}],comments:{count:3,partial:true,through:'2026-11-17',more:false,rows:[{at:now-30000,itemId:'6a251b23-8b49-4458-a10a-62fd7c8a4742',text:'The decoder keeps up to three bytes between chunks; a chunk that ends inside a four-byte sequence twice in a row is not tested yet, and this sentence runs long on purpose.'},{at:now-90000000,itemId:'7b251b23-8b49-4458-a10a-62fd7c8a4742',text:'Main moved while this was checking.'}]}};
function Fixture(){ const [message,setMessage]=React.useState(''); const kind=params.get('page');return <ProjectFrame route={route} name="Synthetic project" feed={undefined} projects={null} controls={{viewerHandle:'example-builder',onPicker(){},onPalette(){},onKeys(){}}}>{kind==='holder'?<HolderView route={route} data={holder} busy={false} problem={null} offer={null} change={v=>setMessage(v.reason||'Holder changed')} more={()=>{}}/>:kind==='agent'?<AgentView route={{...route,rest:'example-builder/amber-fox'}} person="example-builder" run="amber-fox" data={agentRun} more={()=>{}}/>:<SessionsView route={route} data={data} more={()=>{}} first={()=>{}}/>}<p role="status">{message}</p></ProjectFrame>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,
  );
  const { build } = await import('vite');
  await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: temp,
    envDir: false,
    logLevel: 'error',
    resolve: {
      alias: {
        react: dirname(require.resolve('react/package.json')),
        'react-dom': dirname(require.resolve('react-dom/package.json')),
      },
    },
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: html } },
  });
  if (shots) mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  t.after(async () => {
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  });
  for (const kind of ['sessions', 'holder', 'agent'])
    for (const width of [1440, 390])
      for (const theme of ['dark', 'light'])
        await t.test(`${kind} ${width} ${theme}: no clipping or axe violations`, async () => {
          const context = await browser.newContext({
            viewport: { width, height: width === 390 ? 844 : 1000 },
          });
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', e => errors.push(e.message));
          await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.hostname !== 'forge.test') return route.abort();
            const path = url.pathname.slice(1) || 'fixture.html';
            const file = path.startsWith('fonts/') ? join(root, 'web/public', path) : join(out, path);
            if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
            return route.fulfill({
              contentType: file.endsWith('.js')
                ? 'text/javascript'
                : file.endsWith('.css')
                  ? 'text/css'
                  : file.endsWith('.woff2')
                    ? 'font/woff2'
                    : 'text/html',
              body: readFileSync(file),
            });
          });
          await page.goto(`https://forge.test/fixture.html?page=${kind}&theme=${theme}`);
          await page.locator('h1').waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
          const result = await page.evaluate(() =>
            window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }),
          );
          assert.deepEqual(
            result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
            [],
          );
          if (kind === 'agent') {
            // Four figures: Lanes, saves, landings, comments; the comments list says older ones are archived.
            const figures = await page.locator('.nums > div').allInnerTexts();
            assert.deepEqual(
              figures.map(text => text.replace(/\s+/g, ' ').trim()),
              ['3 Lanes', '13 saves', '1 landing', '3+ comments'],
            );
            assert.match(
              (await page.locator('.nums > div').nth(3).locator('span[title]').getAttribute('title')) ?? '',
              /older days are counted from what is still kept/,
            );
            await page.getByRole('heading', { name: 'Comments' }).waitFor();
            assert.equal(await page.locator('.row.cm').count(), 2);
            await page.getByText('older comments are archived', { exact: false }).waitFor();
            await page.getByRole('link', { name: 'Item 6a251b23' }).waitFor();
          }
          if (kind === 'holder') {
            await page.getByRole('button', { name: 'Take over here', exact: true }).click();
            const reason = page.getByRole('textbox', { name: 'Reason', exact: true });
            await reason.fill('Continue the saved work');
            await reason.press('Tab');
            await page.keyboard.press('Enter');
            await page.getByRole('status').filter({ hasText: 'Continue the saved work' }).waitFor();
          }
          if (shots)
            await page.screenshot({ path: join(shots, `${kind}-${width}-${theme}.png`), fullPage: true });
          assert.deepEqual(errors, []);
          await context.close();
        });
});

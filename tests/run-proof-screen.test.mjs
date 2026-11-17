// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_PROOF_SHOTS;

test('proof screen distinguishes missing, empty and many claims, preserves attribution and fits both themes and widths', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-proof-screen-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const html = join(temp, 'proof.html');
  const entry = join(temp, 'entry.tsx');
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>What was checked · Forge</title><style>body { margin: 0; }</style></head><body><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>',
  );
  writeFileSync(
    entry,
    `import React, {useState} from ${JSON.stringify(join(root, 'node_modules/react/index.js'))};
import {createRoot} from ${JSON.stringify(join(root, 'node_modules/react-dom/client.js'))};
import {ConvexProvider,ConvexReactClient} from 'convex/react';
import {ReportFiles} from ${JSON.stringify(join(root, 'web/src/app/proof/ReportFiles.tsx'))};
import {ProofView} from ${JSON.stringify(join(root, 'web/src/app/proof/ProofView.tsx'))};
import {ProjectFrame} from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const source='a'.repeat(64);
let reportPhase='passed';
const client=new ConvexReactClient('https://forge.test.convex.cloud');
client.action=async(_,args)=>JSON.stringify({contractReports:reportPhase==='running'?{}:Object.fromEntries(Array.from({length:args.cursor?9:8},(_,i)=>['tests/source-'+(i+(args.cursor?8:0))+'.test.mjs',{failed:false,durationMs:1250}])),nextCursor:reportPhase==='running'||args.cursor?null:'next'});
const original={agentClient:'test-editor:test-model',lane:{id:'lane',intentId:'item',head:source,state:'active'},save:{id:'save',head:source,at:'2026-11-01T10:00:00.000Z',author:'builder/steady-fox',notVerified:['The optional adapter was not checked.','Transport timeout recovery was not checked on this platform.']},check:{runId:'run',head:source,status:'passed',check:'verify',files:{total:17,failed:0,flaky:0},selection:{mode:'scoped',reason:'Selected tests depend on the changed files.'},skipped:null,ciMinutes:1.25,wallSeconds:86,shards:{completed:3,passed:3,failed:0,total:3},at:'2026-11-01T10:00:00.000Z',endedAt:'2026-11-01T10:01:26.000Z',providerLink:null},claimMatchesCheck:true,currentHead:source,stale:false,afterLandingCheck:null};
function Fixture(){const[data,setData]=useState(original);const[message,setMessage]=useState('');window.proofState=(kind)=>{reportPhase=kind==='running'||kind==='unreported'?'running':'passed';setData({...original,save:kind==='none'?{...original.save,notVerified:undefined}:kind==='empty'?{...original.save,notVerified:[]}:kind==='many'?{...original.save,notVerified:Array.from({length:37},(_,i)=>'Unverified line '+(i+1)+' '+('verylongtext'.repeat(20)))}:original.save,landing:kind==='different'?{receiptId:'receipt',candidateId:'candidate',head:'b'.repeat(64)}:null,declaration:kind==='landing'?{kind:'landing',id:'submission',head:source,at:original.save.at,author:original.save.author,notVerified:['The landing claim remains distinct.']}:null,check:kind==='nocheck'?null:kind==='running'||kind==='queued'||kind==='unknown'?{...original.check,status:kind,endedAt:null}:kind==='unreported'?{...original.check,files:null,ciMinutes:null}:original.check});};return <ConvexProvider client={client}><ProjectFrame route={{frame:'project',handle:'example',project:'workspace',place:'lanes',section:'',rest:'lane/checked'}} name="Workspace" projects={[]} controls={{onPalette(){},onKeys(){},onPicker(){},viewerHandle:'example'}}><ProofView data={data} reportDetails={data.check?<ReportFiles projectId="project" runId="run" version={data.check.endedAt?[data.check.endedAt,data.check.files?.total,data.check.files?.failed,data.check.files?.flaky].join(':'):null}/>:null} lanesHref="#lanes" changeHref="#change" recoveryHref="#check" message={message} onRunAll={()=>setMessage('A full check was requested on this exact source.')} onRevert={data.landing?()=>setMessage('Taking it out of main as a new landing.'):undefined} onFollowups={(line)=>setMessage(line===undefined?'37 linked Items in Plan.':'1 linked Item in Plan.')} /></ProjectFrame></ConvexProvider>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
  );
  const { build } = await import('vite');
  const out = join(temp, 'out');
  await build({
    configFile: join(root, 'web/vite.config.ts'),
    plugins: [
      {
        name: 'proof-only-input',
        configResolved(config) {
          config.build.rolldownOptions.input = { proof: html };
        },
      },
    ],
    root: temp,
    resolve: {
      alias: {
        react: join(root, 'node_modules/react'),
        'react-dom': join(root, 'node_modules/react-dom'),
        'convex/react': join(root, 'node_modules/convex/dist/esm/react/index.js'),
      },
    },
    logLevel: 'error',
    build: {
      outDir: out,
      emptyOutDir: true,
      rolldownOptions: { input: { proof: html } },
    },
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const path = new URL(route.request().url()).pathname;
    let file = join(out, path.slice(1));
    if (path === '/proof.html') {
      const names = [];
      const find = dir => {
        for (const entry of requireFs.readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) find(p);
          else if (entry.name === 'proof.html') names.push(p);
        }
      };
      find(out);
      file = names[0];
    }
    if (!file || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
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
  await page.goto('https://forge.test/proof.html');
  await page.getByRole('heading', { name: 'What ran', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Run every test now' }).click();
  await page.getByRole('status').filter({ hasText: 'A full check was requested' }).waitFor();
  for (const kind of [
    'none',
    'empty',
    'nocheck',
    'unreported',
    'many',
    'landing',
    'different',
    'queued',
    'unknown',
  ]) {
    await page.evaluate(kind => window.proofState(kind), kind);
    if (kind === 'different') {
      await page.getByRole('button', { name: 'Take it out of main', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Taking it out of main as a new landing.' }).waitFor();
    }
    if (kind === 'none')
      await page.getByText('No verification list accompanied this save.', { exact: false }).waitFor();
    if (kind === 'empty') await page.getByText('The agent sent an empty list:', { exact: false }).waitFor();
    if (kind === 'nocheck')
      await page.getByText('No check recorded. Forge cannot say which tests ran.').waitFor();
    if (kind === 'unreported')
      await page.getByText('No test-file report establishes which tests ran.', { exact: false }).waitFor();
    if (kind === 'queued') await page.getByText('verify: Queued.', { exact: false }).waitFor();
    if (kind === 'unknown') {
      await page.getByText("verify: Can't confirm.", { exact: false }).waitFor();
      assert.equal(await page.getByText('Checking now.', { exact: false }).count(), 0);
    }
    if (kind === 'different')
      await page
        .getByText('Coverage of the accepted source is not established by this read.', { exact: false })
        .waitFor();
    if (kind === 'landing') {
      await page.getByText('The landing claim remains distinct.', { exact: true }).waitFor();
      await page.getByText('wrote with the landing at', { exact: false }).waitFor();
    }
    if (kind === 'many') {
      assert.equal(await page.getByRole('button', { name: 'Make it an Item', exact: true }).count(), 8);
      await page.getByRole('button', { name: 'Show 29 more' }).click();
      assert.equal(await page.getByRole('button', { name: 'Make it an Item', exact: true }).count(), 37);
    }
  }
  await page.evaluate(() => window.proofState('running'));
  assert.equal(await page.getByRole('button', { name: 'Run every test now' }).isEnabled(), true);
  await page.getByText('Reported test files', { exact: true }).click();
  await page.getByText('No retained file reports are available.', { exact: true }).waitFor();
  await page.evaluate(() => window.proofState('unreported'));
  await page.getByText('No test-file report establishes which tests ran.', { exact: false }).waitFor();
  await page.evaluate(() => window.proofState('normal'));
  await page.getByText('tests/source-0.test.mjs', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next page of reports' }).click();
  await page.getByText('tests/source-8.test.mjs', { exact: true }).waitFor();
  assert.equal(await page.getByText('tests/source-0.test.mjs', { exact: true }).count(), 0);
  await page.getByText('Reported test files', { exact: true }).click();
  await page.getByText('test-editor', { exact: false }).waitFor();
  await page.getByText('test-model', { exact: false }).waitFor();
  await page.getByText('declared, not verified', { exact: true }).waitFor();
  await page.addScriptTag({ path: axe });
  for (const theme of ['dark', 'light'])
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await page.evaluate(async theme => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.getBoundingClientRect();
        await Promise.all(
          document.getAnimations().map(animation => animation.finished.catch(() => undefined)),
        );
      }, theme);
      const violations = await page.evaluate(async () =>
        (
          await axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
          })
        ).violations.map(v => ({
          id: v.id,
          nodes: v.nodes.map(n => ({ target: n.target, failure: n.failureSummary })),
        })),
      );
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, `checked-${width}-${theme}.png`), fullPage: true });
      }
      assert.deepEqual(violations, [], `${theme}/${width}: axe`);
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${theme}/${width}: no sideways scroll`,
      );
    }
  assert.deepEqual(errors, []);
  await context.close();
});
const requireFs = createRequire(import.meta.url)('node:fs');

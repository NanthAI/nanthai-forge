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
import {getFunctionName} from 'convex/server';
import {ReportFiles} from ${JSON.stringify(join(root, 'web/src/app/proof/ReportFiles.tsx'))};
import {ProofView} from ${JSON.stringify(join(root, 'web/src/app/proof/ProofView.tsx'))};
import ProofPage from ${JSON.stringify(join(root, 'web/src/app/proof/ProofPage.tsx'))};
import {ProjectFrame} from ${JSON.stringify(join(root, 'web/src/app/frames.tsx'))};
import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
const source='a'.repeat(64);
let reportPhase='passed';
const client=new ConvexReactClient('https://forge.test.convex.cloud');
client.action=async(_,args)=>JSON.stringify({contractReports:reportPhase==='running'?{}:Object.fromEntries(Array.from({length:args.cursor?9:8},(_,i)=>['tests/source-'+(i+(args.cursor?8:0))+'.test.mjs',{failed:false,durationMs:1250}])),nextCursor:reportPhase==='running'||args.cursor?null:'next'});
const original={agentClient:'test-editor:test-model',lane:{id:'lane',intentId:'item',head:source,state:'active'},save:{id:'save',head:source,at:'2026-11-01T10:00:00.000Z',author:'builder/steady-fox',notVerified:['The optional adapter was not checked.','Transport timeout recovery was not checked on this platform.']},check:{runId:'run',head:source,status:'passed',check:'verify',files:{total:17,failed:0,flaky:0},selection:{mode:'contract',effective:'full',tests:Array.from({length:24},(_,i)=>'tests/requested-'+i+'.test.mjs'),reason:'The runner used the full command.'},skipped:null,ciMinutes:1.25,wallSeconds:86,shards:{completed:3,passed:3,failed:0,total:3},at:'2026-11-01T10:00:00.000Z',endedAt:'2026-11-01T10:01:26.000Z',providerLink:null},claimMatchesCheck:true,currentHead:source,stale:false,afterLandingCheck:null};
// These source relationships come from real single, shared-batch and retried
// landing receipts. Identifiers and saved claim text are synthetic.
const receiptSources = {
  single: ['a', 'a'],
  batch: ['b', 'c'],
  retry: ['d', 'e'],
};
function receiptFixture(kind) {
  const [input, landed] = receiptSources[kind];
  const saved = input.repeat(64), accepted = landed.repeat(64);
  return {
    ...original,
    lane: {...original.lane, head: saved},
    save: {...original.save, id: 'save-' + kind, head: saved},
    landing: {receiptId: 'receipt-' + kind, candidateId: 'candidate-' + kind, head: accepted, acceptedBy: {kind:'auto', note:'Project landing policy'}},
    check: {...original.check, runId: 'accepted-run-' + kind, head: accepted},
    currentHead: accepted,
    claimMatchesCheck: saved === accepted,
  };
}
const route = {frame:'project',handle:'example',project:'workspace',place:'lanes',section:'',rest:'lane/checked'};
let receiptData;
window.followupRequests = [];
client.watchQuery = (reference) => ({
  localQueryResult: () => getFunctionName(reference) === 'projectRunProof:read'
    ? JSON.stringify(receiptData)
    : undefined,
  onUpdate: () => () => {},
});
client.mutation = async (reference, args) => {
  if (getFunctionName(reference) !== 'projectRunProofActions:followups') throw Error('Unexpected mutation');
  window.followupRequests.push(args);
  const source = receiptData.declaration ?? receiptData.save;
  const start = args.line ?? args.offset;
  const end = args.line === undefined ? Math.min(start + 100, source.notVerified.length) : start + 1;
  return JSON.stringify({
    items: source.notVerified.slice(start, end).map((_, index) => ({id: source.id + '-' + (start + index)})),
    nextOffset: args.line === undefined && end < source.notVerified.length ? end : null,
  });
};
function Fixture(){const[data,setData]=useState(original);const[receipt,setReceipt]=useState(null);const[message,setMessage]=useState('');window.proofState=(kind)=>{setMessage('');reportPhase=kind==='running'||kind==='unreported'?'running':'passed';if (Object.hasOwn(receiptSources,kind) || kind === 'declared') {
  receiptData = receiptFixture(kind === 'declared' ? 'retry' : kind);
  if (kind === 'declared') receiptData.declaration = {kind:'landing',id:'submission-declared', head:receiptData.landing.head, at:original.save.at,author:original.save.author,notVerified:Array.from({length:101},(_,index)=>'Unverified check '+index)};
  if (kind === 'declared') receiptData.claimMatchesCheck = true;
  setReceipt(kind);
  return;
}
setReceipt(null);
setData({...original,save:kind==='hiddenauthor'?{...original.save,author:undefined}:kind==='none'?{...original.save,notVerified:undefined}:kind==='empty'?{...original.save,notVerified:[]}:kind==='many'?{...original.save,notVerified:Array.from({length:37},(_,i)=>'Unverified line '+(i+1)+' '+('verylongtext'.repeat(20)))}:original.save,landing:kind==='different'||kind==='accepted'?{receiptId:'receipt',candidateId:'candidate',head:kind==='different'?'b'.repeat(64):source,acceptedBy:{kind:'auto',note:'Project landing policy'}}:null,declaration:kind==='landing'?{kind:'landing',id:'submission',head:source,at:original.save.at,author:original.save.author,notVerified:['The landing claim remains distinct.']}:null,check:kind==='nocheck'?null:kind==='newScope'?{...original.check,selection:{mode:'future-mode'},shards:{completed:1,passed:0,failed:1,total:1}}:kind==='running'||kind==='queued'||kind==='unknown'?{...original.check,status:kind,endedAt:null,shards:{completed:0,passed:0,failed:0,total:null}}:kind==='unreported'?{...original.check,files:null,ciMinutes:null}:original.check});};return <ConvexProvider client={client}><ProjectFrame route={route} name="Workspace" projects={[]} controls={{onPalette(){},onKeys(){},onPicker(){},viewerHandle:'example'}}>{receipt ? <ProofPage key={receipt} route={route} projectId="project" /> : <ProofView data={data} reportDetails={data.check?<ReportFiles projectId="project" runId="run" version={data.check.endedAt?[data.check.endedAt,data.check.files?.total,data.check.files?.failed,data.check.files?.flaky].join(':'):null}/>:null} lanesHref="#lanes" changeHref="#change" recoveryHref="#check" message={message} onRunAll={()=>setMessage('A full check was requested on this exact source.')} onRevert={data.landing?()=>setMessage('Taking it out of main as a new landing.'):undefined} onFollowups={(line)=>setMessage(line === undefined ? '37 linked Items in Plan.' : '1 linked Item in Plan.')} />}</ProjectFrame></ConvexProvider>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
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
        'convex/server': join(root, 'node_modules/convex/dist/esm/server/index.js'),
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
  const context = await browser.newContext({ reducedMotion: 'reduce' });
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
  const ran = page.getByRole('region', { name: 'What ran', exact: true });
  const exclusions = page.getByRole('region', { name: 'What did not run', exact: true });
  await ran.getByText('3 of 3 shards · full check').waitFor();
  await page.getByText('verify, full check', { exact: true }).waitFor();
  assert.equal(await ran.locator('.shards .ok').count(), 3);
  await ran.getByText('The runner used the full command.').waitFor();
  assert.equal(await exclusions.getByText('The runner used the full command.').count(), 0);
  await ran.getByText('Tests named in the request (24)').click();
  assert.equal(await ran.getByText('tests/requested-23.test.mjs').count(), 0);
  await ran.getByRole('button', { name: 'Show 4 more tests' }).click();
  await ran.getByText('tests/requested-23.test.mjs').waitFor();
  assert.equal(await page.locator(':focus').textContent(), 'tests/requested-20.test.mjs');
  await ran.getByText('Tests named in the request (24)').click();
  await page.getByText('steady-fox lists 2 things it did not verify.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Run every test now' }).click();
  await page.getByRole('status').filter({ hasText: 'A full check was requested' }).waitFor();
  for (const kind of [
    'newScope',
    'none',
    'hiddenauthor',
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
    if (kind === 'newScope') {
      await ran.getByText('1 of 1 shard · 1 failed · check scope not reported').waitFor();
      assert.equal(await ran.locator('.shards .bad').count(), 1);
    }
    if (kind === 'hiddenauthor') {
      await page.getByText('Author not shown', { exact: true }).waitFor();
      await page.getByText('The agent lists 2 things it did not verify.', { exact: false }).waitFor();
    }
    if (kind === 'none')
      await page.getByText('No verification list accompanied this save.', { exact: false }).waitFor();
    if (kind === 'none')
      await page
        .getByText('Whether steady-fox left anything unverified is not reported.', { exact: false })
        .waitFor();
    if (kind === 'empty') {
      await page.getByText('The agent sent an empty list:', { exact: false }).waitFor();
      await page.getByText('steady-fox says it verified everything it changed.', { exact: false }).waitFor();
    }
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
  await t.test('single, batch and retried receipts retain the source of a follow-up claim', async () => {
    for (const kind of ['single', 'batch', 'retry']) {
      await page.evaluate(value => window.proofState(value), kind);
      const mismatch = page.getByText('Its coverage of the composed check source is not established.', {
        exact: false,
      });
      if (kind === 'single') await mismatch.waitFor({ state: 'hidden' });
      else await mismatch.waitFor();
      await page.getByRole('button', { name: 'Make it an Item', exact: true }).first().click();
      await page.getByText('1 linked Item in Plan.', { exact: false }).waitFor();
      const batch = page.getByRole('button', { name: 'Make all 2 Items' });
      await batch.click();
      await page.getByText('2 linked Items in Plan.', { exact: false }).waitFor();
      await batch.click();
      await page.getByText('2 linked Items in Plan.', { exact: false }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.followupRequests.slice(-3)), [
        { projectId: 'project', saveId: `save-${kind}`, line: 0 },
        { projectId: 'project', saveId: `save-${kind}`, offset: 0 },
        { projectId: 'project', saveId: `save-${kind}`, offset: 0 },
      ]);
    }
  });
  await t.test(
    'a landing declaration owns every page of its follow-up batch, including retries',
    async () => {
      await page.evaluate(() => window.proofState('declared'));
      await page.getByRole('button', { name: 'Make it an Item', exact: true }).first().click();
      await page.getByText('1 linked Item in Plan.', { exact: false }).waitFor();
      const batch = page.getByRole('button', { name: 'Make all 101 Items' });
      for (let i = 0; i < 2; i++) {
        await batch.click();
        await page.getByText('101 linked Items in Plan.', { exact: false }).waitFor();
      }
      assert.deepEqual(
        await page.evaluate(() => window.followupRequests.slice(-5)),
        [{ line: 0 }, { offset: 0 }, { offset: 100 }, { offset: 0 }, { offset: 100 }].map(input => ({
          projectId: 'project',
          submissionId: 'submission-declared',
          ...input,
        })),
      );
    },
  );
  await page.evaluate(() => window.proofState('running'));
  await ran.getByText('0 shards completed · total not reported', { exact: false }).waitFor();
  assert.equal(await ran.locator('.stick').count(), 0);
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
  await page.evaluate(() => window.proofState('accepted'));
  await page.getByRole('region', { name: 'This landing' }).waitFor();
  await page.addScriptTag({ path: axe });
  for (const theme of ['dark', 'light'])
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await page.evaluate(async theme => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.getBoundingClientRect();
        await Promise.all(
          document
            .getAnimations()
            .filter(
              animation =>
                animation.playState === 'running' &&
                Number.isFinite(animation.effect?.getComputedTiming().endTime),
            )
            .map(animation => animation.finished.catch(() => undefined)),
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
        const capture = name =>
          page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`), fullPage: width === 1440 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await capture('checked');
        const requested = ran.getByText('Tests named in the request (24)');
        await requested.click();
        await requested.scrollIntoViewIfNeeded();
        await capture('requested');
        await requested.click();
        await page.evaluate(() => window.proofState('running'));
        await ran.getByText('0 shards completed · total not reported', { exact: false }).waitFor();
        await page.evaluate(() => window.scrollTo(0, 0));
        await capture('checking');
        await page.evaluate(() => window.proofState('many'));
        await page.getByText('steady-fox lists 37 things it did not verify.', { exact: false }).waitFor();
        const claims = page.getByRole('heading', {
          name: 'Not verified, in the agent’s words',
          exact: false,
        });
        await claims.evaluate(el => el.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: join(shots, `claims-${width}-${theme}.png`) });
        await page.evaluate(() => window.proofState('accepted'));
        await page.getByRole('region', { name: 'This landing' }).waitFor();
        await page.evaluate(() => window.scrollTo(0, 0));
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

// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { join, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { WorkService } from '../dist/work.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { fixture, git, write, code } from './helpers.mjs';

async function setup(t, { native = false } = {}) {
  const previousPath = process.env.PATH,
    originalFetch = globalThis.fetch;
  let root, gitCalled, work;
  t.after(() => {
    process.env.PATH = previousPath;
    globalThis.fetch = originalFetch;
    for (const item of work?.store.load().deployments ?? [])
      if (item.directory) rmSync(item.directory, { recursive: true, force: true });
  });
  if (native) {
    const directory = mkdtempSync(join(tmpdir(), 'forge-native-delivery-')),
      blocked = join(directory, 'bin');
    root = join(directory, 'project');
    mkdirSync(root);
    mkdirSync(blocked);
    // TMPDIR may be inside an ESM project during a clean Forge check.
    writeFileSync(join(blocked, 'package.json'), '{"type":"commonjs"}');
    gitCalled = join(directory, 'git-called');
    const executable = join(blocked, process.platform === 'win32' ? 'git.cmd' : 'git');
    writeFileSync(
      executable,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(gitCalled)},'Unexpected Git execution');process.exit(91);\n`,
    );
    chmodSync(executable, 0o700);
    process.env.PATH = blocked;
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    write(root, 'a.ts', 'export const a = 1;\n');
    initNative(root);
  } else {
    root = fixture(t, { 'a.ts': 'export const a = 1;\n' });
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Original source']);
  }
  work = new WorkService(root);
  const local = input => work.execute(input, work.status().revision).result;
  const dispatch = (input, revision = work.status().revision) => work.dispatch(input, revision);
  const intent = local({ action: 'intent', outcome: 'Deliver exact selected build bytes' }),
    lane = local({ action: 'lane', intentId: intent.id, name: 'Unfinished approach' });
  const view = local({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const check = local({
    action: 'define-check',
    name: 'Build é <script>literal</script>',
    executable: process.execPath,
    args: [
      '-e',
      'const fs=require("node:fs");fs.mkdirSync("out");fs.writeFileSync("out/index.html","<h1>Original release</h1>");fs.writeFileSync("out/raw.bin",Buffer.from([0,255,42]));process.exit(1)',
    ],
    artifactPaths: ['out/index.html', 'out/raw.bin'],
  });
  const runId = randomUUID();
  await dispatch({
    action: 'run-check',
    operationId: runId,
    viewId: view.id,
    expectedHead: view.head,
    checkId: check.id,
    expectedDefinition: check.definition,
    expectedEnvironment: work.status().environment.fingerprint,
  });
  for (let attempt = 0; !work.status().runs[0].endedAt && attempt < 200; attempt++)
    await new Promise(r => setTimeout(r, 25));
  assert.equal(work.status().runs[0].status, 'failed');
  const acceptanceId = randomUUID();
  await dispatch({
    action: 'accept-channel',
    operationId: acceptanceId,
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
  });
  const releaseId = randomUUID();
  await dispatch({
    action: 'create-release',
    operationId: releaseId,
    acceptanceId,
    expectedHead: view.head,
    name: 'Original release',
    buildRunIds: [runId],
  });
  write(root, 'unfinished.txt', 'Keep root work');
  write(work.store.path(lane.id), 'a.ts', 'Keep Lane work');
  const provider = join(root, 'provider.json'),
    bin = join(root, 'trusted-cli');
  mkdirSync(bin);
  writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(
    provider,
    JSON.stringify({
      uploads: 0,
      reads: 0,
      state: 'ready',
      lostReply: false,
      denied: false,
      duplicates: false,
    }),
  );
  const executable = join(bin, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const script = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const file=${JSON.stringify(provider)},args=process.argv.slice(2),s=JSON.parse(fs.readFileSync(file));
assert.deepEqual(args.slice(0,3),['--yes','--package=netlify-cli@27.10.2','netlify']);
assert.ok(!process.cwd().startsWith(${JSON.stringify(root)}));assert.ok(!('NODE_OPTIONS' in process.env));
if(s.denied)process.exit(1);
if(args[3]==='deploy') {assert.ok(args.includes('--draft')&&args.includes('--no-build')&&args.includes('--skip-functions-cache'));assert.ok(!args.includes('--prod'));assert.equal(fs.readdirSync('empty-functions').length,0);assert.match(fs.readFileSync('netlify.toml','utf8'),/command = ""/);s.uploads++;s.marker=args[args.indexOf('--message')+1];s.site=args[args.indexOf('--site')+1];s.html=fs.readFileSync('public/index.html').toString('base64');s.raw=fs.existsSync('public/assets/raw.bin')?fs.readFileSync('public/assets/raw.bin').toString('base64'):null;const tmp=file+'.'+process.pid;fs.writeFileSync(tmp,JSON.stringify(s));fs.renameSync(tmp,file);if(s.lostReply)process.exit(1);console.log(JSON.stringify({deploy_id:(s.providerId||'a'.repeat(24))}));}
else {assert.equal(args[3],'api');const page=JSON.parse(args[args.indexOf('--data')+1]);assert.equal(page.site_id||s.site,s.site||page.site_id);if(args[4]==='getDeploy')assert.equal(page.deploy_id,(s.providerId||'a'.repeat(24)));const item={id:(s.providerId||'a'.repeat(24)),site_id:page.site_id||s.site,title:s.marker,state:s.state,context:'deploy-preview',published_at:null,deploy_ssl_url:'https://'+ (s.providerId||'a'.repeat(24))+'--fixture.netlify.app'};console.log(JSON.stringify(args[4]==='getDeploy'?item:s.paged&&page.page===1?Array.from({length:100},(_,i)=>({...item,id:i.toString(16).padStart(24,'0'),title:'Earlier unrelated draft'})):s.marker ? (s.duplicates?[item,{...item,id:'b'.repeat(24)}]:[item]):[]));}
`;
  writeFileSync(executable, script);
  chmodSync(executable, 0o700);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('--fixture.netlify.app')) return originalFetch(url, options);
    assert.equal(options.redirect, 'manual');
    const s = JSON.parse(readFileSync(provider));
    return new Response(
      Buffer.from(
        s.wrongBytes ? 'changed' : String(url).endsWith('index.html') ? s.html : s.raw,
        s.wrongBytes ? 'utf8' : 'base64',
      ),
    );
  };
  const get = () => JSON.parse(readFileSync(provider)),
    set = patch => {
      const tmp = provider + '.parent';
      writeFileSync(tmp, JSON.stringify({ ...get(), ...patch }));
      renameSync(tmp, provider);
    };
  const input = {
    action: 'deploy-release',
    operationId: randomUUID(),
    releaseId,
    expectedHead: view.head,
    siteId: randomUUID(),
    files: [
      { runId, sourcePath: 'out/index.html', path: 'index.html' },
      { runId, sourcePath: 'out/raw.bin', path: 'assets/raw.bin' },
    ],
  };
  return { root, work, dispatch, input, get, set, lane, originalFetch, gitCalled };
}

test('native source draft delivery and preview rollback preserve retained bytes and dirty work without Git', async t => {
  const { root, work, dispatch, input, get, set, lane, gitCalled } = await setup(t, { native: true });
  assert.equal(work.store.native, true);
  assert.equal(existsSync(join(root, '.git')), false);
  for (const capability of ['nativeSource', 'releases', 'netlifyDrafts', 'previewEnvironments'])
    assert.equal(work.status().capabilities[capability], true);
  const before = work.store.load(),
    source = new NativeSource(root),
    originalState = source.state(input.expectedHead);
  assert.equal(originalState.files.length, 1);
  assert.equal(originalState.files[0].path, 'a.ts');
  assert.equal(source.object(originalState.files[0].blob).toString(), 'export const a = 1;\n');
  const laneBefore = work.status().lanes.find(item => item.id === lane.id);
  set({ lostReply: true, paged: true });
  const replies = await Promise.all([dispatch(input), dispatch(input), dispatch(input)]);
  assert.ok(replies.every(reply => reply.result.id === input.operationId));
  assert.equal(get().uploads, 1);
  // Concurrent callers may return the pending original while its owner completes the upload.
  const retained = work.store.load().deployments;
  assert.equal(retained.length, 1);
  const first = retained.find(item => item.id === input.operationId);
  assert.ok(first?.observation);
  assert.equal(first.observation.state, 'ready');
  assert.ok(first.observation.files.every(file => file.status === 'verified'));
  assert.equal(Buffer.from(get().html, 'base64').toString(), '<h1>Original release</h1>');
  assert.deepEqual(Buffer.from(get().raw, 'base64'), Buffer.from([0, 255, 42]));
  assert.deepEqual(readFileSync(join(first.directory, 'public/assets/raw.bin')), Buffer.from([0, 255, 42]));
  const recovered = new WorkService(root);
  assert.equal((await recovered.dispatch(input, 0)).result.id, first.id);
  assert.equal(get().uploads, 1);
  set({ lostReply: false, providerId: 'b'.repeat(24), state: 'processing' });
  const second = (await dispatch({ ...input, operationId: randomUUID() })).result;
  assert.equal(get().uploads, 2);
  assert.notEqual(first.providerId, second.providerId);
  const command = {
    action: 'select-preview-environment',
    operationId: randomUUID(),
    name: 'Native preview',
    deploymentId: first.id,
    expectedPrevious: null,
  };
  set({ denied: true }); // Retained preview selection and rollback must not need another provider operation.
  const selected = (await dispatch(command)).result;
  assert.deepEqual(selected.deployment.files, first.files);
  const forward = (
    await dispatch({
      ...command,
      operationId: randomUUID(),
      deploymentId: second.id,
      expectedPrevious: selected.id,
    })
  ).result;
  assert.equal(work.status().previewEnvironments[0].deployment.providerId, second.providerId);
  const rollback = { ...command, operationId: randomUUID(), expectedPrevious: forward.id },
    save = work.store.save.bind(work.store);
  let interrupted = false;
  work.store.save = data => {
    save(data);
    if (!interrupted) {
      interrupted = true;
      throw new Error('Lost native preview reply');
    }
  };
  await assert.rejects(dispatch(rollback), /Lost native preview reply/);
  work.store.save = save;
  const reopened = new WorkService(root);
  assert.equal((await reopened.dispatch(rollback, 0)).result.id, rollback.operationId);
  await reopened.dispatch(command, 0);
  assert.equal(reopened.status().previewEnvironments[0].id, rollback.operationId);
  assert.deepEqual(reopened.status().previewEnvironments[0].deployment.files, first.files);
  assert.equal(reopened.status().environmentMoves.length, 3);
  assert.equal(get().uploads, 2);
  const after = reopened.store.load();
  for (const key of ['nativeHead', 'runs', 'releases', 'channelMoves', 'views', 'lanes'])
    assert.deepEqual(after[key], before[key]);
  assert.deepEqual(source.state(input.expectedHead), originalState);
  assert.equal(source.object(originalState.files[0].blob).toString(), 'export const a = 1;\n');
  assert.deepEqual(
    reopened.status().lanes.find(item => item.id === lane.id),
    laneBefore,
  );
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(readFileSync(join(root, 'unfinished.txt'), 'utf8'), 'Keep root work');
  assert.equal(readFileSync(join(work.store.path(lane.id), 'a.ts'), 'utf8'), 'Keep Lane work');
  assert.equal(existsSync(join(root, '.git')), false);
  assert.equal(existsSync(gitCalled), false);
});

test('draft delivery preserves exact failed-run bytes, original source and dirty work; retries and byte observations never upload twice', async t => {
  const { root, work, dispatch, input, get, set, lane } = await setup(t),
    before = work.store.load(),
    index = git(root, ['write-tree']);
  const first = (await dispatch(input)).result;
  assert.equal(get().uploads, 1);
  assert.ok(first.observation.files.every(file => file.status === 'verified'));
  assert.equal(first.observation.publishedAt, null);
  assert.equal(first.files[1].size, 3);
  assert.ok(existsSync(join(first.directory, 'public/assets/raw.bin')));
  await dispatch(input, 0);
  assert.equal(get().uploads, 1);
  await assert.rejects(dispatch({ ...input, siteId: randomUUID() }, 0), code('WORK_OPERATION_CHANGED'));
  set({ wrongBytes: true });
  const nativeMock = globalThis.fetch;
  let announce,
    releaseRead,
    held = false;
  const started = new Promise(resolve => {
      announce = resolve;
    }),
    released = new Promise(resolve => {
      releaseRead = resolve;
    });
  globalThis.fetch = async (url, options) => {
    const response = await nativeMock(url, options);
    if (!held && String(url).endsWith('index.html')) {
      held = true;
      announce();
      await released;
    }
    return response;
  };
  const older = dispatch({ action: 'check-deployment', id: first.id }, 0);
  await started;
  set({ wrongBytes: false });
  const newer = await dispatch({ action: 'check-deployment', id: first.id }, 0);
  releaseRead();
  await older;
  globalThis.fetch = nativeMock;
  assert.deepEqual(work.store.load().deployments[0].observation, newer.result.observation);
  assert.ok(newer.result.observation.files.every(file => file.status === 'verified'));
  set({ wrongBytes: true });
  const changed = (await dispatch({ action: 'check-deployment', id: first.id }, 0)).result;
  assert.equal(changed.observation.state, 'ready');
  assert.ok(changed.observation.files.every(file => file.status === 'unconfirmed'));
  assert.equal(get().uploads, 1);
  set({ denied: true });
  await assert.rejects(dispatch(input, 0), code('NETLIFY_UNAVAILABLE'));
  set({ denied: false });
  const after = work.store.load();
  for (const key of ['runs', 'releases', 'channelMoves', 'views', 'lanes'])
    assert.deepEqual(after[key], before[key]);
  assert.equal(git(root, ['write-tree']), index);
  assert.equal(readFileSync(join(root, 'unfinished.txt'), 'utf8'), 'Keep root work');
  assert.equal(readFileSync(join(work.store.path(lane.id), 'a.ts'), 'utf8'), 'Keep Lane work');
  const originalFiles = work.store.load().runs[0].artifacts;
  rmSync(join(work.store.directory, `check-${input.files[0].runId}`, 'artifacts', originalFiles[1].filename));
  set({ wrongBytes: false });
  const selectedOnly = (
    await dispatch({
      ...input,
      operationId: randomUUID(),
      siteId: input.siteId.toUpperCase(),
      files: [input.files[0]],
    })
  ).result;
  assert.equal(selectedOnly.siteId, input.siteId);
  assert.equal(selectedOnly.observation.files[0].status, 'verified');
  assert.equal(get().uploads, 2);
});

test('lost and concurrent deployment replies reconcile the same provider marker; changed/unsafe originals do not manufacture another upload', async t => {
  const { work, dispatch, input, get, set } = await setup(t);
  set({ lostReply: true, paged: true });
  await Promise.all([dispatch(input), dispatch(input), dispatch(input)]);
  assert.equal(get().uploads, 1);
  assert.equal(work.store.load().deployments.length, 1);
  assert.equal(work.store.load().deployments[0].observation.state, 'ready');
  set({ marker: 'Edited provider title' });
  assert.equal((await dispatch(input, 0)).result.providerId, 'a'.repeat(24));
  assert.equal(get().uploads, 1);
  for (const path of ['../outside', '/absolute', 'index.html']) {
    const files =
      path === 'index.html' ? [input.files[0], { ...input.files[1], path }] : [{ ...input.files[0], path }];
    await assert.rejects(dispatch({ ...input, operationId: randomUUID(), files }), code('BAD_ARGUMENT'));
  }
  await assert.rejects(
    dispatch({
      ...input,
      operationId: randomUUID(),
      files: [input.files[0], { ...input.files[1], path: 'index.html/nested' }],
    }),
    code('BAD_ARGUMENT'),
  );
  await assert.rejects(dispatch({ ...input, operationId: randomUUID() }, 0), code('WORK_STALE'));
  const save = work.store.save.bind(work.store);
  let interrupted = false;
  work.store.save = data => {
    save(data);
    if (data.deployments.at(-1)?.attemptedAt && data.deployments.length === 2 && !interrupted) {
      interrupted = true;
      throw new Error('Lost attempted write');
    }
  };
  const interruptedInput = { ...input, operationId: randomUUID() };
  await assert.rejects(dispatch(interruptedInput), /Lost attempted write/);
  work.store.save = save;
  assert.equal(get().uploads, 1);
  assert.equal((await dispatch(interruptedInput, 0)).result.observation.state, 'unconfirmed');
  assert.equal(get().uploads, 1);
});

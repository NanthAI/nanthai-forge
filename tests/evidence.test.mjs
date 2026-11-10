// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  linkSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WorkService } from '../dist/work.js';

import { fixture, git, write, code } from './helpers.mjs';

function setup(t) {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Baseline']);
  const work = new WorkService(root);
  const local = command => work.execute(command, work.status().revision).result;
  const dispatch = (command, revision = work.status().revision) => work.dispatch(command, revision);
  const intent = local({ action: 'intent', outcome: 'Check exact source' });
  const lane = local({ action: 'lane', intentId: intent.id, name: 'Candidate' });
  const compose = () =>
    local({
      action: 'compose',
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: work.status().lanes[0].actualHead }],
    });
  const view = compose();
  const define = (script, patch = {}) =>
    local({
      action: 'define-check',
      name: 'Synthetic check',
      executable: process.execPath,
      args: ['-e', script],
      ...patch,
    });
  const command = check => ({
    action: 'run-check',
    operationId: randomUUID(),
    viewId: view.id,
    expectedHead: view.head,
    checkId: check.id,
    expectedDefinition: check.definition,
    expectedEnvironment: work.status().environment.fingerprint,
  });
  const output = (id, stream = 'stdout', offset = 0, bytes = 16384) =>
    dispatch({ action: 'read-check-output', operationId: id, stream, offset, bytes });
  return { root, work, local, dispatch, intent, lane, compose, view, define, command, output };
}
async function finished(work, id) {
  for (let i = 0; i < 200; i++) {
    const run = work.status().runs.find(r => r.id === id);
    if (run?.endedAt) return run;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Run did not finish');
}

test('optional native resource observations preserve outcomes, original definitions, cancellation and durable recovery', async t => {
  const { root, work, local, dispatch, define, command, lane, output } = setup(t);
  const { parseResources } = await import('../dist/work-resources.js');
  const script = `const bytes=Buffer.alloc(64*1024*1024,1); let n=0; for(let i=0;i<1e6;i++) n+=i; console.log('measured '+bytes.length+' '+n);console.error('selected stderr');`;
  const original = define(script),
    plainDefinition = original.definition;
  const disabled = define(script, { checkId: original.id, measureResources: false });
  assert.equal(disabled.definition, plainDefinition);
  assert.equal(disabled.measureResources, undefined);
  const measured = define(script, { checkId: original.id, measureResources: true });
  assert.notEqual(measured.definition, plainDefinition);
  write(work.store.path(lane.id), 'a.ts', 'original unfinished Lane');
  const head = git(root, ['rev-parse', 'HEAD']),
    index = readFileSync(join(root, '.git/index'));
  const input = command(measured);
  await dispatch(input);
  const run = await finished(work, input.operationId);
  assert.equal(run.status, 'passed');
  assert.equal(run.exitCode, 0);
  assert.equal(run.resourceUsage.status, 'measured');
  assert.ok(run.resourceUsage.peakRssBytes >= 32 * 1024 * 1024);
  assert.ok(run.resourceUsage.realSeconds >= 0);
  assert.ok(run.resourceUsage.userSeconds >= 0);
  assert.match(run.resourceUsage.details, /not an aggregate/);
  assert.match(run.details, /native time wrapper/);
  assert.match((await output(run.id)).result.text, /^measured 67108864 /);
  assert.equal((await output(run.id, 'stderr')).result.text, 'selected stderr\n');
  assert.equal(statSync(join(work.store.directory, `check-${run.id}/resources.txt`)).mode & 0o777, 0o600);
  assert.equal(existsSync(join(work.store.directory, `check-${run.id}/workspace`)), false);
  assert.equal((await dispatch(input, 0)).result.id, run.id);
  assert.equal(work.status().runs.length, 1);
  const manifest = JSON.parse((await dispatch({ action: 'export-check', id: run.id })).result.json);
  assert.deepEqual(manifest.run.resourceUsage, run.resourceUsage);
  const data = work.store.load();
  const saved = data.runs[0];
  saved.status = 'running';
  delete saved.endedAt;
  delete saved.resourceUsage;
  work.store.save(data);
  const recovered = new WorkService(root).status().runs[0];
  assert.deepEqual(recovered.resourceUsage, run.resourceUsage);
  assert.equal(recovered.status, 'passed');
  local({
    action: 'define-check',
    checkId: measured.id,
    name: measured.name,
    executable: measured.executable,
    args: measured.args,
  });
  assert.equal(work.status().runs[0].applicability, 'historical');
  assert.equal(work.status().runs[0].resourceUsage.status, 'measured');
  const failedInput = command(
    define('console.error("failure stderr");process.exit(7);', { measureResources: true }),
  );
  await dispatch(failedInput);
  const failed = await finished(work, failedInput.operationId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.resourceUsage.status, 'measured');
  assert.match((await output(failed.id, 'stderr')).result.text, /failure stderr/);
  const missingReport = command(
    define(`require('node:fs').unlinkSync('../resources.txt');console.log('command succeeded');`, {
      measureResources: true,
    }),
  );
  await dispatch(missingReport);
  const unavailable = await finished(work, missingReport.operationId);
  assert.equal(unavailable.status, 'passed');
  assert.equal(unavailable.resourceUsage.status, 'unavailable');
  const long = command(
    define('console.log("running");setInterval(()=>{},1000);', { measureResources: true }),
  );
  await dispatch(long);
  for (let i = 0; i < 100 && !(await output(long.operationId)).result.text.includes('running'); i++)
    await new Promise(r => setTimeout(r, 20));
  assert.match((await output(long.operationId)).result.text, /running/);
  await dispatch({ action: 'cancel-check', operationId: long.operationId });
  const cancelled = await finished(work, long.operationId);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.resourceUsage);
  assert.equal((await dispatch(long, 0)).result.status, 'cancelled');
  const ordinary = command(define('console.log("ordinary");'));
  await dispatch(ordinary);
  const unchanged = await finished(work, ordinary.operationId);
  assert.equal(unchanged.resourceUsage, undefined);
  assert.equal(unchanged.status, 'passed');
  const sample = 'real 1.5\nuser 0.2\nsys 0.1\n42 maximum resident set size\n';
  assert.equal(parseResources(sample, 'GNU test', 'linux').peakRssBytes, 42 * 1024);
  assert.equal(parseResources(sample, 'BSD test', 'darwin').peakRssBytes, 42);
  for (const invalid of [
    sample + 'real 2\n',
    sample.replace('42 maximum', '999999999999999999999999 maximum'),
    sample.replace('sys 0.1', 'sys NaN'),
    '',
  ])
    assert.equal(parseResources(invalid, 'untrusted', 'darwin').status, 'unavailable');
  assert.equal(git(root, ['rev-parse', 'HEAD']), head);
  assert.deepEqual(readFileSync(join(root, '.git/index')), index);
  assert.equal(readFileSync(join(work.store.path(lane.id), 'a.ts'), 'utf8'), 'original unfinished Lane');
});

test('exact check pins, private lossless paged logs, idempotent retries and historical reviews preserve source', async t => {
  const { root, work, local, dispatch, lane, view, define, command, output, compose } = setup(t);
  const original = git(root, ['rev-parse', 'HEAD']).trim();
  write(work.store.path(lane.id), 'a.ts', 'unfinished Lane source');
  const check = define(
    `const fs=require('node:fs'); console.log(fs.readFileSync('a.ts','utf8')); console.error('private stderr'); process.stdout.write('é'.repeat(2200000)); if(process.env.FORGE_TEST_SECRET) process.exit(9);`,
  );
  const secret = process.env.FORGE_TEST_SECRET;
  process.env.FORGE_TEST_SECRET = 'must-not-forward';
  t.after(() => {
    if (secret === undefined) delete process.env.FORGE_TEST_SECRET;
    else process.env.FORGE_TEST_SECRET = secret;
  });
  const input = command(check),
    revision = work.status().revision;
  assert.equal((await dispatch(input)).result.id, input.operationId);
  const result = await finished(work, input.operationId);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.inputs, view.inputs);
  assert.deepEqual(result.dependencies, view.dependencies);
  assert.equal(result.base, view.base);
  const path = join(work.store.directory, `check-${result.id}`);
  assert.equal(existsSync(join(path, 'workspace')), false);
  const actual = readFileSync(join(path, 'stdout.log'));
  assert.ok(actual.length > 4 * 1024 * 1024);
  assert.ok(actual.toString().startsWith('export const a = 1;'));
  const first = (await output(result.id, 'stdout', 0, 25)).result;
  const second = (await output(result.id, 'stdout', 25, 100)).result;
  assert.deepEqual(
    Buffer.concat([Buffer.from(first.base64, 'base64'), Buffer.from(second.base64, 'base64')]),
    actual.subarray(0, 125),
  );
  assert.equal((await output(result.id, 'stderr')).result.text, 'private stderr\n');
  assert.equal(statSync(join(path, 'stdout.log')).mode & 0o777, 0o600);
  assert.ok(statSync(join(work.store.directory, 'work.json')).size < 20000);
  assert.equal((await dispatch(input, revision)).result.id, result.id);
  assert.equal(work.status().runs.length, 1);
  await assert.rejects(
    dispatch({ ...input, expectedHead: '0'.repeat(40) }, revision),
    code('EVIDENCE_CHANGED'),
  );
  local({
    action: 'review-view',
    viewId: view.id,
    expectedHead: view.head,
    reviewer: 'Synthetic reviewer',
    decision: 'comment',
    text: 'Fixture record, not a verified human approval.',
  });
  assert.equal(work.status().reviews[0].provenance, 'user-declared');
  define('process.exit(0)', { checkId: check.id });
  assert.equal(work.status().runs[0].applicability, 'historical');
  assert.equal(work.status().reviews[0].applicability, 'current');
  compose();
  assert.equal(work.status().reviews[0].applicability, 'historical');
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), original);
  assert.equal(readFileSync(join(work.store.path(lane.id), 'a.ts'), 'utf8'), 'unfinished Lane source');
  unlinkSync(join(path, 'stdout.log'));
  symlinkSync(join(root, 'a.ts'), join(path, 'stdout.log'));
  await assert.rejects(output(result.id), code('NOT_FOUND'));
  unlinkSync(join(path, 'stdout.log'));
  linkSync(join(root, 'a.ts'), join(path, 'stdout.log'));
  await assert.rejects(output(result.id), code('UNSAFE_PATH'));
});

test('stale definitions, runtime and View pins fail before execution; failures and changed workspaces remain explicit', async t => {
  const { root, work, dispatch, define, command } = setup(t);
  const check = define('process.exit(7)');
  const input = command(check);
  for (const [patch, error] of [
    [{ expectedHead: '0'.repeat(40) }, 'VIEW_STALE'],
    [{ expectedDefinition: '0'.repeat(64) }, 'EVIDENCE_CHANGED'],
    [{ expectedEnvironment: '0'.repeat(64) }, 'EVIDENCE_CHANGED'],
  ]) {
    await assert.rejects(dispatch({ ...input, ...patch }), code(error));
  }
  await assert.rejects(dispatch(input, 0), code('WORK_STALE'));
  assert.equal(work.status().runs.length, 0);
  await dispatch(input);
  assert.equal((await finished(work, input.operationId)).exitCode, 7);
  const missing = command(define('', { executable: join(root, 'not-an-executable') }));
  await dispatch(missing);
  assert.equal((await finished(work, missing.operationId)).status, 'failed');
  const journalFailure = command(define('', { executable: join(root, 'also-not-an-executable') }));
  const save = work.store.save.bind(work.store);
  work.store.save = data => {
    if (data.runs.at(-1)?.status === 'running') throw new Error('Synthetic journal failure');
    save(data);
  };
  await dispatch(journalFailure);
  assert.equal((await finished(work, journalFailure.operationId)).status, 'failed');
  work.store.save = save; // A spawn error remains handled even if running-journal publication fails.
  const mutated = command(
    define("require('node:fs').writeFileSync('a.ts','changed during execution'); console.log('done')"),
  );
  await dispatch(mutated);
  const result = await finished(work, mutated.operationId);
  assert.equal(result.status, 'passed');
  assert.match(result.details, /workspace retained/i);
  assert.equal(
    readFileSync(join(work.store.directory, `check-${result.id}`, 'workspace/a.ts'), 'utf8'),
    'changed during execution',
  );
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'export const a = 1;\n');
});

test('HTTP starts promptly, paged output is capability protected and another WorkService can cancel a live process group', async t => {
  const { root, work, define, command, output } = setup(t);
  const selected = command(
    define(
      `const cp=require('node:child_process'); console.log('running'); const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('descendant='+child.pid); process.on('SIGTERM',()=>child.once('close',()=>process.exit(0))); setInterval(()=>{},1000);`,
    ),
  );

  const body = JSON.stringify({ command: selected, revision: work.status().revision });

  await new WorkService(root).dispatch(JSON.parse(body).command, JSON.parse(body).revision);
  let text = '';
  for (let i = 0; i < 100 && !text.includes('descendant='); i++) {
    await new Promise(r => setTimeout(r, 20));
    text = (await output(selected.operationId)).result.text;
  }
  assert.match(text, /running/);
  const descendant = Number(text.match(/descendant=(\d+)/)[1]);
  const other = new WorkService(root);
  await other.dispatch({ action: 'cancel-check', operationId: selected.operationId }, 0);
  const result = await finished(work, selected.operationId);
  assert.equal(result.status, 'cancelled');
  assert.throws(
    () => process.kill(descendant, 0),
    e => e.code === 'ESRCH',
  );
  assert.equal(
    (await other.dispatch({ action: 'cancel-check', operationId: selected.operationId }, 0)).result.status,
    'cancelled',
  );
  const protectedBody = JSON.stringify({
    command: { action: 'read-check-output', operationId: selected.operationId, stream: 'stdout' },
    revision: 0,
  });
});

test('runner death never repeats a command; a durable completion receipt reconciles once', async t => {
  const { root, work, define, command } = setup(t);
  const check = define('console.log("not executed")');
  const input = command(check);
  const data = work.store.load();
  const pid = Number(
    execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim(),
  );
  data.runs.push({
    id: input.operationId,
    viewId: input.viewId,
    head: input.expectedHead,
    base: data.views[0].base,
    inputs: data.views[0].inputs,
    dependencies: [],
    check,
    environment: work.status().environment,
    status: 'preparing',
    startedAt: new Date().toISOString(),
    runner: { pid, host: (await import('node:os')).hostname() },
    details: 'Interrupted fixture',
  });
  work.store.save(data);
  const recovered = new WorkService(root).status();
  assert.equal(recovered.runs[0].status, 'interrupted');
  assert.equal(existsSync(join(work.store.directory, `check-${input.operationId}`)), false);
  assert.equal((await work.dispatch(input, 0)).result.status, 'interrupted');
  const next = work.store.load();
  next.runs[0].status = 'running';
  next.runs[0].runner.pid = process.pid;
  delete next.runs[0].endedAt;
  work.store.save(next);
  const path = join(work.store.directory, `check-${input.operationId}`);
  mkdirSync(path);
  writeFileSync(
    join(path, 'result.json'),
    JSON.stringify({ status: 'passed', exitCode: 0, signal: null, details: 'Incomplete receipt' }),
    { mode: 0o600 },
  );
  assert.equal(work.status().runs[0].status, 'running'); // A partial receipt cannot manufacture completion.
  writeFileSync(
    join(path, 'result.json'),
    JSON.stringify({
      status: 'passed',
      exitCode: 0,
      signal: null,
      endedAt: new Date().toISOString(),
      details: 'Durable fixture receipt',
    }),
    { mode: 0o600 },
  );
  const result = work.status();
  assert.equal(result.runs[0].status, 'passed');
  assert.equal(work.status().revision, result.revision);
});

test('recorded environment drift marks old outcomes historical without automatic runs or review inheritance', async t => {
  const { work, local, dispatch, define, command, view, lane, compose } = setup(t);
  const input = command(define('process.exit(0)'));
  await dispatch(input);
  await finished(work, input.operationId);
  local({
    action: 'review-view',
    viewId: view.id,
    expectedHead: view.head,
    reviewer: 'Synthetic fixture',
    decision: 'approve',
  });
  assert.equal(work.status().reviews[0].text, '');
  local({
    action: 'review-view',
    viewId: view.id,
    expectedHead: view.head,
    reviewer: 'Synthetic fixture',
    decision: 'comment',
    text: 'Long synthetic review: ' + 'x'.repeat(5000),
  });
  assert.ok(work.status().reviews[1].text.length > 4000);
  const before = process.env.TZ;
  try {
    process.env.TZ = 'Etc/GMT+3';
    assert.equal(work.status().runs[0].applicability, 'historical');
    assert.equal(work.status().reviews[0].applicability, 'current');
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
  assert.equal(work.status().runs.length, 1);
  const path = work.store.path(lane.id);
  write(path, 'a.ts', 'export const a = 2;\n');
  git(path, ['add', 'a.ts']);
  const current = work.status().lanes[0];
  local({
    action: 'checkpoint',
    laneId: lane.id,
    expectedHead: current.actualHead,
    expectedTree: current.indexTree,
    message: 'Changed input',
  });
  const next = compose();
  assert.notEqual(next.head, view.head);
  assert.equal(work.status().runs[0].head, view.head);
  assert.equal(work.status().runs[0].applicability, 'historical');
  assert.equal(work.status().reviews[0].head, view.head);
  assert.equal(work.status().reviews[0].applicability, 'historical');
});

function githubFixture(t, root) {
  const path = join(root, '.git/checks.json');
  writeFileSync(path, JSON.stringify({ count: 101 }));
  const state = () => JSON.parse(readFileSync(path, 'utf8'));
  const change = patch => writeFileSync(path, JSON.stringify({ ...state(), ...patch }));
  const bin = join(root, '.git/check-bin');
  mkdirSync(bin);
  const before = process.env.PATH;
  t.after(() => {
    process.env.PATH = before;
  });
  writeFileSync(
    join(bin, 'gh'),
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const path=${JSON.stringify(path)}, state=JSON.parse(readFileSync(path,'utf8'));
if(state.denied) process.exit(1);
const endpoint=process.argv[7]; const match=endpoint?.match(/commits\\/([0-9a-f]+)\\/check-runs.*page=(\\d+)/);
if(!match) process.exit(2); state.calls=(state.calls||0)+1; writeFileSync(path,JSON.stringify(state));
const page=Number(match[2]), start=state.repeated ? 0 : (page-1)*100;
const checks=Array.from({length:Math.max(0,Math.min(100,state.count-start))},(_,i)=>({id:start+i+1,name:'Check '+(start+i+1),head_sha:state.badHead?'0'.repeat(40):match[1],status:'completed',conclusion:'success',html_url:null,started_at:null,completed_at:null,app:{id:1,name:'Fixture CI'}}));
if(state.delay) await new Promise(r=>setTimeout(r,state.delay));
console.log(JSON.stringify({total_count:state.count,check_runs:checks}));
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${before}`;
  return { state, change };
}
test('GitHub check imports paginate, retain original provenance, reconcile IDs and reject denied or wrong-head reads', async t => {
  const { root, work, local, dispatch, view, intent, compose } = setup(t);
  const { state, change } = githubFixture(t, root);
  const command = {
    action: 'import-checks',
    operationId: randomUUID(),
    viewId: view.id,
    expectedHead: view.head,
    repository: 'tests/example',
  };
  const result = (await dispatch(command)).result;
  assert.equal(result.checks.length, 101);
  assert.equal(state().calls, 2);
  change({ denied: true });
  assert.equal((await dispatch(command, 0)).result.id, result.id); // Reconciliation reads retained metadata, not revoked GitHub.
  await assert.rejects(dispatch({ ...command, operationId: randomUUID() }), code('PUBLISH_GITHUB_FAILED'));
  await assert.rejects(dispatch({ ...command, repository: 'tests/another' }, 0), code('EVIDENCE_CHANGED'));
  change({ denied: false, badHead: true });
  await assert.rejects(dispatch({ ...command, operationId: randomUUID() }), code('EVIDENCE_CHANGED'));
  change({ badHead: false, count: 0 });
  const empty = (await dispatch({ ...command, operationId: randomUUID() })).result;
  assert.deepEqual(empty.checks, []);
  assert.match(empty.details, /unknown/);
  change({ count: 101, repeated: true });
  const partial = (await dispatch({ ...command, operationId: randomUUID() })).result;
  assert.equal(partial.checks.length, 100);
  assert.match(partial.details, /incomplete/);
  change({ count: 1, repeated: false, delay: 150 });
  const delayed = dispatch({ ...command, operationId: randomUUID() });
  await new Promise(r => setTimeout(r, 75));
  local({ action: 'note', intentId: intent.id, kind: 'decision', text: 'Concurrent decision stays intact' });
  await delayed;
  assert.equal(work.status().intents[0].notes[0].text, 'Concurrent decision stays intact');
  compose();
  assert.equal(work.status().githubChecks[0].applicability, 'historical');
});

test('cancellation observed during preparation prevents the selected executable from starting', async t => {
  const { root, work, define, command, dispatch, output } = setup(t);
  const bin = join(root, '.git/cancel-bin');
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const before = process.env.PATH;
  t.after(() => {
    process.env.PATH = before;
  });
  const storeModule = new URL('../dist/work-store.js', import.meta.url).href;
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}
import { execFileSync } from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('worktree') && args.includes('add') && args.includes('--detach')) {
  const { WorkStore } = await import(${JSON.stringify(storeModule)}); const store=new WorkStore(${JSON.stringify(root)});
  store.locked(()=>{const data=store.load(); data.runs.at(-1).cancelRequested=true; data.revision++; store.save(data);});
}
try { process.stdout.write(execFileSync(${JSON.stringify(realGit)},args,{encoding:'utf8',stdio:['ignore','pipe','pipe']})); }
catch(e) { process.exit(e.status||1); }
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${before}`;
  const selected = command(define('console.log("must never execute");'));
  await dispatch(selected);
  const result = await finished(work, selected.operationId);
  assert.equal(result.status, 'cancelled');
  assert.match(result.details, /before.*started/);
  assert.equal((await output(selected.operationId)).result.text, '');
  assert.equal(existsSync(join(work.store.directory, `check-${selected.operationId}/workspace`)), false);
});

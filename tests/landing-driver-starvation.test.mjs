// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises';
import { landReceipt, observeLandReceipt } from '../dist/land-receipt.js';
import { observeUnfinishedFinishes } from '../dist/agent-finish-journal.js';
import { observePendingLands } from '../dist/land-journal.js';
import { controlActions } from '../dist/github-actions-controller.js';
import { admitLandingCheck } from '../dist/landing-check-admission.js';
import { detachedChecksRequired } from '../dist/check-execution-context.js';
import { WorkRecordTransaction } from '../dist/work-record-transaction.js';
import { claimLandingDriver } from '../dist/landing-driver.js';
import { historyFixture } from './landing-starvation-fixture.mjs';
import { fixture } from './landing-batch-fixture.mjs';
import { batchEdit, selectBatch, composeBatch } from '../dist/landing-batch-store.js';
import { observeLandingQueue } from '../dist/landing-records.js';

test('driver observation with 550 entries and 450 batches yields to provider completion', async t => {
  const f = await historyFixture(t);
  await yieldTurn();
  const pollMs = 200,
    turns = [];
  let completedAt,
    completedPoll,
    observedPoll,
    polls = 0,
    observedAt,
    previous = performance.now(),
    maxLag = 0;
  const lag = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - previous - 5);
    previous = now;
  }, 5);
  t.after(() => clearInterval(lag));
  const complete = setImmediate(() => {
    completedAt = performance.now();
    completedPoll = polls;
  });
  t.after(() => clearImmediate(complete));
  const journal = {
    repo: 'synthetic/checks',
    runId: 1,
    commit: 'a'.repeat(40),
    retrying: [],
    retrySources: {},
    oom: [],
    logged: [],
    states: {},
  };
  const api = {
    async request(endpoint) {
      if (endpoint.endsWith('/timing')) return {};
      return {
        head_sha: journal.commit,
        status: completedAt ? 'completed' : 'in_progress',
        conclusion: completedAt ? 'success' : null,
      };
    },
    async pages() {
      if (completedAt) {
        observedAt ??= performance.now();
        observedPoll ??= polls;
      }
      return ['forge-static', 'forge-shard-0'].map((name, id) => ({
        id: id + 1,
        name,
        status: completedAt ? 'completed' : 'in_progress',
        conclusion: completedAt ? 'success' : null,
      }));
    },
    log: async () => 'synthetic passed\n',
    sleep: async () => {
      polls++;
      await delay(pollMs);
    },
  };
  const provider = controlActions(
    { output: f.store.directory, groups: [['synthetic.test.mjs']] },
    journal,
    () => {},
    api,
    () => false,
    () => {},
  );
  // The cold header index must also yield; include it in event-loop lag measurement.
  const coldStart = performance.now();
  await observeLandingQueue(f.store, 'main');
  assert.notEqual(completedAt, undefined, 'cold discovery yields to a ready provider completion');
  await Promise.all([observeUnfinishedFinishes(f.store), observePendingLands(f.store)]);
  const coldMs = performance.now() - coldStart;
  const result = await provider;
  const originalAt = WorkRecordTransaction.prototype.at;
  const hydration = t.mock.method(WorkRecordTransaction.prototype, 'at', function (collection, position) {
    assert.equal(
      collection,
      'checks',
      'scheduling must not hydrate entries, prefix histories, Views, Lanes or runs',
    );
    return originalAt.call(this, collection, position);
  });
  try {
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const observed = await observeLandingQueue(f.store, 'main');
      turns.push(performance.now() - start);
      assert.equal(observed.landingEntries.length, 1);
      assert.equal(observed.landingBatches.length, 1);
      await yieldTurn();
    }
  } finally {
    hydration.mock.restore();
  }
  const command = {
    action: 'land',
    operationId: randomUUID(),
    laneIds: [f.input.lane.laneId],
    channel: 'main',
  };
  const retained = {
    command: f.input.command,
    inputs: f.input.view.inputs,
    viewId: f.input.view.id,
    queued: true,
    result: { status: 'waiting' },
  };
  await observeLandReceipt(f.store, command, { state: { entries: [retained] } });
  const receiptTurns = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const receipt = landReceipt(f.store, command, { state: { entries: [retained] } });
    receiptTurns.push(performance.now() - start);
    assert.equal(receipt.result.terminal, false);
    assert.equal(
      receipt.result.entries[0].phases.attempts.length,
      1,
      "only this submission's batch is hydrated",
    );
    await yieldTurn();
  }
  const journalRead = fs.readFileSync;
  let journalReads = 0;
  const read = t.mock.method(fs, 'readFileSync', (...args) => {
    if (/agent-(?:finish|land)/.test(String(args[0]))) journalReads++;
    return journalRead(...args);
  });
  const { syncBuiltinESMExports } = await import('node:module');
  syncBuiltinESMExports();
  try {
    await Promise.all([observeUnfinishedFinishes(f.store), observePendingLands(f.store)]);
  } finally {
    read.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(journalReads, 0, 'unchanged terminal journals are not reread or parsed');

  t.diagnostic(
    `landReceipt turns ${receiptTurns.map(value => value.toFixed(2)).join(', ')}ms; 1,000 unchanged terminal journals reread ${journalReads} files`,
  );
  await delay(10);
  clearInterval(lag);
  assert.equal(result.status, 'passed');

  assert.ok(
    observedAt !== undefined && observedPoll - completedPoll <= 1,
    `completion must be observed by the next provider poll: ${observedPoll - completedPoll}`,
  );
  t.diagnostic(
    `550 entries / 450 batches: cold cooperative observation ${coldMs.toFixed(2)}ms; warm turns ${turns.map(value => value.toFixed(2)).join(', ')}ms; max event-loop lag ${maxLag.toFixed(2)}ms; GitHub completion observed after ${(observedAt - completedAt).toFixed(2)}ms (${pollMs}ms poll)`,
  );
});

test('GitHub landing admission requires a detached check controller even outside the owner worker', async t => {
  const f = await fixture(t, { remote: false });
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    checks: { runner: 'github-actions', repo: 'synthetic/checks' },
  });
  await f.candidate('detached.txt');
  const selected = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
  await composeBatch(f.work, selected);
  const batch = f.store.select('landingBatches', selected.id),
    driver = await claimLandingDriver(f.work, 'main');
  let dispatched = 0;
  f.work.dispatch = async command => {
    assert.equal(command.action, 'run-check');
    assert.equal(detachedChecksRequired(), true);
    dispatched++;
  };
  assert.equal(await admitLandingCheck(f.work, batch, batch.prefixes[0], driver), true);
  assert.equal(dispatched, 1);
  assert.equal(detachedChecksRequired(), false, 'detachment context does not escape admission');
});

test('presence-hosted drain observes detached GitHub completion after prompt SIGTERM shutdown', async t => {
  let release = () => {};
  t.after(() => release());
  const f = await historyFixture(t, { github: true });
  const directory = f.store.directory;
  const ready = join(directory, 'fake-actions-ready'),
    complete = join(directory, 'fake-actions-complete'),
    observed = join(directory, 'fake-actions-observed');
  release = () => {
    if (existsSync(directory)) writeFileSync(complete, 'green');
  };
  const controller = join(directory, 'fake-actions-controller.mjs');
  const module = name => new URL('../dist/' + name + '.js', import.meta.url).href;
  const pollMs = 1000;
  writeFileSync(
    controller,
    `import fs from 'node:fs';
import {WorkStore} from ${JSON.stringify(module('work-store'))};
import {runCheckController} from ${JSON.stringify(module('check-controller'))};
import {launchGithubActionsRun} from ${JSON.stringify(module('work-github-actions-run'))};
const commit='a'.repeat(40), id=process.argv[3];
const done=()=>fs.existsSync(${JSON.stringify(complete)});
const api={async request(endpoint){if(endpoint.endsWith('/timing'))return {};return {id:1,head_sha:commit,status:done()?'completed':'in_progress',conclusion:done()?'success':null};},
async pages(){fs.writeFileSync(${JSON.stringify(ready)},'ready');if(done()&&!fs.existsSync(${JSON.stringify(observed)}))fs.writeFileSync(${JSON.stringify(observed)},String(Date.now()));return [{id:20,name:'forge-static',status:done()?'completed':'in_progress',conclusion:done()?'success':null,run_attempt:1}];},
async log(){return 'synthetic passed\\n';},sleep:()=>new Promise(resolve=>setTimeout(resolve,${pollMs}))};
await runCheckController(new WorkStore(process.argv[2]),id,(store,run)=>launchGithubActionsRun(store,run,api,async(plan,journal,save)=>{journal.commit=commit;journal.runId=1;journal.pushed=true;save();},async()=>{}));
`,
  );
  const preload = join(directory, 'fake-actions-preload.mjs');
  writeFileSync(
    preload,
    `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const spawn=cp.spawn;cp.spawn=(executable,args,options)=>spawn(executable,args[0]?.endsWith('/check-controller-worker.js')?[${JSON.stringify(controller)},...args.slice(1)]:args,options);syncBuiltinESMExports();`,
  );
  const child = spawn(
    process.execPath,
    ['--import', preload, new URL('../dist/presence-worker.js', import.meta.url).pathname, f.root],
    { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const exited = once(child, 'exit');
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', bytes => (stderr += bytes));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  const end = Date.now() + 20000;
  while (!existsSync(ready)) {
    assert.equal(child.exitCode, null, stderr);
    assert.ok(Date.now() < end, `detached Actions controller did not start: ${stderr}`);
    await delay(20);
  }
  const batch = f.store.select('landingBatches', f.batch.id),
    run = f.store.select('runs', batch.prefixes[0].runId);
  assert.notEqual(
    run.runner.pid,
    child.pid,
    'presence process does not own the GitHub observer or check slot',
  );
  const stoppedAt = performance.now();
  child.kill('SIGTERM');
  await Promise.race([exited, delay(2000).then(() => assert.fail('presence worker ignored SIGTERM for 2s'))]);
  const stopMs = performance.now() - stoppedAt;
  const completedAt = Date.now();
  writeFileSync(complete, 'green');
  const result = join(directory, `check-${run.id}`, 'result.json');
  while (!existsSync(result)) {
    assert.ok(Date.now() - completedAt < 3000, 'detached check lost completion after presence shutdown');
    await delay(20);
  }
  assert.equal(JSON.parse(readFileSync(result)).status, 'passed');
  const completionMs = Number(readFileSync(observed, 'utf8')) - completedAt;
  assert.ok(completionMs <= pollMs, `completion observation exceeded one ${pollMs}ms poll: ${completionMs}`);
  t.diagnostic(
    `presence SIGTERM exit ${stopMs.toFixed(2)}ms; detached GitHub completion ${completionMs}ms (${pollMs}ms poll); result.json passed`,
  );
});

test('Q2 stall deadlines and terminal continuations select only live entries and exact prefix runs', async t => {
  const { landingStallRecords } = await import('../dist/landing-stall-watch.js');
  const { terminalLandingBatches } = await import('../dist/landing-worker.js');
  const { entryProgress } = await import('../dist/landing-entry-stall.js');
  const f = await historyFixture(t, { journals: false });
  const executed = (await f.agent.dispatch({ action: 'run', viewId: f.input.view.id })).result;
  const run = f.store.select('runs', executed.runId);
  f.store.locked(() => {
    const tx = f.store.records();
    tx.append('runs', { ...run, id: f.batch.prefixes[0].runId });
    for (let i = 0; i < 25; i++) tx.append('runs', { ...run, id: randomUUID() });
    f.store.commitRecords(tx);
  });
  const full = f.store.load();
  const expected = entryProgress(
    full,
    full.landingEntries.find(entry => entry.id === f.batch.entryIds[0]),
  );
  await observeLandingQueue(f.store); // Prime immutable location headers cooperatively.
  t.mock.method(f.store, 'load', () => assert.fail('Q2 observations must not load whole Work'));
  const at = WorkRecordTransaction.prototype.at;
  const hydrated = [];
  t.mock.method(WorkRecordTransaction.prototype, 'at', function (collection, position) {
    hydrated.push([collection, position]);
    assert.equal(collection, 'landingBatches', 'only selected live prefix histories need hydration');
    return at.call(this, collection, position);
  });
  const fields = WorkRecordTransaction.prototype.fields;
  const runIds = [];
  t.mock.method(WorkRecordTransaction.prototype, 'fields', function (collection, id) {
    if (collection === 'runs') runIds.push(id);
    return fields.call(this, collection, id);
  });
  const observed = landingStallRecords(f.store);
  assert.equal(observed.landingEntries.length, 1);
  assert.equal(observed.landingBatches.length, 1);
  assert.equal(observed.runs.length, 1);
  assert.deepEqual(entryProgress(observed, observed.landingEntries[0]), expected);
  assert.deepEqual(
    (await terminalLandingBatches(f.store, 'main')).map(batch => batch.id),
    [f.batch.id],
  );
  assert.deepEqual(runIds, [f.batch.prefixes[0].runId, f.batch.prefixes[0].runId]);
  assert.equal(hydrated.length, 2, 'one live batch for each observation, no historical batches');
  t.diagnostic(
    '550 entries / 450 batches / 27 runs: Q2 hydrated 2 live batches and selected 2 exact run headers across both observations',
  );
});

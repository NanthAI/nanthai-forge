// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { allRecords } from '../dist/agent-lifecycle.js';
import { agentClean } from '../dist/agent-clean.js';
import { automaticCleanup } from '../dist/work-auto-clean.js';
import { retentionPlan, RETENTION_MS, LOG_TAIL_BYTES } from '../dist/clean-retention.js';
import { mockProcessCoverage } from './cleanup-process-fixture.mjs';

const clean = (p, patch = {}) =>
  agentClean(p.store, { action: 'clean', apply: false, kinds: ['check-retention'], ...patch }).result;
const now = Date.now();
function age(path, time) {
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) age(join(path, name), time);
  utimesSync(path, time / 1000, time / 1000);
}
function replace(p, collection, id, patch) {
  p.store.locked(() => {
    const tx = p.store.records(),
      found = tx.find(collection, id);
    tx.replace(collection, found.position, { ...found.record, ...patch });
    p.store.commitRecords(tx);
  });
}
async function fixture(t) {
  const scan = mockProcessCoverage(t),
    root = mkdtempSync(join(tmpdir(), 'forge-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'synthetic\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  await agent.dispatch({ action: 'set-policy', operationId: randomUUID(), preset: 'trusted' });
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', "console.error('failure tail');process.exitCode=1"],
  });
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic retained run' })).result;
  writeFileSync(join(lane.path, 'changed.txt'), 'synthetic changed source');
  await agent.dispatch({ action: 'finish', laneId: lane.laneId, message: 'Synthetic' });
  const run = allRecords(store, 'runs')[0],
    directory = join(store.directory, `check-${run.id}`);
  const p = { scan, root, agent, store, lane, run, directory };
  replace(p, 'lanes', lane.laneId, { state: 'completed' });
  const receipt = JSON.parse(readFileSync(join(directory, 'result.json')));
  const endedAt = new Date(now - RETENTION_MS - 1000).toISOString();
  const failureSummary = 'Synthetic failure remains readable';
  replace(p, 'runs', run.id, { endedAt, failureSummary });
  writeFileSync(join(directory, 'result.json'), JSON.stringify({ ...receipt, endedAt, failureSummary }));
  mkdirSync(join(directory, 'modal-source'), { recursive: true });
  writeFileSync(join(directory, 'modal-source', 'source.txt'), 'disposable source');
  mkdirSync(join(directory, 'shards', 'work-0'), { recursive: true });
  writeFileSync(join(directory, 'shards', 'work-0', 'build'), 'disposable work');
  for (const name of ['stdout.log', 'stderr.log', 'shards/0.log'])
    writeFileSync(join(directory, name), 'x'.repeat(LOG_TAIL_BYTES * 2) + '\nfailure tail\n');
  for (const name of [
    'selection.json',
    'changes.json',
    'modal-plan.json',
    'modal-state.json',
    'github-actions.json',
  ])
    writeFileSync(join(directory, name), '{"synthetic":true}');
  age(directory, now - RETENTION_MS - 1000);
  return p;
}

test('seven-day boundary applies to shard work and logs; remote source copies expire immediately', async t => {
  const p = await fixture(t);
  const plan = time => retentionPlan(p.store, ['check-retention'], { paths: [], unknown: false }, time);
  assert.equal(plan(now - 1000).items.length, 1, 'only remote source at exactly seven days');
  assert.equal(plan(now - 1001).items.length, 1, 'only remote source when younger');
  assert.equal(plan(now).items.length, 5, JSON.stringify(plan(now)));
  age(join(p.directory, 'modal-source'), now);
  assert.equal(plan(now).items.length, 5, 'recent remote source copy also expires');
});

test('dry-run is read-only; apply keeps receipts, summaries, compact evidence and expires log bytes, then is idempotent', async t => {
  const p = await fixture(t),
    before = p.store.pointer();
  const dry = clean(p);
  assert.equal(dry.totals.count, 5, JSON.stringify(dry));
  assert.ok(p.store.pointer().equals(before));
  assert.equal(readFileSync(join(p.directory, 'stdout.log')).length, LOG_TAIL_BYTES * 2 + 14);
  const applied = clean(p, { apply: true });
  assert.equal(applied.totals.count, 5);
  assert.equal(existsSync(join(p.directory, 'modal-source')), false);
  assert.equal(existsSync(join(p.directory, 'shards', 'work-0')), false);
  for (const name of ['stdout.log', 'stderr.log', 'shards/0.log']) {
    assert.equal(existsSync(join(p.directory, name)), false);
    assert.match(readFileSync(join(p.directory, 'test-reports.json'), 'utf8'), /failure tail/);
  }
  for (const name of [
    'selection.json',
    'changes.json',
    'modal-plan.json',
    'modal-state.json',
    'github-actions.json',
  ])
    assert.equal(readFileSync(join(p.directory, name), 'utf8'), '{"synthetic":true}');
  assert.equal(
    JSON.parse(readFileSync(join(p.directory, 'result.json'))).failureSummary,
    'Synthetic failure remains readable',
  );
  const status = await p.agent.dispatch({ action: 'status' });
  assert.ok(status.result);
  const records = (await p.agent.dispatch({ action: 'records', collection: 'runs' })).result.items;
  assert.equal(records.find(r => r.id === p.run.id).failureSummary, 'Synthetic failure remains readable');
  const logs = await p.agent.dispatch({ action: 'log', operationId: p.run.id, tail: 4096 });
  assert.match(JSON.stringify(logs.result), /failure tail/);
  assert.equal(clean(p, { apply: true }).totals.count, 0);
});

for (const status of ['queued', 'preparing', 'running'])
  test(`${status} run is excluded`, async t => {
    const p = await fixture(t);
    replace(p, 'runs', p.run.id, { status });
    // Direct planner avoids the unrelated dead-run recovery used by clean apply.
    const plan = retentionPlan(p.store, ['check-retention'], { paths: [], unknown: false }, now);
    assert.equal(plan.items.length, 0);
    assert.match(plan.skipped[0].reason, new RegExp(status));
  });

test('open Lanes and acceptance references keep evidence; explicit release/export pins keep copies', async t => {
  const p = await fixture(t);
  replace(p, 'lanes', p.lane.laneId, { state: 'active' });
  assert.equal(clean(p).totals.count, 5);
  writeFileSync(join(p.store.directory, 'acceptance.json'), JSON.stringify({ viewId: p.run.viewId }));
  assert.equal(clean(p).totals.count, 5);
  replace(p, 'lanes', p.lane.laneId, { state: 'completed' });
  for (const [name, value] of [
    ['release.json', { buildRuns: [{ id: p.run.id }] }],
    ['export.json', { files: [{ path: `check-${p.run.id}/stdout.log` }] }],
  ]) {
    const path = join(p.store.directory, name);
    writeFileSync(path, JSON.stringify(value));
    assert.equal(clean(p).totals.count, name === 'export.json' ? 4 : 0, name);
    rmSync(path);
  }
  assert.equal(clean(p).totals.count, 5);
});

test('apply rechecks stale plans, running processes and uncertain remote outcomes', async t => {
  const p = await fixture(t),
    items = clean(p)
      .candidates.flatMap(g => g.items)
      .map(i => i.id);
  p.scan.paths = [join(p.directory, 'modal-source')];
  assert.equal(clean(p, { apply: true, items }).totals.count, 0);
  p.scan.paths = [];
  writeFileSync(
    join(p.directory, 'modal-executions.json'),
    JSON.stringify({ creating: false, executions: [{ id: 'synthetic-remote' }] }),
  );
  assert.equal(clean(p).totals.count, 0);
  writeFileSync(
    join(p.directory, 'modal-executions.json'),
    JSON.stringify({ creating: false, executions: [{ id: 'synthetic-remote', exitCode: 1 }] }),
  );
  replace(p, 'runs', p.run.id, { status: 'running' });
  assert.equal(
    retentionPlan(p.store, ['check-retention'], { paths: [], unknown: false }, now).items.length,
    0,
  );
  assert.ok(existsSync(join(p.directory, 'modal-source')));
});

test('symlinks and unknown process/reference coverage preserve copies', async t => {
  const p = await fixture(t);
  const source = join(p.directory, 'modal-source');
  rmSync(source, { recursive: true });
  symlinkSync(p.lane.path, source);
  assert.ok(
    !clean(p)
      .candidates.flatMap(g => g.items)
      .some(i => i.path === source),
  );
  p.scan.unavailable = true;
  assert.equal(clean(p).totals.count, 0);
  p.scan.unavailable = false;
  writeFileSync(join(p.store.directory, 'pending-export.json'), 'incomplete');
  assert.equal(clean(p).totals.count, 0);
});

test('exchange staging expires only after seven days without references; retained exports pin check files', async t => {
  const p = await fixture(t),
    id = randomUUID(),
    path = join(p.store.directory, `exchange-${id}`);
  mkdirSync(path);
  writeFileSync(
    join(path, 'manifest.json'),
    JSON.stringify({ files: [{ path: `check-${p.run.id}/stdout.log` }] }),
  );
  age(path, now - RETENTION_MS - 1000);
  assert.equal(clean(p).totals.count, 5, 'unreferenced staging does not pin old check bytes');
  const kinds = ['check-retention', 'exchange-staging'];
  const planned = clean(p, { kinds });
  assert.equal(planned.totals.count, 6);
  const checkItems = planned.candidates
    .flatMap(g => g.items)
    .filter(i => i.kind === 'check-retention')
    .map(i => i.id);
  assert.equal(
    retentionPlan(p.store, kinds, { paths: [], unknown: false }, now, new Set(checkItems)).items.length,
    5,
    'unreferenced unselected staging does not pin check bytes',
  );
  writeFileSync(join(p.store.directory, 'pending-export.json'), JSON.stringify({ operationId: id }));
  assert.equal(clean(p, { kinds }).totals.count, 4);
  rmSync(join(p.store.directory, 'pending-export.json'));
  const applied = clean(p, { kinds, apply: true });
  assert.equal(applied.totals.count, 6);
  assert.equal(existsSync(path), false);
  assert.equal(clean(p, { kinds, apply: true }).totals.count, 0);
});

test('existing cleanup policy controls automatic seven-day sweeps and replay', async t => {
  const p = await fixture(t);
  assert.equal(automaticCleanup(p.store, 'disabled', 'test'), undefined);
  await p.agent.dispatch({ action: 'set-policy', operationId: randomUUID(), preset: 'autonomous' });
  const result = automaticCleanup(p.store, 'retention-event', 'test', { runId: randomUUID() });
  assert.equal(result.removed.find(g => g.kind === 'check-retention').count, 4);
  assert.equal(result.removed.find(g => g.kind === 'check-workspaces').count, 1);
  assert.equal(existsSync(join(p.directory, 'modal-source')), false);
  assert.deepEqual(automaticCleanup(p.store, 'retention-event', 'test', { runId: randomUUID() }), result);
});

for (const collection of ['channelMoves', 'releases', 'release-without-builds'])
  test(`retained ${collection} ${collection === 'releases' ? 'pins copies' : 'keeps evidence without pinning copies'}`, async t => {
    const p = await fixture(t);
    assert.equal(clean(p).totals.count, 5);
    const acceptance = {
      id: randomUUID(),
      channel: 'main',
      viewId: p.run.viewId,
      head: p.run.head,
      previous: null,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    };
    p.store.locked(() => {
      const tx = p.store.records();
      tx.append(
        collection === 'release-without-builds' ? 'releases' : collection,
        collection === 'channelMoves'
          ? acceptance
          : {
              id: randomUUID(),
              request: 'a'.repeat(64),
              name: 'Synthetic release',
              notes: '',
              acceptance,
              at: new Date().toISOString(),
              provenance: 'user-declared-local',
              buildRuns: collection === 'releases' ? [p.store.select('runs', p.run.id)] : [],
            },
      );
      p.store.commitRecords(tx);
    });
    assert.equal(clean(p).totals.count, collection === 'releases' ? 0 : 5);
    assert.ok(existsSync(join(p.directory, 'modal-source')));
  });

test('pruning an accepted run preserves command reads, acceptance evidence and GitHub audit lookups', async t => {
  const p = await fixture(t);
  // A person may accept a View with failing evidence; retention preserves that
  // historical verdict rather than inventing a passing result after pruning.
  const { WorkService } = await import('../dist/work.js');
  const work = new WorkService(p.root);
  const move = work.execute(
    {
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: p.run.viewId,
      expectedHead: p.run.head,
      expectedPrevious: null,
    },
    p.store.revision(),
  ).result;
  const pin = 'a'.repeat(64);
  replace(p, 'runs', p.run.id, { backend: { requested: 'modal', actual: 'modal', pin } });
  writeFileSync(
    join(p.directory, 'modal-plan.json'),
    JSON.stringify({
      pin,
      head: p.run.head,
      definition: p.run.check.definition,
      groups: [['tests/synthetic.test.mjs']],
    }),
  );
  writeFileSync(
    join(p.directory, 'modal-shard-logs.json'),
    JSON.stringify([
      { executionId: 'synthetic-failed', index: 0, attempt: 0, exitCode: 1 },
      { executionId: 'synthetic-static', index: 1, attempt: 0, exitCode: 0 },
    ]),
  );
  // Match the authoritative terminal receipt after adding synthetic provider pins.
  const current = p.store.select('runs', p.run.id);
  const receiptPath = join(p.directory, 'result.json');
  writeFileSync(
    receiptPath,
    JSON.stringify({ ...JSON.parse(readFileSync(receiptPath)), backend: current.backend }),
  );
  age(p.directory, now - RETENTION_MS - 1000);
  const retained = Object.fromEntries(
    readdirSync(p.directory)
      .filter(n => n.endsWith('.json'))
      .map(n => [n, readFileSync(join(p.directory, n))]),
  );
  assert.equal(clean(p, { apply: true }).totals.count, 5);
  assert.equal(existsSync(join(p.directory, 'modal-source')), false);
  assert.equal(existsSync(join(p.directory, 'shards', 'work-0')), false);
  for (const [name, bytes] of Object.entries(retained))
    assert.deepEqual(readFileSync(join(p.directory, name)), bytes, name);
  const status = (await p.agent.dispatch({ action: 'status' })).result;
  assert.equal(status.runs.items.find(r => r.runId === p.run.id).status, 'failed');
  const observed = (await p.agent.dispatch({ action: 'observe', operationId: p.run.id })).result;
  assert.equal(observed.failureSummary, 'Synthetic failure remains readable');
  assert.equal(observed.status, 'failed');
  const replay = (
    await p.agent.dispatch({
      action: 'run',
      operationId: p.run.id,
      viewId: p.run.viewId,
      expectedHead: p.run.head,
      checkId: p.run.check.id,
    })
  ).result;
  assert.equal(replay.failureSummary, observed.failureSummary);
  const records = (await p.agent.dispatch({ action: 'records', collection: 'runs' })).result.items;
  assert.equal(records.find(r => r.id === p.run.id).failureSummary, observed.failureSummary);
  for (const stream of ['stdout', 'stderr']) {
    const log = (await p.agent.dispatch({ action: 'log', operationId: p.run.id, stream, tail: 4096 })).result;
    assert.equal(log.status, 'provider-held');
    assert.equal(log.providerUrl, 'https://modal.com/apps');
  }
  const shard = (await p.agent.dispatch({ action: 'log', operationId: p.run.id, shard: 0, tail: 4096 }))
    .result;
  assert.equal(shard.status, 'provider-held');
  const view = (await p.agent.dispatch({ action: 'view', viewId: p.run.viewId })).result;
  assert.equal(view.status, 'accepted');
  assert.equal(view.accepted[0].id, move.id);
  assert.equal(view.runs[0].failureSummary, observed.failureSummary);
  const { failureSummary } = await import('../dist/agent-run-failure.js');
  assert.match(failureSummary(p.store, current), /Synthetic failure remains readable/);
  const { failedAuditTests } = await import('../dist/optimistic-evidence.js');
  assert.deepEqual(failedAuditTests(p.store, current), ['tests/synthetic.test.mjs']);
  const { requestPushAudit } = await import('../dist/pre-push-audit.js');
  assert.deepEqual(requestPushAudit(p.store), { channel: 'main', checkId: p.run.check.id });
  const { latestMain, isGreenMain } = await import('../dist/github-auto-push-state.js');
  assert.equal(latestMain(p.store.load()).id, move.id);
  assert.equal(isGreenMain(p.store.load()), false, 'failed evidence remains failed for GitHub sync');
  assert.equal(clean(p, { apply: true }).totals.count, 0);
});

test('completed exchange baseline keeps staging metadata without pinning old owner log prefixes', async t => {
  const p = await fixture(t),
    id = randomUUID(),
    path = join(p.store.directory, `exchange-${id}`);
  mkdirSync(path);
  writeFileSync(
    join(path, 'manifest.json'),
    JSON.stringify({ id, files: [{ path: `check-${p.run.id}/stdout.log` }] }),
  );
  writeFileSync(
    join(p.store.directory, 'exchange-baseline-synthetic.json'),
    JSON.stringify({ payload: JSON.stringify({ manifest: { id } }) }),
  );
  age(path, now - RETENTION_MS - 1000);
  const kinds = ['check-retention', 'exchange-staging'];
  assert.equal(clean(p, { kinds }).totals.count, 5);
  assert.equal(clean(p, { kinds, apply: true }).totals.count, 5);
  assert.ok(existsSync(path), 'old baseline still reads staging metadata');
  assert.equal(existsSync(join(p.directory, 'stdout.log')), false);
});

// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { NativeSource } from '../dist/native-source.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { checkEnvironment } from '../dist/work-run.js';
import { bisectLandings } from '../dist/optimistic-bisect.js';
import { undoOptimisticRevert } from '../dist/optimistic-undo.js';
import { WorkService } from '../dist/work.js';
import { agentPeers } from '../dist/agent-peers.js';
import { failedAuditTests } from '../dist/optimistic-evidence.js';
import { prepareOptimistic } from '../dist/optimistic-landing.js';
import { standardSelection } from '../scripts/test-impact.mjs';

const now = () => new Date().toISOString();
function fixture(t, { bad = [1], enabled = true, supervised = false, flaky = false, count = 4 } = {}) {
  const savedWait = process.env.FORGE_WORK_LOCK_WAIT_MS;
  process.env.FORGE_WORK_LOCK_WAIT_MS = '10000';
  t.after(() => {
    if (savedWait === undefined) delete process.env.FORGE_WORK_LOCK_WAIT_MS;
    else process.env.FORGE_WORK_LOCK_WAIT_MS = savedWait;
  });
  const root = mkdtempSync(join(tmpdir(), 'forge-optimistic-'));
  writeFileSync(join(root, 'base.txt'), 'base\n');
  const { head: base } = initNative(root),
    store = new WorkStore(root),
    source = new NativeSource(root);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const marker = join(store.directory, 'flake-once');
  const check = {
    id: randomUUID(),
    name: 'verify',
    executable: process.execPath,
    args: [
      '-e',
      `const fs=require('fs');setTimeout(()=>{${flaky ? `if(process.env.FORGE_CHECK_FULL==='1'&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'once');process.exit(1)}` : ''}process.exit(fs.readdirSync('.').some(p=>/^bad/.test(p))?1:0)},5)`,
    ],
    definition: 'a'.repeat(64),
    environmentLabel: '',
    at: now(),
  };
  const data = store.load();
  data.schema = 14;
  data.autonomyPolicy = policyPreset(supervised ? 'supervised' : 'trusted');
  if (enabled) data.autonomyPolicy.acceptance.landing = 'optimistic';
  data.checks.push(check);
  const seedIntent = randomUUID(),
    seedView = randomUUID();
  data.intents.push({
    id: seedIntent,
    outcome: 'Seed',
    constraints: '',
    base,
    status: 'active',
    notes: [],
    createdAt: now(),
  });
  data.views.push({
    id: seedView,
    intentId: seedIntent,
    base,
    composedMain: base,
    head: base,
    inputs: [],
    dependencies: [],
    status: 'clean',
    details: '',
    at: now(),
  });
  data.channelMoves.push({
    id: randomUUID(),
    channel: 'main',
    viewId: seedView,
    head: base,
    previous: null,
    status: 'accepted',
    provenance: 'user-declared-local',
    at: now(),
  });
  let previous = base;
  const lanes = [],
    moves = [];
  for (let i = 0; i < count; i++) {
    const intentId = randomUUID(),
      laneId = randomUUID(),
      viewId = randomUUID();
    const files = [
      ...source.state(previous).files,
      {
        path: `${bad.includes(i) ? 'bad' : 'good'}${i}.txt`,
        blob: source.put(Buffer.from(`${i}\n`)),
        mode: 'file',
      },
    ];
    const head = source.writeState(files, [previous], 'Synthetic landing', now());
    data.intents.push({
      id: intentId,
      outcome: `Synthetic ${i}`,
      constraints: '',
      base: previous,
      status: 'completed',
      notes: [],
      createdAt: now(),
    });
    data.lanes.push({
      id: laneId,
      intentId,
      name: `lane ${i}`,
      base: previous,
      head,
      state: 'completed',
      assignment: '',
      target: '',
      checkpoints: [],
    });
    data.views.push({
      id: viewId,
      intentId,
      base: previous,
      composedMain: previous,
      head,
      optimistic: true,
      inputs: [{ laneId, head }],
      dependencies: [],
      status: 'clean',
      details: '',
      at: now(),
    });
    const move = {
      id: randomUUID(),
      channel: 'main',
      viewId,
      head,
      previous,
      status: 'accepted',
      provenance: 'user-declared-local',
      at: now(),
      postAccept: { checkId: check.id, mode: 'full', reason: 'scoped-check' },
    };
    data.channelMoves.push(move);
    moves.push(move);
    lanes.push(laneId);
    previous = head;
  }
  store.locked(() => store.save(data));
  return {
    root,
    store,
    source,
    check,
    moves,
    lanes,
    paths: () => source.state(store.load().channelMoves.at(-1).head).files.map(file => file.path),
  };
}

for (const bad of [[1], [0, 3]])
  test(`recovery compensates only culprits ${bad}; preserves history, reopens and notifies`, async t => {
    const f = fixture(t, { bad });
    await drainPostAccept(f.store);
    const data = f.store.load(),
      recovery = data.channelMoves.find(move => move.optimisticRecovery)?.optimisticRecovery;
    assert.equal(recovery.status, 'reverted');
    assert.deepEqual(new Set(recovery.culpritIds), new Set(bad.map(i => f.moves[i].id)));
    assert.equal(f.paths().filter(path => path.startsWith('bad')).length, 0);
    assert.equal(f.paths().filter(path => path.startsWith('good')).length, 4 - bad.length);
    assert.deepEqual(
      data.channelMoves.slice(1, 5).map(move => move.id),
      f.moves.map(move => move.id),
    );
    for (const i of bad) {
      assert.equal(f.store.select('lanes', f.lanes[i]).state, 'active');
      const peers = agentPeers(f.store, { laneId: f.lanes[i] });
      assert.match(peers.notices[0].text, /Automatic compensating revert/);
    }
    assert.ok(f.source.contains(data.channelMoves.at(-1).head, f.moves.at(-1).head));
    assert.match(data.channelMoves.at(-1).automatic.undo, /undo-revert/);
    assert.equal(data.runs.filter(run => run.recovery?.phase === 'retry').length, 1);
    assert.equal(
      data.runs.filter(run => run.mainCheck && !run.recovery && run.status === 'passed').length,
      1,
    );
    const count = data.channelMoves.length;
    await drainPostAccept(f.store);
    assert.equal(f.store.load().channelMoves.length, count);
  });

test('flaky full audit retries once and does not revert or open fix-forward', async t => {
  const f = fixture(t, { bad: [], flaky: true });
  await drainPostAccept(f.store);
  const data = f.store.load();
  assert.equal(data.channelMoves.length, 5);
  assert.equal(data.channelMoves.at(-1).optimisticRecovery.status, 'flaky');
  assert.equal(data.runs.length, 2);
  assert.equal(
    data.intents.some(intent => intent.mainCheckFailure),
    false,
  );
});

for (const options of [{ enabled: false }, { supervised: true }])
  test(`policy off retains fix-forward behavior ${JSON.stringify(options)}`, async t => {
    const f = fixture(t, options);
    await drainPostAccept(f.store);
    const data = f.store.load();
    assert.equal(data.channelMoves.length, 5);
    assert.equal(data.runs.length, 1);
    assert.equal(data.intents.filter(intent => intent.mainCheckFailure).length, 1);
    assert.ok(f.paths().includes('bad1.txt'));
  });

test('one-command undo is checked, preserves later work, and reconciles a lost reply', async t => {
  const f = fixture(t);
  await drainPostAccept(f.store);
  const reverted = f.store.load().channelMoves.at(-1);
  // Simulate a repair to the verification contract: restoring the original source is now permitted.
  f.store.locked(() => {
    const data = f.store.load();
    data.checks[0].args = ['-e', 'process.exit(0)'];
    data.revision++;
    f.store.save(data);
  });
  laterChange(f, 'later.txt', 'preserved');
  const command = { operationId: randomUUID(), acceptanceId: reverted.id };
  const work = new WorkService(f.root, { kind: 'agent', id: 'synthetic-undo' });
  const first = await undoOptimisticRevert(work, command);
  const second = await undoOptimisticRevert(work, command);
  assert.equal(first.result.id, second.result.id);
  await assert.rejects(undoOptimisticRevert(work, { ...command, acceptanceId: randomUUID() }), {
    code: 'WORK_OPERATION_CHANGED',
  });
  assert.ok(f.paths().includes('bad1.txt'));
  assert.ok(f.paths().includes('later.txt'));
  assert.equal(f.paths().filter(path => path.startsWith('good')).length, 3);
  await drainPostAccept(f.store);
});

test('bisect memoizes through caller and preserves interacting sets; inconclusive is never guilt', async () => {
  const seen = new Map();
  const outcome = await bisectLandings([0, 1, 2, 3], async items => {
    const key = items.join();
    seen.set(key, (seen.get(key) ?? 0) + 1);
    return items.includes(0) && items.includes(1) ? 'failed' : 'passed';
  });
  assert.deepEqual(outcome, [0, 1]);
  assert.ok([...seen.values()].every(count => count === 1));
  await assert.rejects(
    bisectLandings([0, 1], async () => 'interrupted'),
    { code: 'CANCELLED' },
  );
});

test('opt-in scoped selection keeps the standard static verification and protected paths require review', t => {
  const f = fixture(t, { bad: [] }),
    data = f.store.load(),
    view = data.views.at(-1);
  const work = new WorkService(f.root, { kind: 'agent', id: 'synthetic' });
  assert.equal(prepareOptimistic(work, { accept: { channel: 'main' } }, view), true);
  f.store.locked(() => {
    const d = f.store.load();
    d.autonomyPolicy.acceptance.protectedPaths = ['good3.txt'];
    d.revision++;
    f.store.save(d);
  });
  assert.equal(prepareOptimistic(work, { accept: { channel: 'main' } }, view), false);
  const selection = standardSelection({
    paths: ['src/errors.ts'],
    files: new Map([
      ['src/errors.ts', 'export const error = 1;'],
      ['tests/errors.test.mjs', "import '../dist/errors.js';"],
    ]),
    optimistic: true,
    env: {},
  });
  assert.equal(selection.scope, 'scoped');
});

function laterChange(f, path, text) {
  f.store.locked(() => {
    const data = f.store.load(),
      previous = data.channelMoves.at(-1);
    const files = f.source.state(previous.head).files.filter(file => file.path !== path);
    files.push({ path, mode: 'file', blob: f.source.put(Buffer.from(text)) });
    const head = f.source.writeState(files, [previous.head], 'Later accepted work', now());
    const view = {
      ...data.views.find(view => view.id === previous.viewId),
      id: randomUUID(),
      head,
      base: previous.head,
      composedMain: previous.head,
      inputs: [],
      recovery: undefined,
      optimistic: undefined,
    };
    data.views.push(view);
    data.channelMoves.push({
      id: randomUUID(),
      channel: 'main',
      head,
      previous: previous.head,
      viewId: view.id,
      status: 'accepted',
      provenance: 'user-declared-local',
      at: now(),
    });
    data.revision++;
    f.store.save(data);
  });
}

test('conflicting later source gets a fix-forward handoff and is never overwritten', async t => {
  const f = fixture(t);
  laterChange(f, 'bad1.txt', 'later edited bytes');
  const before = f.store.load().channelMoves.at(-1).head;
  await drainPostAccept(f.store);
  const data = f.store.load();
  assert.equal(data.channelMoves.at(-1).head, before);
  assert.equal(data.channelMoves.at(-1).optimisticRecovery.status, 'fix-forward');
  assert.equal(data.intents.filter(intent => intent.mainCheckFailure).length, 1);
});

test('retained failed shards are selected only with exact audit pins', t => {
  const f = fixture(t),
    id = randomUUID();
  const directory = join(f.store.directory, `check-${id}`);
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'modal-plan.json'),
    JSON.stringify({
      pin: 'pin',
      head: 'head',
      definition: f.check.definition,
      groups: [['tests/a.test.mjs'], ['tests/b.test.mjs']],
    }),
  );
  writeFileSync(
    join(directory, 'modal-shard-logs.json'),
    JSON.stringify([
      { index: 0, attempt: 0, exitCode: 0 },
      { index: 1, attempt: 0, exitCode: 1 },
      { index: 2, attempt: 0, exitCode: 0 },
    ]),
  );
  const audit = { id, head: 'head', backend: { pin: 'pin' }, check: f.check };
  assert.deepEqual(failedAuditTests(f.store, audit), ['tests/b.test.mjs']);
  assert.equal(failedAuditTests(f.store, { ...audit, head: 'different' }), undefined);
});

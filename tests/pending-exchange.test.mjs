// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { pushNativeExchange, prepareNativeExchange } from '../dist/native-exchange.js';
import {
  acknowledgePendingExchange,
  exchangeBookkeeping,
  readPendingExchange,
} from '../dist/pending-exchange.js';
import { updateHostState } from '../dist/host-binding.js';
import {
  autoExchangeSchema,
  editedPolicy,
  effectivePolicy,
  policyPreset,
  policyWriteSchema,
} from '../dist/autonomy-policy.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-pending-exchange-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'source.txt'), 'initial\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = new WorkStore(root),
    objects = new Map();
  const transport = {
    missing: async pins => pins.filter(pin => !objects.has(pin.sha256)).map(pin => pin.sha256),
    upload: async (pin, bytes) => {
      objects.set(pin.sha256, Buffer.from(bytes));
    },
    publish: async pin => pin.sha256,
  };
  const pending = () => readPendingExchange(store.directory);
  const push = (options = {}) =>
    pushNativeExchange(store, store.revision(), randomUUID(), transport, options);
  return { root, agent, store, objects, transport, pending, push };
}

test('bursts of unlanded saves and Work changes coalesce with their earliest pending time', async t => {
  const f = fixture(t);
  await f.push();
  const lane = (await f.agent.dispatch({ action: 'start', outcome: 'Unlanded changes' })).result;
  const first = f.pending().pending[0].firstPendingAt;
  for (let n = 1; n <= 3; n++) {
    writeFileSync(join(lane.path, 'source.txt'), `save ${n}\n`);
    await f.agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: `Save ${n}` });
  }
  const work = new WorkService(f.root);
  work.execute(
    { action: 'note', intentId: lane.intentId, kind: 'comment', text: 'Saved metadata' },
    f.store.revision(),
  );
  const state = f.pending();
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].firstPendingAt, first);
  assert.equal(state.pending[0].lastRevision, f.store.revision());
  assert.ok(state.pending[0].throughSequence > state.pending[0].fromSequence);
  assert.equal(f.store.load().channelMoves.length, 0);
  await f.push();
  assert.deepEqual(f.pending().pending, []);
});

test('a write during upload retains its own earliest age after the older snapshot succeeds or replays', async t => {
  const f = fixture(t),
    operationId = randomUUID(),
    revision = f.store.revision();
  const upload = f.transport.upload;
  let during;
  f.transport.upload = async (...args) => {
    await upload(...args);
    if (!during) {
      new WorkService(f.root).execute({ action: 'intent', outcome: 'During transfer' }, f.store.revision());
      during = f.pending().pending.at(-1);
    }
  };
  const first = await pushNativeExchange(f.store, revision, operationId, f.transport);
  assert.deepEqual(f.pending().pending, [during]);
  assert.ok(during.fromSequence > first.pendingCoverage.capture.throughSequence);
  const retry = await pushNativeExchange(f.store, revision, operationId, f.transport);
  assert.deepEqual(retry.pendingCoverage, first.pendingCoverage);
  assert.deepEqual(f.pending().pending, [during]);
  await f.push();
  assert.deepEqual(f.pending().pending, []);
});

test('unknown publication outcomes retain pending work until original-operation reconciliation succeeds', async t => {
  const f = fixture(t),
    id = randomUUID(),
    revision = f.store.revision(),
    before = f.pending();
  const publish = f.transport.publish;
  let published;
  f.transport.publish = async pin => {
    published = await publish(pin);
    throw new Error('lost reply');
  };
  await assert.rejects(pushNativeExchange(f.store, revision, id, f.transport), /lost reply/);
  assert.deepEqual(f.pending().pending, before.pending);
  f.transport.published = async pin => (pin.sha256 === published ? published : null);
  await pushNativeExchange(new WorkStore(f.root), revision, id, f.transport);
  assert.deepEqual(f.pending().pending, []);
});

test('check completion and landing create pending work after the previous capture', async t => {
  const f = fixture(t);
  const local = f.store.load();
  local.autonomyPolicy = { ...effectivePolicy(local), checkLogs: { uploadLocal: true, retentionDays: 90 } };
  f.store.save(local);
  const lane = (await f.agent.dispatch({ action: 'start', outcome: 'Check and land' })).result;
  const check = (
    await f.agent.dispatch({
      action: 'define-check',
      name: 'local fake',
      executable: process.execPath,
      args: ['-e', 'console.log("complete")'],
    })
  ).result;
  const view = (
    await f.agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
    })
  ).result;
  await f.push();
  const work = new WorkService(f.root);
  const run = await f.agent.dispatch({
    action: 'run',
    operationId: randomUUID(),
    viewId: view.viewId,
    expectedHead: view.head,
    checkId: check.id,
    expectedDefinition: check.definition,
    wait: true,
  });
  assert.equal(run.result.status, 'passed');
  assert.ok(f.pending().pending.length);
  assert.equal(f.pending().pending.at(-1).lastRevision, f.store.revision());
  const logPath = join(f.store.directory, `check-${run.result.runId}/stdout.log`);
  const log = readFileSync(logPath),
    before = f.pending().pending;
  unlinkSync(logPath);
  const incomplete = await f.push();
  assert.ok(incomplete.pendingCoverage.unavailable.includes(`check-${run.result.runId}/stdout.log`));
  assert.deepEqual(f.pending().pending, before);
  writeFileSync(logPath, log, { mode: 0o600 });
  await f.push();
  assert.deepEqual(f.pending().pending, []);
  await work.dispatch(
    {
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: view.viewId,
      expectedHead: view.head,
      expectedPrevious: null,
    },
    f.store.revision(),
  );
  assert.ok(f.pending().pending.length);
  assert.equal(f.store.load().channelMoves.at(-1).status, 'accepted');
});

test('partial history, missing evidence and unfinished source return do not acknowledge coverage', async t => {
  const f = fixture(t);
  const initial = f.pending().pending;
  await f.push({ stage: 'current' });
  assert.deepEqual(f.pending().pending, initial);
  const oldId = randomUUID(),
    oldRevision = f.store.revision();
  const old = await prepareNativeExchange(f.store, oldRevision, oldId);
  unlinkSync(join(old.directory, 'pending-work.json'));
  const legacy = await pushNativeExchange(f.store, oldRevision, oldId, f.transport);
  assert.equal(legacy.pendingCoverage, undefined);
  assert.deepEqual(f.pending().pending, initial);
  const deferred = await f.push({ deferPendingAcknowledgement: true });
  assert.deepEqual(f.pending().pending, initial);
  acknowledgePendingExchange(f.store, {
    ...deferred.pendingCoverage,
    unavailable: ['check-fixture/stdout.log'],
  });
  assert.deepEqual(f.pending().pending, initial);
  acknowledgePendingExchange(f.store, {
    ...deferred.pendingCoverage,
    capture: { ...deferred.pendingCoverage.capture, ownerId: randomUUID() },
  });
  assert.deepEqual(f.pending().pending, initial);
  acknowledgePendingExchange(f.store, deferred.pendingCoverage);
  assert.deepEqual(f.pending().pending, []);
});

test('capture preparation, transport bookkeeping and reconciliation receipts never enqueue themselves', async t => {
  const f = fixture(t);
  await f.push();
  const before = f.pending().sequence,
    revision = f.store.revision();
  updateHostState(f.store, state => {
    state.pulls = { synthetic: randomUUID() };
  });
  await prepareNativeExchange(f.store, revision, randomUUID());
  f.store.locked(() =>
    exchangeBookkeeping(() => {
      const data = f.store.load();
      data.revision++;
      f.store.save(data);
    }),
  );
  assert.deepEqual(f.pending().pending, []);
  assert.equal(f.pending().sequence, before);
  await f.push();
  assert.deepEqual(f.pending().pending, []);
  assert.equal(f.store.revision(), revision + 1);
  assert.equal(f.pending().sequence, before);
});

test('saved pending work survives immediate process exit and a fresh owner instance', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-pending-restart-')),
    root = join(dir, 'owner');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(root);
  const script = `import { initNative } from ${JSON.stringify(new URL('../dist/native-work.js', import.meta.url).href)};
    import { WorkService } from ${JSON.stringify(new URL('../dist/work.js', import.meta.url).href)};
    initNative(process.argv[1]); const work = new WorkService(process.argv[1]);
    work.execute({action:'intent',outcome:'Durable after exit'},work.store.revision()); process.exit(0);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script, root], {
    env: { PATH: process.env.PATH },
  });
  const store = new WorkStore(root),
    state = readPendingExchange(store.directory);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].lastRevision, store.revision());
  assert.equal(store.load().intents[0].outcome, 'Durable after exit');
  assert.deepEqual(readPendingExchange(new WorkStore(root).directory), state);
  assert.equal(
    JSON.parse(readFileSync(join(store.directory, 'pending-exchange.json'))).ownerId,
    state.ownerId,
  );
});

test('autoExchange defaults off and partial edits preserve cadence independently of other sync settings', () => {
  const defaults = { enabled: false, debounceMs: 30_000, maxPendingAgeMs: 300_000 };
  assert.deepEqual(autoExchangeSchema.parse({}), defaults);
  for (const preset of ['supervised', 'trusted', 'autonomous'])
    assert.deepEqual(policyPreset(preset).autoExchange, defaults);
  const legacy = policyPreset('trusted');
  delete legacy.autoExchange;
  assert.deepEqual(effectivePolicy({ autonomyPolicy: legacy }).autoExchange, defaults);
  const edit = (previous, autoExchange) =>
    editedPolicy(
      previous,
      policyWriteSchema.parse({
        action: 'set-policy',
        operationId: randomUUID(),
        autoExchange,
      }),
    );
  const enabled = edit(legacy, { enabled: true, debounceMs: 40_000 });
  const updated = edit(enabled, { maxPendingAgeMs: 240_000 });
  assert.deepEqual(updated.autoExchange, { enabled: true, debounceMs: 40_000, maxPendingAgeMs: 240_000 });
  assert.equal(updated.preset, 'custom');
  assert.equal(updated.githubMirror, undefined);
  assert.deepEqual(edit(updated, { enabled: false }).autoExchange, {
    enabled: false,
    debounceMs: 40_000,
    maxPendingAgeMs: 240_000,
  });
});

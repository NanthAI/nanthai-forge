// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  appendFileSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { readRecoveryInventory } from '../dist/recovery-inventory.js';
import { prepareNativeExchange, pushNativeExchange } from '../dist/native-exchange.js';
import { exportNativeWork } from '../dist/native-backup.js';
import { hostProject } from '../dist/host-cli.js';
import { digest } from '../dist/hash.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-recovery-inventory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  initNative(root);
  const work = new WorkService(root);
  const act = command => work.execute(command, work.store.revision()).result;
  const intent = act({ action: 'intent', outcome: 'Synthetic recovery inventory' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'Unlanded' });
  const objects = new Map();
  const transport = {
    missing: async pins => pins.filter(pin => !objects.has(pin.sha256)).map(pin => pin.sha256),
    upload: async (pin, bytes) => {
      assert.equal(pin.sha256, digest(bytes));
      objects.set(pin.sha256, bytes);
    },
    publish: async pin => pin.sha256,
  };
  const push = (operationId = randomUUID(), options = {}) =>
    pushNativeExchange(work.store, work.store.revision(), operationId, transport, options);
  return { root, directory, work, act, intent, lane, transport, push };
}
function save(f) {
  writeFileSync(join(f.work.store.path(f.lane.id), 'source.ts'), 'export const value = 2;\n');
  const observed = f.work.status().lanes[0];
  return f.act({
    action: 'checkpoint',
    laneId: f.lane.id,
    expectedHead: observed.head,
    expectedTree: observed.indexTree,
    message: 'Unlanded save',
  });
}
function runRecord(f, finished = false) {
  const view = f.act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: f.intent.id,
    inputs: [{ laneId: f.lane.id, head: f.lane.head }],
  });
  const check = f.act({ action: 'define-check', name: 'Synthetic', executable: process.execPath, args: [] });
  const data = f.work.store.load();
  const run = {
    id: randomUUID(),
    viewId: view.id,
    head: view.head,
    base: view.base,
    inputs: view.inputs,
    dependencies: [],
    check,
    environment: f.work.status().environment,
    status: finished ? 'failed' : 'running',
    startedAt: '2026-10-21T10:00:00.000Z',
    ...(finished ? { endedAt: '2026-10-21T10:01:00.000Z', exitCode: 1 } : {}),
    runner: { pid: process.pid, host: 'synthetic' },
    details: 'Synthetic evidence',
  };
  data.runs.push(run);
  data.revision++;
  f.work.store.save(data);
  const directory = join(f.work.store.directory, `check-${run.id}`);
  mkdirSync(directory);
  writeFileSync(join(directory, 'stdout.log'), 'first bytes\n', { mode: 0o600 });
  writeFileSync(join(directory, 'stderr.log'), '', { mode: 0o600 });
  if (finished) writeFileSync(join(directory, 'result.json'), '{}', { mode: 0o600 });
  return { run, directory };
}

test('complete exchange covers saved unlanded heads and later checkpoints and metadata remain pending', async t => {
  const f = fixture(t);
  const initial = await f.push();
  assert.equal(initial.recovery.status, 'recorded');
  const checkpoint = save(f);
  let inventory = await readRecoveryInventory(f.root, Date.now() + 60_000);
  assert.equal(inventory.latestCompleteOffMachine.workRevision, initial.revision);
  assert.ok(inventory.pending.saves.some(item => item.kind === 'checkpoint' && item.sha256));
  assert.ok(inventory.pending.oldestKnownPendingAgeMs >= 60_000);
  const captured = await f.push();
  inventory = await readRecoveryInventory(f.root);
  assert.equal(inventory.pending.saves.length, 0);
  assert.equal(inventory.pending.oldestPendingAgeMs, 0);
  assert.equal(f.work.store.load().lanes[0].head, checkpoint.head);
  assert.equal(f.work.store.load().channelMoves.length, 0);
  const head = captured.recovery.capture.sourceHead;
  f.act({ action: 'note', intentId: f.intent.id, kind: 'comment', text: 'Synthetic newer metadata only' });
  inventory = await readRecoveryInventory(f.root);
  assert.equal(inventory.latestCompleteOffMachine.sourceHead, head);
  assert.ok(inventory.pending.workRevision > inventory.latestCompleteOffMachine.workRevision);
  assert.ok(inventory.pending.saves.some(item => item.id === `intents:${f.intent.id}`));
  const priorRevision = f.work.store.revision();
  await readRecoveryInventory(f.root);
  assert.equal(f.work.store.revision(), priorRevision, 'inventory does not save or recover Work');
});

test('local export persists capture time and exact pins but does not establish off-machine protection', async t => {
  const f = fixture(t);
  save(f);
  const exported = await exportNativeWork(f.work.store, f.work.store.revision(), true);
  assert.equal(exported.result.recovery.status, 'recorded');
  const capture = exported.result.recovery.capture;
  const manifest = JSON.parse(exported.result.json);
  assert.equal(capture.work.sha256, manifest.files.find(item => item.path === 'work.json').sha256);
  assert.equal(capture.sourceHead, manifest.head);
  assert.ok(capture.capturedAt <= capture.completedAt);
  const inventory = await readRecoveryInventory(f.root);
  assert.equal(inventory.latestExport.id, capture.id);
  assert.equal(inventory.latestCompleteOffMachine, null);
  assert.ok(inventory.pending.saves.some(item => item.kind === 'checkpoint'));
  assert.equal(inventory.pending.oldestPendingAgeMs, null);
});

test('missing logs and retained artifacts are per-item unavailable without denying a successful capture', async t => {
  const f = fixture(t);
  const { run, directory } = runRecord(f, true);
  rmSync(join(directory, 'stderr.log'));
  const data = f.work.store.load();
  data.runs[0].artifacts = [
    {
      sourcePath: 'build/output.bin',
      filename: 'artifact-0.bin',
      status: 'retained',
      size: 7,
      sha256: digest('missing'),
    },
  ];
  data.revision++;
  f.work.store.save(data);
  const result = await f.push();
  assert.equal(result.recovery.status, 'recorded');
  assert.equal(result.recovery.capture.completeHistory, 'complete');
  const inventory = await readRecoveryInventory(f.root);
  for (const path of [`check-${run.id}/stderr.log`, `check-${run.id}/artifacts/artifact-0.bin`]) {
    assert.equal(
      inventory.latestCompleteOffMachine.evidence.find(item => item.path === path).status,
      'unavailable',
    );
    assert.equal(inventory.pending.evidence.find(item => item.path === path).status, 'unavailable');
  }
  assert.equal(inventory.pending.oldestPendingAgeMs, null);
});

test('running-log tail and a later completion are uncovered even when main is unchanged', async t => {
  const f = fixture(t);
  const { run, directory } = runRecord(f);
  await f.push();
  const revision = f.work.store.revision();
  appendFileSync(join(directory, 'stdout.log'), 'later bytes\n');
  let inventory = await readRecoveryInventory(f.root);
  assert.equal(f.work.store.revision(), revision);
  assert.equal(
    inventory.pending.evidence.find(item => item.path === `check-${run.id}/stdout.log`).status,
    'pending',
  );
  const data = f.work.store.load();
  data.runs[0].status = 'failed';
  data.runs[0].endedAt = new Date().toISOString();
  data.revision++;
  f.work.store.save(data);
  writeFileSync(join(directory, 'result.json'), '{}', { mode: 0o600 });
  inventory = await readRecoveryInventory(f.root);
  assert.ok(inventory.pending.saves.some(item => item.kind === 'check-completion' && item.id === run.id));
  await f.push();
  inventory = await readRecoveryInventory(f.root);
  assert.equal(inventory.pending.saves.length, 0);
  assert.ok(inventory.pending.evidence.every(item => item.status === 'covered'));
});

test('first hosting remains incomplete until completeHistory succeeds, including resumable failure', async t => {
  const f = fixture(t);
  let fail = true;
  const dependencies = {
    exchange: () => f.transport,
    client: {
      mutation: async () => ({
        projectId: 'synthetic-project',
        projectUrl: 'https://example.invalid/project',
      }),
      action: async ref => {
        // Function references use the Convex helper, rather than depending on object layout.
        const { getFunctionName } = await import('convex/server');
        if (getFunctionName(ref).endsWith(':completeHistory') && fail)
          throw Error('synthetic history not validated');
      },
    },
  };
  const options = { deployment: 'https://example.convex.cloud', deferBackfill: true };
  const first = await hostProject(f.root, options, dependencies);
  assert.equal(first.historyBackfilling, true);
  let inventory = await readRecoveryInventory(f.root);
  assert.equal(inventory.latestCompleteOffMachine, null);
  assert.ok(inventory.captures.some(item => item.completeHistory === 'incomplete'));
  await assert.rejects(
    hostProject(f.root, { ...options, deferBackfill: false }, dependencies),
    /synthetic history/,
  );
  assert.equal((await readRecoveryInventory(f.root)).latestCompleteOffMachine, null);
  fail = false;
  await hostProject(f.root, { ...options, deferBackfill: false }, dependencies);
  inventory = await readRecoveryInventory(f.root);
  assert.equal(inventory.latestCompleteOffMachine.completeHistory, 'complete');
});

test('unknown old capture time stays unknown, retry keeps pins and does not invent a new capture time', async t => {
  const f = fixture(t),
    operationId = randomUUID();
  const prepared = await prepareNativeExchange(f.work.store, f.work.store.revision(), operationId);
  rmSync(join(prepared.directory, 'recovery-timing.json'));
  const pushed = await f.push(operationId);
  assert.equal(pushed.recovery.capture.capturedAt, null);
  const again = await f.push(operationId);
  assert.deepEqual(again.recovery.capture, pushed.recovery.capture);
  const inventory = await readRecoveryInventory(f.root);
  assert.equal(inventory.latestCompleteOffMachine.capturedAt, null);
  assert.equal(inventory.pending.oldestPendingAgeMs, null);
});

test('failed or unknown publication creates no successful receipt; same-id replay reconciles it', async t => {
  const f = fixture(t),
    operationId = randomUUID(),
    publish = f.transport.publish;
  f.transport.publish = async () => {
    throw Error('synthetic lost reply');
  };
  await assert.rejects(f.push(operationId), /synthetic lost reply/);
  assert.equal((await readRecoveryInventory(f.root)).captures.length, 0);
  f.transport.publish = publish;
  await f.push(operationId);
  assert.equal((await readRecoveryInventory(f.root)).captures.length, 1);
});

test('corrupt or unwritable inventory is unknown and never changes successful exchange behavior', async t => {
  const f = fixture(t);
  await f.push();
  const directory = join(f.work.store.directory, 'recovery-inventory');
  const receipt = join(directory, readdirSync(directory)[0], 'receipt.json');
  writeFileSync(receipt, 'invalid synthetic receipt');
  let inventory = await readRecoveryInventory(f.root);
  assert.equal(inventory.availability, 'unknown');
  assert.equal(inventory.latestCompleteOffMachine, null);
  rmSync(directory, { recursive: true });
  writeFileSync(directory, 'synthetic obstruction');
  const result = await f.push();
  assert.equal(result.recovery.status, 'unavailable');
  inventory = await readRecoveryInventory(f.root);
  assert.equal(inventory.availability, 'unknown');
  assert.equal(inventory.latestCompleteOffMachine, null);
});

test('inventory never follows evidence-directory symlinks and reports unknown current bytes', async t => {
  const f = fixture(t);
  const { run, directory } = runRecord(f);
  await f.push();
  const outside = join(f.directory, 'synthetic-outside-evidence');
  mkdirSync(outside);
  writeFileSync(join(outside, 'stdout.log'), 'unrelated synthetic private data', { mode: 0o600 });
  writeFileSync(join(outside, 'stderr.log'), '', { mode: 0o600 });
  rmSync(directory, { recursive: true });
  symlinkSync(outside, directory);
  const inventory = await readRecoveryInventory(f.root);
  const log = inventory.pending.evidence.find(item => item.path === `check-${run.id}/stdout.log`);
  assert.equal(log.current, null);
  assert.equal(log.status, 'unknown');
  assert.ok(log.captured, 'the original captured fingerprint remains available');
});

test('pending save times compare instants across offsets and malformed dates stay unknown', async () => {
  const { pendingRecoverySaves, recoverySaves } = await import('../dist/recovery-saves.js');
  const save = { kind: 'work-mutation', id: 'synthetic', sha256: 'old', at: '2026-10-21T10:00:00.000Z' };
  const equivalent = { ...save, sha256: 'new', at: '2026-10-21T11:00:00+01:00' };
  assert.equal(pendingRecoverySaves([equivalent], [save])[0].at, null);
  const records = recoverySaves({
    revision: 1,
    lanes: [{ id: 'synthetic', checkpoints: [{ at: 'unknown-time' }] }],
    runs: [],
  });
  assert.equal(records.find(item => item.kind === 'checkpoint').at, null);
});

test('corrupt retained artifact bytes stay unavailable; a protected declared artifact survives local damage', async t => {
  const f = fixture(t);
  const { run, directory } = runRecord(f, true);
  mkdirSync(join(directory, 'artifacts'));
  const path = join(directory, 'artifacts/artifact-0.bin');
  writeFileSync(path, 'damaged', { mode: 0o600 });
  const data = f.work.store.load();
  data.runs[0].artifacts = [
    {
      sourcePath: 'build/output.bin',
      filename: 'artifact-0.bin',
      status: 'retained',
      size: 8,
      sha256: digest('original'),
    },
  ];
  data.revision++;
  f.work.store.save(data);
  await f.push();
  let inventory = await readRecoveryInventory(f.root);
  const evidencePath = `check-${run.id}/artifacts/artifact-0.bin`;
  assert.equal(inventory.pending.evidence.find(item => item.path === evidencePath).status, 'unavailable');
  writeFileSync(path, 'original');
  await f.push();
  writeFileSync(path, 'damaged');
  inventory = await readRecoveryInventory(f.root);
  assert.equal(inventory.pending.evidence.find(item => item.path === evidencePath).status, 'covered');
});

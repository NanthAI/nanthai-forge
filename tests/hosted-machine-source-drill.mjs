// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { finishFixture, landingApi } from './hosted-finish-fixture.mjs';
const startApi = await import(moduleUrl('../convex/projectHostedStart.ts'));
const lanesApi = await import(moduleUrl('../convex/projectHostedLanes.ts'));
const lifecycleApi = await import(moduleUrl('../convex/projectHostedLifecycle.ts'));

export async function hostedMachineSourceDrill(t) {
  const f = await saveFixture();
  const root = mkdtempSync(join(tmpdir(), 'forge-q4-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const main = {
    schema: 2,
    projectId: f.projectId,
    snapshotId: 'synthetic',
    sourceRevision: 0,
    channel: 'main',
    head: f.baseline.sha256,
    authority: { mode: 'server', epoch: 1 },
    receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  f.insert('projectHostedChannels', {
    projectId: f.projectId,
    name: 'main',
    operationId: randomUUID(),
    selection: JSON.stringify(main),
  });
  f.insert('projectHostedStates', {
    projectId: f.projectId,
    head: main.head,
    size: f.baseline.size,
    input: 'a'.repeat(64),
    output: 'b'.repeat(64),
    jobId: randomUUID(),
  });
  const request = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    expectedMain: { head: main.head, receiptId: main.receipt.id },
    intent: { kind: 'new', outcome: 'Q4 saved source', constraints: '' },
  };
  const started = JSON.parse(
    await f.transaction('machineStart', startApi.start, { projectId: f.projectId, ...request }),
  );
  const laneId = started.lane.laneId;
  const select = async () =>
    JSON.parse(await f.transaction('machineSelect', lanesApi.select, { projectId: f.projectId, laneId }));
  const transport = {
    select,
    objects: async ids => ids.map(sha256 => ({ sha256, size: f.objects.get(sha256).length })),
    downloadToFile: async (pin, path) => writeFileSync(path, f.objects.get(pin.sha256)),
  };
  const open = destination =>
    checkoutHostedLane(
      destination,
      { operationId: randomUUID(), url: 'https://fixture.invalid', projectId: f.projectId, laneId },
      transport,
    );
  const first = join(root, 'first-mac');
  await open(first);
  writeFileSync(join(first, 'a.txt'), 'saved before losing the first Mac\n');
  const captureRoot = join(root, 'capture');
  const capture = await captureHostedSave(first, captureRoot);
  const save = await f.prepare(capture.changes, { laneId });
  for (const file of capture.files) f.put(readFileSync(join(captureRoot, file.path)));
  await f.stage(save);
  await f.submit(save);
  const built = await f.work(save);
  const saved = await f.publish(built);
  assert.deepEqual(await f.publish(built), saved, 'lost save reply reconciles its original operation');
  renameSync(first, join(root, 'offline-mac'));
  const second = join(root, 'replacement-mac');
  await open(second);
  assert.equal(readFileSync(join(second, 'a.txt'), 'utf8'), 'saved before losing the first Mac\n');
  assert.equal((await select()).head, built.head);
  assert.equal((await select()).sourceVersion, 1);
  return { synthetic: true, started: true, saves: 1, resumedFromFreshRoot: true, savedHead: built.head };
}

export async function hostedMachineCancelDrill(t) {
  const f = await finishFixture(t);
  const request = f.request();
  const submission = await f.enqueue(request);
  await f.drain();
  const cancelRequest = { operationId: randomUUID(), authorityEpoch: 1, submissionId: submission.id };
  const cancel = () =>
    f
      .tx('machineCancel', landingApi.cancel, {
        projectId: f.projectId,
        request: JSON.stringify(cancelRequest),
      })
      .then(JSON.parse);
  const cancelled = await cancel();
  assert.equal(cancelled.phase, 'terminal-failed');
  assert.deepEqual(await cancel(), cancelled);
  const lane = await f.readLane(f.lane.laneId);
  const abandon = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    action: 'abandon',
    reason: 'Q4 disposable cancelled work',
    target: {
      kind: 'lane',
      laneId: lane.id,
      expected: {
        head: lane.head,
        version: lane.version,
        sourceVersion: lane.sourceVersion,
        lifecycleVersion: lane.lifecycleVersion,
      },
    },
  };
  const transition = () =>
    f
      .tx('machineAbandon', lifecycleApi.transition, {
        projectId: f.projectId,
        request: JSON.stringify(abandon),
      })
      .then(JSON.parse);
  const abandoned = await transition();
  assert.deepEqual(await transition(), abandoned);
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submission.id)).submission.phase, 'terminal-failed');
  assert.equal((await f.readLane(lane.id)).state, 'abandoned');
  assert.equal((await f.readLane(lane.id)).head, lane.head, 'abandon retains saved source');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(f.pending().length, 0);
  return { synthetic: true, cancelled: true, abandoned: true, accepted: 0, stranded: 0 };
}

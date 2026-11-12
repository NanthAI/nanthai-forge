// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { physicalProject, physicalObjectRow } from './convex-physical-manifest-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { ConvexExchange } from '../dist/exchange-client.js';
import { saveHostedLane } from '../dist/hosted-save-client.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { saveBytes } from '../dist/hosted-save.js';
const sync = await import(moduleUrl('../convex/projectHostedSync.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
function moveMain(f, pin, receipt) {
  f.s.main.head = pin.sha256;
  f.s.main.receipt.id = receipt;
  f.s.moveMain(pin.sha256, receipt);
}
function dogfood(s) {
  for (const [kind, count] of [
    ['intent', 600],
    ['lane', 560],
    ['save', 2800],
    ['candidate', 2200],
    ['job', 1500],
  ])
    for (let index = 0; index < count; index++)
      s.insert('projectHostedRecordHeads', {
        projectId: s.projectId,
        kind,
        key: `unselected-${kind}-${index}`,
        version: 0,
        parent: '',
        status: 'unselected',
        recordId: `unselected-body-${index}`,
      });
  for (let index = 0; index < 32000; index++)
    s.insert('projectObjects', {
      projectId: s.projectId,
      digest: `unselected-${index}`,
      size: 0,
      nonce: 'synthetic',
      removed: false,
    });
}
test('29k dogfood landing keeps save, real disjoint sync and compose descriptor calls at most five with no per-file writer scan', async t => {
  const f = await physicalProject(t, 29000);
  await f.queueSeed();
  await f.seed();
  const initial = await f.compose(f.files, f.base, 'main-0');
  moveMain(f, initial.head, 'main-1');
  // Build the peer with the real writer before this landing, as an accepted main
  // would arrive. The measured Lane still starts on its previous base.
  const peerFiles = f.files.map((file, index) =>
    index === 16 ? f.s.file(file.path, 'first\npeer\nlast\n') : file,
  );
  const peer = await f.compose(peerFiles, initial.head, 'main-1');
  moveMain(f, peer.head, 'main-2');
  const entry = await f.s.lane(initial.head, { base: { head: initial.head.sha256, receiptId: 'main-1' } });
  const state = JSON.parse(f.s.objects.get(initial.head.sha256));
  const root = mkdtempSync(join(tmpdir(), 'forge-physical-landing-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  t.after(() =>
    rmSync(root + '.forge-client', { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );
  mkdirSync(join(root, '.forge'));
  writeFileSync(
    join(root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: 'https://fixture.invalid',
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: f.s.projectId,
        laneId: entry.laneId,
        intentId: f.s.intentId,
        head: entry.head,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        base: { head: initial.head.sha256, receiptId: 'main-1' },
        authority: { mode: 'server', epoch: 1 },
      },
      state,
      scope: [],
      materialized: state.files.slice(0, 8).map(file => file.path),
    }),
  );
  for (const file of state.files.slice(0, 8)) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `first\nlanding-${file.path}\nlast\n`);
  }
  dogfood(f.s);
  const exchange = new ConvexExchange(
    'https://fixture.invalid',
    'synthetic',
    f.s.projectId,
    randomUUID(),
    null,
  );
  exchange.client = f.c.client;
  const old = process.env.FORGE_PHYSICAL_MANIFESTS;
  process.env.FORGE_PHYSICAL_MANIFESTS = '1';
  t.after(() => {
    if (old === undefined) delete process.env.FORGE_PHYSICAL_MANIFESTS;
    else process.env.FORGE_PHYSICAL_MANIFESTS = old;
  });
  const starts = { requests: f.requests.length, calls: f.c.calls.length, db: f.s.counts.length };
  const save = await saveHostedLane(
    root,
    { operationId: randomUUID(), message: 'eight-file landing' },
    exchange,
    {
      overlapEvidence: false,
      submitPage: true,
      submitRun: true,
      prepareTargets: true,
      runPublish: true,
      uploadPacks: true,
    },
  );
  assert.equal(save.outcome.status, 'completed');
  const saved = readHostedLaneCheckout(root).selection;
  assert(physicalObjectRow(f.s, saved.head).statePhysical);
  const saveEnd = f.requests.length;
  const request = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    kind: 'sync',
    laneId: entry.laneId,
    expected: {
      head: saved.head,
      version: saved.version,
      sourceVersion: saved.sourceVersion,
      lifecycleVersion: saved.lifecycleVersion,
    },
    target: { kind: 'main', head: peer.head.sha256, receiptId: 'main-2' },
    message: 'merge accepted peer',
  };
  await f.s.call('S5 sync prepare', sync.prepare, {
    projectId: f.s.projectId,
    request: JSON.stringify(request),
  });
  const progress = JSON.parse(
    await f.s.call('S5 sync progress', sync.progress, {
      projectId: f.s.projectId,
      operationId: request.operationId,
    }),
  );
  f.s.put(saveBytes(progress.input));
  const synced = JSON.parse(
    await f.c.call('projectSourceRun:submit', {
      projectId: f.s.projectId,
      kind: 'sync',
      operationId: request.operationId,
      input: Buffer.from(saveBytes(progress.input)).toString('utf8'),
    }),
  );
  assert.equal(synced.outcome.status, 'completed');
  const syncEnd = f.requests.length;
  const record = JSON.parse(
    (
      await f.s.run('S5 read synced Lane', ctx =>
        records.readHostedRecord(ctx, { ...f.s.auth, kind: 'lane', key: entry.laneId }),
      )
    ).value,
  );
  assert.notEqual(record.head, saved.head, 'sync writes the combined State');
  assert(physicalObjectRow(f.s, record.head).statePhysical);
  const object = physicalObjectRow(f.s, record.head);
  const selection = f.s.selection([
    {
      laneId: record.id,
      head: record.head,
      version: record.version,
      sourceVersion: record.sourceVersion,
      lifecycleVersion: record.lifecycleVersion,
      state: {
        object: { sha256: record.head, size: object.size },
        recipe: object.recipe ? { sha256: object.recipe.digest, size: object.recipe.size } : null,
      },
    },
  ]);
  await f.s.prepare(selection);
  await f.s.stage(selection);
  const pending = await f.s.submit(selection);
  await f.c.call('projectConvexSource:dispatch', { projectId: f.s.projectId, jobId: pending.jobId });
  await f.c.call('projectConvexSource:step', { projectId: f.s.projectId, jobId: pending.jobId, step: 0 });
  const end = f.requests.length;
  const measured = f.requests.slice(starts.requests);
  assert.equal(
    measured.filter(request => request.seed).length,
    0,
    'the normalized landing performs no catalog seed',
  );
  assert(measured.length <= 5, `${measured.length} descriptor calls across save/sync/compose`);
  const fileIds = new Set([
    ...state.files.map(file => file.blob),
    ...readHostedLaneCheckout(root).state.files.map(file => file.blob),
    peerFiles[16].blob,
  ]);
  const fileLookups = measured.flatMap(request => request.digests).filter(id => fileIds.has(id));
  assert.equal(
    fileLookups.length,
    0,
    'committed and parent-manifest file bindings require no descriptor RPC',
  );
  assert.equal(f.c.storageCalls(), 0);
  t.diagnostic(
    JSON.stringify({
      files: 29000,
      changedPaths: 8,
      descriptorCalls: {
        save: saveEnd - starts.requests,
        sync: syncEnd - saveEnd,
        compose: end - syncEnd,
        total: measured.length,
      },
      functionCalls: f.c.calls.length - starts.calls,
      dbReadBytes: f.s.counts.slice(starts.db).reduce((sum, row) => sum + row.readBytes, 0),
    }),
  );
});

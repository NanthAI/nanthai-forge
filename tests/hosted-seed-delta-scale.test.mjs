// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fixture,
  checkpoint,
  preparedCheckpoint,
  seedRecordCheckpoint,
} from './project-exchange-fixture.mjs';
import { land } from './source-landings-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { digest } from '../dist/hash.js';
import { parseWork } from '../dist/work-unified-types.js';

import { indexObjects, measurePublication } from './hosted-seed-delta-scale-fixture.mjs';

test('dogfood-sized paged seed then 23 landings publishes delta within call and memory budgets', async t => {
  const s = fixture(),
    first = await checkpoint(t, s),
    store = first.store;
  indexObjects(s);
  // This measures hosted publication, not local fragmented-store fsync cost.
  // Retain valid legacy JSON fixture snapshots through the normal Work reader.
  store.save = value => {
    parseWork(value);
    writeFileSync(join(store.directory, 'work.json'), JSON.stringify(value, null, 2));
  };
  land(store, 575, 5);
  const data = store.load();
  // ~100 MiB of retained Work, spread over bounded record bodies and packs.
  for (const intent of data.intents)
    intent.notes.push(
      ...Array.from({ length: 48 }, () => ({ kind: 'comment', at: 'now', text: 'x'.repeat(4000) })),
    );
  while (data.views.length < 2200)
    data.views.push({ ...data.views[data.views.length % 575], id: randomUUID() });
  const check = {
    id: randomUUID(),
    name: 'Synthetic check',
    executable: 'node',
    args: [],
    environmentLabel: 'synthetic',
    definition: 'a'.repeat(64),
    at: 'now',
  };
  data.checks.push(check);
  for (let i = 0; i < 1500; i++) {
    const view = data.views[i];
    data.runs.push({
      id: randomUUID(),
      viewId: view.id,
      head: view.head,
      base: view.base,
      inputs: view.inputs,
      dependencies: [],
      check,
      environment: {
        platform: 'synthetic',
        arch: 'synthetic',
        os: 'synthetic',
        node: 'synthetic',
        env: {},
        fingerprint: 'b'.repeat(64),
      },
      status: 'passed',
      startedAt: 'now',
      endedAt: 'later',
      runner: { pid: 1, host: 'synthetic' },
      details: 'Synthetic retained run',
    });
  }
  data.revision = 28041;
  store.save(data);
  // Extra retained source blobs bring the seed to the observed 32,000-object shape.
  const source = new NativeSource(store.root);
  const put = bytes => {
    const id = digest(bytes);
    writeFileSync(join(source.directory, id), bytes);
    return id;
  };
  const files = Array.from({ length: 3000 }, (_, i) => ({
    path: `src/file-${i}.ts`,
    mode: 'file',
    blob: put(Buffer.from(`export const n = ${i};\n`)),
  }));
  // The root State retains thousands of files; immutable historical objects are
  // added by the prepared fixture below without changing the accepted source.
  const head = source.writeState(files, [data.nativeHead], 'Synthetic tree', 'now');
  const oldHead = data.nativeHead,
    baselineLane = data.lanes.at(-1);
  const baselineView = data.views.find(view => view.id === data.channelMoves.at(-1).viewId);
  baselineLane.checkpoints.push({ head, parent: oldHead, at: 'now', message: 'Synthetic tree' });
  baselineLane.head =
    baselineView.head =
    baselineView.inputs[0].head =
    data.channelMoves.at(-1).head =
    data.nativeHead =
      head;
  store.save(data);
  const seed = await preparedCheckpoint(s, store, 0, undefined, { records: true });
  // Native reachability need not retain unreferenced objects: fill the storage
  // table to 32k to prove indexed publication cost is independent of its size.
  for (let i = 0; s.tables.projectObjects.size < 32000; i++) {
    const bytes = Buffer.from(`retained synthetic ${i}`),
      id = digest(bytes),
      storageId = await s.ctx.storage.store(new Blob([bytes]));
    s.files.get(storageId).unreferenced = true;
    await s.ctx.db.insert('projectObjects', {
      projectId: 'project',
      digest: id,
      size: bytes.length,
      nonce: randomUUID(),
      storageId,
      removed: false,
    });
  }
  assert(s.tables.projectObjects.size >= 32000);
  assert(seed.tree.root.work.size > 100 * 1024 * 1024);
  const backupId = await seedRecordCheckpoint(s, seed);
  assert.equal(s.tables.projectBackups.get(backupId).validatedWorkRecords, 1);
  const baseline = JSON.parse(
    readFileSync(join(store.directory, `exchange-${seed.input.operationId}`, 'work.json')),
  );
  land(store, 23);
  const after = store.load();
  after.revision = 29558;
  // A 280-file source change is retained alongside the 23 Work landings.
  const changed = files.map((file, i) =>
    i < 280 ? { ...file, blob: put(Buffer.from(`export const changed = ${i};\n`)) } : file,
  );
  const previous = after.nativeHead;
  after.nativeHead = source.writeState(changed, [previous], 'Changed 280 files', 'later');
  const lane = after.lanes.at(-1),
    view = after.views.at(-1);
  lane.checkpoints.push({ head: after.nativeHead, parent: previous, at: 'later', message: 'Changed files' });
  lane.head = view.head = view.inputs[0].head = after.channelMoves.at(-1).head = after.nativeHead;
  store.save(after);
  const next = await preparedCheckpoint(s, store, 0, undefined, { records: true, baseline });
  next.input.previous = backupId;
  const metrics = await measurePublication(s, next.input, join(store.directory, 'scale-publication'));
  const { logs, ...measured } = metrics;
  t.diagnostic(
    JSON.stringify({
      objects: s.tables.projectObjects.size,
      workBytes: seed.tree.root.work.size,
      landings: 23,
      revisions: 1517,
      changedFiles: 280,
      callsPerLanding: metrics.calls / 23,
      callsPerChangedRecord: metrics.calls / 92,
      recordsValidated: metrics.logs.find(([name]) => name === 'work-record exchange prepared')?.[1]
        .recordsValidated,
      ...measured,
    }),
  );
  assert.equal(metrics.validatedWorkRecords, 1);
  assert(
    metrics.logs.some(
      ([name, details]) => name === 'work-record exchange prepared' && details.mode === 'delta',
    ),
  );
  assert(
    !metrics.logs.some(
      ([name, details]) => name === 'work-record exchange prepared' && details.mode === 'seed',
    ),
  );
  assert(!metrics.logs.some(([name]) => name === 'work-record publication skip'));
  assert(metrics.calls < 500, `publication calls ${metrics.calls}`);
  const peak = Math.max(metrics.processPeakRssBytes, metrics.peakRssBytes);
  assert(peak < 256 * 1024 * 1024, `peak RSS ${peak}`);
  assert(metrics.elapsedMs < 30000, `publication wall time ${metrics.elapsedMs} ms`);
});

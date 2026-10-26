// SPDX-License-Identifier: Apache-2.0
// Standalone synthetic measurement; never reads a user's owner or credentials.
import { mkdtempSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { initNative } from '../dist/native-work.js';
import { workSchema } from '../dist/work-types.js';
import { WorkStore } from '../dist/work-store.js';
import { recordIO, putCollection, publishRecords } from '../dist/work-records.js';
import { migrateWorkDetails } from '../dist/work-detail-migration.js';
import { recordRoots } from '../dist/work-record-reachability.js';
import { workDetailPins } from '../dist/work-record-details.js';
import { runFixture } from './work-detail-fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'forge-record-details-measure-'));
try {
  writeFileSync(join(root, 'source.txt'), 'Synthetic source\n');
  initNative(root);
  const store = new WorkStore(root),
    head = store.load().nativeHead;
  let data = store.load();
  data.schema = 21;
  const path = index =>
    `tests/synthetic-component-${String(index).padStart(4, '0')}-${'x'.repeat(36)}.test.mjs`;
  const tests = Array.from({ length: 100 }, (_, i) => path(i));
  data.runs = Array.from({ length: 1446 }, (_, i) => ({
    ...runFixture(head),
    details: `Run ${i}: ${'Synthetic complete execution summary. '.repeat(80)}`,
    checkSelection: {
      scope: 'full',
      reason: 'Synthetic dogfood-shaped selection',
      tests,
      coverage: {
        mode: 'shadow',
        currentCount: 100,
        coverageCount: 65,
        tests: tests.slice(0, 65),
        fallback: null,
      },
    },
    backend: {
      requested: 'modal',
      actual: 'modal',
      verdict: 'clean',
      testVerdicts: Array.from({ length: 150 }, (_, j) => ({
        test: `${path(j)} :: synthetic assertion ${j}`,
        verdict: 'passed',
      })),
    },
  }));
  data.automaticActions = Array.from({ length: 1968 }, (_, i) => ({
    id: randomUUID(),
    at: '2026-01-01T00:00:00Z',
    action: {
      actor: 'synthetic',
      summary: `Sweep ${i}: ${'Synthetic removed cache. '.repeat(16)}`,
      undo: 'Reopen the retained Lane.',
    },
    result: JSON.stringify({
      removed: Array.from({ length: 120 }, (_, j) => ({
        id: `${i}:${j}`,
        path: `synthetic/cache/${'p'.repeat(100)}/${j}`,
        bytes: 100,
      })),
    }),
  }));
  data.intents = Array.from({ length: 300 }, () => ({
    id: randomUUID(),
    base: head,
    outcome: 'Synthetic retained Intent',
    constraints: 'c'.repeat(3000),
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    notes: [{ kind: 'comment', at: '2026-01-01T00:00:00Z', text: 'n'.repeat(3500) }],
  }));
  data.views = Array.from({ length: 1000 }, () => ({
    id: randomUUID(),
    intentId: data.intents[0].id,
    base: head,
    head,
    inputs: [],
    dependencies: [],
    status: 'clean',
    details: 'v'.repeat(4100),
    at: '2026-01-01T00:00:00Z',
  }));
  data.lanes = Array.from({ length: 500 }, () => ({
    id: randomUUID(),
    intentId: data.intents[0].id,
    name: 'Synthetic Lane',
    base: head,
    head,
    state: 'active',
    assignment: 'a'.repeat(200),
    target: 't'.repeat(200),
    checkpoints: [],
  }));
  workSchema.parse(data);
  // Emulate the old writer, retaining the same compressed record-page layout.
  const io = recordIO(store.directory),
    pointer = { schema: 'forge-work-records-v3', fields: {}, keys: Object.keys(data), collections: {} };
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) pointer.collections[key] = putCollection(io, value);
    else pointer.fields[key] = value;
  }
  publishRecords(store.directory, pointer);
  data = undefined;
  const bytes = () => store.snapshotBytes().length;
  const logical = value =>
    Object.values(value)
      .filter(Array.isArray)
      .reduce(
        (total, rows) => total + rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0),
        0,
      );
  const disk = directory =>
    readdirSync(directory).reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);
  const loadTime = () => {
    const values = [];
    for (let i = 0; i < 5; i++) {
      global.gc?.();
      const start = performance.now();
      store.load();
      values.push(performance.now() - start);
    }
    return { medianMs: values.sort((a, b) => a - b)[2], samplesMs: values };
  };
  const before = {
    workJsonBytes: bytes(),
    logicalRecordBytes: logical(store.load()),
    recordDirectoryBytes: disk(join(store.directory, 'records')),
    fullLoad: loadTime(),
  };
  let page;
  do {
    page = store.locked(() => migrateWorkDetails(store));
  } while (!page.complete);
  const kept = recordRoots(store, new Set(readdirSync(join(store.directory, 'records')))).kept;
  const currentRecordBytes = [...kept.keys()].reduce(
    (sum, id) => sum + statSync(join(store.directory, 'records', id)).size,
    0,
  );
  const after = {
    currentRecordBytes,
    workJsonBytes: bytes(),
    logicalRecordBytes: logical(store.load()),
    recordDirectoryBytes: disk(join(store.directory, 'records')),
    detailObjectBytes: workDetailPins(store.load()).reduce((sum, pin) => sum + pin.size, 0),
    fullLoad: loadTime(),
  };
  console.log(
    JSON.stringify(
      {
        fixture: {
          runs: 1446,
          automaticActions: 1968,
          intents: 300,
          views: 1000,
          lanes: 500,
          timing: 'warm filesystem, fresh parsed Work, five samples; explicit GC when available',
        },
        before,
        after,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

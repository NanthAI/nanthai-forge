import { NativeSource } from '../dist/native-source.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkService } from '../dist/work.js';
import { workSchema } from '../dist/work-types.js';
import {
  compactRun,
  hydrateRun,
  compactAction,
  actionResult,
  compactDetailPage,
} from '../dist/work-record-details.js';
import { detailReader, detailWriter, runDetails } from '../dist/work-detail-store.js';
import { migrateWorkDetails } from '../dist/work-detail-migration.js';
import { writeRecords, readWorkFile } from '../dist/work-records.js';
import { nativeReachable } from '../dist/native-reachable.js';
import { exportNativeWork, restoreNativeWork } from '../dist/native-backup.js';
import { checkEvidenceFingerprint } from '../dist/check-reuse-evidence.js';
import { digest } from '../dist/hash.js';

import { runFixture } from './work-detail-fixture.mjs';

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'forge-slim-records-')),
    root = join(parent, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.txt'), 'Synthetic source\n');
  initNative(root);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, store: new WorkStore(root) };
}
function memoryObjects() {
  const objects = new Map();
  return {
    objects,
    put(bytes) {
      const sha256 = digest(bytes);
      objects.set(sha256, bytes);
      return { sha256, size: bytes.length };
    },
    read(pin) {
      return objects.get(pin.sha256);
    },
  };
}

test('run summaries retain counts and bounded failure names; detail restores exact check evidence', () => {
  const io = memoryObjects(),
    original = runFixture(),
    compact = compactRun(original, io.put);
  assert.equal(compact.backend.testVerdicts, undefined);
  assert.deepEqual(compact.checkSelection.tests, []);
  assert.equal(compact.checkSelection.coverage, undefined);
  assert.deepEqual(compact.detailSummary, {
    tests: 2,
    coverageTests: 1,
    verdicts: { passed: 1, failed: 1, flake: 1 },
    failedTests: ['tests/b.test.mjs :: fails'],
  });
  assert.deepEqual(hydrateRun(compact, io.read), original);
  assert.equal(checkEvidenceFingerprint(hydrateRun(compact, io.read)), checkEvidenceFingerprint(original));
  assert.deepEqual(compactRun(compact, io.put), compact);
  assert.equal(io.objects.size, 1);
});

test('content verification rejects changed detail without affecting summary reads', () => {
  const io = memoryObjects(),
    compact = compactRun(runFixture(), io.put);
  io.objects.set(compact.detailRef.sha256, new TextEncoder().encode('{}'));
  assert.equal(compact.detailSummary.tests, 2);
  assert.throws(() => hydrateRun(compact, io.read), { code: 'INVALID_WORK_STORE' });
});

test('automatic results stay replayable without retaining their full JSON in record pages', () => {
  const io = memoryObjects(),
    original = {
      id: randomUUID(),
      at: 'now',
      action: { actor: 'synthetic', summary: 'Completed', undo: 'Reopen' },
      result: JSON.stringify({ completed: Array(1000).fill('retained-result') }),
    };
  const compact = compactAction(original, io.put);
  assert.ok(compact.result.length < 100);
  assert.equal(actionResult(compact, io.read), original.result);
  assert.deepEqual(compactAction(compact, io.put), compact);
});

test('native migration resumes finite pages, preserving revision, identities, old objects and history', t => {
  const { store } = fixture(t),
    data = store.load();
  data.runs = Array.from({ length: 3 }, () => runFixture(data.nativeHead));
  data.automaticActions = [
    {
      id: randomUUID(),
      at: 'now',
      action: { actor: 'synthetic', summary: 'Completed', undo: 'Reopen' },
      result: '{"completed":true}',
    },
  ];
  data.schema = 21;
  // Retain a pre-upgrade records-v3 fixture without going through new writer compaction.
  writeRecords(store.directory, { ...data, runs: [], automaticActions: [] });
  const tx = store.readRecords();
  // Raw legacy inline bytes emulate the older writer exactly.
  const pointer = JSON.parse(readWorkFile(store.directory));
  const { recordIO, putCollection, publishRecords } = awaitImport;
  const io = recordIO(store.directory);
  pointer.fields.schema = 21;
  pointer.collections.runs = putCollection(io, data.runs);
  pointer.collections.automaticActions = putCollection(io, data.automaticActions);
  publishRecords(store.directory, pointer);
  tx.dispose();
  const before = store.pointer();
  const first = store.locked(() => migrateWorkDetails(store, 1));
  assert.deepEqual(first, { complete: false, migrated: 1 });
  assert.equal(store.load().runs.filter(run => run.detailRef).length, 1);
  assert.equal(store.revision(), data.revision);
  let result;
  do {
    result = store.locked(() => migrateWorkDetails(new WorkStore(store.root), 1));
  } while (!result.complete);
  assert.deepEqual(
    store.load().runs.map(run => runDetails(store, run)),
    data.runs,
  );
  assert.equal(
    actionResult(store.load().automaticActions[0], detailReader(store.directory)),
    data.automaticActions[0].result,
  );
  assert.equal(store.load().schema, 23);
  assert.equal(store.revision(), data.revision);
  assert.deepEqual(store.pinnedData(before).runs, data.runs);
  const current = store.pointer();
  assert.deepEqual(
    store.locked(() => migrateWorkDetails(store, 1)),
    { complete: true, migrated: 0 },
  );
  assert.deepEqual(store.pointer(), current);
  const tooNew = JSON.parse(current);
  tooNew.fields.schema = 25;
  writeFileSync(join(store.directory, 'work.json'), JSON.stringify(tooNew));
  assert.throws(() => store.select('runs', data.runs[0].id), { code: 'WORK_UPGRADE_REQUIRED' });
});
const awaitImport = await import('../dist/work-records.js');

test('native save, selected replacement, export and restore retain lazy detail objects', async t => {
  const { store, parent } = fixture(t),
    data = store.load();
  const original = runFixture(data.nativeHead);
  data.runs.push(original);
  store.save(data);
  const compact = store.select('runs', original.id);
  assert.ok(compact.detailRef);
  assert.ok(nativeReachable(store).includes(compact.detailRef.sha256));
  store.locked(() => {
    const tx = store.records();
    const found = tx.find('runs', original.id);
    tx.replace('runs', found.position, { ...found.record, details: 'Updated summary' });
    store.commitRecords(tx);
  });
  const archive = await exportNativeWork(store, store.revision(), true);
  assert.ok(
    JSON.parse(archive.result.json).files.some(file => file.path === `objects/${compact.detailRef.sha256}`),
  );
  const restored = join(parent, 'restored');
  await restoreNativeWork(archive.result.archive.path, restored);
  const recovered = new WorkStore(restored);
  assert.deepEqual(
    runDetails(recovered, recovered.select('runs', original.id)).backend.testVerdicts,
    original.backend.testVerdicts,
  );
  const service = new WorkService(restored);
  const migration = await service.dispatch({ action: 'migrate-record-details' }, recovered.revision());
  assert.equal(migration.result.complete, true);
});

test('the shared hosted record-page conversion is deterministic and keeps unrelated records exact', () => {
  const io = memoryObjects(),
    runs = [runFixture(), runFixture()];
  const page = compactDetailPage('runs', runs, io.put);
  assert.deepEqual(compactDetailPage('runs', runs, io.put), page);
  assert.deepEqual(
    page.map(run => hydrateRun(run, io.read)),
    runs,
  );
  const other = [{ id: 'untouched', unknown: { digest: 'preserve' } }];
  assert.deepEqual(compactDetailPage('views', other, io.put), other);
});

test('pending detail objects survive concurrent explicit source-object collection', async t => {
  const { store } = fixture(t);
  const { nativeObjects } = await import('../dist/native-objects.js');
  const orphan = new NativeSource(store.root).put(Buffer.from('unreferenced source during detail staging'));
  const tx = store.records();
  const record = tx.append('runs', runFixture(store.load().nativeHead));
  const collection = nativeObjects(store, { action: 'collect-native-objects' });
  assert.ok(!collection.result.removed.some(item => item.id === record.detailRef.sha256));
  assert.ok(collection.result.removed.some(item => item.id === orphan));
  assert.equal(runDetails(store, record).checkSelection.tests.length, 2);
  store.locked(() => store.commitRecords(tx));
  assert.equal(runDetails(store, store.select('runs', record.id)).checkSelection.tests.length, 2);
});

test('selected native run and action detail reads never assemble complete Work', async t => {
  const { store } = fixture(t),
    data = store.load();
  const original = runFixture(data.nativeHead);
  const action = {
    id: randomUUID(),
    at: 'now',
    action: { actor: 'synthetic', summary: 'Completed', undo: 'Reopen' },
    result: '{"completed":true}',
  };
  data.runs.push(original);
  data.automaticActions = [action];
  store.save(data);
  const { readWorkDetail } = await import('../dist/work-detail.js');
  store.load = () => {
    throw new Error('must read selected records');
  };
  assert.deepEqual(
    readWorkDetail(store, {
      action: 'read-work-detail',
      kind: 'run',
      id: original.id,
      expectedHead: original.head,
    }).result.run,
    original,
  );
  assert.equal(
    readWorkDetail(store, { action: 'read-work-detail', kind: 'automatic-action', id: action.id }).result
      .action.result,
    action.result,
  );
  assert.throws(
    () =>
      readWorkDetail(store, {
        action: 'read-work-detail',
        kind: 'run',
        id: original.id,
        expectedHead: 'e'.repeat(64),
      }),
    { code: 'EVIDENCE_CHANGED' },
  );
});
test('slim native Work can migrate to unified Intents without lowering its format or losing evidence', async t => {
  const { store } = fixture(t),
    data = store.load();
  const original = runFixture(data.nativeHead);
  data.runs.push(original);
  store.save(data);
  const { convertWorkTo18 } = await import('../dist/work-intent-converter.js');
  const unified = convertWorkTo18(store.load());
  assert.equal(unified.schema, 24);
  store.save(unified);
  assert.deepEqual(runDetails(store, store.select('runs', original.id)), original);
});

test('source-object collection preserves details named by retained historical or pending record pointers', async t => {
  const { store } = fixture(t),
    data = store.load(),
    original = runFixture(store.load().nativeHead);
  data.runs.push(original);
  store.save(data);
  const before = store.pointer(),
    pin = store.select('runs', original.id).detailRef;
  const next = store.load();
  next.runs[0] = {
    ...runDetails(store, next.runs[0]),
    checkSelection: { scope: 'full', reason: 'New inventory', tests: ['tests/new.test.mjs'] },
  };
  store.save(next);
  writeFileSync(join(store.directory, 'pending-pointer.json'), before);
  const { nativeObjects } = await import('../dist/native-objects.js');
  const result = nativeObjects(store, { action: 'collect-native-objects' });
  assert.ok(!result.result.removed.some(item => item.id === pin.sha256));
  assert.deepEqual(runDetails(store, store.pinnedData(before).runs[0]), original);
});

test('a reader capped at format22 refuses slim Work before CLI reads or writes', t => {
  const { store } = fixture(t),
    data = store.load();
  data.runs.push(runFixture(data.nativeHead));
  store.save(data);
  const loader = join(store.root, 'format22-loader.mjs'),
    preload = join(store.root, 'format22-preload.mjs');
  writeFileSync(
    loader,
    `export async function load(url, context, next) {
    const result = await next(url, context);
    if (url === ${JSON.stringify(pathToFileURL(resolve('dist/work-format.js')).href)})
      return { ...result, source: result.source.toString().replace('latestWorkFormat = 24', 'latestWorkFormat = 22') };
    return result;
  }`,
  );
  writeFileSync(
    preload,
    `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)});`,
  );
  const before = store.pointer();
  for (const [action, request] of [
    ['status', {}],
    ['start', { outcome: 'Must preserve old Work' }],
  ]) {
    const result = spawnSync(
      process.execPath,
      ['--import', preload, resolve('dist/cli.js'), 'agent', store.root, action, JSON.stringify(request)],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /WORK_UPGRADE_REQUIRED/);
    assert.deepEqual(store.pointer(), before);
  }
});
test('an ordinary full save can complete an interrupted migration without losing its identity', t => {
  const { store } = fixture(t),
    data = store.load();
  data.runs = [runFixture(data.nativeHead), runFixture(data.nativeHead)];
  writeFileSync(join(store.directory, 'work.json'), JSON.stringify(data));
  // Install an old record pointer through the legacy primitives.
  const io = awaitImport.recordIO(store.directory),
    pointer = { schema: 'forge-work-records-v3', fields: {}, keys: Object.keys(data), collections: {} };
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) pointer.collections[key] = awaitImport.putCollection(io, value);
    else pointer.fields[key] = value;
  }
  awaitImport.publishRecords(store.directory, pointer);
  store.locked(() => migrateWorkDetails(store, 1));
  const pending = store.load().workDetailMigration;
  store.save(store.load());
  assert.equal(store.load().workDetailMigrationReceipt.id, pending.id);
  assert.equal(store.load().workDetailMigration, undefined);
  assert.deepEqual(
    store.locked(() => migrateWorkDetails(store)),
    { complete: true, migrated: 0 },
  );
});

test('hydrated controller ownership retains updated backend pins on a startup failure', async t => {
  const { store } = fixture(t),
    data = store.load();
  const { hostname } = await import('node:os');
  const { executeOwnedRun } = await import('../dist/work-run.js');
  const raw = {
    ...runFixture(data.nativeHead),
    status: 'running',
    runner: { pid: process.pid, host: hostname() },
  };
  delete raw.endedAt;
  delete raw.exitCode;
  data.runs.push(raw);
  store.save(data);
  const claimed = store.select('runs', raw.id),
    pin = 'd'.repeat(64);
  assert.ok(claimed.detailRef);
  await executeOwnedRun(store, claimed, async (_store, run) => {
    run.backend.pin = pin;
    store.locked(() => {
      const tx = store.records();
      const found = tx.find('runs', run.id);
      tx.replace('runs', found.position, run);
      store.commitRecords(tx);
    });
    throw new Error('Synthetic controller startup failed after retaining the plan');
  });
  assert.equal(store.select('runs', raw.id).status, 'interrupted');
  const receipt = JSON.parse(readFileSync(join(store.directory, `check-${raw.id}`, 'result.json')));
  assert.equal(receipt.backend.pin, pin);
});

// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { workSchema } from '../dist/work-types.js';
import { recordObject, recordIO, putRecord } from '../dist/work-records.js';
import { unifyIntent } from '../dist/work-intent-local.js';
import { exportNativeWork, restoreNativeWork } from '../dist/native-backup.js';

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'forge-work-records-')),
    root = join(parent, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.txt'), 'source\n');
  initNative(root);
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const work = new WorkService(root);
  return { parent, root, work, store: work.store };
}
const intent = (base, i) =>
  unifyIntent({
    id: randomUUID(),
    outcome: `Retained intent ${i}`,
    constraints: '',
    base,
    status: 'active',
    notes: [],
    createdAt: '2026-01-01T00:00:00Z',
  });

test('current monolithic journal migration retains unknown fields, history, ordering and all record IDs', t => {
  const { store } = fixture(t),
    data = store.load();
  data.intents = Array.from({ length: 270 }, (_, i) => intent(data.nativeHead, i));
  data.futureEvidence = { original: 'Keep unknown provenance' };
  data.intents[0].future = 'preserved';
  const legacy = Buffer.from(JSON.stringify(data, null, 2) + '\n');
  writeFileSync(join(store.directory, 'work.json'), legacy);
  assert.deepEqual(store.snapshotBytes(), legacy);
  assert.deepEqual(store.load(), data);
  const next = store.load();
  next.revision++;
  next.intents[1].notes.push({ kind: 'comment', at: 'now', text: 'A new note' });
  store.locked(() => store.save(next));
  assert.deepEqual(new WorkStore(store.root).load(), next);
  assert.equal(JSON.parse(readFileSync(join(store.directory, 'work.json'))).schema, 'forge-work-records-v3');
  assert.throws(() => workSchema.parse(JSON.parse(readFileSync(join(store.directory, 'work.json')))));
  assert.deepEqual(store.page('intents', 125, 10).records, next.intents.slice(125, 135));
  assert.equal(store.page('intents', 125, 10).nextOffset, 135);
  assert.equal(store.page('intents', 260, 20).nextOffset, null);
});

test('one changed record writes only selected fragments and leaves retained bytes unchanged', t => {
  const { store } = fixture(t),
    data = store.load();
  data.intents = Array.from({ length: 260 }, (_, i) => intent(data.nativeHead, i));
  store.save(data);
  const dir = join(store.directory, 'records'),
    before = new Map(readdirSync(dir).map(name => [name, statSync(join(dir, name)).mtimeMs]));
  data.revision++;
  data.intents[140].notes.push({ kind: 'comment', at: 'now', text: 'Changed only this Intent' });
  store.save(data);
  const after = readdirSync(dir),
    added = after.filter(name => !before.has(name));
  // A unified note also adds its stable conversation record and index.
  t.diagnostic(`Changed-note record objects: ${added.length}`);
  assert.ok(added.length <= 7);
  for (const [name, mtime] of before) assert.equal(statSync(join(dir, name)).mtimeMs, mtime);
  const pointer = JSON.parse(readFileSync(join(store.directory, 'work.json'))),
    changed = pointer.collections.intents.pages[1];
  const hashes = recordObject(store.directory, changed);
  rmSync(join(dir, hashes[0]));
  // Reading another page does not touch records outside the requested slice.
  assert.equal(store.page('intents', 0, 5).records.length, 5);
  assert.throws(
    () => store.load(),
    error => error.code === 'INVALID_WORK_STORE',
  );
});

test('unfinished staged writes preserve the old atomic snapshot and retry cleanly', t => {
  const { store } = fixture(t),
    original = store.snapshotBytes();
  writeFileSync(join(store.directory, 'interrupted.tmp'), 'unpublished');
  writeFileSync(join(store.directory, 'records', 'a'.repeat(64)), 'unreferenced staged bytes');
  assert.deepEqual(new WorkStore(store.root).snapshotBytes(), original);
  const data = store.load();
  data.revision++;
  store.save(data);
  assert.equal(new WorkStore(store.root).load().revision, data.revision);
});

test('a failed staged record write cannot replace the last committed snapshot', t => {
  const { store } = fixture(t),
    before = readFileSync(join(store.directory, 'work.json')),
    next = store.load();
  next.intents = [intent(next.nativeHead, 1), intent(next.nativeHead, 2)];
  next.revision++;
  const id = putRecord(recordIO(store.directory), next.intents[1]),
    corrupted = join(store.directory, 'records', id),
    bytes = readFileSync(corrupted);
  writeFileSync(corrupted, 'corrupted pre-existing content');
  assert.throws(
    () => store.save(next),
    error => error.code === 'INVALID_WORK_STORE',
  );
  assert.deepEqual(readFileSync(join(store.directory, 'work.json')), before);
  assert.equal(store.load().intents.length, 0);
  writeFileSync(corrupted, bytes);
  store.save(next);
  assert.deepEqual(store.load(), next);
});

test(
  'more than 4 MiB and former Intent, note, Lane and View ceilings remain usable and restorable',
  // Parallel Forge checks can stall the event loop; this is a hang guard, not a performance assertion.
  { timeout: 300000 },
  async t => {
    const { parent, work, store } = fixture(t),
      data = store.load(),
      head = data.nativeHead;
    data.intents = Array.from({ length: 102 }, (_, i) => intent(head, i));
    data.intents[0].notes = Array.from({ length: 1100 }, (_, i) => ({
      kind: 'comment',
      at: 'now',
      text: `${i}:` + 'x'.repeat(3990),
    }));
    // Retained clean Views need no materialized workspace; constructing history does not run source.
    data.views = Array.from({ length: 101 }, () => ({
      id: randomUUID(),
      intentId: data.intents[0].id,
      base: head,
      head,
      status: 'clean',
      inputs: [],
      details: 'Retained',
      at: 'now',
    }));
    data.lanes = Array.from({ length: 65 }, (_, i) => ({
      id: randomUUID(),
      intentId: data.intents[0].id,
      name: `Lane ${i}`,
      assignment: '',
      target: '',
      state: 'paused',
      base: head,
      head,
      checkpoints: [],
    }));
    store.save(data);
    assert.ok(store.snapshotBytes().length > 4 * 1024 * 1024);
    const apply = command => work.execute(command, store.load().revision).result;
    const created = apply({ action: 'intent', outcome: 'After the former ceiling' });
    apply({ action: 'note', intentId: data.intents[0].id, kind: 'comment', text: 'Still usable' });
    const lane = apply({ action: 'lane', intentId: created.id, name: 'After 64' });
    const view = apply({
      action: 'compose',
      operationId: randomUUID(),
      intentId: created.id,
      inputs: [{ laneId: lane.id, head: lane.head }],
    });
    assert.equal(view.status, 'clean');
    assert.equal(store.load().views.length, 102);
    const exported = (await exportNativeWork(store, store.load().revision, true)).result;
    const target = join(parent, 'restored');
    await restoreNativeWork(exported.archive.path, target);
    assert.deepEqual(new WorkStore(target).load(), store.load());
  },
);

test('agent records reads only the selected collection page without assembling Work', async t => {
  const { store, root } = fixture(t),
    data = store.load();
  data.intents = [intent(data.nativeHead, 0)];
  store.save(data);
  const original = WorkStore.prototype.load;
  WorkStore.prototype.load = () => {
    throw Error('Full Work read forbidden in this probe');
  };
  try {
    const result = await new AgentWorkflow(root).dispatch({
      action: 'records',
      collection: 'intents',
      offset: 0,
      limit: 1,
    });
    assert.equal(result.result.records[0].id, data.intents[0].id);
    assert.equal(result.result.total, 1);
    assert.equal(result.revision, data.revision);
  } finally {
    WorkStore.prototype.load = original;
  }
});

test('full-load memo keeps shared immutable references independent and revalidates the next read', t => {
  const { store } = fixture(t),
    data = store.load();
  const record = { ...intent(data.nativeHead, 0), future: { retained: ['original'] } };
  data.intents = [record, structuredClone(record)];
  store.save(data);
  const loaded = store.load();
  loaded.intents[0].future.retained.push('local mutation');
  assert.deepEqual(loaded.intents[1].future.retained, ['original']);
  assert.deepEqual(store.load().intents[0].future.retained, ['original']);
  const manifest = JSON.parse(readFileSync(join(store.directory, 'work.json'), 'utf8'));
  const page = recordObject(store.directory, manifest.collections.intents.pages[0]);
  writeFileSync(join(store.directory, 'records', page[0]), '{}');
  assert.throws(() => store.load(), { code: 'INVALID_WORK_STORE' });
});

test('lock-free pointer reads survive a concurrent atomic replace of work.json', async t => {
  const { mkdtempSync, writeFileSync, rmSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { readWorkFile } = await import('../dist/work-records.js');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'forge-pointer-')));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const body = JSON.stringify({ revision: 1, pad: 'x'.repeat(4096) });
  writeFileSync(join(dir, 'work.json'), body);
  const writer = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('fs'),p=require('path');const d=process.argv[1],b=process.argv[2];
for(let i=0;i<3000;i++){const t=p.join(d,i+'.tmp');fs.writeFileSync(t,b);fs.renameSync(t,p.join(d,'work.json'));}`,
      dir,
      body,
    ],
    { stdio: 'ignore' },
  );
  let running = true;
  const done = new Promise(resolve => writer.on('exit', () => ((running = false), resolve())));
  let reads = 0;
  while (running) {
    for (let i = 0; i < 50; i++, reads++) assert.equal(readWorkFile(dir).toString(), body);
    await new Promise(resolve => setImmediate(resolve));
  }
  await done;
  assert.ok(reads > 0);
});

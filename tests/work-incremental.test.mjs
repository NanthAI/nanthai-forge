// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkService } from '../dist/work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { recordManifest, readRecords } from '../dist/work-records.js';
import { unpackRecord } from '../dist/work-record-codec.js';
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'forge-incremental-'));
  fs.writeFileSync(join(root, 'a.txt'), 'source\n');
  initNative(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new WorkStore(root), work: new WorkService(root), agent: new AgentWorkflow(root) };
}
const intent = (base, i) => ({
  id: randomUUID(),
  outcome: `Retained ${i}`,
  constraints: '',
  base,
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
  notes: [],
});
async function measured(directory, fn) {
  const originals = {
      openSync: fs.openSync,
      closeSync: fs.closeSync,
      readSync: fs.readSync,
      writeFileSync: fs.writeFileSync,
    },
    fds = new Map(),
    metrics = { reads: 0, readBytes: 0, writes: 0, writtenBytes: 0 };
  fs.openSync = function (path, ...args) {
    const fd = originals.openSync.call(this, path, ...args);
    if (String(path).startsWith(directory + '/')) fds.set(fd, String(path));
    return fd;
  };
  fs.closeSync = function (fd) {
    fds.delete(fd);
    return originals.closeSync.call(this, fd);
  };
  fs.readSync = function (fd, ...args) {
    const n = originals.readSync.call(this, fd, ...args);
    if (fds.has(fd) && n) {
      metrics.reads++;
      metrics.readBytes += n;
    }
    return n;
  };
  fs.writeFileSync = function (path, value, ...args) {
    if (fds.has(path) || (typeof path === 'string' && path.startsWith(directory + '/'))) {
      metrics.writes++;
      metrics.writtenBytes += Buffer.byteLength(value);
    }
    return originals.writeFileSync.call(this, path, value, ...args);
  };
  syncBuiltinESMExports();
  const start = performance.now();
  try {
    const value = await fn();
    return { value, ...metrics, ms: Math.round((performance.now() - start) * 100) / 100 };
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}
test('ordinary compact mutations and agent frontdoors do not reconstruct unrelated retained Work', async t => {
  const { root, store, work, agent } = fixture(t),
    data = store.load();
  data.intents = Array.from({ length: 150 }, (_, i) => intent(data.nativeHead, i));
  store.save(data);
  const original = WorkStore.prototype.load;
  WorkStore.prototype.load = function () {
    throw Error('Full Work reconstruction forbidden');
  };
  try {
    const note = work.execute(
      { action: 'note', intentId: data.intents[0].id, text: 'selected', kind: 'comment' },
      store.revision(),
      { compact: true },
    );
    assert.equal(note.result.note.text, 'selected');
    work.execute(
      { action: 'intent-status', intentId: data.intents[0].id, status: 'completed' },
      store.revision(),
      { compact: true },
    );
    const planned = await work.dispatch(
      {
        action: 'put-planning-item',
        operationId: randomUUID(),
        itemId: randomUUID(),
        kind: 'issue',
        title: 'Scoped',
        intentIds: [data.intents[0].id],
      },
      store.revision(),
    );
    assert.equal(planned.result.title, 'Scoped');
    const command = { action: 'start', operationId: randomUUID(), outcome: 'Scoped start' },
      started = (await agent.dispatch(command)).result;
    assert.equal((await agent.dispatch(command)).result.laneId, started.laneId);
    fs.writeFileSync(join(started.path, 'a.txt'), 'changed\n');
    const checkpoint = {
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: started.laneId,
      expectedHead: started.head,
      message: 'Scoped source',
    };
    const saved = (await agent.dispatch(checkpoint)).result;
    assert.equal((await agent.dispatch(checkpoint)).result.head, saved.head);
    const status = await agent.dispatch({ action: 'status', limit: 2 });
    assert.equal(status.result.intents.total, 151);
    assert.equal(status.result.intents.items.length, 2);
    const check = await agent.dispatch({
      action: 'define-check',
      name: 'Scoped definition',
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
    });
    assert.ok(check.result.definition);
  } finally {
    WorkStore.prototype.load = original;
  }
  assert.equal(store.load().intents[0].notes[0].text, 'selected');
  assert.equal(new WorkStore(root).load().intents[0].lifecycle.length, 1);
});
test('scoped CAS, unpublished fragments, corruption and extension fields preserve originals', t => {
  const { store } = fixture(t),
    data = store.load();
  data.intents = [intent(data.nativeHead, 0), intent(data.nativeHead, 1)];
  data.intents[0].future = { opaque: ['preserved'] };
  data.intents[0].notes = [{ kind: 'comment', text: 'old', at: 'now', future: { original: true } }];
  data.futureRoot = ['opaque'];
  store.save(data);
  const first = store.records(),
    stale = store.records();
  first.appendField('intents', data.intents[0].id, 'notes', { kind: 'comment', text: 'new', at: 'now' });
  store.locked(() => store.commitRecords(first));
  stale.patchFields('intents', data.intents[1].id, { status: 'ready' });
  assert.throws(
    () => store.locked(() => store.commitRecords(stale)),
    error => error.code === 'WORK_STALE',
  );
  const crossProcess = store.records();
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import {WorkStore} from ${JSON.stringify(new URL('../dist/work-store.js', import.meta.url).href)};const store=new WorkStore(${JSON.stringify(store.root)});store.locked(()=>{const tx=store.records();tx.patchFields('intents',${JSON.stringify(data.intents[1].id)},{status:'ready'});store.commitRecords(tx);});`,
  ]);
  assert.throws(
    () => store.locked(() => store.commitRecords(crossProcess)),
    error => error.code === 'WORK_STALE',
  );
  const before = store.snapshotBytes(),
    aborted = store.records();
  aborted.appendField('intents', data.intents[0].id, 'notes', {
    kind: 'comment',
    text: 'unpublished',
    at: 'now',
  });
  assert.deepEqual(new WorkStore(store.root).snapshotBytes(), before);
  const selected = store.records(),
    original = selected.find('intents', data.intents[0].id);
  selected.replace('intents', original.position, { ...original.record, status: 'ready' });
  store.locked(() => store.commitRecords(selected));
  const result = store.load();
  assert.deepEqual(result.futureRoot, ['opaque']);
  assert.deepEqual(result.intents[0].future, data.intents[0].future);
  assert.deepEqual(result.intents[0].notes[0].future, { original: true });
  assert.equal(result.intents[0].notes.length, 2);
  const pointer = fs.readFileSync(join(store.directory, 'work.json')),
    manifest = recordManifest(JSON.parse(pointer));
  // Pages may be stored compressed; their identity is the decoded JSON.
  const page = JSON.parse(
    unpackRecord(fs.readFileSync(join(store.directory, 'records', manifest.collections.intents.pages[0]))),
  );
  fs.writeFileSync(join(store.directory, 'records', page[1]), 'corrupt');
  const scoped = store.records();
  scoped.appendField('intents', data.intents[0].id, 'notes', {
    kind: 'comment',
    text: 'independent',
    at: 'now',
  });
  store.locked(() => store.commitRecords(scoped));
  assert.throws(
    () => store.load(),
    error => error.code === 'INVALID_WORK_STORE',
  );
  assert.throws(
    () => store.select('intents', data.intents[1].id),
    error => error.code === 'INVALID_WORK_STORE',
  );
});
test('version-one and monolithic migration are lossless; malformed legacy data never publishes a new pointer', t => {
  const { store } = fixture(t),
    data = store.load();
  data.intents = [intent(data.nativeHead, 0)];
  data.unknown = { nested: ['original'] };
  data.intents[0].notes = [{ kind: 'comment', text: 'preserve', at: 'now', future: 'unknown' }];
  const legacy = Buffer.from(JSON.stringify(data, null, 2));
  fs.writeFileSync(join(store.directory, 'work.json'), legacy);
  store.locked(() => store.records());
  assert.deepEqual(store.load(), data);
  assert.deepEqual(JSON.parse(store.snapshotBytes()), data);
  const put = value => {
    const bytes = Buffer.from(JSON.stringify(value)),
      hash = createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(join(store.directory, 'records', hash), bytes);
    return hash;
  };
  const fields = {},
    collections = {};
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value))
      collections[key] = { count: value.length, pages: value.length ? [put(value.map(put))] : [] };
    else fields[key] = value;
  }
  fs.writeFileSync(
    join(store.directory, 'work.json'),
    JSON.stringify({ schema: 'forge-work-records-v1', keys: Object.keys(data), fields, collections }),
  );
  store.locked(() => store.records());
  assert.deepEqual(store.load(), data);
  fs.writeFileSync(join(store.directory, 'work.json'), '{invalid');
  assert.throws(() => store.locked(() => store.records()));
  assert.equal(fs.readFileSync(join(store.directory, 'work.json'), 'utf8'), '{invalid');
});
test('optional undefined fields retain portable JSON semantics across save, scoped replacement and export', t => {
  const { store } = fixture(t),
    data = store.load();
  data.intents = [
    { ...intent(data.nativeHead, 0), dependencies: undefined, future: { omitted: undefined, kept: true } },
  ];
  data.futureRoot = undefined;
  data.extra = [undefined, { omitted: undefined, kept: true }];
  store.save(data);
  const expected = JSON.parse(JSON.stringify(data));
  assert.deepEqual(store.load(), expected);
  assert.deepEqual(JSON.parse(store.snapshotBytes()), expected);
  const tx = store.records(),
    found = tx.find('intents', data.intents[0].id);
  tx.appendField('intents', data.intents[0].id, 'notes', {
    kind: 'comment',
    text: 'Optional entry',
    at: 'now',
    future: undefined,
  });
  found.record.notes.push({ kind: 'comment', text: 'Optional entry', at: 'now' });
  tx.replace('intents', found.position, { ...found.record, dependencies: undefined, status: 'ready' });
  store.locked(() => store.commitRecords(tx));
  const restored = store.load();
  assert.equal(restored.intents[0].status, 'ready');
  assert.deepEqual(restored.intents[0].notes, [{ kind: 'comment', text: 'Optional entry', at: 'now' }]);
  assert.equal(Object.hasOwn(restored.intents[0], 'dependencies'), false);
  assert.deepEqual(restored.intents[0].future, { kept: true });
  assert.deepEqual(restored.extra, [null, { kept: true }]);
  assert.equal(Object.hasOwn(restored, 'futureRoot'), false);
});
test(
  '100/1000/10000 retained records and same-Intent notes have bounded selected mutation I/O',
  { timeout: 300000 },
  async t => {
    const results = [];
    for (const count of [100, 1000, 10000]) {
      const { store, work, agent } = fixture(t),
        data = store.load();
      data.intents = Array.from({ length: count }, (_, i) => intent(data.nativeHead, i));
      data.intents[0].notes = Array.from({ length: count }, (_, i) => ({
        kind: 'comment',
        at: 'now',
        text: `${i}:` + 'x'.repeat(1000),
      }));
      const fsync = fs.fsyncSync;
      fs.fsyncSync = () => {};
      syncBuiltinESMExports();
      try {
        store.save(data);
      } finally {
        fs.fsyncSync = fsync;
        syncBuiltinESMExports();
      }
      const before = await measured(store.directory, () => store.load());
      const mutation = await measured(store.directory, () =>
        work.execute(
          { action: 'note', intentId: data.intents[0].id, text: 'one new note', kind: 'comment' },
          store.revision(),
          { compact: true },
        ),
      );
      const status = await measured(store.directory, () => agent.dispatch({ action: 'status', limit: 5 }));
      assert.equal(mutation.value.result.note.text, 'one new note');
      assert.equal(status.value.result.intents.total, count);
      assert.ok(mutation.reads < 100, `selected append read ${mutation.reads} objects at ${count}`);
      assert.ok(mutation.readBytes < 150000, `selected append read ${mutation.readBytes} bytes at ${count}`);
      assert.ok(mutation.writtenBytes < 40000);
      assert.ok(status.reads < 100);
      assert.equal(store.select('intents', data.intents[0].id).notes.length, count + 1);
      const compact = ({ value, ...metrics }) => metrics;
      results.push({ count, fullRead: compact(before), append: compact(mutation), status: compact(status) });
    }
    t.diagnostic(
      JSON.stringify({
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          syntheticSeedFsync: false,
          measuredMutationFsync: true,
        },
        measurements: results,
      }),
    );
  },
);

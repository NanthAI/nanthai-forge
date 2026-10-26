// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { editWork, retryWorkEdit } from '../dist/work-edit.js';
import { retryWorkPhase } from '../dist/work-retry.js';
import { PreparedWorkSource } from '../dist/native-work-preparation.js';
import { batchEdit } from '../dist/landing-batch-store.js';
import { WorkService } from '../dist/work.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-work-edit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.txt'), 'synthetic\n');
  initNative(root);
  return new WorkStore(root);
}
function outsideWriter(t, store) {
  let held = false;
  const locked = store.locked.bind(store);
  t.mock.method(store, 'locked', (run, options) =>
    locked(() => {
      held = true;
      try {
        return run();
      } finally {
        held = false;
      }
    }, options),
  );
  for (const method of ['load', 'prepareSave']) {
    const original = store[method].bind(store);
    t.mock.method(store, method, (...args) => {
      assert.equal(held, false, `${method} must run outside the writer lock`);
      return original(...args);
    });
  }
  return () => assert.equal(held, false);
}

test('prepares Work outside writer lock and retries a concurrent commit without losing either edit', async t => {
  const store = fixture(t),
    peer = new WorkStore(store.root);
  outsideWriter(t, store);
  let attempts = 0,
    raced = false;
  const result = await retryWorkPhase(randomUUID(), () =>
    editWork(
      store,
      data => {
        attempts++;
        data.extension = 'first';
        return 'retained';
      },
      () => {
        if (raced) return;
        raced = true;
        const data = peer.load();
        data.otherExtension = 'concurrent';
        data.revision++;
        peer.save(data);
      },
    ),
  );
  assert.equal(result, 'retained');
  assert.equal(attempts, 2);
  assert.equal(store.load().extension, 'first');
  assert.equal(store.load().otherExtension, 'concurrent');
  assert.deepEqual(readdirSync(join(store.directory, 'record-staging')), []);
});

test('a no-op still checks the driver fence and stale pointer, without replacing Work', t => {
  const store = fixture(t),
    peer = new WorkStore(store.root);
  const before = store.pointer();
  assert.throws(
    () =>
      editWork(
        store,
        () => {},
        () => {
          throw new Error('replaced driver');
        },
      ),
    /replaced driver/,
  );
  assert.deepEqual(store.pointer(), before);
  // A writer racing every attempt (same revision is still a different pointer)
  // never makes the no-op replace Work; the locked attempt observes the write.
  editWork(
    store,
    () => {},
    () => {
      const data = peer.load();
      data.extension = 'concurrent';
      peer.save(data);
    },
  );
  assert.equal(store.load().extension, 'concurrent');
});

test('steady concurrent writes cannot starve a preparation: the third attempt prepares under the lock', t => {
  const store = fixture(t),
    peer = new WorkStore(store.root);
  let attempts = 0,
    writes = 0;
  const result = editWork(
    store,
    data => {
      attempts++;
      data.extension = 'mine';
      return 'landed';
    },
    () => {
      const data = peer.load();
      data.otherExtension = `concurrent-${++writes}`;
      data.revision++;
      peer.save(data);
    },
  );
  assert.equal(result, 'landed');
  assert.equal(attempts, 3);
  assert.equal(store.load().extension, 'mine');
  assert.equal(store.load().otherExtension, 'concurrent-3');
});

test('landing projection and compatibility edits prepare outside writer lock', async t => {
  const store = fixture(t),
    work = new WorkService(store.root);
  const assertOutside = outsideWriter(t, work.store);
  for (const channel of [undefined, 'main']) {
    await batchEdit(
      work,
      randomUUID(),
      data => {
        assertOutside();
        // Empty queue is a legitimate no-op projection.
        assert.deepEqual(data.landingEntries ?? [], []);
      },
      () => {},
      channel,
    );
  }
  assert.equal(existsSync(join(store.directory, 'lock')), false);
});

test('prepared native source detects collection before any reference is published', t => {
  const store = fixture(t),
    source = new PreparedWorkSource(store.root);
  const id = source.put(Buffer.from('new unreferenced synthetic bytes'));
  const verify = source.preparePublication();
  verify();
  unlinkSync(join(source.directory, id));
  assert.throws(verify, { code: 'WORK_STALE' });
});

test('source collection before every lock retries and validates the restored fallback preparation', t => {
  const store = fixture(t),
    source = new PreparedWorkSource(store.root),
    bytes = Buffer.from('synthetic collected preparation'),
    id = source.put(bytes),
    locked = store.locked.bind(store),
    attempts = [];
  let verify;
  t.mock.method(store, 'locked', (...args) => {
    rmSync(join(source.directory, id), { force: true });
    return locked(...args);
  });
  editWork(
    store,
    data => {
      attempts.push(existsSync(join(store.directory, 'lock')));
      source.put(bytes);
      verify = source.preparePublication();
      data.extension = id;
    },
    undefined,
    () => verify(),
  );
  assert.deepEqual(attempts, [false, false, true]);
  assert.equal(store.load().extension, id);
  assert.deepEqual(source.object(id), bytes);
  assert.deepEqual(readdirSync(join(store.directory, 'record-staging')), []);
});

test('a lost publication reply is surfaced once without repeating the committed edit', t => {
  const store = fixture(t),
    publish = store.publishSave.bind(store),
    lost = new Error('Lost prepared publication reply');
  let edits = 0;
  t.mock.method(store, 'publishSave', (...args) => {
    publish(...args);
    throw lost;
  });
  assert.throws(
    () =>
      editWork(store, data => {
        edits++;
        data.extension = 'retained';
      }),
    error => error === lost,
  );
  assert.equal(edits, 1);
  assert.equal(store.load().extension, 'retained');
});

test('semantic stale inputs return immediately rather than retrying a changed binding', async t => {
  const store = fixture(t);
  const { ForgeError } = await import('../dist/errors.js');
  let calls = 0;
  await assert.rejects(
    retryWorkEdit(store, randomUUID(), () => {
      calls++;
      throw new ForgeError('WORK_STALE', 'Binding changed');
    }),
    { code: 'WORK_STALE', message: 'Binding changed' },
  );
  assert.equal(calls, 1);
});

test('delta staging retains immutable history pages, scalar fields and opaque extension arrays', t => {
  const store = fixture(t);
  const data = store.load();
  data.opaqueHistory = [{ value: 'old' }];
  store.save(data);
  const original = store.readRecords().manifest.collections;
  editWork(store, next => {
    next.opaqueHistory.push({ value: 'new' });
    next.extension = 'retained';
  });
  const loaded = store.load(),
    current = store.readRecords().manifest.collections;
  assert.deepEqual(loaded.opaqueHistory, [{ value: 'old' }, { value: 'new' }]);
  assert.equal(loaded.extension, 'retained');
  assert.deepEqual(current.lanes, original.lanes);
  assert.deepEqual(current.runs, original.runs);
});

test('record publication releases writer before warming peer caches and returns with caches ready', async t => {
  const store = fixture(t);
  const { PeersCache } = await import('../dist/agent-peers-cache.js');
  const { agentStart } = await import('../dist/agent-workflow-mutations.js');
  const { agentActionSchema } = await import('../dist/agent-workflow-schema.js');
  const lane = agentStart(
    store,
    agentActionSchema.parse({
      action: 'start',
      operationId: randomUUID(),
      outcome: 'Synthetic cache publication',
    }),
  ).result;
  let writes = 0;
  const write = PeersCache.prototype.write;
  t.mock.method(PeersCache.prototype, 'write', function (...args) {
    assert.equal(existsSync(join(store.directory, 'lock')), false);
    writes++;
    return write.apply(this, args);
  });
  const tx = store.readRecords();
  tx.patchFields('lanes', lane.laneId, { assignment: 'changed synthetic header' });
  store.locked(() => store.commitRecords(tx));
  assert.ok(writes > 0, 'immutable cache pages are warm before the mutation receipt returns');
});

test('an error from an obsolete preparation retries before reporting a semantic conflict', async t => {
  const store = fixture(t),
    peer = new WorkStore(store.root);
  const { ForgeError } = await import('../dist/errors.js');
  let calls = 0;
  await retryWorkEdit(store, randomUUID(), data => {
    if (!calls++) {
      peer.locked(() => {
        const concurrent = peer.load();
        concurrent.otherExtension = 'retained';
        concurrent.revision++;
        peer.save(concurrent);
      });
      throw new ForgeError('WORK_STALE', 'obsolete binding observation');
    }
    data.extension = 'retry succeeded';
  });
  assert.equal(calls, 2);
  assert.equal(store.load().extension, 'retry succeeded');
  assert.equal(store.load().otherExtension, 'retained');
});

test('a prepared record pointer remains invisible until CAS and cannot replace a concurrent commit', t => {
  const store = fixture(t),
    peer = new WorkStore(store.root);
  const before = store.pointer(),
    tx = store.readRecords();
  tx.manifest.fields.extension = 'prepared';
  tx.manifest.keys.push('extension');
  store.prepareCommitRecords(tx);
  assert.deepEqual(store.pointer(), before);
  peer.locked(() => {
    const concurrent = peer.load();
    concurrent.otherExtension = 'retained';
    concurrent.revision++;
    peer.save(concurrent);
  });
  assert.throws(() => store.locked(() => store.commitRecords(tx, undefined, { prepared: true })), {
    code: 'WORK_STALE',
  });
  assert.equal(store.load().extension, undefined);
  assert.equal(store.load().otherExtension, 'retained');
});

test('prepared record publication commits its selected revision exactly once', t => {
  const store = fixture(t),
    tx = store.readRecords(),
    revision = tx.revision;
  tx.manifest.fields.extension = 'prepared';
  tx.manifest.keys.push('extension');
  store.prepareCommitRecords(tx);
  store.locked(() => store.commitRecords(tx, undefined, { prepared: true }));
  assert.equal(store.load().revision, revision + 1);
  assert.equal(store.load().extension, 'prepared');
});

test('changed prepared pointer bytes never replace committed Work', t => {
  const store = fixture(t),
    tx = store.readRecords(),
    before = store.pointer();
  tx.manifest.fields.extension = 'prepared';
  tx.manifest.keys.push('extension');
  store.prepareCommitRecords(tx);
  const temporary = readdirSync(store.directory).find(name => /^[a-f0-9-]{36}\.tmp$/.test(name));
  assert.ok(temporary);
  writeFileSync(join(store.directory, temporary), 'damaged synthetic pointer');
  assert.throws(() => store.locked(() => store.commitRecords(tx, undefined, { prepared: true })), {
    code: 'INVALID_WORK_STORE',
  });
  assert.deepEqual(store.pointer(), before);
});

test('tool publication fence detects replacement and earlier PATH shadowing without reading later candidates', async t => {
  const store = fixture(t);
  const { checkToolFence } = await import('../dist/check-tool-fence.js');
  const { delimiter } = await import('node:path');
  const first = join(store.root, 'first-bin'),
    second = join(store.root, 'second-bin');
  mkdirSync(first);
  mkdirSync(second);
  const chosen = join(second, 'synthetic-tool');
  writeFileSync(chosen, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const environment = { env: { PATH: [first, second].join(delimiter) } };
  const original = checkToolFence(['synthetic-tool'], environment);
  assert.equal(original(), true);
  const shadow = join(first, 'synthetic-tool');
  writeFileSync(shadow, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(original(), false);
  const current = checkToolFence(['synthetic-tool'], environment);
  writeFileSync(chosen, '#!/bin/sh\nexit 1\n');
  assert.equal(current(), true, 'a later PATH candidate cannot affect the resolved tool');
  writeFileSync(shadow, '#!/bin/sh\nexit 1\n');
  assert.equal(current(), false);
});

test('pending exchange capture racing preparation retries without losing its coverage', async t => {
  const store = fixture(t);
  const { capturePendingExchange, readPendingExchange } = await import('../dist/pending-exchange.js');
  const sequence = readPendingExchange(store.directory).sequence;
  let captured = false,
    attempts = 0;
  await retryWorkPhase(randomUUID(), () =>
    editWork(
      store,
      data => {
        attempts++;
        data.extension = 'retained';
      },
      () => {
        if (!captured) {
          captured = true;
          capturePendingExchange(store.directory, store.pointer());
        }
      },
    ),
  );
  const pending = readPendingExchange(store.directory);
  assert.equal(attempts, 2);
  assert.equal(pending.capturedThrough, sequence);
  assert.equal(pending.sequence, sequence + 1);
  assert.equal(store.load().extension, 'retained');
});

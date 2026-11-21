// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { getFunctionName } from 'convex/server';
import { v } from 'convex/values';
import { digest } from '../dist/hash.js';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { replayUrlSwitch } from './maintenance-online-url.mjs';

const { legacyBlob, legacyMetadata, tombstone } = await import(moduleUrl('../convex/legacyStorageRead.ts'));
const { blobStore } = await import(moduleUrl('../convex/blobStore.ts'));
const { internalMutation } = await import(moduleUrl('../convex/server.ts'));
const payload = Buffer.from('exact legacy bytes');
const mediaType = 'application/x-forge-fixture';
const pin = (storageId, projectId, bytes = payload) => ({
  storageId,
  digest: digest(bytes),
  size: bytes.length,
  copyKey: `v1/p/${projectId}/o/${digest(bytes)}`,
  operationId: 'synthetic-retirement',
  contentType: mediaType,
});

// The switch exists only in this fixture. There is no production writer for
// tombstones in the expand slice. The fixture transaction makes the old file
// removal and the row visible together and replays the same operation id.
async function switchFile(ctx, pin, verifiedBytes) {
  const existing = await tombstone._handler(ctx, { storageId: pin.storageId });
  if (existing?.operationId === pin.operationId) return false;
  if (!verifiedBytes || verifiedBytes.length !== pin.size || digest(verifiedBytes) !== pin.digest)
    return false;
  await ctx.db.insert('legacyStorageTombstones', pin);
  await ctx.storage.delete(pin.storageId);
  return true;
}

const ordinaryWrite = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    revision: v.number(),
    command: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, operationId, revision, command }) => {
    await ctx.db.insert('projectWorkEvents', {
      projectId,
      operationId,
      request: command,
      actor: 'synthetic',
      at: '2026-11-05T12:00:00Z',
      previousRevision: revision - 1,
      revision,
      command,
    });
    return null;
  },
});

async function fileFixture() {
  const f = state([]);
  const storageId = await f.ctx.storage.store(new Blob([payload], { type: mediaType }));
  const file = pin(storageId, 'project');
  const ctx = {
    storage: f.ctx.storage,
    runQuery(ref, args) {
      assert.equal(getFunctionName(ref), 'legacyStorageRead:tombstone');
      return tombstone._handler(f.ctx, args);
    },
  };
  return { f, file, ctx };
}

test('copy and replayed switch preserve ordinary write order and final rows at every insertion point', async () => {
  // This fixed schedule includes an unindexed legacy ID inside a Work body.
  const operations = ['save beta', 'save alpha', 'accept alpha', 'reference', 'accept beta'];
  const run = async positions => {
    const { f, file } = await fileFixture();
    let copy;
    const switched = [];
    for (let i = 0; i <= operations.length; i++) {
      if (positions?.[0] === i) copy = Buffer.from(payload);
      for (const position of positions?.slice(1) ?? [])
        if (position === i) switched.push(await f.transaction(() => switchFile(f.ctx, file, copy)));
      if (i === operations.length) break;
      const command = operations[i] === 'reference' ? `unindexed:${file.storageId}` : operations[i];
      assert.equal(
        await f.transaction(() =>
          ordinaryWrite._handler(f.ctx, {
            projectId: 'project',
            operationId: `write-${i}`,
            revision: i + 1,
            command,
          }),
        ),
        null,
        'ordinary writes commit with no refusal or retry time',
      );
    }
    assert.deepEqual(switched, positions ? [true, false] : []);
    assert.deepEqual(f.scheduled, [], 'no re-drive or retry is scheduled');
    return [...f.tables.projectWorkEvents.values()].map(({ _id, _creationTime, ...row }) => row);
  };
  const control = await run();
  for (let copy = 0; copy <= operations.length; copy++)
    for (let commit = copy; commit <= operations.length; commit++)
      for (let replay = commit; replay <= operations.length; replay++)
        assert.deepEqual(
          await run([copy, commit, replay]),
          control,
          `copy/switch/replay at ${copy}/${commit}/${replay}`,
        );
});

function* orders(steps) {
  if (!steps.length) {
    yield [];
    return;
  }
  for (const [i, step] of steps.entries())
    for (const tail of orders(steps.filter((_, j) => i !== j))) yield [step, ...tail];
}

test('both reads keep the original digest through every write and switch interleaving', async t => {
  const { objects, requests } = fakeSourceR2(t);
  const logs = t.mock.method(console, 'info', () => {});
  for (const order of orders(['reference', 'switch', 'read-1', 'read-2'])) {
    const { f, file, ctx } = await fileFixture();
    objects.set('/synthetic/' + file.copyKey, payload);
    let retired = false;
    for (const step of order) {
      if (step === 'reference')
        await f.transaction(() =>
          ordinaryWrite._handler(f.ctx, {
            projectId: 'project',
            operationId: 'reference',
            revision: 1,
            command: `unindexed:${file.storageId}`,
          }),
        );
      else if (step === 'switch') retired = await f.transaction(() => switchFile(f.ctx, file, payload));
      else {
        const getCount = requests.length,
          messageCount = logs.mock.callCount();
        const blob = await blobStore(ctx).get(file.storageId);
        assert.equal(blob.size, file.size, order.join(' '));
        assert.equal(digest(new Uint8Array(await blob.arrayBuffer())), file.digest);
        assert.equal(blob.type, mediaType);
        assert.equal(requests.length - getCount, Number(retired));
        assert.equal(logs.mock.callCount() - messageCount, Number(retired));
      }
    }
    assert(retired, 'switch committed');
    assert.equal([...f.tables.projectWorkEvents.values()][0].command, `unindexed:${file.storageId}`);
    assert.deepEqual(await legacyMetadata(f.ctx, file.storageId), {
      storageId: file.storageId,
      sha256: file.digest,
      size: file.size,
      contentType: mediaType,
    });
  }
  assert(requests.every(method => method === 'GET'));
  assert(
    logs.mock.calls.every(
      ({ arguments: args }) =>
        args[0] === 'legacy_storage_read_through' &&
        Object.keys(args[1]).sort().join(',') === 'operationId,storageId',
    ),
  );
});

test('a missing or changed retained copy never yields bytes, and a healthy native read never looks up a tombstone', async t => {
  const { objects, requests } = fakeSourceR2(t);
  t.mock.method(console, 'info', () => {});
  const { f, file, ctx } = await fileFixture();
  const native = { ...ctx, runQuery: () => assert.fail('healthy read performed a tombstone query') };
  assert.equal((await legacyBlob(native, file.storageId)).size, file.size);
  assert.equal((await legacyMetadata(native, file.storageId)).sha256, file.digest);
  assert.equal(requests.length, 0);
  assert.equal(await legacyBlob(ctx, 'unknown-file'), null);
  assert.equal(await legacyMetadata(ctx, 'unknown-file'), null);
  for (const bytes of [undefined, Buffer.alloc(file.size, 1)])
    assert.equal(await f.transaction(() => switchFile(f.ctx, file, bytes)), false);
  assert(f.files.has(file.storageId));
  assert.equal(f.tables.legacyStorageTombstones.size, 0);
  await f.transaction(() => switchFile(f.ctx, file, payload));
  await assert.rejects(legacyBlob(ctx, file.storageId), { code: 'R2_OBJECT_UNAVAILABLE' });
  for (const bytes of [Buffer.alloc(file.size, 1), payload.subarray(1), Buffer.concat([payload, payload])]) {
    objects.set('/synthetic/' + file.copyKey, bytes);
    await assert.rejects(legacyBlob(ctx, file.storageId), { code: 'BLOB_DIGEST_MISMATCH' });
  }
});

test('legacy URL reads use the native hit or resolve one exact tombstone in queries, mutations and actions', async t => {
  const { requests } = fakeSourceR2(t);
  const logs = t.mock.method(console, 'info', () => {});
  const { f, file, ctx } = await fileFixture();
  const reads = t.mock.method(f.ctx.db, 'query');
  const calls = t.mock.method(ctx, 'runQuery');
  const transactionCtx = { db: f.ctx.db, storage: f.ctx.storage };
  const readers = [
    id => blobStore(transactionCtx).getUrl(id),
    id => f.transaction(() => blobStore(transactionCtx).getUrl(id)),
    id => blobStore(ctx).getUrl(id),
  ];
  const native = await f.ctx.storage.getUrl(file.storageId);
  for (const read of readers) assert.equal(await read(file.storageId), native);
  assert.equal(reads.mock.callCount(), 0);
  assert.equal(calls.mock.callCount(), 0);
  for (const read of readers) assert.equal(await read('unknown-file'), null);
  assert.equal(reads.mock.callCount(), 3);
  assert.equal(calls.mock.callCount(), 1);
  assert.equal(logs.mock.callCount(), 0);

  await f.transaction(() => switchFile(f.ctx, file, payload));
  reads.mock.resetCalls();
  calls.mock.resetCalls();
  for (const read of readers) {
    const url = new URL(await read(file.storageId));
    assert.equal(url.origin, 'https://synthetic.r2.cloudflarestorage.com');
    assert.equal(url.pathname, '/synthetic/' + file.copyKey);
    assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
    assert.match(url.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
  }
  assert.equal(reads.mock.callCount(), 3);
  assert.equal(calls.mock.callCount(), 1);
  assert.deepEqual(requests, [], 'issuing a URL never fetches bytes');
  assert.deepEqual(
    logs.mock.calls.map(call => call.arguments),
    Array(3).fill([
      'legacy_storage_read_through',
      { storageId: file.storageId, operationId: file.operationId },
    ]),
  );
});

test('incident 779d17be: the 22-minute maintenance replay preserves every landing and its order', async t => {
  const before = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
  Object.assign(process.env, synthetic);
  t.after(() => {
    for (const [key, value] of Object.entries(before))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const outcomes = [];
  for (const online of [false, true])
    await t.test(online ? 'online maintenance' : 'control', async t => {
      const f = await batchesFixture(t, { count: 2, batching: false, requestCheck: true });
      // The second landing must recompose from its persisted Lane head after
      // the first moves main. Force that exact input through the legacy byte path.
      const input = f.entries[1].lane.head;
      const stateBytes = f.c.objects.get(input);
      const linked = pin(
        await f.sourceStorage.store(new Blob([stateBytes], { type: mediaType })),
        'project',
        stateBytes,
      );
      const row = [...f.tables.projectObjects.values()].find(row => row.digest === linked.digest);
      assert(row, 'the landing input has a source row');
      f.patch('projectObjects', row._id, {
        storageId: linked.storageId,
        location: undefined,
        r2Committed: undefined,
        r2Key: undefined,
      });
      const files = [linked];
      for (let i = 1; i < 16; i++)
        files.push(pin(await f.sourceStorage.store(new Blob([payload], { type: mediaType })), 'project'));
      const reads = t.mock.method(f.sourceStorage, 'get');
      const fetches = globalThis.fetch.mock;
      const logs = t.mock.method(console, 'info', () => {});
      const landed = [];
      let saved = false,
        windowEnd,
        switched = false,
        replayed = false;
      const page = () =>
        f.transaction(
          'online-switch-fixture',
          {
            _handler: async ctx => {
              const results = [];
              for (const file of files)
                results.push(await switchFile(ctx, file, f.c.objects.get(file.digest)));
              return results;
            },
          },
          {},
        );
      for (let tick = 0; landed.length < 3; tick++) {
        assert(tick < 250, 'every landing settles');
        for (const run of f.runs().filter(run => run.status === 'queued')) {
          const active = await f.rawChecks.activate(run.id);
          if (!saved) {
            if (online) windowEnd = f.now() + 22 * 60_000;
            await f.add(2);
            saved = true;
          }
          await f.rawChecks.pass(active);
        }
        if (online && !switched && states(f).some(state => state.phase === 'ready')) {
          assert(windowEnd, 'verified copies are retained before the switch');
          assert.deepEqual(await page(), Array(16).fill(true));
          switched = true;
        }
        const task = f.pending()[0];
        assert(task, 'scheduled progress remains while landings are unsettled');
        await f.execute(task);
        for (const state of states(f))
          if (state.phase === 'landed' && !landed.includes(state.sequence)) landed.push(state.sequence);
        if (online && switched && !replayed && landed.length) {
          assert(f.now() < windowEnd, 'a landing settled inside the maintenance window');
          assert.deepEqual(await page(), Array(16).fill(false));
          replayed = true;
        }
      }
      if (online) {
        assert(replayed, 'copy, switch and replay all ran while landings were active');
        assert.equal(f.tables.legacyStorageTombstones.size, 16);
        const fallback = logs.mock.calls.filter(
          ({ arguments: [event, ids] }) =>
            event === 'legacy_storage_read_through' && ids.storageId === linked.storageId,
        );
        assert(fallback.length > 0, 'the actual recompose fell through to the retired input');
        const getCount = fetches.calls.filter(
          ({ arguments: [url, init] }) =>
            new URL(url).pathname.endsWith('/o/' + linked.digest) && (init?.method ?? 'GET') === 'GET',
        ).length;
        assert.equal(getCount, fallback.length, 'one verified GET for each actual fallback');
        f.advanceClock(Math.max(0, windowEnd - f.now()));
      } else {
        assert(!logs.mock.calls.some(({ arguments: [event] }) => event === 'legacy_storage_read_through'));
        assert(!f.metrics.convexSourceCalls.includes('legacyStorageRead:tombstone'));
      }
      assert(
        reads.mock.calls.some(({ arguments: [id] }) => id === linked.storageId),
        'the actual recompose reads the native ID in both cases',
      );
      assert.deepEqual(
        states(f).map(state => state.phase),
        ['landed', 'landed', 'landed'],
      );
      assert(
        ![...f.tables._scheduled_functions.values()].some(
          task => task.state.kind === 'failed' || task.name.startsWith('projectHostedLandingRedrive:'),
        ),
        'maintenance caused zero refused tasks or landing re-drives',
      );
      const accepted = JSON.parse(f.c.objects.get(f.currentMain().head));
      assert(
        accepted.files.some(file => file.path === 'member-1'),
        'the re-composed Lane reached main',
      );
      outcomes.push({ landed, files: accepted.files });
    });
  assert.deepEqual(outcomes[0]?.landed, [1, 2, 3]);
  assert.deepEqual(outcomes[1], outcomes[0]);
  await t.test('an Actions URL reader reissues its grant after retirement and verifies the copy', t =>
    replayUrlSwitch(t, { payload, pin, switchFile }),
  );
});

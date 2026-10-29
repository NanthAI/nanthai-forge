// SPDX-License-Identifier: Apache-2.0
// Deterministic per-push storage accounting for hosted source return. A virtual
// clock charges every Convex call and storage transfer, so action time budgets
// end invocations as they would on a slow hosted worker, independent of this
// machine's speed. Storage bytes are counted at ctx.storage.get (Blob size).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { digest } from '../dist/hash.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { initNative } from '../dist/native-work.js';
import { fixture, preparedCheckpoint, modules } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const memo = existsSync(new URL('../convex/projectSourceReturnCursor.ts', import.meta.url))
  ? await import(moduleUrl('../convex/projectSourceReturnCursor.ts'))
  : {};

// Landings over a wide tree: every State lists `width` files, one changed per save.
function landWide(store, count, saves, width) {
  const data = store.load(),
    source = new NativeSource(store.root);
  const object = bytes => {
    const hash = digest(bytes),
      path = join(source.directory, hash);
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' });
    return hash;
  };
  const fixed = Array.from({ length: width }, (_, i) => ({
    path: `src/module-${String(i).padStart(4, '0')}.ts`,
    blob: object(Buffer.from(`export const value${i} = ${i};\n`)),
    mode: 'file',
  }));
  for (let n = 0; n < count; n++) {
    const base = data.channelMoves.at(-1)?.head ?? data.nativeHead;
    const intentId = randomUUID(),
      laneId = randomUUID(),
      viewId = randomUUID(),
      checkpoints = [];
    let head = base;
    for (let i = 0; i < saves; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + (data.lanes.length * 100 + i) * 1000).toISOString();
      const blob = object(Buffer.from(`export const a = ${data.lanes.length * 100 + i};\n`));
      const next = object(
        Buffer.from(
          JSON.stringify({
            schema: 1,
            kind: 'forge-source-state',
            parents: [head],
            files: [{ path: 'a.ts', blob, mode: 'file' }, ...fixed],
            message: 'Synthetic save',
            at,
          }),
        ),
      );
      checkpoints.push({ head: next, parent: head, message: 'Synthetic save', at });
      head = next;
    }
    const at = checkpoints.at(-1).at;
    data.intents.push({
      id: intentId,
      base,
      outcome: 'Synthetic landing',
      constraints: '',
      status: 'completed',
      createdAt: at,
      notes: [],
    });
    data.lanes.push({
      id: laneId,
      intentId,
      name: 'Synthetic',
      base,
      head,
      assignment: '',
      target: '',
      state: 'completed',
      checkpoints,
    });
    data.views.push({
      id: viewId,
      intentId,
      base,
      head,
      inputs: [{ laneId, head }],
      status: 'clean',
      details: 'Synthetic',
      at,
    });
    data.channelMoves.push({
      id: randomUUID(),
      channel: 'main',
      viewId,
      head,
      previous: base,
      at,
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    data.nativeHead = head;
    data.revision++;
  }
  store.save(data);
}

// Charges per Convex call and per transferred byte (10 MB/s), in virtual ms.
function virtualClock(s) {
  const now = Date.now;
  let virtual = now();
  Date.now = () => virtual;
  const charge = (ms, bytes = 0) => {
    virtual += ms + Math.ceil(bytes / 10_000);
  };
  for (const [method, ms] of [
    ['runQuery', 20],
    ['runMutation', 40],
    ['runAction', 500],
  ]) {
    const original = s.ctx[method];
    s.ctx[method] = async (ref, args) => {
      charge(ms);
      return original(ref, args);
    };
  }
  const store = s.ctx.storage.store;
  s.ctx.storage.store = async blob => {
    charge(50, blob.size);
    return store(blob);
  };
  return {
    charge,
    restore: () => {
      Date.now = now;
    },
  };
}

async function push(t, { cold }) {
  // The initial upload was never published or read. Keep fresh source hashes
  // for each warm/cold case so process-wide raw-byte caches cannot mask reads.
  const s = fixture(),
    root = mkdtempSync(join(tmpdir(), 'forge-return-egress-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  const first = { store: new WorkStore(root) };
  landWide(first.store, 25, 40, 300);
  const seed = await preparedCheckpoint(s, first.store);
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, seed.input);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  await index.ensure._handler(s.ctx, { projectId: 'project' });
  const revision = first.store.load().revision;
  landWide(first.store, 60, 4, 300);
  const next = await preparedCheckpoint(s, first.store);
  next.input.previous = backupId;
  const candidateId = await modules.projectExchangeActions.publish._handler(s.ctx, next.input);
  const input = {
    projectId: 'project',
    backupId: candidateId,
    expectedBackupId: backupId,
    revision,
    operationId: randomUUID(),
    continuation: true,
  };
  const objects = next.manifest.files.length;
  const clock = virtualClock(s);
  t.after(clock.restore);
  const counts = { invocations: 0, steps: 0, storageReads: 0, storageBytes: 0, cursorBytes: 0 };
  const cursors = new Set();
  const get = s.ctx.storage.get,
    store = s.ctx.storage.store,
    mutation = s.ctx.runMutation;
  s.ctx.storage.store = async blob => {
    const id = await store(blob);
    if (blob.type === 'application/json' || blob.type === 'application/gzip') cursors.add(id);
    return id;
  };
  s.ctx.storage.get = async id => {
    const blob = await get(id);
    if (blob) {
      counts.storageReads++;
      counts.storageBytes += blob.size;
      if (cursors.has(id)) counts.cursorBytes += blob.size;
      clock.charge(30, blob.size);
    }
    return blob;
  };
  s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectReturnIndexStage:batch') counts.steps++;
    return mutation(ref, args);
  };
  const log = console.log;
  console.log = () => {};
  let result;
  try {
    do {
      assert(counts.invocations++ < 5000, 'continuations terminate');
      if (cold) memo.forgetReturnCursors?.();
      result = await modules.projectSourceReturn.returnSource._handler(s.ctx, input);
    } while (result.pending);
  } finally {
    console.log = log;
  }
  assert.equal(result.revision, first.store.load().revision + 1);
  return { objects, ...counts, receipt: result };
}

// The same push before this accounting (3 s invocations, a plain JSON cursor and
// snapshot reread by every invocation, one diffstat stage per step):
// 30 invocations, 133 steps, 419 reads, 60,548,879 storage bytes of which
// 51,944,347 were cursor/snapshot bodies.
for (const cold of [false, true])
  test(`per-push source-return storage reads stay bounded (${cold ? 'cold' : 'warm'} workers)`, async t => {
    const measured = await push(t, { cold });
    const { receipt, ...row } = measured;
    console.log('SOURCE_RETURN_EGRESS', JSON.stringify({ cold, ...row, accounting: receipt.accounting }));
    assert.deepEqual(receipt.accounting, {
      storageReads: row.storageReads,
      storageBytes: row.storageBytes,
      steps: row.steps,
      invocations: row.invocations,
    });
    assert.ok(row.objects > 2000);
    assert.ok(row.invocations <= 5, `${row.invocations} invocations`);
    assert.ok(row.steps <= 60, `${row.steps} steps`);
    // Cursor/snapshot bodies: none on a warm worker, compressed once per cold invocation.
    if (cold) assert.ok(row.cursorBytes <= row.invocations * 400_000, `${row.cursorBytes} cursor bytes`);
    else assert.equal(row.cursorBytes, 0);
    assert.ok(row.storageBytes < 12_000_000, `${row.storageBytes} storage bytes`);
  });

test('cursor memo serves only bodies whose current storage metadata still matches', async () => {
  const s = fixture(),
    value = { phase: 'diffstats', rows: Array.from({ length: 500 }, (_, i) => `row-${i}`) };
  let reads = 0;
  const get = s.ctx.storage.get;
  s.ctx.storage.get = async id => {
    reads++;
    return get(id);
  };
  const id = await memo.storeReturnJson(s.ctx, value);
  assert.equal(s.files.get(id).blob.type, 'application/gzip');
  assert.ok(s.files.get(id).blob.size < JSON.stringify(value).length / 3);
  assert.deepEqual(await memo.readReturnJson(s.ctx, id, 'missing'), value);
  assert.equal(reads, 0, 'a warm worker reuses the body it stored');
  // Same ID, different bytes (only possible in fixtures): the metadata check rereads.
  s.files.get(id).metadata.sha256 = 'f'.repeat(64);
  await memo.readReturnJson(s.ctx, id, 'missing');
  assert.equal(reads, 1);
  memo.forgetReturnCursors();
  await memo.readReturnJson(s.ctx, id, 'missing');
  assert.equal(reads, 2, 'a cold worker reads storage');
  const legacy = await s.ctx.storage.store(new Blob([JSON.stringify(value)], { type: 'application/json' }));
  assert.deepEqual(await memo.readReturnJson(s.ctx, legacy, 'missing'), value);
  await memo.deleteReturnJson(s.ctx, id);
  await assert.rejects(memo.readReturnJson(s.ctx, id, 'missing'), e => e.code === 'WORK_STALE');
});

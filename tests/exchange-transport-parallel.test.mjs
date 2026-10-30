import { captureNativeArchive } from './native-archive-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { mapExchange } from '../dist/exchange-parallel.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { pullNativeExchange } from '../dist/native-exchange.js';
import { buildExchangeRoot, resolveExchangeRoot } from '../dist/native-exchange-tree.js';
import { WorkStore } from '../dist/work-store.js';
import { initNative } from '../dist/native-work.js';
import { digest } from '../dist/hash.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const pin = bytes => ({ sha256: digest(bytes), size: bytes.length });
function owner(t, files = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-transport-test-')),
    root = join(directory, 'owner');
  mkdirSync(root);
  for (let i = 0; i < files; i++) writeFileSync(join(root, `source-${i}.ts`), `export const value = ${i};\n`);
  initNative(root);
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { directory, root, store: new WorkStore(root) };
}

test('weighted scheduler bounds bytes and concurrency; oversized existing items run alone', async () => {
  const sizes = [4, 4, 4, 20, 4],
    gates = sizes.map(deferred),
    started = [];
  let active = 0,
    bytes = 0;
  const running = mapExchange(
    sizes,
    4,
    async (size, index) => {
      started.push(index);
      active++;
      bytes += size;
      assert(active <= 4);
      assert(bytes <= 8 || (active === 1 && size > 8));
      await gates[index].promise;
      active--;
      bytes -= size;
      return index;
    },
    { bytes: 8, size: value => value },
  );
  await tick();
  assert.deepEqual(started, [0, 1]);
  gates[0].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  gates[1].resolve();
  gates[2].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(active, 1);
  gates[3].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  gates[4].resolve();
  assert.deepEqual(await running, [0, 1, 2, 3, 4]);
});

test('failed scheduler drains active operations before rejection and starts no remaining jobs', async () => {
  const gates = [deferred(), deferred()],
    started = [];
  let finished = false;
  const result = mapExchange([0, 1, 2, 3], 2, async index => {
    started.push(index);
    await gates[index].promise;
    return index;
  }).then(
    () => assert.fail('must reject'),
    error => {
      finished = true;
      return error;
    },
  );
  await tick();
  gates[0].reject(new Error('original failure'));
  await tick();
  assert.equal(finished, false);
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve();
  assert.match((await result).message, /original failure/);
  assert.equal(finished, true);
});

test('manifest and Work tree traversal share one bounded reader and retain exact byte order', async () => {
  const work = Buffer.from(
    JSON.stringify({
      records: Array.from({ length: 500 }, (_, i) => ({ id: i, text: `${i}:` + 'retained'.repeat(160) })),
    }),
  );
  const head = 'a'.repeat(64),
    manifest = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-native-work-backup',
        id: randomUUID(),
        head,
        revision: 0,
        files: [
          { path: 'work.json', ...pin(work) },
          ...Array.from({ length: 1500 }, (_, i) => {
            const sha256 = digest(`source-${i}`);
            return { path: `objects/${sha256}`, sha256, size: 1 };
          }),
        ],
        unavailable: [],
        coverage: 'Synthetic exact metadata',
      }),
    );
  const built = buildExchangeRoot(manifest, work);
  let active = 0,
    peak = 0,
    calls = 0;
  const restored = await resolveExchangeRoot(built.bytes, async pins => {
    assert(pins.length <= 8);
    calls++;
    active++;
    peak = Math.max(peak, active);
    await tick();
    active--;
    return pins.map(p => built.objects.get(p.sha256));
  });
  assert(calls > 10);
  assert(peak > 1 && peak <= 4);
  assert.deepEqual(restored, { manifest, work });
  let pending = 0;
  await assert.rejects(
    resolveExchangeRoot(built.bytes, async pins => {
      pending++;
      try {
        await tick();
        return pins.map(p =>
          p.sha256 === built.root.work.tree.sha256 ? Buffer.from('bad') : built.objects.get(p.sha256),
        );
      } finally {
        pending--;
      }
    }),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
  assert.equal(pending, 0);
});

test('legacy and record exchange failures drain the other metadata traversal before rejecting', async t => {
  const { store } = owner(t),
    work = Buffer.from(JSON.stringify(store.load(), null, 2)),
    manifest = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-native-work-backup',
        id: randomUUID(),
        head: store.load().nativeHead,
        revision: store.load().revision,
        files: [{ path: 'work.json', ...pin(work) }],
        unavailable: [],
        coverage: 'Synthetic exact metadata',
      }),
    );
  for (const records of [false, true]) {
    const built = buildExchangeRoot(manifest, work, { records }),
      workTree = records ? built.root.records.tree : built.root.work.tree;
    for (const corrupt of [built.root.manifest.tree, workTree]) {
      await t.test(
        `schema ${built.root.schema}, corrupt ${corrupt === workTree ? 'Work' : 'manifest'}`,
        async () => {
          const gate = deferred();
          let pending = 0,
            settled = false;
          const result = resolveExchangeRoot(built.bytes, async pins => {
            pending++;
            try {
              if (!pins.some(p => p.sha256 === corrupt.sha256)) await gate.promise;
              return pins.map(p =>
                p.sha256 === corrupt.sha256 ? Buffer.from('bad') : built.objects.get(p.sha256),
              );
            } finally {
              pending--;
            }
          }).then(
            () => assert.fail('must reject corrupted metadata'),
            error => {
              settled = true;
              return error;
            },
          );
          try {
            await tick();
            assert.equal(pending, 1);
            assert.equal(settled, false, 'rejection waits for the other traversal');
          } finally {
            gate.resolve();
          }
          assert.equal((await result).code, 'INVALID_WORK_BACKUP');
          assert.equal(pending, 0);
        },
      );
    }
  }
});

test('ranged downloads overlap at four requests, assemble in offset order and drain auth failure', async () => {
  const client = new ConvexExchange('https://fixture.convex.cloud', 'fixture', 'project', 'operation', null),
    chunk = 2 * 1024 * 1024,
    bytes = Buffer.alloc(chunk * 6 + 31);
  for (let i = 0; i < bytes.length; i += chunk) bytes.fill(i / chunk, i, Math.min(i + chunk, bytes.length));
  const expected = pin(bytes);
  let active = 0,
    peak = 0;
  client.client.mutation = async () => []; // no R2 objects
  client.client.action = async (ref, args) => {
    assert.equal(getFunctionName(ref), 'projectExchangeActions:downloadPart');
    active++;
    peak = Math.max(peak, active);
    await tick();
    if (args.offset === 0) await tick();
    active--;
    return {
      data: bytes.subarray(args.offset, Math.min(args.offset + chunk, bytes.length)),
      digest: expected.sha256,
      size: bytes.length,
    };
  };
  assert.deepEqual(await client.download(expected), bytes);
  assert(peak > 1 && peak <= 4);
  const gates = Array.from({ length: 4 }, deferred);
  let calls = 0,
    settled = false;
  client.client.action = async (_ref, args) => {
    const i = calls++;
    await gates[i].promise;
    return {
      data: bytes.subarray(args.offset, args.offset + chunk),
      digest: expected.sha256,
      size: bytes.length,
    };
  };
  const failed = client.download(expected).then(
    () => assert.fail('must fail'),
    error => {
      settled = true;
      return error;
    },
  );
  await tick();
  assert.equal(calls, 4);
  gates[0].reject(new Error('current authority revoked'));
  await tick();
  assert.equal(settled, false);
  for (const gate of gates.slice(1)) gate.resolve();
  assert.match((await failed).message, /authority revoked/);
  assert.equal(calls, 4);
});

test('parallel pull drains active transfers before removing failed staging and never creates an owner', async t => {
  const { directory, store } = owner(t),
    target = join(directory, 'restored'),
    payloads = Array.from({ length: 24 }, (_, i) => Buffer.from(`source${i}`)),
    head = pin(payloads[0]).sha256,
    work = Buffer.from(JSON.stringify(store.load()));
  const manifest = {
      schema: 1,
      kind: 'forge-native-work-backup',
      id: randomUUID(),
      head,
      revision: 0,
      files: [
        { path: 'work.json', ...pin(work) },
        ...payloads.map(bytes => ({ path: `objects/${pin(bytes).sha256}`, ...pin(bytes) })),
      ],
      unavailable: [],
      coverage: 'Synthetic failed transfer',
    },
    json = JSON.stringify(manifest),
    gates = [deferred(), deferred()];
  let calls = 0,
    active = 0,
    finished = false;
  const tr = {
    manifest: async () => ({ json, digest: digest(json), size: Buffer.byteLength(json) }),
    download: async value => {
      assert.equal(value.sha256, pin(work).sha256);
      return work;
    },
    downloadBatch: async pins => {
      const index = calls++;
      active++;
      try {
        await gates[index].promise;
        return pins.map(p => payloads.find(bytes => pin(bytes).sha256 === p.sha256));
      } finally {
        active--;
      }
    },
  };
  const result = pullNativeExchange('backup', target, tr).then(
    () => assert.fail('must fail'),
    error => {
      finished = true;
      assert.equal(active, 0);
      return error;
    },
  );
  await tick();
  assert.equal(calls, 2);
  gates[0].reject(new Error('download interrupted'));
  await tick();
  assert.equal(finished, false);
  gates[1].resolve();
  assert.match((await result).message, /download interrupted/);
  assert.equal(calls, 2);
  assert.equal(existsSync(target), false);
});

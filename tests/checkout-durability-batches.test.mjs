// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { visitCheckoutFiles, withCheckoutFileBatch } from '../dist/checkout-file-batch.js';
import { flushCheckoutPaths } from '../dist/checkout-durability.js';
import { withCheckoutMaterialization, materializationDirectory } from '../dist/checkout-materialization.js';
import { checkoutIo, checkoutIoCapacity, checkoutVolumeCapacity } from '../dist/checkout-io.js';
import { queueEntries } from '../dist/check-queue.js';
import syncFs from 'node:fs';
import { dirname } from 'node:path';

test('the final copy turn retains its barrier before a queued peer dirties the volume', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-copy-barrier-turn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'source'),
    events = [];
  let ready, release;
  const entered = new Promise(r => (ready = r)),
    held = new Promise(r => (release = r));
  t.signal.addEventListener('abort', () => release(), { once: true });
  const owner = withCheckoutMaterialization(root, () =>
    withCheckoutFileBatch(root, async () => {
      await visitCheckoutFiles(root, 'copy', [path], async (path, io) =>
        io(async () => {
          ready();
          await held;
          writeFileSync(path, 'source');
          events.push('copy');
        }),
      );
      await flushCheckoutPaths(root, [path]);
      events.push('durable');
    }),
  );
  await entered;
  const peer = withCheckoutFileBatch(root, async () => events.push('peer'));
  release();
  await Promise.all([owner, peer]);
  assert.deepEqual(events, ['copy', 'durable', 'peer']);
});

test(
  'equal-sized prepared copies retain transaction locality while keeping FIFO order',
  { timeout: 10000 },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'forge-equal-copy-turn-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const count = Math.min(checkoutIoCapacity(), checkoutVolumeCapacity()) * 180;
    let ready,
      complete = false;
    const entered = new Promise(r => (ready = r));
    const owner = withCheckoutMaterialization(root, () =>
      withCheckoutFileBatch(
        root,
        async () => {
          await visitCheckoutFiles(root, 'copy', Array.from({ length: count }), async (_, io) =>
            io(async () => {
              ready();
              await new Promise(r => setTimeout(r, 8));
            }),
          );
          complete = true;
        },
        count,
      ),
    );
    await entered;
    const peer = withCheckoutFileBatch(
      root,
      async () => assert(complete, 'equal work must not force another dirty copy round'),
      count,
    );
    await Promise.all([owner, peer]);
  },
);

test('an uncontended traversal does not write a new coordination ticket per directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-durability-admissions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = Array.from({ length: 64 }, (_, i) => {
    const directory = join(root, String(i));
    mkdirSync(directory);
    const path = join(directory, 'source');
    writeFileSync(path, 'source', { mode: 0o600 });
    return path;
  });
  const namespace = `${materializationDirectory(root)}.writes`,
    original = syncFs.mkdirSync;
  let tickets = 0;
  syncFs.mkdirSync = (path, ...args) => {
    if (dirname(String(path)) === namespace) tickets++;
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    syncFs.mkdirSync = original;
    syncBuiltinESMExports();
  });
  await withCheckoutMaterialization(root, () => flushCheckoutPaths(root, paths));
  assert.equal(tickets, 1, 'directory count must not manufacture fsync-visible admission writes');
});

test(
  'a large directory yields its durability traversal to an older peer without overlapping traversals',
  {
    timeout: 10000,
  },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'forge-durability-batches-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'large'));
    mkdirSync(join(root, 'peer'));
    const workers = Math.min(checkoutIoCapacity(), checkoutVolumeCapacity());
    const paths = Array.from({ length: workers * 64 }, (_, i) => join(root, 'large', String(i)));
    const peer = join(root, 'peer', 'one');
    for (const path of [...paths, peer]) writeFileSync(path, 'source', { mode: 0o600 });
    const original = fs.open,
      active = new Map();
    const namespace = `${materializationDirectory(root)}.writes`,
      originalMkdir = syncFs.mkdirSync;
    let tickets = 0;
    syncFs.mkdirSync = (path, ...args) => {
      if (dirname(String(path)) === namespace) tickets++;
      return originalMkdir(path, ...args);
    };
    let ready,
      complete = false,
      opened = 0,
      closed = 0,
      peakDescriptors = 0,
      firstBarrierAt;
    const entered = new Promise(r => (ready = r));
    t.after(() => {
      fs.open = original;
      syncFs.mkdirSync = originalMkdir;
      syncBuiltinESMExports();
    });
    fs.open = async (...args) => {
      const handle = await original(...args),
        sync = handle.sync.bind(handle),
        close = handle.close.bind(handle);
      const kind = String(args[0]).includes('/large/') ? 'large' : 'peer';
      opened++;
      peakDescriptors = Math.max(peakDescriptors, opened - closed);
      handle.sync = async () => {
        active.set(kind, (active.get(kind) || 0) + 1);
        assert.equal(
          [...active.values()].filter(n => n > 0).length,
          1,
          'directory traversals must not interleave',
        );
        if (kind === 'large') {
          firstBarrierAt ??= performance.now();
          ready();
        } else
          assert(
            performance.now() - firstBarrierAt >= 900,
            'waiting for a copy phase must not consume the barrier service quantum',
          );
        try {
          await new Promise(r => setTimeout(r, kind === 'large' ? 30 : 1));
          await sync();
        } finally {
          active.set(kind, active.get(kind) - 1);
        }
      };
      handle.close = async () => {
        await close();
        closed++;
      };
      return handle;
    };
    syncBuiltinESMExports();
    let releaseCopy, copyReady;
    const copyGate = new Promise(r => (releaseCopy = r)),
      copyingReady = new Promise(r => (copyReady = r));
    const copying = withCheckoutMaterialization(root, () =>
      checkoutIo(async () => {
        copyReady();
        await copyGate;
      }),
    );
    await copyingReady;
    const large = withCheckoutMaterialization(root, () => flushCheckoutPaths(root, paths)).then(
      () => (complete = true),
    );
    await new Promise(r => setImmediate(r));
    const small = withCheckoutMaterialization(root, () =>
      withCheckoutFileBatch(root, () => flushCheckoutPaths(root, [peer])),
    );
    await new Promise(r => setTimeout(r, 1100));
    releaseCopy();
    await entered;
    try {
      await small;
      assert.equal(complete, false, 'a continuing directory cannot starve a queued peer');
    } finally {
      releaseCopy();
      await Promise.all([copying, large]);
    }
    assert.equal(tickets, 2, 'finite turns must reuse their original tickets');
    assert.equal(opened, paths.length + 1);
    assert.equal(closed, opened);
    assert(peakDescriptors <= 16);
    assert.deepEqual(queueEntries(`${materializationDirectory(root)}.writes`), []);
  },
);

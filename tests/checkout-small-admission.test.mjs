// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { CheckQueue, queueEntries } from '../dist/check-queue.js';
import { checkoutIo, checkoutVolumeCapacity } from '../dist/checkout-io.js';
import {
  withCheckoutMaterialization,
  withCheckoutWritePass,
  materializationDirectory,
} from '../dist/checkout-materialization.js';
import { HostedCheckoutCache } from '../dist/hosted-checkout-cache.js';
import { digest } from '../dist/hash.js';
import { smallCheckout, smallCheckoutBytes, smallCheckoutFiles } from '../dist/checkout-workload.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-small-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('both file count and logical bytes must fit the small-tree boundary', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'blob'), Buffer.alloc(4096));
  assert.equal(smallCheckout([], root), true);
  assert.equal(smallCheckout(Array(smallCheckoutFiles).fill({ blob: 'blob' }), root), true);
  assert.equal(smallCheckout(Array(smallCheckoutFiles + 1).fill({ blob: 'blob' }), root), false);
  writeFileSync(join(root, 'large'), Buffer.alloc(smallCheckoutBytes + 1));
  assert.equal(smallCheckout([{ blob: 'large' }], root), false);
  // Duplicate blobs are counted per installed inode, not once per digest.
  writeFileSync(join(root, 'medium'), Buffer.alloc(smallCheckoutBytes / 2));
  assert.equal(smallCheckout(Array(2).fill({ blob: 'medium' }), root), true);
  assert.equal(smallCheckout(Array(3).fill({ blob: 'medium' }), root), false);
});

for (const cooperative of [true, false])
  test(
    `${cooperative ? 'large' : 'small'} copy progresses beside a durability holder without bypassing capacity`,
    { timeout: 10000 },
    async t => {
      const root = fixture(t),
        directory = join(root, 'queue');
      let entered, release;
      const ready = new Promise(r => {
          entered = r;
        }),
        held = new Promise(r => {
          release = r;
        });
      const large = withCheckoutMaterialization(
        root,
        () =>
          checkoutIo(async () => {
            entered();
            await held;
          }, 'durability'),
        { directory },
      );
      await ready;
      try {
        if (checkoutVolumeCapacity() > 1) {
          await withCheckoutMaterialization(
            root,
            () =>
              checkoutIo(async () => {
                const holders = queueEntries(directory).filter(entry => entry.ticket?.holding);
                assert(holders.some(entry => entry.ticket.phase === 'durability'));
                assert(holders.some(entry => entry.ticket.phase === (cooperative ? 'copy' : 'shared')));
                assert(holders.length <= checkoutVolumeCapacity());
              }),
            { directory, cooperative: () => cooperative },
          );
        }
      } finally {
        release();
        await large;
      }
      assert.deepEqual(queueEntries(directory), []);
    },
  );

for (const kind of ['worker', 'write'])
  for (const event of ['cancelled', 'removed']) {
    test(
      `${kind}: a ${event} waiting ticket fails clearly and releases its other tickets`,
      { timeout: 10000 },
      async t => {
        const root = fixture(t),
          directory = join(root, 'queue');
        const blockedDirectory = directory;
        const holder = new CheckQueue(blockedDirectory, { limit: 1, serializeAdmission: false });
        assert(holder.tryAcquire());
        let ran = false;
        const pending =
          kind === 'write'
            ? withCheckoutWritePass(
                root,
                async () => {
                  ran = true;
                },
                { directory },
              )
            : withCheckoutMaterialization(
                root,
                () =>
                  checkoutIo(async () => {
                    ran = true;
                  }),
                { directory },
              );
        const rejected = assert.rejects(pending, {
          code: event === 'cancelled' ? 'CHECKOUT_QUEUE_CANCELLED' : 'CHECKOUT_QUEUE_LOST',
        });
        try {
          const waiter = queueEntries(blockedDirectory).find(entry => entry.path !== holder.path);
          assert(waiter, 'test must invalidate a published waiting ticket');
          if (event === 'cancelled') writeFileSync(join(waiter.path, 'cancel'), '');
          else rmSync(waiter.path, { recursive: true });
          await rejected;
          assert.equal(ran, false);
        } finally {
          holder.release();
        }
        assert.deepEqual(queueEntries(directory), []);
        assert.deepEqual(queueEntries(`${directory}.phase-gate`), []);
      },
    );
  }

test(
  'a continuously producing open yields to an older waiter at the shared capacity',
  { timeout: 10000 },
  async t => {
    const root = fixture(t),
      directory = join(root, 'queue');
    const original = os.availableParallelism;
    os.availableParallelism = () => 1;
    syncBuiltinESMExports();
    let entered,
      stop = false;
    const ready = new Promise(r => {
      entered = r;
    });
    const producer = withCheckoutMaterialization(
      root,
      async () => {
        while (!stop)
          await checkoutIo(async () => {
            entered();
            await delay(5);
          });
      },
      { directory, cooperative: () => false },
    );
    await ready;
    try {
      await withCheckoutMaterialization(
        root,
        () =>
          checkoutIo(async () => {
            assert.equal(queueEntries(directory).filter(entry => entry.ticket?.holding).length, 1);
            stop = true;
          }, 'durability'),
        { directory },
      );
    } finally {
      stop = true;
      await producer;
      os.availableParallelism = original;
      syncBuiltinESMExports();
    }
    assert.deepEqual(queueEntries(directory), []);
  },
);

test(
  'private cache download fsync remains independent of an editing write pass',
  { timeout: 10000 },
  async t => {
    const root = fixture(t),
      bytes = Buffer.from('synthetic cold cache object'),
      id = digest(bytes);
    const holder = new CheckQueue(`${materializationDirectory(root)}.writes`, {
      limit: 1,
      serializeAdmission: false,
    });
    assert(holder.tryAcquire());
    const calls = { objects: 0, downloads: 0 };
    const cache = new HostedCheckoutCache(
      join(root, 'cache'),
      {
        objects: async ids => {
          calls.objects++;
          assert.deepEqual(ids, [id]);
          return [{ sha256: id, size: bytes.length }];
        },
        downloadToFile: async (pin, path) => {
          calls.downloads++;
          writeFileSync(path, bytes);
        },
      },
      undefined,
      null,
    );
    try {
      await withCheckoutMaterialization(root, () => cache.ensure([id]));
      assert.deepEqual(calls, { objects: 1, downloads: 1 });
      assert.equal(cache.downloadedBytes, bytes.length);
    } finally {
      holder.release();
    }
  },
);

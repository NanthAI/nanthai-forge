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
import { aheadOf, runDownloadWindows } from '../dist/checkout-download-schedule.js';
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

test('download windows start heavy groups at once in their own windows, stay bounded, and settle every window on failure', async () => {
  const pin = (name, size = 1) => ({ sha256: name, size });
  async function* pages(list) {
    for (const groups of list) {
      await delay(1);
      yield groups;
    }
  }
  const order = [],
    active = { heavy: 0, light: 0 },
    peak = { heavy: 0, light: 0 };
  let lightBusyAtBig = 0;
  await runDownloadWindows(
    pages([
      [[pin('a')], [pin('b')], [pin('c')]],
      [
        [pin('d')],
        [pin('big', 3 * 1024 * 1024)],
        [pin('big2', 3 * 1024 * 1024)],
        [pin('big3', 3 * 1024 * 1024)],
      ],
    ]),
    2,
    async group => {
      const kind = group[0].size > 2 * 1024 * 1024 ? 'heavy' : 'light';
      order.push(group[0].sha256);
      if (group[0].sha256 === 'big') lightBusyAtBig = active.light;
      peak[kind] = Math.max(peak[kind], ++active[kind]);
      await delay(10);
      active[kind]--;
    },
  );
  assert.deepEqual(peak, { heavy: 2, light: 2 }, 'each kind has its own bounded windows');
  assert.equal(lightBusyAtBig, 2, 'a later page’s large group starts while both small windows still run');
  assert.ok(order.indexOf('big') < order.indexOf('c'), 'it never waits behind queued small groups');
  assert.deepEqual([...order].sort(), ['a', 'b', 'big', 'big2', 'big3', 'c', 'd']);

  // Pages wait while too many pins are held; the first failure throws only after all settle.
  let settled = 0,
    pulled = 0;
  const failing = (async function* () {
    for (let i = 0; i < 20; i++) {
      pulled++;
      yield [[pin(`f${i}`)]];
    }
  })();
  await assert.rejects(
    runDownloadWindows(
      failing,
      2,
      async group => {
        await delay(group[0].sha256 === 'f0' ? 1 : 10);
        settled++;
        if (group[0].sha256 === 'f0') throw new Error('window failed');
      },
      2,
    ),
    /window failed/,
  );
  assert.ok(pulled < 20, 'no page is described past a failure');
  assert.equal(settled, pulled > 1 ? 2 : 1, 'every started window settled before the failure surfaced');

  // aheadOf keeps `depth` later calls in flight, in order, and surfaces a failure at its own item.
  const started = [];
  const seen = [];
  await assert.rejects(async () => {
    for await (const [item, value] of aheadOf([1, 2, 3, 4], 2, async item => {
      started.push(item);
      if (item === 3) throw new Error('describe 3 failed');
      return item * 10;
    })) {
      seen.push([item, value, started.length]);
    }
  }, /describe 3 failed/);
  assert.deepEqual(seen, [
    [1, 10, 3],
    [2, 20, 4],
  ]);
});

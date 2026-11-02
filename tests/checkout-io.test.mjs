// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkoutIo,
  mapCheckoutIo,
  checkoutIoCapacity,
  checkoutVolumeCapacity,
} from '../dist/checkout-io.js';
import { withCheckoutMaterialization } from '../dist/checkout-materialization.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('all concurrent phase maps share the runtime I/O capacity and drain on failure', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-io-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const withCheckoutIo = run =>
    withCheckoutMaterialization(directory, run, { directory: join(directory, 'queue') });
  const previous = process.env.UV_THREADPOOL_SIZE;
  process.env.UV_THREADPOOL_SIZE = '4';
  let active = 0,
    peak = 0,
    finished = 0;
  const failure = Error('synthetic file barrier failure');
  try {
    assert.equal(checkoutIoCapacity(), 4);
    const results = await withCheckoutIo(() =>
      Promise.allSettled(
        ['cache', 'copy', 'file-flush', 'directory-flush'].map(phase =>
          mapCheckoutIo(
            Array.from({ length: 28 }, (_, i) => i),
            async i => {
              active++;
              peak = Math.max(peak, active);
              try {
                await new Promise(r => setImmediate(r));
                if (phase === 'file-flush' && i === 0) throw failure;
              } finally {
                active--;
                finished++;
              }
            },
          ),
        ),
      ),
    );
    assert.equal(peak, Math.min(4, checkoutVolumeCapacity()));
    assert.equal(active, 0);
    assert(finished >= 85 && finished <= 112);
    assert.equal(results[2].status, 'rejected');
    assert.equal(results[2].reason, failure);
    for (const i of [0, 1, 3]) assert.equal(results[i].status, 'fulfilled');
    assert.equal(await withCheckoutIo(() => checkoutIo(async () => 42)), 42);
    process.env.UV_THREADPOOL_SIZE = '2';
    assert.equal(checkoutIoCapacity(), 2);
    delete process.env.UV_THREADPOOL_SIZE;
    assert.equal(checkoutIoCapacity(), 4);
  } finally {
    if (previous === undefined) delete process.env.UV_THREADPOOL_SIZE;
    else process.env.UV_THREADPOOL_SIZE = previous;
  }
});

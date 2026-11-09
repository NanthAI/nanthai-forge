// SPDX-License-Identifier: Apache-2.0
import syncFs, { readFileSync, appendFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { queueEntries } from '../../dist/check-queue.js';
import assert from 'node:assert/strict';
import { checkoutIo, checkoutVolumeCapacity } from '../../dist/checkout-io.js';
import { withCheckoutMaterialization, withCheckoutWritePass, materializationDirectory } from '../../dist/checkout-materialization.js';
import { checkoutHostedLane } from '../../dist/hosted-lane-checkout.js';
const [mode, directory, count] = process.argv.slice(2);
if (mode === 'writes') {
  await withCheckoutWritePass(directory, async () => {
    appendFileSync(join(directory, 'events'), `${process.hrtime.bigint()} 1\n`);
    await new Promise(resolve => setTimeout(resolve, 20));
    appendFileSync(join(directory, 'events'), `${process.hrtime.bigint()} -1\n`);
  }, { directory: join(directory, 'queue') });
} else if (mode === 'queue' || mode === 'queue-shared') {
  await Promise.all(Array.from({ length: Number(count) }, (_, index) =>
    withCheckoutMaterialization(directory, () => checkoutIo(async () => {
      appendFileSync(join(directory, 'events'), `${process.hrtime.bigint()} 1 ${index % 2 ? "durability" : "copy"}\n`);
      await new Promise(resolve => setTimeout(resolve, 20));
      appendFileSync(join(directory, 'events'), `${process.hrtime.bigint()} -1 ${index % 2 ? "durability" : "copy"}\n`);
    }, index % 2 ? 'durability' : 'copy'), { directory: join(directory, 'queue'), cooperative: () => mode !== 'queue-shared' }),
  ));
} else {
  const { request, selection } = JSON.parse(readFileSync(join(directory, 'request.json')));
  const calls = { select: 0, objects: 0, downloads: 0 };
  // Regression guard on the real checkout, not only the scheduling helper:
  // cache hashes, clones and all asynchronous fsync descriptors require its lease.
  const assertLease = path => {
    if (!String(path).includes('/objects/') && !String(path).includes('/checkout-')) return;
    const entries = queueEntries(materializationDirectory(directory));
    assert(entries.filter(e => e.ticket?.holding).length <= checkoutVolumeCapacity());
    assert(entries.some(e => e.pid === process.pid && e.ticket?.holding), 'checkout I/O escaped its volume budget');
  };
  const openSync = syncFs.openSync, copyFile = fs.copyFile, open = fs.open;
  syncFs.openSync = (...args) => { assertLease(args[0]); return openSync(...args); };
  fs.copyFile = async (...args) => { assertLease(args[0]); assertLease(args[1]); return copyFile(...args); };
  fs.open = async (...args) => { assertLease(args[0]); return open(...args); };
  syncBuiltinESMExports();
  if (mode === 'crash') {
    // Whole-tree checkouts publish without a per-file fsync (fea47345 round 3): the crash lands while
    // the private stage is being written, holding its I/O ticket, before its marker exists.
    const original = fs.copyFile;
    let paused = false;
    fs.copyFile = async (...args) => {
      if (!paused && String(args[1]).includes('/checkout-')) {
        paused = true;
        process.on('message', () => {});
        process.send({ barrier: true });
        await new Promise(() => {});
      }
      return original(...args);
    };
    syncBuiltinESMExports();
  }
  const result = await checkoutHostedLane(join(directory, 'client'), request, {
    select: async () => { calls.select++; return selection; },
    objects: async () => { throw Error('unexpected metadata call'); },
    downloadToFile: async () => { throw Error('unexpected object download'); },
  });
  process.send?.({ result, calls });
}
process.disconnect?.();

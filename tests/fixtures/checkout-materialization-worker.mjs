// SPDX-License-Identifier: Apache-2.0
import { readFileSync, appendFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { withCheckoutMaterialization } from '../../dist/checkout-materialization.js';
import { checkoutHostedLane } from '../../dist/hosted-lane-checkout.js';
const [mode, directory, count] = process.argv.slice(2);
if (mode === 'queue') {
  await Promise.all(Array.from({ length: Number(count) }, () =>
    withCheckoutMaterialization(directory, async () => {
      appendFileSync(join(directory, 'events'), `${process.hrtime.bigint()} 1\n`);
      await new Promise(resolve => setTimeout(resolve, 20));
      appendFileSync(join(directory, 'events'), `${process.hrtime.bigint()} -1\n`);
    }, { directory: join(directory, 'queue'), slots: 3 }),
  ));
} else {
  const { request, selection } = JSON.parse(readFileSync(join(directory, 'request.json')));
  const calls = { select: 0, objects: 0, downloads: 0 };
  if (mode === 'crash') {
    const original = fs.open;
    let paused = false;
    fs.open = async (...args) => {
      const handle = await original(...args);
      if (!paused && String(args[0]).includes('/checkout-')) {
        paused = true;
        handle.sync = async () => {
          process.on('message', () => {});
          process.send({ barrier: true });
          await new Promise(() => {});
        };
      }
      return handle;
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

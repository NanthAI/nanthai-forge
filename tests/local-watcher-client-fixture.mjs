// SPDX-License-Identifier: Apache-2.0
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { watchLocal, watcherRuntime } from '../dist/local-watcher.js';
const scopes = [];
const create = watcherRuntime.createWorker;
watcherRuntime.createWorker = directory => {
  scopes.push(directory);
  return create(directory);
};
const missing = watchLocal(join(process.argv[2], 'not-created-yet'), {}, () => {});
const watcher = watchLocal(process.argv[2], { recursive: true }, (event, name) => {
  if (process.connected) process.send({ event, name });
});
if (process.argv[3] === '--hold-handshake') {
  queueMicrotask(async () => {
    const prefix = process.argv[4];
    writeFileSync(prefix + '.ready', '');
    const deadline = Date.now() + 10000;
    while (!existsSync(prefix + '.release') && Date.now() < deadline)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    await Promise.all([watcher.close(), missing.close()]);
    process.exit(0);
  });
}
const health = await watcher.probe();
const missingHealth = await missing.probe();
process.send?.({ health, missingHealth, scopes });
process.on('message', async message => {
  if (message === 'close') {
    await Promise.all([watcher.close(), missing.close()]);
    process.exit(0);
  }
});

// SPDX-License-Identifier: Apache-2.0
// Synthetic owner that remains busy; no provider or real owner is contacted.
import { WorkStore } from '../dist/work-store.js';
import { ForgeError } from '../dist/errors.js';
import { workLocked } from '../dist/work-lock.js';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
WorkStore.prototype.readRecords = () => undefined;
WorkStore.prototype.revision = () => 1;
WorkStore.prototype.load = () => ({
  revision: 1,
  channelMoves: [],
  checks: [],
  intents: [],
  views: [],
  lanes: [],
  runs: [{ id: 'synthetic-running', status: 'running', mainCheck: { channel: 'main' } }],
});
WorkStore.prototype.observing = run => run();
WorkStore.prototype.locked = function (run) {
  process.send?.('contended');
  return workLocked(join(this.directory, 'synthetic-busy-lock'), run);
};
// An unrelated open socket/timer must not keep a completed shutdown alive.
setInterval(() => {}, 60_000);
setImmediate(() => process.send?.('ready'));
// Give presence a busy callback too; it inherits the worker's nonblocking context.
WorkStore.prototype.select = () => {
  throw new ForgeError('WORK_BUSY', 'Synthetic owner is busy');
};

const entry = resolve(`dist/${process.argv[3]}.js`);
process.argv[1] = entry;
process.argv.length = 3;
await import(`${pathToFileURL(entry).href}?shutdown-test`);

// SPDX-License-Identifier: Apache-2.0
import { mock } from 'node:test';
import { realpathSync } from 'node:fs';
import { watcherRuntime } from '../dist/local-watcher.js';
import { FakeWatchWorker } from './local-watcher-fixture.mjs';
const controlledDate = !!process.env.FORGE_TEST_CONTROL_DATE;
const workers = [];

// Queue ownership and landing-idle are not native watcher readiness. A helper
// may still be electing itself and writing its lease after those observations.
const create = watcherRuntime.createWorker;
watcherRuntime.createWorker = directory => {
  // Idle guard behavior is independent of native probe health. The real
  // notification path has separate presence/shared-watcher integration tests.
  const worker = controlledDate ? new FakeWatchWorker() : create(directory);
  workers.push(worker);
  const healthy = new Set();
  let ready = false;
  worker.on('message', message => {
    if (message.type === 'event' && message.name === 'edit.txt') process.send({ edited: true });
    if (message.type === 'healthy') {
      healthy.add(message.id);
      // This fixture has owner, Lane and landing subscriptions on one helper.
      if (healthy.size === 3 && !ready) {
        ready = true;
        process.send({ watching: true });
      }
    }
  });
  return worker;
};

// Preload in the real presence-worker entrypoint. Native filesystem notifications and startup stay
// real in deletion cases; idle cases inject hints independently of native probe health.
// Interval callbacks wait for an explicit observation stage. The acknowledgement means every
// callback due in that stage ran, regardless of how long the CI scheduler paused this process.
mock.timers.enable({
  apis: ['setInterval', ...(controlledDate ? ['Date'] : [])],
  now: Date.now(),
});
process.on('message', ({ ms, now, editPath }) => {
  if (editPath) {
    for (const worker of workers) worker.event?.('edit.txt', 'change', realpathSync(editPath));
    return;
  }
  if (now !== undefined) mock.timers.setTime(now);
  mock.timers.tick(ms);
  process.send({ advanced: ms });
});

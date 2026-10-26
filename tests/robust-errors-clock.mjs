// SPDX-License-Identifier: Apache-2.0
import { mock } from 'node:test';
import { watcherRuntime } from '../dist/local-watcher.js';

// Queue ownership and landing-idle are not native watcher readiness. A helper
// may still be electing itself and writing its lease after those observations.
const create = watcherRuntime.createWorker;
watcherRuntime.createWorker = directory => {
  const worker = create(directory);
  const healthy = new Set();
  let ready = false;
  worker.on('message', message => {
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
// real; only interval callbacks wait for an explicit deletion stage. The acknowledgement means every
// callback due in that stage ran, regardless of how long the CI scheduler paused this process.
mock.timers.enable({ apis: ['setInterval'] });
process.on('message', ({ ms }) => {
  mock.timers.tick(ms);
  process.send({ advanced: ms });
});

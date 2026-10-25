// SPDX-License-Identifier: Apache-2.0
import { mock } from 'node:test';

// Preload in the real presence-worker entrypoint. Native filesystem notifications and startup stay
// real; only interval callbacks wait for an explicit deletion stage. The acknowledgement means every
// callback due in that stage ran, regardless of how long the CI scheduler paused this process.
mock.timers.enable({ apis: ['setInterval'] });
process.on('message', ({ ms }) => {
  mock.timers.tick(ms);
  process.send({ advanced: ms });
});

// SPDX-License-Identifier: Apache-2.0
import { runCheckController } from './check-controller.js';
import { WorkStore } from './work-store.js';

// Keep the executable separate: awaiting execution in the reusable module would
// deadlock its dynamic import of work-run (which also imports that module).
const keepAlive = setInterval(() => undefined, 60_000);
try {
  if (process.argv[2] && process.argv[3])
    await runCheckController(new WorkStore(process.argv[2]), process.argv[3]);
} finally {
  clearInterval(keepAlive);
}

// SPDX-License-Identifier: Apache-2.0
import { withWorkLockOptions } from '../dist/work-lock.js';

/** Run a write that a test injects for another actor while a landing driver runs.
 * A real peer is a separate process with ordinary blocking Work-lock admission. It
 * must not inherit the driver's nonblocking context: there a lock held by a check
 * child throws WORK_BUSY, the driver retries, and a one-shot injection never lands. */
export const asAnotherProcess = run =>
  withWorkLockOptions({ nonblocking: false, cancelled: undefined, waitMs: undefined }, run);

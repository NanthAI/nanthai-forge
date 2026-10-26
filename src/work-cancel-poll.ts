// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import type { CheckRun } from './work-types.js';

/** A concurrent record replacement defers cancellation observation to the next poll. */
export function pollCancellation(read: () => Pick<CheckRun, 'cancelRequested'> | undefined): boolean {
  try {
    return read()?.cancelRequested === true;
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'SOURCE_CHANGED') return false;
    throw error;
  }
}

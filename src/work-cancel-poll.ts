// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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

// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type WorkLockSpan } from './work-lock.js';
import type { WorkStore } from './work-store.js';
export type AttemptTiming = {
  selectedAt: string;
  composeStartedAt?: string;
  composedAt?: string;
  checkReservedAt?: string;
  settlementStartedAt?: string;
  commitObservedAt?: string;
  settledAt?: string;
};
export function readAttemptLocks(store: WorkStore, attemptId: string): WorkLockSpan[] {
  const path = join(store.directory, 'landing-attempt-locks', `${attemptId}.jsonl`);
  if (!existsSync(path)) return [];
  // A process may die mid-append; retain prior complete records.
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as WorkLockSpan];
      } catch {
        return [];
      }
    });
}

// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirBelow } from './mkdir-below.js';
import { observeWorkLocks, type WorkLockSpan } from './work-lock.js';
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
/** Lock evidence is owner-local and written after release, never by observers or
 * through another Work transaction. Concurrent controllers append whole records. */
export function recordAttemptLock(store: WorkStore, attemptId: string, span: WorkLockSpan) {
  if (span.path !== join(store.directory, 'lock')) return;
  const directory = join(store.directory, 'landing-attempt-locks');
  mkdirBelow(store.directory, directory);
  appendFileSync(join(directory, `${attemptId}.jsonl`), JSON.stringify(span) + '\n', {
    mode: 0o600,
    flush: true,
  });
}
export function withLandingAttempt<T>(store: WorkStore, attemptId: string, run: () => T): T {
  let active = true;
  try {
    const value = observeWorkLocks(span => {
      if (active) recordAttemptLock(store, attemptId, span);
    }, run);
    if (value instanceof Promise)
      return value.finally(() => {
        active = false;
      }) as T;
    active = false;
    return value;
  } catch (error) {
    active = false;
    throw error;
  }
}
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

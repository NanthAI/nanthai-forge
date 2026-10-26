// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableReplace } from './native-durability.js';
import type { WorkStore } from './work-store.js';

export type MainAuditState = {
  schema: 1;
  status: 'running' | 'waiting' | 'stalled' | 'idle';
  updatedAt: string;
  lastProgressAt: string;
  runIds: string[];
  code?: string;
  retryAt?: string;
};
const path = (store: WorkStore) => join(store.directory, 'post-accept-main-state.json');
export function readMainAuditState(store: WorkStore): MainAuditState | undefined {
  try {
    const value = JSON.parse(readFileSync(path(store), 'utf8')) as MainAuditState;
    return value.schema === 1 ? value : undefined;
  } catch {
    return;
  }
}
/** Owner-local driver diagnosis. Accepted source and pending audit/run records
 * remain authoritative; ending this driver never cancels or replaces a check. */
export function saveMainAuditState(store: WorkStore, state: Omit<MainAuditState, 'schema' | 'updatedAt'>) {
  const previous = readMainAuditState(store);
  const next = { schema: 1 as const, ...state };
  if (previous && JSON.stringify({ ...previous, updatedAt: undefined }) === JSON.stringify(next)) return;
  durableReplace(path(store), JSON.stringify({ ...next, updatedAt: new Date().toISOString() }));
}

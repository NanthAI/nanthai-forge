// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { agentClean } from './agent-clean.js';
import { readPolicy } from './work-autonomy.js';
import type { WorkStore } from './work-store.js';
/** Stable per lifecycle event and terminal attempt; a resumed run can finish
 * again, while replay cannot clean a subsequently reopened Lane. */
export function automaticCleanup(
  store: WorkStore,
  event: string,
  actor: string,
  scope: { laneIds?: string[]; runId?: string } = {},
) {
  if (!store.native) return undefined;
  if (!readPolicy(store).lifecycle.cleanRegenerableCopies) return undefined;
  const endedAt = scope.runId ? store.select('runs', scope.runId)?.endedAt : undefined;
  const bytes = createHash('sha256')
    .update(`forge-clean:${event}${endedAt ? `:terminal:${endedAt}` : ''}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex'),
    id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const cleanup = agentClean(
    store,
    {
      action: 'clean',
      apply: true,
      kinds: scope.runId
        ? ['check-workspaces', 'check-retention', 'exchange-staging']
        : scope.laneIds
          ? ['lanes', 'lane-deps', 'check-retention', 'exchange-staging']
          : ['lanes', 'lane-deps', 'check-workspaces', 'check-retention', 'exchange-staging'],
    },
    { id, actor, ...scope },
  );
  return { ...cleanup.result, automatic: store.select('automaticActions', id)?.action };
}

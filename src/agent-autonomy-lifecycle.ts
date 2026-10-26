// SPDX-License-Identifier: Apache-2.0
import { automaticResult } from './work-detail-store.js';
import { createHash } from 'node:crypto';
import { optimisticLanding } from './autonomy-policy.js';
import { readPolicy } from './work-autonomy.js';
import { completeAccepted } from './agent-lifecycle.js';
import { agentClean } from './agent-clean.js';
import type { WorkService } from './work.js';
import type { ChannelMove } from './work-types.js';
function lifecycleId(id: string) {
  const bytes = createHash('sha256').update(`forge-accept-lifecycle:${id}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function acceptedLifecycle(work: WorkService, move: ChannelMove, keepOpen?: boolean) {
  const policy = move.automatic?.policy ?? readPolicy(work.store),
    id = lifecycleId(move.id);
  if (optimisticLanding(policy)) return {}; // Retain original Lanes and working copies for recovery.
  if (keepOpen || !policy.lifecycle.completeOnAccept || move.status !== 'accepted') return {};
  const original = work.store.select('automaticActions', id);
  const retained = automaticResult(work.store, original);
  if (retained !== undefined)
    return JSON.parse(retained) as {
      completed?: Awaited<ReturnType<typeof completeAccepted>>;
      lifecycleAction?: { summary: string; undo: string };
      cleanup?: unknown;
    };
  const lifecycleAction = {
    summary: 'Completed accepted input Lanes and Intent',
    undo: 'Run reopen with the Lane or Intent id; completion retains source and history.',
  };
  work.store.locked(() => {
    const tx = work.store.records();
    if (!tx.find('automaticActions', id)) {
      tx.setSchema(11);
      tx.append('automaticActions', {
        id,
        at: new Date().toISOString(),
        action: { actor: work.actor.id, ...lifecycleAction },
      });
      work.store.commitRecords(tx);
    }
  });
  const completed = await completeAccepted(work, move.viewId);
  const cleanup =
    policy.lifecycle.cleanRegenerableCopies && work.store.native
      ? agentClean(
          work.store,
          { action: 'clean', apply: true, kinds: ['check-workspaces', 'lane-deps', 'lanes'] },
          { id: move.id, actor: work.actor.id },
        )
      : undefined;
  const result = {
    completed,
    lifecycleAction,
    ...(cleanup
      ? { cleanup: { ...cleanup.result, automatic: work.store.select('automaticActions', move.id)?.action } }
      : {}),
  };
  work.store.locked(() => {
    const tx = work.store.records(),
      previous = tx.find('automaticActions', id)!;
    if (!previous.record.result) {
      tx.replace('automaticActions', previous.position, {
        ...previous.record,
        result: JSON.stringify(result),
      });
      work.store.commitRecords(tx);
    }
  });
  return result;
}

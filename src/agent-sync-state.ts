// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { PRESENCE } from './presence.js';

export const syncErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  seq: z.number(),
  at: z.number(),
  attempts: z.number().int().positive(),
  operationId: z.string(),
});
export const agentSyncSchema = z.object({
  sequence: z.number().int().nonnegative(),
  observations: z.record(z.string(), z.string()).optional(),
  pending: z.array(
    z.object({
      operationId: z.uuid(),
      projectId: z.string(),
      deployment: z.string(),
      activity: z.unknown(),
      metadata: z.string(),
    }),
  ),
  headError: syncErrorSchema.optional(),
  nextAttemptAt: z.number().optional(),
  unprepared: z.string().optional(),
  rejected: z.array(syncErrorSchema).optional(),
  discarded: z.number().optional(),
});
export type AgentSyncState = z.infer<typeof agentSyncSchema>;
export type SyncEntry = AgentSyncState['pending'][number];
const activity = (entry: SyncEntry) =>
  entry.activity as { sessionId?: string; sequence?: number; activityAt?: number };
const metadata = (entry: SyncEntry) => {
  try {
    const parsed = JSON.parse(entry.metadata);
    return parsed && typeof parsed === 'object' ? (parsed as { revision?: number; entries?: unknown[] }) : {};
  } catch {
    return {};
  }
};
const presenceOnly = (entry: SyncEntry) => metadata(entry).entries?.length === 0;
export const syncSequence = (entry: SyncEntry) => activity(entry)?.sequence ?? 0;

/** Never change a retained UUID's payload: an earlier attempt may have committed. */
export function compactAgentSync(queue: AgentSyncState, now = Date.now(), boundProjectId?: string) {
  // After a rebind, the new project was seeded from this owner's full Work: entries
  // for the previous project are obsolete and would block the serial queue forever.
  const bound = boundProjectId
    ? queue.pending.filter(entry => entry.projectId === boundProjectId)
    : queue.pending;
  if (queue.headError && !bound.some(entry => entry.operationId === queue.headError?.operationId)) {
    if (queue.pending.some(entry => entry.operationId === queue.headError?.operationId)) {
      delete queue.headError;
      delete queue.nextAttemptAt;
      delete queue.unprepared;
    }
  }
  const latest = new Map<string, SyncEntry>();
  for (const entry of bound) {
    if (presenceOnly(entry) && now - (activity(entry)?.activityAt ?? 0) > PRESENCE.workingMs) continue;
    const key = JSON.stringify([
      entry.deployment,
      entry.projectId,
      activity(entry)?.sessionId ?? entry.operationId,
      presenceOnly(entry),
    ]);
    const previous = latest.get(key);
    const rank = (item: SyncEntry) =>
      presenceOnly(item) ? syncSequence(item) : (metadata(item).revision ?? syncSequence(item));
    if (!previous || rank(entry) >= rank(previous)) latest.set(key, entry);
  }
  let pending = [...latest.values()].sort((a, b) => syncSequence(a) - syncSequence(b));
  // A newer metadata snapshot also carries presence; older presence adds nothing.
  pending = pending.filter(
    entry =>
      !presenceOnly(entry) ||
      !pending.some(
        other =>
          !presenceOnly(other) &&
          other.projectId === entry.projectId &&
          other.deployment === entry.deployment &&
          activity(other)?.sessionId === activity(entry)?.sessionId &&
          syncSequence(other) >= syncSequence(entry),
      ),
  );
  let bytes = pending.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0);
  while (pending.length > 100 || bytes > 512 * 1024) {
    const index = Math.max(0, pending.findIndex(presenceOnly));
    bytes -= Buffer.byteLength(JSON.stringify(pending[index]));
    pending.splice(index, 1);
  }
  queue.discarded = (queue.discarded ?? 0) + queue.pending.length - pending.length;
  queue.pending = pending;
  delete queue.observations; // Fingerprints already live in local presence.
  if (queue.rejected) queue.rejected = queue.rejected.slice(-20);
}

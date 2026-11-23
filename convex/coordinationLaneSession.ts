// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './server';
import { session } from './coordinationWrite';
import { COORDINATION_LIMITS as L } from '../src/coordination-types';

/** The operation id that marks a session a Lane wrote. An announced session that happens to reuse
 * the Lane id is never overwritten by its Lane; it is released with the Lane only when it names it. */
const laneOperation = (laneId: string) => `lane-session:${laneId}`;
const harness = (app?: string): 'claude-code' | 'codex' | 'cursor' | 'pi' | 'other' =>
  app === 'claude-code' || app === 'codex' || app === 'cursor' || app === 'pi' ? app : 'other';

export type LaneSessionValue = {
  actor: string;
  agent?: string;
  app?: string;
  goal: string;
  intentId: string;
  at: number;
};

/** Automatic enrolment (Issue c6615b66): every open Lane is a coordination session, keyed by its Lane
 * id. It rides the Lane's presence row insert and delete (start, a Lane coming back into view, close), so it
 * adds no call, nothing per save and nothing at idle: one indexed read and one write at each end. `null`
 * releases it with the presence row, so a session never outlives its Lane. */
export async function syncLaneSession(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  value: LaneSessionValue | null,
) {
  const row = await session(ctx, projectId, laneId);
  const ours = row?.operationId === laneOperation(laneId);
  if (!value) {
    // Close releases the Lane's session, also when an agent later announced over it for this Lane.
    if (row && (ours || row.context?.laneId === laneId)) await ctx.db.delete(row._id);
    return;
  }
  // An announced session is the agent's own: Lane writes never overwrite it.
  if (row && !ours) return;
  const fields = {
    actor: value.actor,
    sequence: Math.max(value.at, (row?.sequence ?? 0) + 1),
    name: (value.agent || 'Lane').slice(0, L.name),
    environment: 'Lane',
    status: 'working' as const,
    summary: value.goal.slice(0, L.summary),
    // Paths live on the presence row, which saves keep current; the session only links the Lane.
    context: { laneId, intentId: value.intentId },
    lastSeen: value.at,
    lastActivity: value.at,
    activityKind: 'Lane',
    kind: 'agent' as const,
    harness: harness(value.app),
  };
  if (row) await ctx.db.patch(row._id, fields);
  else
    await ctx.db.insert('projectCoordinationSessions', {
      projectId,
      sessionId: laneId,
      operationId: laneOperation(laneId),
      ...fields,
    });
}

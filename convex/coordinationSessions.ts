// SPDX-License-Identifier: Apache-2.0
import { activityAt } from '../src/presence';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { sessionFields, sessionKind, harness } from './coordinationFields';
import { session } from './coordinationWrite';
import { withActorName } from './projectActorNames';
import { COORDINATION_STALE_MS, type CoordinationCommand } from '../src/coordination-types';
import { invariant } from '../src/errors';

export const liveSession = (row: { status: string; lastSeen: number; lastActivity?: number }, now: number) =>
  row.status !== 'completed' && now - activityAt(row) <= COORDINATION_STALE_MS;

/** Only the link's creation/replacement requires a live parent; a child may finish after its parent. */
export async function sessionStructure(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  credentialId: string | undefined,
  current: Doc<'projectCoordinationSessions'> | null,
  command: Extract<CoordinationCommand, { kind: 'activity' }>,
  now: number,
) {
  const parentSessionId = command.parentSessionId ?? current?.parentSessionId;
  const kind = command.sessionKind ?? current?.kind ?? (parentSessionId ? 'subagent' : 'agent');
  if (parentSessionId) {
    invariant(kind === 'subagent', 'BAD_ARGUMENT', 'A child session has kind subagent.');
    if (!current || parentSessionId !== current.parentSessionId) {
      const parent = await session(ctx, projectId, parentSessionId);
      invariant(
        parent &&
          parent.actor === actor &&
          parent.credentialId === credentialId &&
          (!current || current.credentialId === credentialId) &&
          // Parent linkage follows receipt freshness; quiet display state is not an access rule.
          liveSession({ status: parent.status, lastSeen: parent.lastSeen }, now),
        'BAD_ARGUMENT',
        'Select an active parent session of the same actor and credential in this project.',
      );
      const seen = new Set([command.sessionId]);
      let ancestor: Doc<'projectCoordinationSessions'> | null = parent;
      while (ancestor) {
        invariant(!seen.has(ancestor.sessionId), 'BAD_ARGUMENT', 'Session parent links cannot form a cycle.');
        seen.add(ancestor.sessionId);
        ancestor = ancestor.parentSessionId ? await session(ctx, projectId, ancestor.parentSessionId) : null;
      }
    }
  }
  // Keep an established credential binding when this actor resumes with a different login.
  return {
    parentSessionId,
    kind,
    harness: command.harness ?? current?.harness ?? 'other',
    harnessVersion:
      command.harnessVersion ??
      (command.harness && command.harness !== current?.harness ? undefined : current?.harnessVersion),
    credentialId: current?.credentialId ?? credentialId,
  };
}

const { credentialId: _credentialId, ...visibleFields } = sessionFields;
void _credentialId;
export const sessionView = v.object({
  _id: v.id('projectCoordinationSessions'),
  _creationTime: v.number(),
  ...visibleFields,
  kind: sessionKind,
  harness,
  stale: v.boolean(),
  // Children are read through independently paginated session queries.
  subagents: v.array(v.any()),
});
export type SessionTree = Omit<Doc<'projectCoordinationSessions'>, 'credentialId' | 'kind' | 'harness'> & {
  kind: 'agent' | 'subagent' | 'person';
  harness: 'claude-code' | 'codex' | 'cursor' | 'pi' | 'other';
  stale: boolean;
  subagents: SessionTree[];
};
export async function sessionTree(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  row: Doc<'projectCoordinationSessions'>,
  now: number,
): Promise<SessionTree> {
  const { credentialId: _credentialId, ...visible } = await withActorName(ctx, projectId, row);
  void _credentialId;
  return {
    ...visible,
    kind: row.kind ?? 'agent',
    harness: row.harness ?? 'other',
    stale: now - activityAt(row) > COORDINATION_STALE_MS,
    subagents: [],
  };
}

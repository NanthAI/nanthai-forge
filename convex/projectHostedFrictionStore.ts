// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './server';
import { getDocumentSize } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { activeProject, accessibleProject } from './projectAuthority';
import { sourceAuthority } from '../src/hosted-source-authority';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
import type { FrictionEvent, FrictionTriageState } from '../src/friction-types';
export async function recordCaller(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  write = false,
  decision = false,
) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read or record project context.');
  const project = write
    ? await activeProject(ctx, projectId, user.subject)
    : await accessibleProject(ctx, projectId, user.subject);
  if (write) {
    invariant(
      sourceAuthority(project).mode !== 'native-owner',
      'HOSTED_ACTION_UNSUPPORTED',
      'This project retains native record authority.',
    );
    if (decision && project.owner !== user.subject) {
      const grant = await ctx.db
        .query('projectHostedDecisionMaintainers')
        .withIndex('by_project_and_actor', q => q.eq('projectId', projectId).eq('actor', user.subject))
        .order('desc')
        .take(1);
      invariant(
        grant[0]?.enabled,
        'PROJECT_UNAVAILABLE',
        'Decisions require the owner or an assigned decision maintainer.',
      );
    }
  }
  return { actor: user.subject, project };
}
export async function frictionRow(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, id: string) {
  return ctx.db
    .query('projectHostedFriction')
    .withIndex('by_project_and_id', q => q.eq('projectId', projectId).eq('id', id))
    .unique();
}
export async function appendFriction(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  record: FrictionEvent,
  likelyDuplicates?: string,
) {
  const old = await frictionRow(ctx, projectId, record.id);
  if (old) {
    invariant(
      canonicalPayload(JSON.parse(old.value)) === canonicalPayload(record),
      'WORK_OPERATION_CHANGED',
      'Replay the original friction record.',
    );
    return false;
  }
  const row = { projectId, actor, id: record.id, request: record.request, value: canonicalPayload(record) };
  const inline = likelyDuplicates === undefined ? row : { ...row, likelyDuplicates };
  if (likelyDuplicates === undefined || getDocumentSize(inline) <= 1048576)
    await ctx.db.insert('projectHostedFriction', inline);
  else {
    // Hints must never make a formerly valid filing exceed the physical row limit.
    // Both records commit together, so a lost response replays the original snapshot.
    await ctx.db.insert('projectHostedFriction', row);
    await ctx.db.insert('projectHostedFrictionHints', { projectId, id: record.id, value: likelyDuplicates! });
  }
  if (record.kind === 'triage') await applyTriage(ctx, projectId, actor, record);
  return true;
}
/** Keep the latest triage on each capture row so a list is one indexed page, never a join.
 * An older event (an out-of-order import) never replaces a newer state. One point read and
 * one patch per id; the hosted command bounds ids at 50. */
async function applyTriage(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  record: Extract<FrictionEvent, { kind: 'triage' }>,
) {
  const state: FrictionTriageState = {
    status: record.status,
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.laneId ? { laneId: record.laneId } : {}),
    ...(record.planningItemId ? { planningItemId: record.planningItemId } : {}),
    at: record.at,
    by: actor,
  };
  for (const frictionId of record.frictionIds) {
    const row = await frictionRow(ctx, projectId, frictionId);
    if (!row || (row.triage && (JSON.parse(row.triage) as FrictionTriageState).at > record.at)) continue;
    await ctx.db.patch(row._id, { triage: canonicalPayload(state) });
  }
}
export const recordRequest = (value: unknown) => digest(canonicalPayload(value));
export function replayRequest(request: string, expected: string) {
  invariant(request === expected, 'WORK_OPERATION_CHANGED', 'Replay the original record inputs.');
}
export const recordPageOptions = (cursor: string | null) => ({
  cursor,
  numItems: 100,
  maximumRowsRead: 100,
  maximumBytesRead: 256 * 1024,
});

export async function frictionHints(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  id: string,
) {
  return ctx.db
    .query('projectHostedFrictionHints')
    .withIndex('by_project_and_id', q => q.eq('projectId', projectId).eq('id', id))
    .unique();
}

// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './server';
import { getDocumentSize } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { activeProject, accessibleProject } from './projectAuthority';
import { sourceAuthority } from '../src/hosted-source-authority';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
import { isPlanningUuid, planningIdMaxCandidates } from '../src/planning-id';
import type { FrictionEvent, FrictionTriageState } from '../src/friction-types';
import type { CliProvenance } from '../src/self-metric-receipts';

const documentLimit = 1048576;
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
/** The captured friction rows an id or id prefix (8+ hex characters) names: a full UUID is one
 * point read, a prefix one range read on by_project_and_id, at most six keys. Triage and count events
 * have their own random ids, so only captures count. Zero matches is NOT_FOUND, several BAD_ARGUMENT. */
export async function resolveFriction(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  ref: string,
) {
  const isCapture = (row: { value: string }) => JSON.parse(row.value).kind === 'capture';
  if (isPlanningUuid(ref)) {
    const exact = await frictionRow(ctx, projectId, ref);
    const row =
      exact ?? (ref !== ref.toUpperCase() ? await frictionRow(ctx, projectId, ref.toUpperCase()) : null);
    invariant(row && isCapture(row), 'NOT_FOUND', `Friction ${ref} not found.`);
    return row;
  }
  const readPrefix = async (key: string) =>
    (
      await ctx.db
        .query('projectHostedFriction')
        .withIndex('by_project_and_id', q =>
          q.eq('projectId', projectId).gte('id', key).lt('id', `${key}\uffff`),
        )
        .take(planningIdMaxCandidates + 1)
    ).filter(isCapture);
  const exact = await readPrefix(ref);
  const rows = exact.length || ref === ref.toUpperCase() ? exact : await readPrefix(ref.toUpperCase());
  invariant(rows.length > 0, 'NOT_FOUND', `No friction id starts with ${ref}.`);
  invariant(
    rows.length === 1,
    'BAD_ARGUMENT',
    `Friction id prefix ${ref} matches ${rows.length > planningIdMaxCandidates ? 'more than ' + planningIdMaxCandidates : rows.length} frictions (${rows
      .slice(0, planningIdMaxCandidates)
      .map(row => row.id)
      .join(', ')}). Use a longer prefix.`,
  );
  return rows[0]!;
}
export async function appendFriction(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  record: FrictionEvent,
  likelyDuplicates?: string,
  cli?: CliProvenance,
) {
  const old = await frictionRow(ctx, projectId, record.id);
  if (old) {
    invariant(
      canonicalPayload(JSON.parse(old.value)) === canonicalPayload(record),
      'WORK_OPERATION_CHANGED',
      'Replay the original friction record.',
    );
    return record;
  }
  const row = { projectId, actor, id: record.id, request: record.request, value: canonicalPayload(record) };
  const inline = likelyDuplicates === undefined ? row : { ...row, likelyDuplicates };
  const inlineBytes = likelyDuplicates === undefined ? undefined : getDocumentSize(inline);
  const spill = inlineBytes !== undefined && inlineBytes > documentLimit;
  const target = spill ? row : inline;
  // Keep the same inline/spill decision and the same physical bound as a legacy capture.
  const stored =
    cli &&
    record.kind === 'capture' &&
    (spill ? getDocumentSize(row) : (inlineBytes ?? getDocumentSize(target))) +
      canonicalPayload({ cli }).length -
      1 <=
      documentLimit
      ? { ...record, cli }
      : record;
  await ctx.db.insert(
    'projectHostedFriction',
    stored === record ? target : { ...target, value: canonicalPayload(stored) },
  );
  if (spill) {
    // Hints must never make a formerly valid filing exceed the physical row limit.
    // Both records commit together, so a lost response replays the original snapshot.
    await ctx.db.insert('projectHostedFrictionHints', { projectId, id: record.id, value: likelyDuplicates! });
  }
  if (record.kind === 'triage') await applyTriage(ctx, projectId, actor, record);
  return stored;
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

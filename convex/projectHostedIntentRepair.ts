// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from './server';
import type { Doc } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { hostedIntentSchema, hostedLaneSchema } from '../src/hosted-lane';
import { hostedRecordBody, recordHead, writeHostedRecord } from './projectHostedRecords';
import { landedAtLaneHead, laneOverlapHead } from './projectHostedOpenLaneEvidence';

const status = v.union(v.literal('completed'), v.literal('abandoned'));
const row = v.object({ id: v.string(), version: v.number(), status, workStamp: v.string() });
const keys = 16;
const siblings = 100;

async function checkedIntent(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  id: string,
  head: Awaited<ReturnType<typeof recordHead>>,
) {
  if (head?.status !== 'active' || project.needsFix?.[id]) return null;
  const source = await ctx.db.get(head.recordId);
  if (!source || source.purged) return null;
  const intent = hostedIntentSchema.parse(JSON.parse(await hostedRecordBody(ctx, source)));
  if (intent.needsFix) return null;
  const lanes = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_parent', q =>
      q.eq('projectId', project._id).eq('kind', 'lane').eq('parent', id),
    )
    .take(siblings + 1);
  if (lanes.length === 0 || lanes.length > siblings) return null;
  let completedAt = '';
  let latest = '';
  const evidence: string[][] = [];
  for (const lane of lanes) {
    const stamp = [lane.key, lane.recordId, lane.status];
    evidence.push(stamp);
    if (lane.status === 'active') {
      const overlap = await laneOverlapHead(ctx, project._id, lane.key);
      if (lane.pinned || !overlap?.landed || overlap.landed.revertedBy || !landedAtLaneHead(overlap))
        return null;
      if (overlap.landed.at > completedAt) completedAt = overlap.landed.at;
      stamp.push(overlap.landed.receiptId, overlap.landed.laneHead, overlap.landed.at);
      if (overlap.landed.at > latest) latest = overlap.landed.at;
      continue;
    }
    if (lane.status !== 'completed' && lane.status !== 'abandoned') return null;
    const laneRow = await ctx.db.get(lane.recordId);
    if (!laneRow || laneRow.purged) return null;
    const value = hostedLaneSchema.parse(JSON.parse(await hostedRecordBody(ctx, laneRow)));
    if (lane.status === 'completed') {
      const overlap = await laneOverlapHead(ctx, project._id, lane.key);
      const landing = overlap?.landed?.laneHead === value.head ? overlap.landed : undefined;
      if (landing?.revertedBy) return null;
      const completed = landing?.at ?? value.at;
      if (completed > completedAt) completedAt = completed;
      stamp.push(completed);
    }
    if (value.at > latest) latest = value.at;
  }
  // An explicit reopen or a recovery may be newer than every terminal Lane. Do not undo either.
  if (latest < intent.at) return null;
  return {
    intent,
    completedAt,
    move: {
      id,
      version: intent.version,
      status: completedAt ? ('completed' as const) : ('abandoned' as const),
      workStamp: digest(JSON.stringify(evidence)),
    },
  };
}

/** One read-only batch over operator-selected Intent keys, for any project. No Plan writes. */
export const preview = internalQuery({
  args: { projectId: v.id('hostedProjects'), intentIds: v.array(v.string()) },
  returns: v.array(row),
  handler: async (ctx, { projectId, intentIds }) => {
    invariant(intentIds.length <= keys, 'BAD_ARGUMENT', 'Select up to 16 Intent IDs per repair batch.');
    const project = await ctx.db.get(projectId);
    invariant(
      project && !project.removal && project.sourceAuthority,
      'PROJECT_UNAVAILABLE',
      'Select a current project.',
    );
    const found = [];
    for (const id of new Set(intentIds)) {
      const result = await checkedIntent(ctx, project, id, await recordHead(ctx, projectId, 'intent', id));
      if (result) found.push(result.move);
    }
    return found;
  },
});

/** Repair only the approved current Intent versions; never replay a status change on a later version.
 * Plan status recompute is separate. The canonical write updates all readers of the hosted Intent. */
export const apply = internalMutation({
  args: { projectId: v.id('hostedProjects'), expected: v.array(row) },
  returns: v.null(),
  handler: async (ctx, { projectId, expected }) => {
    invariant(
      expected.length <= keys && new Set(expected.map(e => e.id)).size === expected.length,
      'BAD_ARGUMENT',
      'Select up to 16 distinct approved Intent versions.',
    );
    const project = await ctx.db.get(projectId);
    invariant(
      project && !project.removal && project.sourceAuthority,
      'PROJECT_UNAVAILABLE',
      'Select a current project.',
    );
    for (const move of expected) {
      const head = await recordHead(ctx, projectId, 'intent', move.id);
      if (head?.version === move.version + 1 && head.status === move.status) continue;
      const result = await checkedIntent(ctx, project, move.id, head);
      invariant(
        result &&
          result.move.version === move.version &&
          result.move.status === move.status &&
          result.move.workStamp === move.workStamp,
        'WORK_STALE',
        'The approved Intent or its Lane evidence changed. Re-run repair preview.',
      );
      await writeHostedRecord(ctx, {
        projectId,
        actor: project.owner,
        authorityEpoch: project.sourceAuthority.epoch,
        expectedVersion: move.version,
        ...(result.completedAt ? { intentCompletedAt: result.completedAt } : {}),
        record: {
          ...result.intent,
          status: move.status,
          version: move.version + 1,
          at: new Date().toISOString(),
        },
      });
    }
    return null;
  },
});

// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { internalMutation } from './server';
import { capsuleRunArgs } from './projectLandingCapsuleCapture';
import {
  wakeLandingCapsule,
  deferCapsuleCheck,
  capsuleWaitKind,
  landingCapsuleGraceMs,
} from './projectLandingCapsuleWake';
import { loadHostedCheck } from './projectHostedCheckStore';
import { hostedCheckTerminal } from '../src/hosted-check';
import { composeStateSchema } from './projectHostedComposeStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

export const wakeChecks = internalMutation({
  args: { projectId: v.id('hostedProjects'), runId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    if (process.env.FORGE_LANDING_CAPSULES !== '1') return null;
    const rows = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_project_and_run', q =>
        q.eq('kind', capsuleWaitKind).eq('projectId', input.projectId).eq('runId', input.runId),
      )
      .take(8);
    for (const row of rows) {
      await wakeLandingCapsule(ctx, {
        projectId: input.projectId,
        submissionId: row.submissionId!,
        dueAt: JSON.parse(row.value).dueAt,
      });
      await ctx.db.delete(row._id);
    }
    if (rows.length === 8)
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('projectLandingCapsuleRefs:wakeChecks'),
        input,
      );
    return null;
  },
});
export const page = internalMutation({
  args: {
    ...capsuleRunArgs,
    refs: v.array(v.object({ kind: v.union(v.literal('check'), v.literal('compose')), id: v.string() })),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    invariant(input.refs.length <= 4, 'BAD_ARGUMENT', 'Read one capsule reference page.');
    const refs = [];
    for (const ref of input.refs) {
      if (ref.kind === 'check') {
        const { run } = await loadHostedCheck(ctx, { projectId: input.projectId, runId: ref.id }, false);
        const endedAt = Date.parse(run.endedAt ?? '');
        if (
          !hostedCheckTerminal(run) ||
          !Number.isFinite(endedAt) ||
          Date.now() < endedAt + landingCapsuleGraceMs
        ) {
          await deferCapsuleCheck(ctx, { ...input, runId: run.id });
          return canonicalPayload({ deferred: 'check' });
        }
        const old = await ctx.db
          .query('legacyStorageCleanupPages')
          .withIndex('by_operation_and_part', q =>
            q.eq('operationId', `exhaust:${run.id}:callbacks`).eq('part', 'callbacks:0'),
          )
          .unique();
        refs.push({
          kind: 'check',
          id: run.id,
          expiry: old
            ? JSON.parse(old.request)
            : {
                projectId: input.projectId,
                runId: run.id,
                phase: 'callbacks',
                dueAt: Date.parse(run.endedAt!) + landingCapsuleGraceMs,
                operationId: `exhaust:${run.id}:callbacks`,
                part: 0,
              },
        });
      } else {
        const row = await ctx.db
          .query('projectHostedComposes')
          .withIndex('by_project_and_candidate', q =>
            q.eq('projectId', input.projectId).eq('candidateId', ref.id),
          )
          .unique();
        if (!row) continue;
        const state = composeStateSchema.parse(JSON.parse(row.value));
        invariant(
          state.status === 'completed' || state.status === 'failed',
          'WORK_STALE',
          'A referenced composition is still active.',
        );
        refs.push({ kind: 'compose', actor: row.actor, operationId: row.operationId, jobId: row.jobId });
      }
    }
    return canonicalPayload({ refs });
  },
});

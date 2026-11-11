// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { landingCapsuleGraceMs } from './projectLandingCapsuleWake';
import { landingAttemptRow } from './projectHostedLandingAttemptRead';
import { acceptanceRow, acceptancePlan } from './projectHostedAcceptanceStore';
import { finishRow } from './projectHostedFinishWake';
import { batchRow, batchSchema } from './projectHostedLandingBatchState';
import { loadLanding } from './projectHostedLandingStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { LANDING_CAPSULE_TABLES } from '../src/hosted-landing';
import { capsuleOwnerKind, capsuleControlKey, capsuleControlRow } from './projectLandingCapsuleLedger';
import { invariant } from '../src/errors';

export type CapsuleScope = {
  table: (typeof LANDING_CAPSULE_TABLES)[number];
  key?: string;
  kind?: string;
  actor?: string;
  sequence?: number;
  owner?: string;
};
export const capsuleFinishKinds = [
  'projectHostedLandingRequests',
  'projectHostedFinishes',
  'projectHostedFinishOwners',
  'projectHostedLandingPeers',
  'projectHostedLandingDesired',
];
export const capsulePageOptions = (cursor: string | null) => ({
  cursor,
  numItems: 8,
  maximumRowsRead: 8,
  maximumBytesRead: 32 * 1024,
});
async function owned(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  submissionId: string,
  scope: CapsuleScope,
) {
  const selected =
    scope.table === 'projectHostedCheckCallbacks'
      ? `check:${scope.key}`
      : `compose:${scope.actor}:${scope.key}`;
  const sourceId = capsuleControlKey(projectId, selected);
  const old = await capsuleControlRow(ctx, sourceId);
  const data = old ? JSON.parse(old.value) : {};
  if (data.submissionId) return data.submissionId === submissionId;
  const value = canonicalPayload({ ...data, submissionId });
  if (old) await ctx.db.patch(old._id, { value, submissionId });
  else
    await ctx.db.insert('projectFinishReadRows', {
      kind: capsuleOwnerKind,
      sourceId,
      projectId,
      submissionId,
      value,
    });
  return true;
}
async function selected(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  submissionId: string,
  version: number,
  scope: CapsuleScope,
  cursor: string | null,
) {
  const options = capsulePageOptions(cursor);
  switch (scope.table) {
    case 'projectHostedLandingObservations':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_submission_and_version', q =>
          q.eq('projectId', projectId).eq('submissionId', submissionId).lte('version', version),
        )
        .paginate(options);
    case 'projectHostedLandingAttempts':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_submission_and_number', q =>
          q.eq('projectId', projectId).eq('submissionId', submissionId),
        )
        .paginate(options);
    case 'projectFinishReadRows':
      invariant(
        capsuleFinishKinds.includes(scope.kind!),
        'BAD_ARGUMENT',
        'Select a landing-owned projection kind.',
      );
      return ctx.db
        .query(scope.table)
        .withIndex('by_kind_and_project_and_submission', q =>
          q.eq('kind', scope.kind!).eq('projectId', projectId).eq('submissionId', submissionId),
        )
        .paginate(options);
    case 'projectHostedAcceptancePlans':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_receipt', q => q.eq('projectId', projectId).eq('receiptId', scope.key!))
        .paginate(options);
    case 'projectHostedAcceptancePages':
      invariant(
        scope.kind === 'inputs' || scope.kind === 'dependencies',
        'BAD_ARGUMENT',
        'Select acceptance page kind.',
      );
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_receipt_and_kind_and_index', q =>
          q
            .eq('projectId', projectId)
            .eq('receiptId', scope.key!)
            .eq('kind', scope.kind as 'inputs' | 'dependencies'),
        )
        .paginate(options);
    case 'projectHostedAcceptanceEvents':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_sequence', q =>
          q.eq('projectId', projectId).eq('sequence', scope.sequence!),
        )
        .paginate(options);
    case 'projectHostedAcceptanceSnapshots':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_snapshot', q => q.eq('projectId', projectId).eq('snapshotId', scope.key!))
        .paginate(options);
    case 'projectHostedComposePages':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_actor_and_operation_and_kind_and_index', q =>
          q.eq('projectId', projectId).eq('actor', scope.actor!).eq('operationId', scope.key!),
        )
        .paginate(options);
    case 'projectHostedCheckCallbacks':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', scope.key!))
        .paginate(options);
    case 'legacyStorageCleanupPages':
      return ctx.db
        .query(scope.table)
        .withIndex('by_operation_and_part', q => q.eq('operationId', scope.key!))
        .paginate(options);
  }
}
/** Canonical bytes go only to the internal Node packer. Capture never removes a row. */
export const page = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    version: v.number(),
    scope: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const { row, state } = await loadLanding(ctx, input);
    if (row.capsule) return canonicalPayload({ pointer: row.capsule });
    invariant(
      state.version === input.version && ['landed', 'terminal-failed'].includes(state.phase),
      'WORK_STALE',
      'Landing history changed before capsule capture.',
    );
    const scope = JSON.parse(input.scope) as CapsuleScope;
    invariant(LANDING_CAPSULE_TABLES.includes(scope.table), 'BAD_ARGUMENT', 'Select one capsule table.');
    if (
      ['projectHostedComposePages', 'projectHostedCheckCallbacks'].includes(scope.table) &&
      !(await owned(ctx, input.projectId, input.submissionId, scope))
    )
      return canonicalPayload({ rows: [], isDone: true, cursor: null, shared: true });
    if (scope.owner) {
      const row = await capsuleControlRow(ctx, capsuleControlKey(input.projectId, scope.owner));
      if (!row || JSON.parse(row.value).submissionId !== input.submissionId)
        return canonicalPayload({ rows: [], isDone: true, cursor: null, shared: true });
    }
    const page = await selected(ctx, input.projectId, input.submissionId, input.version, scope, input.cursor);
    const rows = page.page.filter(row => {
      if ('eventId' in row && row.eventId.startsWith('reuse:')) return false;
      if (scope.table === 'legacyStorageCleanupPages')
        return 'request' in row && JSON.parse(row.request).projectId === input.projectId;
      return true;
    });
    return canonicalPayload({
      rows: rows.map(row => canonicalPayload(row)),
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    });
  },
});

export const capsuleRunArgs = {
  projectId: v.id('hostedProjects'),
  submissionId: v.string(),
  dueAt: v.number(),
};
/** Terminal age alone is insufficient: late acceptance completion and shared fallback still write history. */
export const begin = internalMutation({
  args: capsuleRunArgs,
  returns: v.string(),
  handler: async (ctx, input) => {
    if (process.env.FORGE_LANDING_CAPSULES !== '1')
      return canonicalPayload({ kept: true, reason: 'disabled' });
    const { row, state } = await loadLanding(ctx, input);
    if (row.capsule) return canonicalPayload({ pointer: row.capsule });
    if (!['landed', 'terminal-failed'].includes(state.phase))
      return canonicalPayload({ kept: true, reason: 'active' });
    const dueAt = Math.max(
      input.dueAt,
      Date.parse(state.timing?.settledAt ?? state.at) + landingCapsuleGraceMs,
    );
    if (Date.now() < dueAt) return canonicalPayload({ kept: true, reason: 'grace', dueAt });
    const batchId = state.batchOriginId ?? state.batchId;
    if (batchId) {
      const row = await batchRow(ctx, { projectId: input.projectId, batchId });
      if (
        row &&
        !['landed', 'superseded', 'split', 'failed'].includes(batchSchema.parse(JSON.parse(row.value)).phase)
      ) {
        if (!row.capsuleWaits?.some(wait => wait.submissionId === state.id))
          await ctx.db.patch(row._id, {
            capsuleWaits: [...(row.capsuleWaits ?? []), { submissionId: state.id, dueAt }],
          });
        return canonicalPayload({ deferred: 'batch' });
      }
    }
    const receipt = state.acceptance
      ? await acceptanceRow(ctx, {
          projectId: input.projectId,
          receiptId: state.acceptance.receiptId,
        })
      : null;
    const plan = receipt ? await acceptancePlan(ctx, receipt) : null;
    if (plan?.completion) {
      if (!plan.capsuleWake) await ctx.db.patch(plan._id, { capsuleWake: { submissionId: state.id, dueAt } });
      return canonicalPayload({ deferred: 'completion' });
    }
    const attempt = await landingAttemptRow(ctx, { projectId: input.projectId, attemptId: state.attemptId });
    invariant(attempt, 'SOURCE_UNAVAILABLE', 'The original terminal attempt is unavailable.');
    return canonicalPayload({
      anchor: state,
      request: row,
      attempt,
      receipt,
      plan,
      finish: await finishRow(ctx, input),
    });
  },
});

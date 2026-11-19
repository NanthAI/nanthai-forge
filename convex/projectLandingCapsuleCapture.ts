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
import { capsuleIndexKind } from './projectLandingCapsuleIndex';
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
  numItems: 64,
  maximumRowsRead: 64,
  maximumBytesRead: capsulePageBytes,
});
/** One capture, publish or removal call carries at most this many row bytes. */
export const capsulePageBytes = 128 * 1024;
/** A batched scope larger than this falls back to its own paginated capture. */
const batchScopeRows = 32;
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
type Row = Record<string, unknown> & { _id: string };
type Selectable = {
  paginate(options: ReturnType<typeof capsulePageOptions>): Promise<{
    page: Row[];
    isDone: boolean;
    continueCursor: string;
  }>;
} & AsyncIterable<Row>;
function selected(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  submissionId: string,
  version: number,
  scope: CapsuleScope,
) {
  switch (scope.table) {
    case 'projectHostedLandingObservations':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_submission_and_version', q =>
          q.eq('projectId', projectId).eq('submissionId', submissionId).lte('version', version),
        );
    case 'projectHostedLandingAttempts':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_submission_and_number', q =>
          q.eq('projectId', projectId).eq('submissionId', submissionId),
        );
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
        );
    case 'projectHostedAcceptancePlans':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_receipt', q => q.eq('projectId', projectId).eq('receiptId', scope.key!));
    case 'projectHostedAcceptancePages':
      invariant(
        scope.kind === 'inputs' || scope.kind === 'dependencies',
        'BAD_ARGUMENT',
        'Select acceptance page kind.',
      );
      return ctx.db.query(scope.table).withIndex('by_project_and_receipt_and_kind_and_index', q =>
        q
          .eq('projectId', projectId)
          .eq('receiptId', scope.key!)
          .eq('kind', scope.kind as 'inputs' | 'dependencies'),
      );
    case 'projectHostedAcceptanceEvents':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_sequence', q =>
          q.eq('projectId', projectId).eq('sequence', scope.sequence!),
        );
    case 'projectHostedAcceptanceSnapshots':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_snapshot', q => q.eq('projectId', projectId).eq('snapshotId', scope.key!));
    case 'projectHostedComposePages':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_actor_and_operation_and_kind_and_index', q =>
          q.eq('projectId', projectId).eq('actor', scope.actor!).eq('operationId', scope.key!),
        );
    case 'projectHostedCheckCallbacks':
      return ctx.db
        .query(scope.table)
        .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', scope.key!));
    case 'legacyStorageCleanupPages':
      return ctx.db
        .query(scope.table)
        .withIndex('by_operation_and_part', q => q.eq('operationId', scope.key!));
  }
}
type CaptureInput = {
  projectId: Id<'hostedProjects'>;
  submissionId: string;
  version: number;
};
/** Shared preconditions; a published pointer ends capture for every caller. */
async function captureLanding(ctx: MutationCtx, input: CaptureInput) {
  const { row, state } = await loadLanding(ctx, input);
  if (row.capsule) return row.capsule;
  invariant(
    state.version === input.version && ['landed', 'terminal-failed'].includes(state.phase),
    'WORK_STALE',
    'Landing history changed before capsule capture.',
  );
  return null;
}
/** Shared scopes capture only for their claimed owner; another owner's rows stay transactional. */
async function captureScope(ctx: MutationCtx, input: CaptureInput, scope: CapsuleScope) {
  invariant(LANDING_CAPSULE_TABLES.includes(scope.table), 'BAD_ARGUMENT', 'Select one capsule table.');
  if (
    ['projectHostedComposePages', 'projectHostedCheckCallbacks'].includes(scope.table) &&
    !(await owned(ctx, input.projectId, input.submissionId, scope))
  )
    return null;
  if (scope.owner) {
    const row = await capsuleControlRow(ctx, capsuleControlKey(input.projectId, scope.owner));
    if (!row || JSON.parse(row.value).submissionId !== input.submissionId) return null;
  }
  return selected(ctx, input.projectId, input.submissionId, input.version, scope) as unknown as Selectable;
}
const kept = (input: CaptureInput, scope: CapsuleScope, row: Row) => {
  if ('eventId' in row && String(row.eventId).startsWith('reuse:')) return false;
  if (scope.table === 'legacyStorageCleanupPages')
    return 'request' in row && JSON.parse(String(row.request)).projectId === input.projectId;
  return true;
};
const captureArgs = {
  projectId: v.id('hostedProjects'),
  submissionId: v.string(),
  version: v.number(),
};
/** Canonical bytes go only to the internal packer. Capture never removes a row. */
export const page = internalMutation({
  args: { ...captureArgs, scope: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    const pointer = await captureLanding(ctx, input);
    if (pointer) return canonicalPayload({ pointer });
    const scope = JSON.parse(input.scope) as CapsuleScope;
    const query = await captureScope(ctx, input, scope);
    if (!query) return canonicalPayload({ rows: [], isDone: true, cursor: null, shared: true });
    const page = await query.paginate(capsulePageOptions(input.cursor));
    return canonicalPayload({
      rows: page.page.filter(row => kept(input, scope, row)).map(row => canonicalPayload(row)),
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    });
  },
});
/** Many small scopes in one transaction. Results answer a prefix of `scopes`; a scope over its row
 * or byte bound returns `done: false` and the packer pages it alone. Reads stop at the first such
 * scope, so one call reads at most the byte bound plus one row. */
export const pages = internalMutation({
  args: { ...captureArgs, scopes: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const pointer = await captureLanding(ctx, input);
    if (pointer) return canonicalPayload({ pointer });
    const scopes = JSON.parse(input.scopes) as CapsuleScope[];
    invariant(
      Array.isArray(scopes) && scopes.length > 0 && scopes.length <= 64,
      'BAD_ARGUMENT',
      'Select up to 64 capsule scopes.',
    );
    const results: Array<{ rows: string[]; done: true } | { done: false }> = [];
    let bytes = 0;
    for (const scope of scopes) {
      const query = await captureScope(ctx, input, scope);
      if (!query) {
        results.push({ rows: [], done: true });
        continue;
      }
      const rows: string[] = [];
      let scanned = 0,
        fits = true;
      for await (const row of query) {
        if (++scanned > batchScopeRows) fits = false;
        else if (kept(input, scope, row)) {
          const text = canonicalPayload(row);
          rows.push(text);
          bytes += new TextEncoder().encode(text).length;
          if (bytes > capsulePageBytes) fits = false;
        }
        if (!fits) break;
      }
      if (!fits) {
        results.push({ done: false });
        break;
      }
      results.push({ rows, done: true });
    }
    return canonicalPayload({ results });
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
    // The packer bootstraps the project index only when this says it is incomplete.
    const index = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_source', q => q.eq('kind', capsuleIndexKind).eq('sourceId', input.projectId))
      .unique();
    return canonicalPayload({
      anchor: state,
      request: row,
      attempt,
      receipt,
      plan,
      finish: await finishRow(ctx, input),
      indexed: !!index && JSON.parse(index.value).done === true,
    });
  },
});

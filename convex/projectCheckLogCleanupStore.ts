import { projectGuard } from './projectCheckLogCleanupGuard';
import { canonicalPayload } from '../src/hosted-source-operation';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { internalQuery, internalMutation } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { activeOwnedProject } from './projectAuthority';
import { removeExclusive } from './projectStorage';
import { r2Key } from './r2';
import { invariant } from '../src/errors';
const address = { projectId: v.id('hostedProjects'), actor: v.string() };
export const inventory = internalQuery({
  args: {
    ...address,
    kind: v.union(
      v.literal('backups'),
      v.literal('objects'),
      v.literal('states'),
      v.literal('proposals'),
      v.literal('output-streams'),
      v.literal('check-runs'),
    ),
    cursor: v.union(v.string(), v.null()),
    one: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, actor, kind, cursor, one }) => {
    const project = await activeOwnedProject(ctx, projectId, actor);
    const options = { cursor, numItems: one ? 1 : 50 };
    const page =
      kind === 'backups'
        ? await ctx.db
            .query('projectBackups')
            .withIndex('by_project', q => q.eq('projectId', projectId))
            .paginate(options)
        : kind === 'objects'
          ? await ctx.db
              .query('projectObjects')
              .withIndex('by_project', q => q.eq('projectId', projectId))
              .paginate(options)
          : kind === 'proposals'
            ? await ctx.db
                .query('projectProposals')
                .withIndex('by_project', q => q.eq('projectId', projectId))
                .paginate(options)
            : kind === 'output-streams'
              ? await ctx.db
                  .query('projectHostedOutputStreams')
                  .withIndex('by_project_and_run', q => q.eq('projectId', projectId))
                  .paginate(options)
              : kind === 'check-runs'
                ? await ctx.db
                    .query('projectHostedCheckRuns')
                    .withIndex('by_project_and_run', q => q.eq('projectId', projectId))
                    .paginate(options)
                : await ctx.db
                    .query('projectHostedStates')
                    .withIndex('by_project_and_head', q => q.eq('projectId', projectId))
                    .paginate(options);
    return JSON.stringify({ ...page, guard: await projectGuard(ctx, project) });
  },
});
export { projectGuard } from './projectCheckLogCleanupGuard';

const identity = { ...address, operationId: v.string() };
export const operation = internalQuery({
  args: identity,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const row = await ctx.db
      .query('projectCheckLogCleanups')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    return row?.value ?? null;
  },
});
export const begin = internalMutation({
  args: { ...identity, value: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const project = await activeOwnedProject(ctx, input.projectId, input.actor);
    const row = await ctx.db
      .query('projectCheckLogCleanups')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    if (row) return row.value;
    const plan = JSON.parse(input.value);
    if (!plan.totalPages) plan.phase = 'ready';
    input.value = JSON.stringify(plan);
    invariant(
      plan.guard === (await projectGuard(ctx, project)),
      'WORK_STALE',
      'Project changed during log cleanup planning.',
    );
    await ctx.db.insert('projectCheckLogCleanups', {
      projectId: input.projectId,
      operationId: input.operationId,
      value: input.value,
    });
    return input.value;
  },
});
/** Exact original row bindings fence late deletes from a replacement upload.
 * R2 cleanup uses the existing pending-key lifecycle and rotates before IO. */
export const claim = internalMutation({
  args: { ...identity, offset: v.number() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const project = await activeOwnedProject(ctx, input.projectId, input.actor);
    const ledger = await ctx.db
      .query('projectCheckLogCleanups')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    invariant(ledger, 'NOT_FOUND', 'Prepare this original log cleanup.');
    const state = JSON.parse(ledger.value);
    if (state.pending) return JSON.stringify(state.pending);
    invariant(input.offset === state.offset, 'WORK_STALE', 'Resume the original cleanup offset.');
    invariant(
      state.guard === (await projectGuard(ctx, project)),
      'WORK_STALE',
      'Project changed after cleanup planning.',
    );
    const jobs: { id: Id<'projectObjects'>; key: string }[] = [];
    invariant(state.phase === 'ready', 'WORK_STALE', 'Complete original cleanup metadata preparation first.');
    const page = await ctx.db
      .query('projectCheckLogCleanupPages')
      .withIndex('by_project_and_operation_and_part_and_position', q =>
        q
          .eq('projectId', input.projectId)
          .eq('operationId', input.operationId)
          .eq('part', 'objects')
          .eq('position', state.offset),
      )
      .unique();
    invariant(page, 'NOT_FOUND', 'Original cleanup object page is unavailable.');
    const rows = JSON.parse(page.value) as Doc<'projectObjects'>[];
    for (const original of rows) {
      const row = await ctx.db.get(original._id);
      invariant(
        row && canonicalPayload(row) === canonicalPayload(original),
        'EVIDENCE_CHANGED',
        'A selected log object changed; retain the original operation and re-observe its scope.',
      );
      if (row.storageId) {
        const removed = await removeExclusive(ctx, row.storageId, row._id);
        invariant(
          removed,
          'EVIDENCE_CHANGED',
          'A stored log has another storage owner; its bytes were preserved.',
        );
      }
      if (row.r2Key && row.r2Committed) jobs.push({ id: row._id, key: row.r2Key });
      await ctx.db.patch(row._id, {
        storageId: undefined,
        recipe: undefined,
        r2Committed: false,
        nonce: crypto.randomUUID(),
        ...(row.r2Key
          ? {
              r2SweepKey: row.r2Key,
              r2Key: `${r2Key(input.projectId, row.digest)}/u/${crypto.randomUUID()}`,
              r2PreparedAt: Date.now(),
            }
          : {}),
      });
    }
    state.pending = { jobs, nextOffset: state.offset + rows.length };
    await ctx.db.patch(ledger._id, { value: JSON.stringify(state) });
    return JSON.stringify(state.pending);
  },
});
export const complete = internalMutation({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const ledger = await ctx.db
      .query('projectCheckLogCleanups')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    invariant(ledger, 'NOT_FOUND', 'Prepare this cleanup first.');
    const state = JSON.parse(ledger.value);
    if (state.pending) {
      for (const job of state.pending.jobs) {
        const row = await ctx.db.get(job.id as Id<'projectObjects'>);
        if (row && row.r2SweepKey === job.key) await ctx.db.patch(row._id, { r2SweepKey: undefined });
      }
      state.offset = state.pending.nextOffset;
      delete state.pending;
      await ctx.db.patch(ledger._id, { value: JSON.stringify(state) });
    }
    return JSON.stringify(state);
  },
});

export const pages = internalQuery({
  args: { ...identity, cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const page = await ctx.db
      .query('projectCheckLogCleanupPages')
      .withIndex('by_project_and_operation_and_part_and_position', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .paginate({ cursor: input.cursor, numItems: 50 });
    return JSON.stringify(page);
  },
});
export const stage = internalMutation({
  args: { ...identity, part: v.string(), position: v.number(), planDigest: v.string(), value: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const project = await activeOwnedProject(ctx, input.projectId, input.actor);
    const ledger = await ctx.db
      .query('projectCheckLogCleanups')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    invariant(ledger, 'NOT_FOUND', 'Prepare this cleanup first.');
    const state = JSON.parse(ledger.value);
    invariant(
      state.planDigest === input.planDigest && state.guard === (await projectGuard(ctx, project)),
      'WORK_STALE',
      'Cleanup source or scope changed during preparation.',
    );
    const existing = await ctx.db
      .query('projectCheckLogCleanupPages')
      .withIndex('by_project_and_operation_and_part_and_position', q =>
        q
          .eq('projectId', input.projectId)
          .eq('operationId', input.operationId)
          .eq('part', input.part)
          .eq('position', input.position),
      )
      .unique();
    if (existing)
      invariant(existing.value === input.value, 'EVIDENCE_CHANGED', 'Retain the original cleanup page.');
    else {
      await ctx.db.insert('projectCheckLogCleanupPages', {
        projectId: input.projectId,
        operationId: input.operationId,
        part: input.part,
        position: input.position,
        value: input.value,
      });
      state.stagedPages++;
      if (state.stagedPages === state.totalPages) state.phase = 'ready';
      await ctx.db.patch(ledger._id, { value: JSON.stringify(state) });
    }
    return null;
  },
});

export const archive = query({
  args: { projectId: v.id('hostedProjects'), backupId: v.id('projectBackups') },
  returns: v.string(),
  handler: async (ctx, input) => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to reconcile the selected archive cleanup.');
    await activeOwnedProject(ctx, input.projectId, user.subject);
    const backup = await ctx.db.get(input.backupId);
    invariant(
      backup?.projectId === input.projectId,
      'PROJECT_UNAVAILABLE',
      'Selected archive is unavailable.',
    );
    return JSON.stringify({
      transport: backup.transport ?? 'archive',
      manifest: backup.objectManifest,
      originalDigest: backup.archiveReceipt?.digest ?? backup.digest,
      operationId: backup.archiveReceipt?.operationId,
    });
  },
});

/** Review only persisted plan pages, with fresh current owner authorization. */
export const review = query({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    planDigest: v.string(),
    part: v.union(
      v.literal('logs'),
      v.literal('shared'),
      v.literal('archives'),
      v.literal('hostedOutputs'),
      v.literal('digests'),
    ),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in as this project owner to review cleanup.');
    await activeOwnedProject(ctx, input.projectId, user.subject);
    const ledger = await ctx.db
      .query('projectCheckLogCleanups')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    const state = ledger && JSON.parse(ledger.value);
    invariant(
      state?.phase === 'ready' && state.planDigest === input.planDigest,
      'EVIDENCE_CHANGED',
      'Review the exact completed cleanup plan.',
    );
    return JSON.stringify(
      await ctx.db
        .query('projectCheckLogCleanupPages')
        .withIndex('by_project_and_operation_and_part_and_position', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId).eq('part', input.part),
        )
        .paginate({ cursor: input.cursor, numItems: 25 }),
    );
  },
});

export {
  read as planRead,
  step as planStep,
  begin as planBegin,
  lookup as planLookup,
  nodes as planNodes,
  queue as planQueue,
} from './projectCheckLogCleanupPlanStore';

// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query, mutation, internalQuery, internalMutation } from './cliServer';
import { activeOwnedProject, accessibleProject } from './projectAuthority';
import { backfillKind, backfillPin } from './r2BackfillFields';
import { tableFor, pinFor, selected, current } from './r2BackfillRows';
import { r2Enabled, r2Key, r2Config, presignPut, presignGet } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Stable project index: flipping location never changes cursor ordering. No blob reads. */
export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    kind: backfillKind,
    cursor: v.union(v.string(), v.null()),
    verify: v.boolean(),
  },
  returns: v.object({
    page: v.array(backfillPin),
    isDone: v.boolean(),
    cursor: v.string(),
    r2Writes: v.boolean(),
    r2Revision: v.number(),
  }),
  handler: async (ctx, { projectId, kind, cursor, verify }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to maintain project storage.');
      const project = await activeOwnedProject(ctx, projectId, user.subject);
      const result = await ctx.db
        .query(tableFor[kind])
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .paginate({ cursor, numItems: 100 });
      return {
        page: result.page.flatMap(row => {
          const pin = pinFor(row, kind),
            source = selected(row, kind);
          return pin && (pin.location !== 'r2' || (verify && source?.r2BackfilledAt !== undefined))
            ? [pin]
            : [];
        }),
        cursor: result.continueCursor,
        isDone: result.isDone,
        r2Writes: !!project.r2Writes && r2Enabled(),
        r2Revision: project.r2BackfillRevision ?? 0,
      };
    } catch (error) {
      return report(error);
    }
  },
});

/** Fresh signed targets stay in process memory; dry-run never calls this. */
export const targets = mutation({
  args: { projectId: v.id('hostedProjects'), pins: v.array(backfillPin) },
  returns: v.array(
    v.object({
      pin: backfillPin,
      url: v.string(),
      target: v.object({ kind: v.literal('r2'), url: v.string(), headers: v.record(v.string(), v.string()) }),
    }),
  ),
  handler: async (ctx, { projectId, pins }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to maintain project storage.');
      const project = await activeOwnedProject(ctx, projectId, user.subject);
      invariant(
        project.r2Writes && r2Enabled(),
        'R2_NOT_ENABLED',
        'Enable R2 writes for this project before backfill.',
      );
      invariant(pins.length <= 100, 'BAD_ARGUMENT', 'Backfill pages contain at most 100 rows.');
      const config = r2Config(),
        targets = [];
      for (const pin of pins) {
        const { matches, source } = await current(ctx, projectId, pin);
        if (!matches || source?.location === 'r2') continue;
        const url = await ctx.storage.getUrl(pin.storageId);
        invariant(url, 'BACKFILL_SOURCE_MISSING', 'A backfill source file is unavailable.');
        targets.push({ pin, url, target: await presignPut(config, r2Key(projectId, pin.digest), pin) });
      }
      return targets;
    } catch (error) {
      return report(error);
    }
  },
});
export const inspectRows = internalQuery({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), pins: v.array(backfillPin) },
  returns: v.array(backfillPin),
  handler: async (ctx, { projectId, actor, pins }) => {
    await activeOwnedProject(ctx, projectId, actor);
    invariant(pins.length <= 100, 'BAD_ARGUMENT', 'Backfill pages contain at most 100 rows.');
    const found = [];
    for (const pin of pins) {
      const { matches, source } = await current(ctx, projectId, pin);
      if (matches && (source?.location ?? null) === pin.location) {
        invariant(
          source?.location !== 'r2' || (source.r2Committed && source.r2Key === r2Key(projectId, pin.digest)),
          'R2_VERIFY_FAILED',
          'A backfilled row has an inconsistent R2 pointer.',
        );
        found.push(pin);
      }
    }
    return found;
  },
});
/** Only the HEAD-verifying action calls this. CAS reads at most 100 rows + project. */
export const flip = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    pins: v.array(backfillPin),
  },
  returns: v.array(v.string()),
  handler: async (ctx, { projectId, actor, operationId, pins }) => {
    const project = await activeOwnedProject(ctx, projectId, actor);
    invariant(
      project.r2Writes && r2Enabled(),
      'R2_NOT_ENABLED',
      'Enable R2 writes for this project before backfill.',
    );
    invariant(pins.length <= 100, 'BAD_ARGUMENT', 'Backfill pages contain at most 100 rows.');
    const flipped = [];
    let changed = false;
    for (const pin of pins) {
      const { row, source, matches } = await current(ctx, projectId, pin);
      if (!matches || !row) continue;
      const key = r2Key(projectId, pin.digest);
      if (source?.location === 'r2') {
        if (source.r2Committed && source.r2Key === key) flipped.push(pin.id);
        continue;
      }
      if ((source?.location ?? null) !== pin.location) continue;
      const patch = {
        location: 'r2' as const,
        r2Key: key,
        r2Committed: true,
        r2BackfilledAt: Date.now(),
        r2BackfillOperationId: operationId,
      };
      if (pin.kind === 'archives' && 'archiveReceipt' in row && row.archiveReceipt)
        await ctx.db.patch(row._id, { archiveReceipt: { ...row.archiveReceipt, ...patch } });
      else await ctx.db.patch(row._id, patch);
      changed = true;
      flipped.push(pin.id);
    }
    if (changed) await ctx.db.patch(projectId, { r2BackfillRevision: (project.r2BackfillRevision ?? 0) + 1 });
    return flipped;
  },
});

/** Archive callers retain their original access checks and Convex ids. */
export const archiveUrl = internalQuery({
  args: { storageId: v.id('_storage'), actor: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { storageId, actor }) => {
    const [backup] = await ctx.db
      .query('projectBackups')
      .withIndex('by_storage', q => q.eq('storageId', storageId))
      .take(1);
    const [proposal] = backup
      ? []
      : await ctx.db
          .query('projectProposals')
          .withIndex('by_storage', q => q.eq('storageId', storageId))
          .take(1);
    const [original] =
      backup || proposal
        ? []
        : await ctx.db
            .query('projectBackups')
            .withIndex('by_archive_storage', q => q.eq('archiveReceipt.storageId', storageId))
            .take(1);
    const row = backup ?? proposal ?? original;
    const source = original ? original.archiveReceipt : row;
    if (!row || source?.location !== 'r2' || !source.r2Committed || !source.r2Key) return null;
    await accessibleProject(ctx, row.projectId, actor);
    return presignGet(r2Config(), source.r2Key);
  },
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './server';
import { activeOwnedProject } from './projectAuthority';
import { workProject } from './projectWorkHead';
import { sourceAuthority } from '../src/hosted-source-authority';
import { invariant } from '../src/errors';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { findObject } from './projectObjectFind';
import { isStored } from './projectObjectFields';
const pin = v.object({ sha256: v.string(), size: v.number() });
const scope = { projectId: v.id('hostedProjects'), owner: v.string(), operationId: v.string() };
const row = async (ctx: MutationCtx, input: { projectId: Id<'hostedProjects'>; operationId: string }) =>
  ctx.db
    .query('projectWorkDetailMigrations')
    .withIndex('by_project_and_operation', q =>
      q.eq('projectId', input.projectId).eq('operationId', input.operationId),
    )
    .unique();
async function current(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; owner: string },
  saved: Doc<'projectWorkDetailMigrations'>,
) {
  const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, input.owner));
  invariant(
    project.work?.backupId === saved.backupId &&
      project.work.revision === saved.revision &&
      JSON.stringify(sourceAuthority(project)) === saved.authority,
    'WORK_STALE',
    'Work or source authority changed during detail migration. Staged objects remain preserved.',
  );
  return project;
}
export const begin = internalMutation({
  args: scope,
  returns: v.string(),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, input.owner));
    invariant(project.work, 'PROJECT_WORK_MISSING', 'Initialize hosted Work before migrating its details.');
    const previous = await row(ctx, input);
    if (previous) {
      // A staged copy goes first (the action deletes it), whatever changed since.
      if (!previous.root && !previous.staged) await current(ctx, input, previous);
      return JSON.stringify(previous);
    }
    // A base-checkpoint scrub (convex/projectCommentPurgeBase.ts) rewrites the base this migration would copy whole.
    invariant(
      !project.itemPurges?.some(item => item.baseScrub && !item.baseScrub.done),
      'WORK_STALE',
      'A purge is scrubbing the base checkpoint. Start the detail migration after it finishes.',
    );
    const id = await ctx.db.insert('projectWorkDetailMigrations', {
      projectId: input.projectId,
      operationId: input.operationId,
      backupId: project.work.backupId,
      revision: project.work.revision,
      authority: JSON.stringify(sourceAuthority(project)),
      collection: 0,
      offset: 0,
      pages: null,
    });
    return JSON.stringify(await ctx.db.get(id));
  },
});
export const advance = internalMutation({
  args: {
    ...scope,
    collection: v.number(),
    offset: v.number(),
    pages: pin,
    nextCollection: v.number(),
    nextOffset: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const saved = await row(ctx, input);
    invariant(saved, 'WORK_STALE', 'Resume the original detail migration.');
    await current(ctx, input, saved);
    if (
      saved.collection === input.nextCollection &&
      saved.offset === input.nextOffset &&
      saved.pages?.sha256 === input.pages.sha256
    )
      return null;
    invariant(
      !saved.root && saved.collection === input.collection && saved.offset === input.offset,
      'WORK_STALE',
      'The detail migration page already advanced; resume its saved cursor.',
    );
    await ctx.db.patch(saved._id, {
      collection: input.nextCollection,
      offset: input.nextOffset,
      pages: input.pages,
    });
    return null;
  },
});
/** The purge rule a new base must pass: no purge open now, or started after this migration began reading (it may
 * have rows this snapshot read whole). */
function noPurgeSince(project: Doc<'hostedProjects'>, saved: Doc<'projectWorkDetailMigrations'>) {
  invariant(
    !project.itemPurges?.some(item => item.purgedAt === undefined || item.startedAt >= saved._creationTime),
    'WORK_STALE',
    'An Item purge is still running on this project. Publish the detail migration after it finishes.',
  );
}

/** Record the new base's catalog root and whole Work before the action writes them (they copy every word), under the
 * same purge rule as publication; from here until publication or deletion no purge starts (noStagedMigration). One
 * staged copy per project (`stagedDetailMigration`), owned by the one step invocation (`token`) that writes it. */
export const stage = internalMutation({
  args: { ...scope, root: pin, work: pin, token: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const saved = await row(ctx, input);
    invariant(saved && !saved.root, 'WORK_STALE', 'Resume the original detail migration.');
    const project = await current(ctx, input, saved);
    invariant(
      saved.collection === 2,
      'INVALID_WORK_STORE',
      'Complete both detail collections before staging.',
    );
    noPurgeSince(project, saved);
    if (saved.staged) {
      invariant(
        saved.staged.token === input.token,
        'WORK_STALE',
        'Another run of this detail migration is writing its copy. Run the step again in a few minutes.',
      );
      return null;
    }
    const marker = (await ctx.db.get(input.projectId))?.stagedDetailMigration;
    invariant(
      !marker || marker.operationId === input.operationId,
      'WORK_STALE',
      'Another Work detail migration has a staged copy. Run its step again (it publishes or deletes the copy) first.',
    );
    const at = Date.now();
    await ctx.db.patch(saved._id, { staged: { root: input.root, work: input.work, at, token: input.token } });
    await ctx.db.patch(input.projectId, { stagedDetailMigration: { operationId: input.operationId, at } });
    return null;
  },
});

/** Delete one batch of a rejected migration's staged objects (Item b6588425 line 2e): each plain object row the copy
 * wrote goes, with its bytes, and its R2 key is kept on the row until the action has deleted it (`discardSettle`).
 * Deleted, not tombstoned: a later migration writes the same content-addressed records again. Only a plain row
 * created after the copy was staged goes; a pack member, recipe, tombstone or catalog entry stays. */
export const discardBatch = internalMutation({
  args: { ...scope, pins: v.array(pin) },
  returns: v.null(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.owner);
    const saved = await row(ctx, input);
    invariant(saved?.staged && !saved.root, 'WORK_STALE', 'This detail migration has no staged copy.');
    invariant(!saved.staged.pending, 'WORK_STALE', 'Delete the previous batch’s bytes first.');
    const deletes = new Set<string>();
    for (const target of input.pins) {
      // A tombstoned row (PURGED) or a catalog entry (no row) is not the copy's.
      const object = await findObject(ctx, input.projectId, target.sha256).catch(() => null);
      // The reference check: a row older than the staged copy was there before it (a base record, a published
      // detail catalog, another writer's object) and may be named elsewhere, so it stays.
      if (!object?._id || object._creationTime === undefined || object._creationTime < saved.staged.at)
        continue;
      if (object.pack || object.recipe || object.purged || object.packMembers) continue;
      if (object.storageId) await ctx.storage.delete(object.storageId);
      if (object.r2Key) deletes.add(object.r2Key);
      await ctx.db.delete(object._id);
    }
    await ctx.db.patch(saved._id, {
      staged: { ...saved.staged, pending: { deletes: [...deletes], zero: [] } },
    });
    return null;
  },
});

/** A staged copy's state for its deletion: whether its catalog is stored (unpurged), and the batch's R2 work. */
export const staged = internalQuery({
  args: scope,
  returns: v.object({
    catalog: v.boolean(),
    pending: v.object({
      deletes: v.array(v.string()),
      zero: v.array(v.object({ key: v.string(), offset: v.number(), size: v.number() })),
    }),
  }),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.owner);
    const saved = await ctx.db
      .query('projectWorkDetailMigrations')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    const catalog = saved?.staged
      ? await findObject(ctx, input.projectId, saved.staged.root.sha256).catch(() => null)
      : null;
    return {
      catalog: !!catalog && !catalog.removed && !catalog.purged && isStored(catalog),
      pending: saved?.staged?.pending ?? { deletes: [], zero: [] },
    };
  },
});

/** The batch's R2 bytes are gone (`done`: the whole staged copy is, and the row keeps no stage). */
export const discardSettle = internalMutation({
  args: { ...scope, done: v.boolean() },
  returns: v.null(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.owner);
    const saved = await row(ctx, input);
    if (!saved?.staged) return null;
    const staged = { ...saved.staged };
    delete staged.pending;
    await ctx.db.patch(saved._id, { staged: input.done ? undefined : staged });
    if (input.done) await clearMarker(ctx, input);
    return null;
  },
});

async function clearMarker(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; operationId: string },
) {
  const project = await ctx.db.get(input.projectId);
  if (project?.stagedDetailMigration?.operationId === input.operationId)
    await ctx.db.patch(input.projectId, { stagedDetailMigration: undefined });
}

export const publish = internalMutation({
  args: { ...scope, root: pin, token: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const saved = await row(ctx, input);
    invariant(saved, 'WORK_STALE', 'Resume the original detail migration.');
    if (saved.root) {
      await activeOwnedProject(ctx, input.projectId, input.owner);
      invariant(
        saved.root.sha256 === input.root.sha256 && saved.root.size === input.root.size,
        'WORK_OPERATION_CHANGED',
        'The detail migration retains its original root.',
      );
      return null;
    }
    const project = await current(ctx, input, saved);
    invariant(
      saved.collection === 2,
      'INVALID_WORK_STORE',
      'Complete both detail collections before publication.',
    );
    // A purge open now, or started after this migration began reading, may have rows this snapshot read whole: a new
    // stored base must not keep them. Run the migration again after the purge.
    noPurgeSince(project, saved);
    // Only the invocation that staged this copy publishes it: a stale run's copy may have been deleted meanwhile.
    invariant(
      saved.staged?.token === input.token && saved.staged.root.sha256 === input.root.sha256,
      'WORK_STALE',
      'This run’s staged copy was deleted by a later run. Run the step again.',
    );
    await ctx.db.patch(saved._id, { root: input.root, staged: undefined });
    await clearMarker(ctx, input);
    await ctx.db.patch(project._id, {
      work: {
        ...project.work!,
        recordDetails: {
          operationId: input.operationId,
          backupId: saved.backupId,
          revision: saved.revision,
          root: input.root,
        },
      },
    });
    return null;
  },
});

/** A detail migration with a staged copy of the Work (convex/projectWorkDetailMigration.ts `stage`) refuses a purge's
 * first step: the copy holds every word whole. Running the migration step again publishes or deletes it. One read
 * of the project row (its `stagedDetailMigration` marker). */
export async function noStagedMigration(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const project = await ctx.db.get(projectId);
  invariant(
    !project?.stagedDetailMigration,
    'WORK_STALE',
    'A Work detail migration has a staged copy of the Work. Run its step again (it publishes or deletes the copy), then retry the purge. Nothing was purged.',
  );
}

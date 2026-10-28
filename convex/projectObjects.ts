// SPDX-License-Identifier: Apache-2.0
import { v, type Infer } from 'convex/values';
import { blobStore } from './blobStore';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { query, mutation, internalQuery } from './cliServer';
import { activeProject, accessibleProject } from './projectAuthority';
import { objectDocument, isStored } from './projectObjectFields';
import { storageDigest, scanComplete } from './projectStorage';
import { invariant } from '../src/errors';
import { report } from './errors';
import { r2Enabled, r2Config, r2Key, presignPut, type R2Config } from './r2';
const pin = v.object({ digest: v.string(), size: v.number() });
const valid = (digest: string, size: number) =>
  /^[0-9a-f]{64}$/.test(digest) && Number.isSafeInteger(size) && size >= 0;

export const missing = query({
  args: { projectId: v.id('hostedProjects'), objects: v.array(pin) },
  returns: v.array(v.string()),
  handler: async (ctx, { projectId, objects }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
      await activeProject(ctx, projectId, user.subject);
      invariant(
        objects.length <= 100 && objects.every(p => valid(p.digest, p.size)),
        'BAD_ARGUMENT',
        'Exchange content metadata in pages of at most 100.',
      );
      const missing: string[] = [];
      for (const p of objects) {
        const row = await ctx.db
          .query('projectObjects')
          .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', p.digest))
          .unique();
        invariant(
          !row || row.size === p.size,
          'INVALID_WORK_BACKUP',
          'Content size differs from the original digest.',
        );
        if (!(row && isStored(row)) || row.removed) missing.push(p.digest);
      }
      return missing;
    } catch (error) {
      return report(error);
    }
  },
});
const preparedObject = v.object({
  id: v.id('projectObjects'),
  stored: v.boolean(),
  created: v.boolean(),
  uploadUrl: v.optional(v.string()),
  target: v.optional(
    v.object({ kind: v.literal('r2'), url: v.string(), headers: v.record(v.string(), v.string()) }),
  ),
  contentType: v.string(),
});
async function prepareObject(
  ctx: MutationCtx,
  { projectId, digest, size }: { projectId: Id<'hostedProjects'>; digest: string; size: number },
  authorized = false,
  r2: R2Config | null = null,
): Promise<Infer<typeof preparedObject>> {
  try {
    if (!authorized) {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
      const project = await activeProject(ctx, projectId, user.subject);
      r2 = r2Enabled() && project.r2Writes ? r2Config() : null;
    }
    invariant(valid(digest, size), 'BAD_ARGUMENT', 'Use the exact content digest and size.');
    let row = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', digest))
      .unique();
    invariant(
      !row || (row.size === size && !row.removed),
      'INVALID_WORK_BACKUP',
      'Content differs from its original binding.',
    );
    const created = !row;
    if (!row) {
      const id = await ctx.db.insert('projectObjects', {
        projectId,
        digest,
        size,
        nonce: crypto.randomUUID(),
        removed: false,
        ...(r2 ? { location: 'r2' as const, r2Key: r2Key(projectId, digest), r2PreparedAt: Date.now() } : {}),
      });
      row = (await ctx.db.get(id))!;
    } else if (!isStored(row) && row.location === 'r2' && !r2) {
      // Pending R2 row but R2 writes are now off: return it to the Convex path.
      await ctx.db.patch(row._id, { location: 'convex', r2Key: undefined });
      row = (await ctx.db.get(row._id))!;
    }
    if (row.location === 'r2' && !isStored(row) && r2) {
      const patch = {
        r2PreparedAt: Date.now(),
        ...(row.r2SweepKey === row.r2Key
          ? {
              r2Key: `${r2Key(projectId, digest)}/u/${crypto.randomUUID()}`,
            }
          : {}),
      };
      await ctx.db.patch(row._id, patch);
      row = (await ctx.db.get(row._id))!;
    }
    const stored = isStored(row);
    return {
      id: row._id,
      created,
      stored,
      contentType: `application/x-forge-object-${row.nonce}`,
      ...(stored
        ? {}
        : row.location === 'r2'
          ? { target: await presignPut(r2!, row.r2Key ?? r2Key(projectId, digest), { digest, size }) }
          : { uploadUrl: await blobStore(ctx).generateUploadUrl() }),
    };
  } catch (error) {
    return report(error);
  }
}
export const prepare = mutation({
  args: { projectId: v.id('hostedProjects'), ...pin.fields },
  returns: preparedObject,
  handler: (ctx, args) => prepareObject(ctx, args),
});
async function completeObject(
  ctx: MutationCtx,
  { id, storageId }: { id: Id<'projectObjects'>; storageId: Id<'_storage'> },
) {
  try {
    const user = await ctx.auth.getUserIdentity(),
      row = await ctx.db.get(id),
      project = row && (await ctx.db.get(row.projectId));
    invariant(user && row && project, 'PROJECT_UNAVAILABLE', 'This original upload is unavailable.');
    const file = await ctx.db.system.get(storageId);
    invariant(
      file &&
        file.contentType === `application/x-forge-object-${row.nonce}` &&
        file.size === row.size &&
        storageDigest(file.sha256) === row.digest,
      'INVALID_WORK_BACKUP',
      'Uploaded content differs from its project-bound digest.',
    );
    if (row.removed || ['deleting', 'deleted'].includes(project.removal ?? '')) {
      invariant(
        project.owner === user.subject,
        'PROJECT_UNAVAILABLE',
        'This upload is unavailable with current access.',
      );
      await blobStore(ctx).delete(storageId);
      return null;
    }
    await activeProject(ctx, row.projectId, user.subject);
    if (row.storageId || row.recipe) {
      if (row.storageId !== storageId) await blobStore(ctx).delete(storageId);
      return null;
    }
    await ctx.db.patch(id, { storageId });
    return null;
  } catch (error) {
    return report(error);
  }
}
const uploadedObject = v.object({ id: v.id('projectObjects'), storageId: v.id('_storage') });
export const complete = mutation({ args: uploadedObject.fields, returns: v.null(), handler: completeObject });
export const prepareBatch = mutation({
  args: { projectId: v.id('hostedProjects'), objects: v.array(pin) },
  returns: v.array(preparedObject),
  handler: async (ctx, { projectId, objects }) => {
    try {
      invariant(
        objects.length <= 100 && objects.every(p => valid(p.digest, p.size)),
        'BAD_ARGUMENT',
        'Prepare content in pages of at most 100 valid pins.',
      );
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
      // One atomic mutation has one authority snapshot for this project.
      const project = await activeProject(ctx, projectId, user.subject);
      // R2 needs the flag and the project's opt-in; a missing setting with both on fails closed.
      const r2 = r2Enabled() && project.r2Writes ? r2Config() : null;
      if (r2 && !project.r2StorageUsed) await ctx.db.patch(projectId, { r2StorageUsed: true });
      const result = [];
      for (const pin of objects) result.push(await prepareObject(ctx, { projectId, ...pin }, true, r2));
      return result;
    } catch (error) {
      return report(error);
    }
  },
});
// Read-only scheduling hints never reserve work. Narrow prepareBatch rechecks
// authority and original bindings without retaining this broad changing read set.
// Existing pending rows remain immediately eligible when no fresh rows remain.
export const available = query({
  args: { projectId: v.id('hostedProjects'), objects: v.array(pin) },
  returns: v.object({ selected: v.array(v.number()), stored: v.array(v.number()) }),
  handler: async (ctx, { projectId, objects }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
      await activeProject(ctx, projectId, user.subject);
      invariant(
        objects.length <= 100 && objects.every(p => valid(p.digest, p.size)),
        'BAD_ARGUMENT',
        'Prepare content in pages of at most 100 valid pins.',
      );
      const fresh: number[] = [],
        pending: number[] = [],
        stored: number[] = [],
        seen = new Set<string>(),
        sizes = new Map<string, number>();
      for (const [index, p] of objects.entries()) {
        invariant(
          !sizes.has(p.digest) || sizes.get(p.digest) === p.size,
          'INVALID_WORK_BACKUP',
          'Content size differs from the original digest.',
        );
        sizes.set(p.digest, p.size);
        const row = await ctx.db
          .query('projectObjects')
          .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', p.digest))
          .unique();
        invariant(
          !row || (row.size === p.size && !row.removed),
          'INVALID_WORK_BACKUP',
          'Content differs from its original binding.',
        );
        if (row && isStored(row)) stored.push(index);
        else if (!seen.has(p.digest)) {
          (row ? pending : fresh).push(index);
          seen.add(p.digest);
        }
      }
      const selected = (fresh.length ? fresh : pending).slice(0, 8);
      return { selected, stored };
    } catch (error) {
      return report(error);
    }
  },
});
export const completeBatch = mutation({
  args: { objects: v.array(uploadedObject) },
  returns: v.null(),
  handler: async (ctx, { objects }) => {
    try {
      invariant(objects.length <= 100, 'BAD_ARGUMENT', 'Complete content in pages of at most 100.');
      for (const object of objects) await completeObject(ctx, object);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const reconcile = mutation({
  args: { id: v.id('projectObjects'), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ stored: v.boolean(), isDone: v.boolean(), cursor: v.string() }),
  handler: async (ctx, { id, cursor }) => {
    try {
      const user = await ctx.auth.getUserIdentity(),
        row = await ctx.db.get(id);
      invariant(user && row, 'PROJECT_UNAVAILABLE', 'This original upload is unavailable.');
      await activeProject(ctx, row.projectId, user.subject);
      if (isStored(row)) return { stored: true, isDone: true, cursor: '' };
      // R2 rows never appear in Convex file storage; HEAD verification commits them.
      if (row.location === 'r2') return { stored: false, isDone: true, cursor: '' };
      const page = await ctx.db.system.query('_storage').order('desc').paginate({ cursor, numItems: 100 });
      const file = page.page.find(
        file =>
          file.contentType === `application/x-forge-object-${row.nonce}` &&
          file.size === row.size &&
          storageDigest(file.sha256) === row.digest,
      );
      if (file) await ctx.db.patch(id, { storageId: file._id });
      return {
        stored: !!file,
        isDone: !!file || scanComplete(page, row._creationTime),
        cursor: page.continueCursor,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const resolve = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    digests: v.array(v.string()),
    pageSize: v.optional(v.literal(1000)),
  },
  returns: v.array(objectDocument),
  handler: async (ctx, { projectId, actor, digests, pageSize }) => {
    try {
      await accessibleProject(ctx, projectId, actor);
      invariant(
        digests.length <= (pageSize ?? 100),
        'BAD_ARGUMENT',
        'Read content metadata in bounded pages.',
      );
      const rows = [];
      for (const digest of digests) {
        const row = await ctx.db
          .query('projectObjects')
          .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', digest))
          .unique();
        invariant(
          row && isStored(row) && !row.removed,
          'INVALID_WORK_BACKUP',
          'A checkpoint content object is unavailable.',
        );
        rows.push(row);
      }
      return rows;
    } catch (error) {
      return report(error);
    }
  },
});

export const authorize = internalQuery({
  args: { projectId: v.id('hostedProjects'), actor: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      await activeProject(ctx, input.projectId, input.actor);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

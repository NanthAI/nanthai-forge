// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v, type Infer } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { query, mutation, internalQuery } from './cliServer';
import { activeProject, accessibleProject, memberProject } from './projectAuthority';
import { objectDocument, isStored } from './projectObjectFields';
import { invariant } from '../src/errors';
import { report } from './errors';
import { r2Config, r2Key, presignPut, type R2Config } from './r2';
import { pointObject } from './projectObjectPointBinding';
import { findObject, findStoredObjects, findStoredObject } from './projectObjectFind';
import { chargeStorage, checkObjectSize } from './abuseLimits';
import { preparePack, uploadPackProposal } from './projectObjectPacks';
import type { UploadPackProposal } from '../src/object-pack-upload';
import { requireCatalogSeed } from './projectHostedSeedObjects';
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
        const row = await findObject(ctx, projectId, p.digest);
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
  /** Absent when a catalog or point entry already stores the object (Item d0297b9f; the catalog
   * seed shortcut has the same shape): no upload, no row. Clients read `stored` before any `id`. */
  id: v.optional(v.id('projectObjects')),
  stored: v.boolean(),
  created: v.boolean(),
  target: v.optional(
    v.object({ kind: v.literal('r2'), url: v.string(), headers: v.record(v.string(), v.string()) }),
  ),
  contentType: v.string(),
  /** Feature upload-packs: this object is a member of the upload pack whose pending row is `id`;
   * the first member carries the pack's one PUT target. */
  pack: v.optional(v.object({ digest: v.string(), size: v.number(), offset: v.number() })),
});
/** Object rows this transaction already looked up by digest (null: none), so preparing their
 * targets does not look them up again. A prepared digest is removed: a repeat reads it fresh. */
export type KnownObjects = Map<string, Awaited<ReturnType<typeof findObject>>>;
async function prepareObject(
  ctx: MutationCtx,
  { projectId, digest, size }: { projectId: Id<'hostedProjects'>; digest: string; size: number },
  authorized = false,
  r2?: R2Config,
  known?: KnownObjects,
  seedOperationId?: string,
): Promise<Infer<typeof preparedObject>> {
  try {
    if (!authorized) {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
      await activeProject(ctx, projectId, user.subject);
      r2 ??= r2Config();
    }
    invariant(valid(digest, size), 'BAD_ARGUMENT', 'Use the exact content digest and size.');
    const cached = known?.get(digest);
    known?.delete(digest);
    const found = cached !== undefined ? cached : await findObject(ctx, projectId, digest);
    invariant(
      !found || (found.size === size && !found.removed),
      'INVALID_WORK_BACKUP',
      'Content differs from its original binding.',
    );
    // Catalog and point entries are always stored: answer without copying one into a row.
    if (found && found._id === undefined) return { stored: true, created: false, contentType: '' };
    let row = found;
    const created = !row;
    if (!row) {
      checkObjectSize(size);
      const id = await ctx.db.insert('projectObjects', {
        projectId,
        digest,
        size,
        nonce: crypto.randomUUID(),
        removed: false,
        location: 'r2' as const,
        r2Key: r2Key(projectId, digest),
        r2PreparedAt: Date.now(),
        ...(seedOperationId ? { seedOperationId } : {}),
      });
      row = (await ctx.db.get(id))!;
    } else if (!isStored(row) && row.location !== 'r2') {
      // A pending reservation from before R2 was the only path now uploads to R2.
      await ctx.db.patch(row._id, {
        location: 'r2',
        r2Key: r2Key(projectId, digest),
        r2PreparedAt: Date.now(),
      });
      row = (await ctx.db.get(row._id))!;
    }
    if (row.location === 'r2' && !isStored(row)) {
      const patch = {
        r2PreparedAt: Date.now(),
        ...(row.seedOperationId !== seedOperationId ? { seedOperationId: undefined } : {}),
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
        : {
            target: await presignPut(r2 ?? r2Config(), row.r2Key ?? r2Key(projectId, digest), {
              digest,
              size,
            }),
          }),
    };
  } catch (error) {
    return report(error);
  }
}
export const prepare = mutation({
  args: { projectId: v.id('hostedProjects'), ...pin.fields },
  returns: preparedObject,
  handler: async (ctx, args) => {
    const prepared = await prepareObject(ctx, args);
    try {
      if (prepared.created) await chargeStorage(ctx, (await ctx.db.get(args.projectId))!, [args.size]);
      return prepared;
    } catch (error) {
      return report(error);
    }
  },
});
export const prepareBatch = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    objects: v.array(pin),
    /** Feature upload-packs: send these objects as one pack (see src/object-pack-upload.ts). */
    pack: v.optional(uploadPackProposal),
    seedOperationId: v.optional(v.string()),
  },
  returns: v.array(preparedObject),
  handler: async (ctx, { projectId, objects, pack, seedOperationId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
      if (!seedOperationId) return await prepareObjectTargets(ctx, projectId, user.subject, objects, pack);
      await requireCatalogSeed(ctx, projectId, user.subject, seedOperationId, true);
      invariant(
        objects.length <= 100 && objects.every(p => valid(p.digest, p.size)),
        'BAD_ARGUMENT',
        'Prepare content in pages of at most 100 valid pins.',
      );
      const rows = await findStoredObjects(
        ctx,
        projectId,
        objects.map(pin => pin.digest),
      );
      const known: KnownObjects = new Map();
      const pending = objects.filter((pin, index) => {
        const row = rows[index] ?? null;
        invariant(
          !row || (row.size === pin.size && !row.removed),
          'INVALID_WORK_BACKUP',
          'Content differs from its original binding.',
        );
        known.set(pin.digest, row);
        return !row || !isStored(row);
      });
      const prepared = await prepareObjectTargets(
        ctx,
        projectId,
        user.subject,
        pending,
        pending.length === objects.length ? pack : undefined,
        known,
        seedOperationId,
      );
      let next = 0;
      return rows.map(row =>
        row && isStored(row) ? { stored: true, created: false, contentType: '' } : prepared[next++]!,
      );
    } catch (error) {
      return report(error);
    }
  },
});
export type PreparedObject = Infer<typeof preparedObject>;
/** The `prepareBatch` transaction for an authenticated actor, also run inside a save or sync
 * prepare that hands back its upload targets (feature prepare-upload-targets): one row per pin, in
 * order, each stored or with its create-only, checksum-bound R2 PUT target. With an eligible
 * `pack` (feature upload-packs), its members (and repeats of their digests) are pack rows instead. */
export async function prepareObjectTargets(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  objects: readonly { digest: string; size: number }[],
  pack?: UploadPackProposal,
  known?: KnownObjects,
  seedOperationId?: string,
): Promise<PreparedObject[]> {
  invariant(
    objects.length <= 100 && objects.every(p => valid(p.digest, p.size)),
    'BAD_ARGUMENT',
    'Prepare content in pages of at most 100 valid pins.',
  );
  // One atomic mutation has one authority snapshot for this project.
  const project = await activeProject(ctx, projectId, actor);
  if (!objects.length) return [];
  // Every project writes R2, including legacy projects created before R2 was the only path.
  const r2 = r2Config();
  const packed = pack ? await preparePack(ctx, projectId, objects, pack, r2, seedOperationId, known) : null;
  const result: PreparedObject[] = [],
    reserved: number[] = [...(packed?.reserved ?? [])];
  for (const pin of objects) {
    const member = packed?.byDigest.get(pin.digest);
    if (member) {
      // The pack's one PUT target rides on its first row; a repeated digest names the same offset.
      result.push(result.some(prior => prior.pack) ? member : { ...member, target: packed!.target });
      continue;
    }
    const prepared = await prepareObject(ctx, { projectId, ...pin }, true, r2, known, seedOperationId);
    if (prepared.created) reserved.push(pin.size);
    result.push(prepared);
  }
  // A batch over quota throws here, so none of its reservations are kept.
  await chargeStorage(ctx, project, reserved);
  return result;
}
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
        const row = await findObject(ctx, projectId, p.digest);
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
export const reconcile = mutation({
  args: { id: v.id('projectObjects'), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ stored: v.boolean(), isDone: v.boolean(), cursor: v.string() }),
  handler: async (ctx, { id }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      let row: import('./projectObjectFind').ObjectView | null = await ctx.db.get(id);
      if (!row && user) {
        const receipt = await ctx.db
          .query('projectObjectReceipts')
          .withIndex('by_key', q => q.eq('key', id))
          .unique();
        if (receipt) {
          await activeProject(ctx, receipt.projectId, user.subject);
          row = receipt.sourceBinding
            ? pointObject(receipt, receipt.projectId, receipt.value)
            : await findStoredObject(ctx, receipt.projectId, receipt.value);
          invariant(
            row && (receipt.size === undefined || row.size === receipt.size),
            'PROJECT_UNAVAILABLE',
            'This original upload is unavailable.',
          );
          return { stored: isStored(row), isDone: true, cursor: '' };
        }
      }
      invariant(user && row, 'PROJECT_UNAVAILABLE', 'This original upload is unavailable.');
      await activeProject(ctx, row.projectId, user.subject);
      if (isStored(row)) return { stored: true, isDone: true, cursor: '' };
      // Bytes only reach R2, where create-only PUTs and HEAD verification commit them.
      return { stored: false, isDone: true, cursor: '' };
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
    memberOnly: v.optional(v.boolean()),
  },
  returns: v.array(objectDocument),
  handler: async (ctx, { projectId, actor, digests, pageSize, memberOnly }) => {
    try {
      await (memberOnly ? memberProject : accessibleProject)(ctx, projectId, actor);
      invariant(
        digests.length <= (pageSize ?? 100),
        'BAD_ARGUMENT',
        'Read content metadata in bounded pages.',
      );
      const rows = [];
      for (const digest of digests) {
        const row = await findStoredObject(ctx, projectId, digest);
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

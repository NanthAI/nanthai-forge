// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Only verified legacy-reader materialization and server-built artifacts call these.
// It shares object bindings and explicit project cleanup with ordinary uploads.
import { v, type Infer } from 'convex/values';
import { internalMutation } from './server';
import { accessibleProject } from './projectAuthority';
import { isStored } from './projectObjectFields';
import { r2Config, r2Key } from './r2';
import { invariant } from '../src/errors';
import { findObject } from './projectObjectFind';
const prepared = v.object({
  /** Absent when a stored catalog or point entry already binds the object: nothing uploads. */
  id: v.optional(v.id('projectObjects')),
  stored: v.boolean(),
  created: v.boolean(),
  contentType: v.string(),
  r2Key: v.optional(v.string()),
});
export const prepare = internalMutation({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), digest: v.string(), size: v.number() },
  returns: prepared,
  handler: async (ctx, input): Promise<Infer<typeof prepared>> => {
    await accessibleProject(ctx, input.projectId, input.actor);
    r2Config();
    invariant(
      /^[0-9a-f]{64}$/.test(input.digest) && Number.isSafeInteger(input.size) && input.size >= 0,
      'INVALID_WORK_BACKUP',
      'Use verified logical metadata pins.',
    );
    const found = await findObject(ctx, input.projectId, input.digest);
    invariant(
      !found || (found.size === input.size && !found.removed),
      'INVALID_WORK_BACKUP',
      'Logical metadata differs from its original object binding.',
    );
    // A stored catalog or point entry needs no upload and no row (Item d0297b9f).
    if (found && found._id === undefined) return { created: false, stored: true, contentType: '' };
    let row = found;
    const created = !row;
    if (!row) {
      const id = await ctx.db.insert('projectObjects', {
        projectId: input.projectId,
        digest: input.digest,
        size: input.size,
        nonce: crypto.randomUUID(),
        removed: false,
        location: 'r2' as const,
        r2Key: r2Key(input.projectId, input.digest),
      });
      row = (await ctx.db.get(id))!;
    }
    if (!isStored(row) && row.location !== 'r2') {
      await ctx.db.patch(row._id, { location: 'r2', r2Key: r2Key(input.projectId, input.digest) });
      row = (await ctx.db.get(row._id))!;
    }
    return {
      id: row._id,
      created,
      stored: isStored(row),
      contentType: `application/x-forge-object-${row.nonce}`,
      ...(row.location === 'r2' ? { r2Key: row.r2Key } : {}),
    };
  },
});

/** Internal actions call this only after a successful signed HEAD verification. */
export const completeR2 = internalMutation({
  args: { id: v.id('projectObjects'), actor: v.string(), key: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, actor, key }) => {
    const row = await ctx.db.get(id);
    invariant(
      row && !row.removed && row.location === 'r2' && row.r2Key === key,
      'INVALID_WORK_BACKUP',
      'Original artifact object binding changed.',
    );
    await accessibleProject(ctx, row.projectId, actor);
    if (!row.r2Committed) await ctx.db.patch(id, { r2Committed: true });
    return null;
  },
});

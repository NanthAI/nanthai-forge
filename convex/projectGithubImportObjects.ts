// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './server';
import { activeOwnedProject } from './projectAuthority';
import { isStored } from './projectObjectFields';
import { invariant } from '../src/errors';
import { findObject } from './projectObjectFind';
const pin = { projectId: v.id('hostedProjects'), actor: v.string(), digest: v.string(), size: v.number() };
/** Internal only: the importer has verified these bytes against the Git object.
 * No cross-project digest-existence oracle is exposed to clients. */
export const reuse = internalMutation({
  args: pin,
  returns: v.boolean(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const bound = await findObject(ctx, input.projectId, input.digest);
    if (bound) {
      invariant(
        bound.size === input.size && !bound.removed,
        'INVALID_WORK_BACKUP',
        'Object binding changed.',
      );
      if (isStored(bound)) return true;
    }
    // New bytes always upload to R2; only an already stored binding is reused.
    return false;
  },
});
export const stored = internalQuery({
  args: pin,
  returns: v.boolean(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const row = await findObject(ctx, input.projectId, input.digest);
    return !!(row && !row.removed && row.size === input.size && isStored(row));
  },
});

/** Reserve the nonce before storage so explicit project removal can reconcile
 * uploads whose action stopped before recording their storage ID. */
export const reserve = internalMutation({
  args: pin,
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const row = await findObject(ctx, input.projectId, input.digest);
    if (row) {
      invariant(row.size === input.size && !row.removed, 'INVALID_WORK_BACKUP', 'Object binding changed.');
      return row.nonce;
    }
    const nonce = crypto.randomUUID();
    await ctx.db.insert('projectObjects', {
      projectId: input.projectId,
      digest: input.digest,
      size: input.size,
      nonce,
      removed: false,
    });
    return nonce;
  },
});

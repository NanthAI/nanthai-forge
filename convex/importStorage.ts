// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Indexed imports predate hostedProjects. Their owner controls the equivalent
 * opt-in; Zones and source-agent grants retain the import's exact artifact. */
export const setR2Writes = mutation({
  args: { id: v.id('imports'), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { id, enabled }) => {
    try {
      const user = await ctx.auth.getUserIdentity(),
        job = await ctx.db.get(id);
      invariant(
        user && job && !job.removal && job.owner === user.subject,
        'IMPORT_UNAVAILABLE',
        'This import is unavailable with current access.',
      );
      if ((job.r2Writes ?? false) !== enabled) await ctx.db.patch(id, { r2Writes: enabled });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

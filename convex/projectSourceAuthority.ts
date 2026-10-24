// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { sourceAuthority } from '../src/hosted-source-authority';
import { sourceAuthority as authorityValidator } from './projectSourceAuthorityFields';
import { invariant } from '../src/errors';
import { report } from './errors';

/** One authorized project-row lookup, with no history scan or read-time migration. */
export const current = query({
  args: { projectId: v.id('hostedProjects') },
  returns: authorityValidator,
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read source authority.');
      return sourceAuthority(await accessibleProject(ctx, projectId, user.subject));
    } catch (error) {
      return report(error);
    }
  },
});

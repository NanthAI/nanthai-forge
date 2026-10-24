// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { report } from './errors';
import { mutation } from './cliServer';
import { createProject } from './projectCreation';
import { invariant } from '../src/errors';
export const open = mutation({
  args: { key: v.string(), name: v.string() },
  returns: v.id('hostedProjects'),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(
        user && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.key) && input.name.trim(),
        'BAD_ARGUMENT',
        'Select an original project key and name.',
      );
      const project = await createProject(ctx, {
        owner: user.subject,
        key: input.key,
        name: input.name.trim(),
      });
      invariant(
        project.name === input.name.trim(),
        'PROJECT_CHANGED',
        'Select this project’s original name.',
      );
      return project._id;
    } catch (error) {
      return report(error);
    }
  },
});

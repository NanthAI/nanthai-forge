// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { accessibleProject, activeOwnedProject } from './projectAuthority';
import { sourceAuthority, nextSourceAuthority, requireSourceAuthority } from '../src/hosted-source-authority';
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

/** Explicit owner CAS; receipts outlive later transitions, including rollback. */
export const transition = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    expected: authorityValidator,
    mode: authorityValidator.fields.mode,
  },
  returns: authorityValidator,
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to change source authority.');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      invariant(
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId),
        'BAD_ARGUMENT',
        'Retain the authority transition operation UUID.',
      );
      const old = await ctx.db
        .query('projectSourceAuthorityTransitions')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      if (old) {
        invariant(
          old.expected.mode === input.expected.mode &&
            old.expected.epoch === input.expected.epoch &&
            old.authority.mode === input.mode,
          'WORK_OPERATION_CHANGED',
          'Replay the original authority transition and expected epoch.',
        );
        return old.authority;
      }
      const current = requireSourceAuthority(project, input.expected);
      const authority = nextSourceAuthority(current, input.expected, input.mode);
      await ctx.db.patch(project._id, { sourceAuthority: authority });
      await ctx.db.insert('projectSourceAuthorityTransitions', {
        projectId: input.projectId,
        operationId: input.operationId,
        expected: input.expected,
        authority,
      });
      return authority;
    } catch (error) {
      return report(error);
    }
  },
});

// SPDX-License-Identifier: AGPL-3.0-only
import { accountFor } from './urlIdentity';
import { hostedProjectRoot } from '../src/project-routes';
import { v } from 'convex/values';
import { mutation, guard, isDeviceIdentity } from './cliServer';
import { createProject } from './projectCreation';
import { invariant } from '../src/errors';
import { report } from './errors';

export const create = mutation({
  args: {
    operationId: v.string(),
    name: v.string(),
    visibility: v.union(v.literal('private'), v.literal('public')),
  },
  returns: v.object({ projectId: v.id('hostedProjects'), projectUrl: v.string() }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(
        user && isDeviceIdentity(user),
        'AUTH_REQUIRED',
        'Run nforge login with cli scope before hosting.',
      );
      await guard(ctx, 'cli');
      invariant(
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId) && input.name.trim(),
        'BAD_ARGUMENT',
        'Use an original hosting operation UUID and project name.',
      );
      const request = JSON.stringify([input.name.trim(), input.visibility]);
      const project = await createProject(ctx, {
        owner: user.subject,
        key: input.operationId,
        name: input.name.trim(),
        visibility: input.visibility,
      });
      invariant(
        !project.hostingRequest || project.hostingRequest === request,
        'WORK_OPERATION_CHANGED',
        'Retry hosting with its original name and visibility.',
      );
      await ctx.db.patch(project._id, { hostingRequest: request });
      const web = process.env.FORGE_WEB_URL ?? process.env.SITE_URL;
      invariant(web, 'HOST_CONFIGURATION', 'Configure FORGE_WEB_URL for hosted project links.');
      const url = new URL(web);
      const account = await accountFor(ctx, project.owner);
      url.pathname = hostedProjectRoot(account!.handle, project.slug!);
      url.search = '';
      url.hash = '';
      return { projectId: project._id, projectUrl: url.href };
    } catch (error) {
      return report(error);
    }
  },
});

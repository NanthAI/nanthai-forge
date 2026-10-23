// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, mutation } from './cliServer';
import { clientErrorKind } from './clientErrorFields';
import { accessibleProject, ownedProject } from './projectAuthority';
import { report as reportError } from './errors';
import { invariant } from '../src/errors';
import { clientErrorLimits as limit, clip, scrubRoute, scrubText } from '../src/client-error-text';

const optionalText = (value: string | undefined, max: number) => {
  const text = value === undefined ? '' : scrubText(value, max).trim();
  return text ? text : undefined;
};

/** Record one browser failure for the signed-in caller. Anonymous reports are dropped. */
export const report = mutation({
  args: {
    operationId: v.string(),
    kind: clientErrorKind,
    message: v.string(),
    stack: v.optional(v.string()),
    route: v.string(),
    build: v.string(),
    projectId: v.optional(v.string()),
    functionName: v.optional(v.string()),
    code: v.optional(v.string()),
  },
  returns: v.union(v.null(), v.id('clientErrors')),
  handler: async (ctx, args) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      if (!user) return null;
      invariant(
        /^[\w-]{8,64}$/.test(args.operationId),
        'BAD_ARGUMENT',
        'Use a client-generated operation ID.',
      );
      const existing = await ctx.db
        .query('clientErrors')
        .withIndex('by_user_and_operationId', q =>
          q.eq('user', user.subject).eq('operationId', args.operationId),
        )
        .unique();
      if (existing) return existing._id;
      // A project is attached only under current access, so its owner never sees reports about projects the caller cannot read.
      const id = args.projectId ? ctx.db.normalizeId('hostedProjects', args.projectId) : null;
      const projectId = id
        ? await accessibleProject(ctx, id, user.subject).then(
            () => id,
            () => undefined,
          )
        : undefined;
      const stack = optionalText(args.stack, limit.stack),
        functionName = optionalText(args.functionName, limit.functionName),
        code = optionalText(args.code, limit.code);
      return await ctx.db.insert('clientErrors', {
        user: user.subject,
        operationId: args.operationId,
        ...(projectId ? { projectId } : {}),
        kind: args.kind,
        message: scrubText(args.message, limit.message) || 'Unknown error',
        ...(stack ? { stack } : {}),
        route: scrubRoute(args.route),
        build: clip(args.build.replace(/[^\w.-]/g, ''), limit.build) || 'unknown',
        ...(functionName ? { functionName } : {}),
        ...(code ? { code } : {}),
      });
    } catch (error) {
      return reportError(error);
    }
  },
});

const recentRow = v.object({
  id: v.id('clientErrors'),
  at: v.number(),
  kind: clientErrorKind,
  message: v.string(),
  stack: v.optional(v.string()),
  route: v.string(),
  build: v.string(),
  functionName: v.optional(v.string()),
  code: v.optional(v.string()),
  reportedByYou: v.boolean(),
});

/** Newest first. Owner only; other reporters stay unnamed so this does not reveal who visited. */
export const recent = query({
  args: { projectId: v.id('hostedProjects'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(recentRow),
  handler: async (ctx, { projectId, paginationOpts }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project errors.');
      await ownedProject(ctx, projectId, user.subject);
      const result = await ctx.db
        .query('clientErrors')
        .withIndex('by_projectId', q => q.eq('projectId', projectId))
        .order('desc')
        .paginate(paginationOpts);
      return {
        ...result,
        page: result.page.map(row => ({
          id: row._id,
          at: row._creationTime,
          kind: row.kind,
          message: row.message,
          ...(row.stack === undefined ? {} : { stack: row.stack }),
          route: row.route,
          build: row.build,
          ...(row.functionName === undefined ? {} : { functionName: row.functionName }),
          ...(row.code === undefined ? {} : { code: row.code }),
          reportedByYou: row.user === user.subject,
        })),
      };
    } catch (error) {
      return reportError(error);
    }
  },
});

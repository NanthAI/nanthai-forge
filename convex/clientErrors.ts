// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, mutation } from './cliServer';
import { clientErrorKind } from './clientErrorFields';
import { accessibleProject, ownedProject, requireDeviceWrite } from './projectAuthority';
import { assertAccountActive } from './accountLimits';
import { requireAccountWriteAccess } from './accessPolicy';
import { projectRole } from './projectRole';
import { report as reportError } from './errors';
import { invariant } from '../src/errors';
import { clientErrorLimits as limit, clip, scrubRoute, scrubText } from '../src/client-error-text';
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';

const dayMs = 86_400_000;
const accountReportCap = 100;
const projectReportCap = 1_000;

async function reportPositions(
  ctx: MutationCtx,
  user: string,
  projectId: Id<'hostedProjects'> | undefined,
  reportDay: number,
) {
  // Index tails give both counters from the reports themselves, so an accepted report needs
  // only its original insert. Concurrent inserts into these ranges conflict and retry.
  const [account] = await ctx.db
    .query('clientErrors')
    .withIndex('by_user_reportDay_accountPosition', q => q.eq('user', user).eq('reportDay', reportDay))
    .order('desc')
    .take(1);
  const accountPosition = (account && 'accountPosition' in account ? (account.accountPosition ?? 0) : 0) + 1;
  if (accountPosition > accountReportCap) return null;
  if (!projectId) return { reportDay, accountPosition };
  const [project] = await ctx.db
    .query('clientErrors')
    .withIndex('by_projectId_reportDay_projectPosition', q =>
      q.eq('projectId', projectId).eq('reportDay', reportDay),
    )
    .order('desc')
    .take(1);
  const projectPosition = (project && 'projectPosition' in project ? (project.projectPosition ?? 0) : 0) + 1;
  return projectPosition > projectReportCap ? null : { reportDay, accountPosition, projectPosition };
}

async function recordDrop(ctx: MutationCtx, user: string, operationId: string, dropDay: number) {
  // Keep one compact receipt for retry reconciliation, with no diagnostic payload or project attribution.
  const [previous] = await ctx.db
    .query('clientErrors')
    .withIndex('by_user_dropDay_dropPosition', q => q.eq('user', user).eq('dropDay', dropDay))
    .order('desc')
    .take(1);
  const dropPosition = (previous && 'dropPosition' in previous ? previous.dropPosition : 0) + 1;
  await ctx.db.insert('clientErrors', { user, operationId, dropDay, dropPosition });
  return null;
}

const optionalText = (value: string | undefined, max: number) => {
  const text = value === undefined ? '' : scrubText(value, max).trim();
  return text ? text : undefined;
};

/** Record one browser failure for the signed-in caller. Anonymous and excess reports are dropped. */
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
      if (existing) return 'dropPosition' in existing ? null : existing._id;
      await assertAccountActive(ctx, user.subject);
      const id = args.projectId ? ctx.db.normalizeId('hostedProjects', args.projectId) : null;
      if (id) await requireDeviceWrite(ctx, id);
      else requireAccountWriteAccess(ctx.forgeDevice);
      // Public source visibility alone cannot put a visitor's report in the owner's error feed.
      const project = id && (await accessibleProject(ctx, id, user.subject).catch(() => null));
      const projectId =
        project && (project.visibility !== 'public' || (await projectRole(ctx, project, user.subject)))
          ? project._id
          : undefined;
      const reportDay = Math.floor(Date.now() / dayMs) * dayMs;
      const positions = await reportPositions(ctx, user.subject, projectId, reportDay);
      if (!positions) return await recordDrop(ctx, user.subject, args.operationId, reportDay);
      const stack = optionalText(args.stack, limit.stack),
        functionName = optionalText(args.functionName, limit.functionName),
        code = optionalText(args.code, limit.code);
      return await ctx.db.insert('clientErrors', {
        user: user.subject,
        operationId: args.operationId,
        ...(projectId ? { projectId } : {}),
        ...positions,
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
        page: result.page
          .filter(row => 'kind' in row)
          .map(row => ({
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

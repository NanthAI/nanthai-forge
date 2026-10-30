// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query, mutation, type QueryCtx, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/hash';
import { hostedBillSchema } from '../src/self-metrics-bills';
import { invariant } from '../src/errors';
import { report } from './errors';

const lookbackMs = 366 * 86400000;
async function reader(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project metrics.');
  const project = await accessibleProject(ctx, projectId, user.subject);
  return { project, actor: user.subject };
}
/** Owner-entered provider bill: one small idempotent write, zero provider API calls. */
export const record = mutation({
  args: { projectId: v.id('hostedProjects'), bill: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { project, actor } = await reader(ctx, input.projectId);
      invariant(project.owner === actor, 'PROJECT_UNAVAILABLE', 'Only the project owner records bills.');
      const bill = hostedBillSchema.parse(JSON.parse(input.bill));
      const value = canonicalPayload(bill),
        hash = digest(value);
      const old = await ctx.db
        .query('projectSelfMetricBills')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', bill.operationId),
        )
        .unique();
      if (old) {
        invariant(old.digest === hash, 'WORK_OPERATION_CHANGED', 'Retry the original bill payload.');
        return canonicalPayload({ ...JSON.parse(old.value), at: old.at, actor: old.actor, replayed: true });
      }
      const at = new Date().toISOString();
      await ctx.db.insert('projectSelfMetricBills', {
        projectId: input.projectId,
        operationId: bill.operationId,
        provider: bill.provider,
        periodFrom: bill.periodFrom,
        actor,
        at,
        digest: hash,
        value,
      });
      return canonicalPayload({ ...bill, at, actor, replayed: false });
    } catch (error) {
      return report(error);
    }
  },
});
/** Bills whose period starts within a year before `to`; the reader keeps overlaps. */
export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    from: v.string(),
    to: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { project, actor } = await reader(ctx, input.projectId);
      if (project.owner !== actor) {
        const member = await ctx.db
          .query('projectContributors')
          .withIndex('by_project_and_contributor', q =>
            q.eq('projectId', input.projectId).eq('contributor', actor),
          )
          .unique();
        invariant(
          member?.agentGuidanceMaintainer === true,
          'PROJECT_UNAVAILABLE',
          'Project metrics require owner or maintainer access.',
        );
      }
      const from = Date.parse(input.from),
        to = Date.parse(input.to);
      invariant(
        Number.isFinite(from) && Number.isFinite(to) && from < to,
        'BAD_ARGUMENT',
        'Use a finite metrics window [from,to).',
      );
      const rows = await ctx.db
        .query('projectSelfMetricBills')
        .withIndex('by_project_and_period', q =>
          q
            .eq('projectId', input.projectId)
            .gte('periodFrom', new Date(from - lookbackMs).toISOString())
            .lt('periodFrom', new Date(to).toISOString()),
        )
        .paginate({
          cursor: input.cursor,
          numItems: 100,
          maximumRowsRead: 100,
          maximumBytesRead: 512 * 1024,
        });
      return canonicalPayload({
        page: rows.page.map(row => ({ ...JSON.parse(row.value), at: row.at, actor: row.actor })),
        isDone: rows.isDone,
        continueCursor: rows.continueCursor,
      });
    } catch (error) {
      return report(error);
    }
  },
});

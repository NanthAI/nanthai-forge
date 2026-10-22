// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query, type QueryCtx, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { hostedWriteProject } from './projectHostedRecords';
import { checkSetting, loadHostedCheck, type CheckIdentity } from './projectHostedCheckStore';
import { exactHostedCheckEvidence } from '../src/hosted-check-evidence';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

const identity = { projectId: v.id('hostedProjects'), runId: v.string() };
async function reader(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted checks.');
  await accessibleProject(ctx, projectId, user.subject);
}
export const status = query({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await reader(ctx, input.projectId);
      return canonicalPayload((await loadHostedCheck(ctx, input)).run);
    } catch (error) {
      return report(error);
    }
  },
});
export const shards = query({
  args: { ...identity, cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await reader(ctx, input.projectId);
      await loadHostedCheck(ctx, input);
      const page = await ctx.db
        .query('projectHostedCheckShards')
        .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
        .paginate({
          cursor: input.cursor,
          numItems: 100,
          maximumRowsRead: 100,
          maximumBytesRead: 128 * 1024,
        });
      return canonicalPayload({ ...page, page: page.page.map(row => JSON.parse(row.value)) });
    } catch (error) {
      return report(error);
    }
  },
});
export const list = query({
  args: { projectId: v.id('hostedProjects'), candidateId: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await reader(ctx, input.projectId);
      const page = await ctx.db
        .query('projectHostedCheckRuns')
        .withIndex('by_project_and_candidate', q =>
          q.eq('projectId', input.projectId).eq('candidateId', input.candidateId),
        )
        .paginate({
          cursor: input.cursor,
          numItems: 100,
          maximumRowsRead: 100,
          maximumBytesRead: 128 * 1024,
        });
      return canonicalPayload({
        ...page,
        page: page.page.map(row => ({
          runId: row.runId,
          candidateId: row.candidateId,
          status: row.status,
        })),
      });
    } catch (error) {
      return report(error);
    }
  },
});
/** H13/H14 call this inside their own transaction, then independently check
 * current landing policy and main head+receipt. A result never grants acceptance. */
export async function requireHostedCheckEvidence(
  ctx: QueryCtx | MutationCtx,
  input: CheckIdentity & {
    actor: string;
    candidateId: string;
    head: string;
    checkId: string;
    definition: string;
    configuration: string;
    environment: string;
    authorityEpoch: number;
  },
) {
  await hostedWriteProject(ctx, input.projectId, input.actor, input.authorityEpoch);
  const { run } = await loadHostedCheck(ctx, input);
  await hostedWriteProject(ctx, input.projectId, run.actor, input.authorityEpoch);
  const check = await checkSetting(ctx, input.projectId, 'definition', input.checkId);
  const runner = await checkSetting(ctx, input.projectId, 'runner', 'runner');
  invariant(
    check?.digest === input.definition && runner?.digest === input.configuration,
    'EVIDENCE_CHANGED',
    'The current check definition or runner configuration changed.',
  );
  return exactHostedCheckEvidence(run, input);
}

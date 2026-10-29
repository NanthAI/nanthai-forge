// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { writableHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { directActions } from './projectHostedActionsDirect';
import { actionsClaimsSchema, validateActionsClaims } from '../src/github-actions-oidc';
import { invariant } from '../src/errors';
import { githubHostedRunsOn } from '../src/github-actions-runner-label';
import { hostedActionsCapabilities } from '../src/hosted-actions-capabilities';
import { latestSourcePack } from './projectSourcePackStore';
import { hostedTimingHistory } from './projectHostedTestTimings';
export const sessionArgs = {
  projectId: v.id('hostedProjects'),
  runId: v.string(),
  claims: v.string(),
  fence: v.optional(v.number()),
};
export type SessionInput = { projectId: Id<'hostedProjects'>; runId: string; claims: string; fence?: number };
/** HTTP verifies the JWT signature. Every transaction rechecks current epoch,
 * original actor authority, dispatch fence, and exact repository/workflow/run. */
export async function actionsSession(ctx: MutationCtx, input: SessionInput) {
  const selected = await writableHostedCheck(ctx, input),
    { row, run } = selected;
  invariant(
    directActions(run) &&
      run.configuration.provider === 'github-actions' &&
      run.dispatchStarted &&
      run.actions &&
      run.actions.fence === run.fence &&
      (input.fence === undefined || input.fence === run.fence),
    'WORK_STALE',
    'Actions dispatch is no longer current.',
  );
  const claims = validateActionsClaims(actionsClaimsSchema.parse(JSON.parse(input.claims)), {
    audience: process.env.CONVEX_SITE_URL!,
    repository: run.configuration.repository,
    executionId: run.executionId,
    workflowSha: run.actions.workflowSha,
    selfHosted: !githubHostedRunsOn(run.configuration.runsOn ?? 'ubuntu-latest'),
  });
  // Binding is provided by dispatch response or HMAC webhook, never "first JWT wins".
  invariant(
    run.executionId === claims.run_id,
    'EVIDENCE_CHANGED',
    'Await the original Actions dispatch acknowledgement or workflow_run event.',
  );
  if (!run.actions.workflowSha) {
    run.actions.workflowSha = claims.workflow_sha;
    await writeHostedCheck(ctx, row._id, run);
  }
  return selected;
}
export const session = internalMutation({
  args: { ...sessionArgs, timings: v.optional(v.boolean()) },
  returns: v.any(),
  handler: async (ctx, input) => {
    const { run } = await actionsSession(ctx, input);
    if (!input.timings) return { ...run, capabilities: [...hostedActionsCapabilities] };
    const { history } = await hostedTimingHistory(ctx, input.projectId);
    return {
      run,
      capabilities: [...hostedActionsCapabilities],
      timingHistory: JSON.stringify(history),
      sourcePack: await latestSourcePack(ctx, input.projectId),
    };
  },
});

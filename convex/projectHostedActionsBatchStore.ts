// SPDX-License-Identifier: Apache-2.0
import { detachCheckReports, reportsDetached, objectReportTransport } from './projectHostedCheckReports';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import { actionsSession } from './projectHostedActionsSession';
import { writableHostedCheck } from './projectHostedCheckStore';
import { directActions } from './projectHostedActionsDirect';
import { invariant } from '../src/errors';
import { resultBatchIndex } from '../src/hosted-actions-result-batch';
import { finalOutputTarget } from './projectHostedActionsOutput';
import { outputMessage, signOutput } from '../src/hosted-check-output';
import { commitHostedOutputWindow } from './projectHostedOutputStore';
import { outputSigningKey } from './projectHostedOutputApi';
import { canonicalPayload } from '../src/hosted-source-operation';
export const batchArgs = {
  projectId: v.id('hostedProjects'),
  runId: v.string(),
  fence: v.number(),
  executionId: v.string(),
  claims: v.optional(v.string()),
  workflowSha: v.optional(v.string()),
};
export type BatchInput = {
  projectId: import('./_generated/dataModel').Id<'hostedProjects'>;
  runId: string;
  fence: number;
  executionId: string;
  claims?: string;
  workflowSha?: string;
};
/** HTTP calls supply verified OIDC claims; absent claims are internal webhook recovery only.
 * Every page and output commit rechecks current actor/epoch, dispatch fence and execution. */
export async function batchSession(ctx: MutationCtx, input: BatchInput) {
  const selected = input.claims
    ? await actionsSession(ctx, { ...input, claims: input.claims }, false)
    : await writableHostedCheck(ctx, input);
  const { run } = selected;
  invariant(
    directActions(run) &&
      run.plan &&
      run.configuration.provider === 'github-actions' &&
      run.fence === input.fence &&
      run.executionId === input.executionId,
    'EVIDENCE_CHANGED',
    'Collect the original prepared Actions execution.',
  );
  const transport = objectReportTransport(run);
  if (transport) {
    invariant(transport.packed !== undefined, 'EVIDENCE_CHANGED', 'Collect only a prepared batch inbox.');
    return { ...selected, packed: transport.packed };
  }
  const batch = await ctx.db
    .query('projectHostedActionsResults')
    .withIndex('by_project_and_run_and_index', q =>
      q.eq('projectId', input.projectId).eq('runId', input.runId).eq('index', resultBatchIndex),
    )
    .unique();
  invariant(batch?.digest === run.planDigest, 'EVIDENCE_CHANGED', 'Collect only a prepared batch inbox.');
  if (!reportsDetached(run)) detachCheckReports(run);
  return { ...selected, packed: batch.state === '{"packed":true}' };
}
export const prepare = internalMutation({
  args: batchArgs,
  returns: v.string(),
  handler: async (ctx, input) => {
    const { run, packed } = await batchSession(ctx, input);
    return JSON.stringify({ run, packed, ...(objectReportTransport(run) ? { reportStorage: 'r2' } : {}) });
  },
});
export const output = internalMutation({
  args: { ...batchArgs, root: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const selected = await batchSession(ctx, input),
      { run } = selected;
    const final = await finalOutputTarget(ctx, input, run),
      root = JSON.parse(input.root);
    invariant(
      final === null || (final && canonicalPayload(final.root) === input.root),
      'EVIDENCE_CHANGED',
      'Finalize the original settled output.',
    );
    const message = outputMessage(run, { kind: 'final', root });
    await commitHostedOutputWindow(
      ctx,
      [{ projectId: input.projectId, message, signature: signOutput(message, outputSigningKey(run.keyId)) }],
      outputSigningKey,
      selected,
    );
    return null;
  },
});

// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { loadHostedCheck } from './projectHostedCheckStore';
import { hostedWriteProject } from './projectHostedRecords';
import { directActions } from './projectHostedActionsDirect';
import { outputSigningKey } from './projectHostedOutputApi';
import { verifyActionsPreflight } from '../src/hosted-actions-preflight';
import { invariant } from '../src/errors';

/** One public query, no HTTP action or nested function. The fixed supervisor
 * retains the proof from its existing OIDC planning session outside project env. */
export const check = query({
  args: { projectId: v.id('hostedProjects'), runId: v.string(), fence: v.number(), signature: v.string() },
  returns: v.object({ status: v.union(v.literal('active'), v.literal('cancelled')) }),
  handler: async (ctx, input) => {
    const { run } = await loadHostedCheck(ctx, input);
    verifyActionsPreflight(run, input.signature, outputSigningKey(run.keyId));
    await hostedWriteProject(ctx, input.projectId, run.actor, run.request.authorityEpoch);
    invariant(
      directActions(run) && run.plan && run.executionId && run.fence === input.fence,
      'EVIDENCE_CHANGED',
      'Use the original prepared Actions execution.',
    );
    return {
      status:
        run.cancelRequested || run.status === 'cancelled' ? ('cancelled' as const) : ('active' as const),
    };
  },
});

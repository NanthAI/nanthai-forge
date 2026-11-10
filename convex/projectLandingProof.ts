// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { checkCaller, writableHostedCheck } from './projectHostedCheckStore';
import { hostedWriteProject } from './projectHostedRecords';
import { outputSigningKey } from './projectHostedOutputApi';
import { landingProofSignature } from '../src/hosted-actions-preflight';
import { proofReportSchema, proofSummary } from '../src/landing-proof';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

/** One call per proof, even after acceptance. No wake, run rewrite, table or receipt change.
 * The runner's plan issued a write-only ticket; other CI uses its project's Forge credential. */
export const report = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    head: v.string(),
    executionId: v.string(),
    report: v.string(),
    ticket: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    // This is a run-scoped write-only ticket, not a collector signing credential.
    // Without a ticket, authenticate before any run lookup, as ordinary project writes do.
    const caller = input.ticket === undefined ? await checkCaller(ctx, input.projectId) : null;
    const { row, run } = await writableHostedCheck(ctx, input);
    if (input.ticket !== undefined) {
      const expected = landingProofSignature(run, outputSigningKey(run.keyId));
      let difference = expected.length ^ input.ticket.length;
      for (let i = 0; i < expected.length; i++)
        difference |= expected.charCodeAt(i) ^ (input.ticket.charCodeAt(i) || 0);
      invariant(
        !difference && run.configuration.provider === 'github-actions',
        'EVIDENCE_CHANGED',
        'Proof ticket differs.',
      );
    } else {
      await hostedWriteProject(ctx, input.projectId, caller!.actor, run.request.authorityEpoch);
    }
    invariant(
      run.proofOnLanding &&
        !run.cancelRequested &&
        run.status !== 'cancelled' &&
        run.request.expectedHead === input.head &&
        run.executionId === input.executionId,
      'EVIDENCE_CHANGED',
      'Use the exact opted-in check run and execution.',
    );
    const proof = canonicalPayload(proofReportSchema.parse(JSON.parse(input.report)));
    invariant(
      !row.proof || row.proof === proof,
      'EVIDENCE_CHANGED',
      'This run already retained another proof.',
    );
    if (!row.proof) await ctx.db.patch(row._id, { proof });
    return null;
  },
});
/** A projection beside the receipt, joined on its exact run. No new query or subscription. */
export function runProof(row: { proof?: string }, run: Parameters<typeof proofSummary>[1]) {
  return row.proof ? proofSummary(proofReportSchema.parse(JSON.parse(row.proof)), run) : undefined;
}

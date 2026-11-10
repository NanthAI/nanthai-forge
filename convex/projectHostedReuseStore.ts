// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx, type MutationCtx } from './server';
import { loadFinish } from './projectHostedFinishStore';
import { loadLanding, type LandingIdentity } from './projectHostedLandingStore';
import { hostedWriteProject } from './projectHostedRecords';
import { saveObject } from './projectHostedSaveStore';
import { fastProof } from '../src/hosted-cross-head-proof';
import { installFinishCompose } from './projectHostedFinishCompose';
import { crossHeadProofSchema } from '../src/hosted-cross-head-proof';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { scheduleFinish } from './projectHostedFinishWake';
import { reuseDecision, type ReuseReads } from './projectHostedReuseDecision';
export { reuseDecision, type ReuseIneligible } from './projectHostedReuseDecision';
const identity = { projectId: v.id('hostedProjects'), submissionId: v.string() };
/** Constant-size admission; uncertainty keeps the existing exact recheck. */
export async function reuseContext(ctx: QueryCtx | MutationCtx, input: LandingIdentity) {
  const decision = await reuseDecision(ctx, input);
  return 'reason' in decision ? null : decision;
}
export const context = internalQuery({ args: identity, returns: v.any(), handler: reuseContext });
const leased = { ...identity, pendingId: v.string(), owner: v.string() };
export const claim = internalMutation({
  args: leased,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const { row, value } = await loadFinish(ctx, input);
    const { state } = await loadLanding(ctx, input);
    if (state.phase !== 'ready' || value.pending?.id !== input.pendingId) return null;
    if (row.reuseLease?.pendingId === input.pendingId)
      return row.reuseLease.owner === input.owner && row.reuseLease.until > Date.now() ? input.owner : null;
    const owner = input.owner;
    const reuseLease = { pendingId: input.pendingId, owner, until: Date.now() + 60_000 };
    await ctx.db.patch(row._id, { reuseLease });
    await scheduleFinish(ctx, row, 60_000, true);
    return owner;
  },
});
export const renew = internalMutation({
  args: leased,
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const { row, value } = await loadFinish(ctx, input);
    const { state } = await loadLanding(ctx, input);
    if (
      state.phase !== 'ready' ||
      value.pending?.id !== input.pendingId ||
      row.reuseLease?.owner !== input.owner ||
      row.reuseLease.pendingId !== input.pendingId ||
      row.reuseLease.until <= Date.now()
    )
      return false;
    await ctx.db.patch(row._id, { reuseLease: { ...row.reuseLease, until: Date.now() + 60_000 } });
    return true;
  },
});
export const objects = internalQuery({
  args: { ...identity, digests: v.array(v.string()) },
  returns: v.any(),
  handler: async (ctx, input) => {
    const { state } = await loadLanding(ctx, input);
    await hostedWriteProject(ctx, input.projectId, state.actor, state.request.authorityEpoch);
    return Promise.all(input.digests.map(sha256 => saveObject(ctx, input.projectId, { sha256 })));
  },
});
export const complete = internalMutation({
  args: { ...leased, proof: v.union(v.string(), v.null()), reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, input) => {
    const finish = await loadFinish(ctx, input);
    const { row, value } = finish;
    if (value.pending?.id !== input.pendingId) return null;
    const landing = await loadLanding(ctx, input);
    if (landing.state.phase !== 'ready') return null;
    if (
      row.reuseLease?.owner !== input.owner ||
      row.reuseLease.pendingId !== input.pendingId ||
      row.reuseLease.until <= Date.now()
    )
      return null;
    // The same decision reuseContext makes; a refusal keeps its own reason.
    const reads: ReuseReads = { finish, landing };
    const decision = await reuseDecision(ctx, input, reads);
    const current = 'reason' in decision ? null : decision;
    const analysed = input.proof && current ? crossHeadProofSchema.parse(JSON.parse(input.proof)) : undefined;
    // A fast proof stands only while fast mode is still effective in this transaction.
    const lapsed = fastProof(analysed) && !current?.fast ? analysed : undefined;
    const proof = lapsed ? undefined : analysed;
    if (proof && current)
      invariant(
        Object.entries(current.basis).every(
          ([key, value]) => canonicalPayload(proof[key as keyof typeof proof]) === canonicalPayload(value),
        ) &&
          proof.checkedSelection === current.selection &&
          (proof.algorithm === 'conservative-impact-v1' ||
            canonicalPayload(proof.checkEntries) === canonicalPayload(current.checkEntries)),
        'EVIDENCE_CHANGED',
        'Complete only the original current proof analysis.',
      );
    if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
    await ctx.db.patch(row._id, { wake: null });
    await installFinishCompose(
      ctx,
      row,
      value,
      proof || undefined,
      reads.source,
      proof
        ? undefined
        : 'reason' in decision
          ? decision.reason
          : (lapsed?.relaxed[0] ?? input.reason ?? 'source-unavailable'),
      reads.checkedRun,
    );
    return null;
  },
});

// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query, internalMutation, type MutationCtx } from './cliServer';
import { acceptanceActor } from './projectAutonomy';
import { accessibleProject, activeOwnedProject } from './projectAuthority';
import { claimReadyLanding } from './projectHostedLandingControl';
import {
  acceptanceSelection,
  prepareAcceptance,
  stageAcceptance,
  acceptanceRow,
  acceptancePlan,
  type AcceptanceIdentity,
} from './projectHostedAcceptanceStore';
import { publishAcceptance } from './projectHostedAcceptancePublish';
import { completeAcceptedHeads } from './projectHostedAcceptanceCompletion';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
const selection = { projectId: v.id('hostedProjects'), submissionId: v.string(), attemptId: v.string() };
async function caller(ctx: MutationCtx, input: AcceptanceIdentity) {
  const selected = await acceptanceSelection(ctx, input);
  const actor = await acceptanceActor(ctx, selected.state.request.agent);
  invariant(
    actor.id === selected.attempt.actor.id && actor.kind === selected.attempt.actor.kind,
    'PROJECT_UNAVAILABLE',
    'Continue the original acceptance actor and authority kind.',
  );
  return selected;
}
export const prepare = mutation({
  args: selection,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await caller(ctx, input);
      return canonicalPayload(await prepareAcceptance(ctx, input));
    } catch (error) {
      return report(error);
    }
  },
});
export const stage = mutation({
  args: {
    ...selection,
    kind: v.union(v.literal('inputs'), v.literal('dependencies')),
    index: v.number(),
    page: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await caller(ctx, input);
      return canonicalPayload(await stageAcceptance(ctx, { ...input, page: JSON.parse(input.page) }));
    } catch (error) {
      return report(error);
    }
  },
});
/** Explicit API acceptance and H15 use exactly the same final publication. A
 * person keeps their reviewed Candidate; a device cannot promote itself. */
export const accept = mutation({
  args: selection,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { attempt } = await caller(ctx, input);
      if (await acceptanceRow(ctx, { projectId: input.projectId, receiptId: attempt.operations.accept }))
        return canonicalPayload(
          await publishAcceptance(ctx, {
            ...input,
            channel: 'main',
            owner: attempt.operations.accept,
            token: 0,
          }),
        );
      const claim = await claimReadyLanding(ctx, {
        ...input,
        channel: 'main',
        owner: attempt.operations.accept,
      });
      return canonicalPayload(
        claim ? await publishAcceptance(ctx, claim) : { status: 'pending', reason: 'queued' },
      );
    } catch (error) {
      return report(error);
    }
  },
});
/** Explicit acceptance of an exact prepared contributor Candidate by the owner.
 * Device identities remain agents and cannot approve their own automation. */
export const approve = mutation({
  args: selection,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const actor = await acceptanceActor(ctx);
      await activeOwnedProject(ctx, input.projectId, actor.id);
      invariant(
        actor.kind === 'person',
        'PROJECT_UNAVAILABLE',
        'Owner approval requires explicit person acceptance.',
      );
      const { attempt } = await acceptanceSelection(ctx, input);
      if (await acceptanceRow(ctx, { projectId: input.projectId, receiptId: attempt.operations.accept }))
        return canonicalPayload(
          await publishAcceptance(
            ctx,
            { ...input, channel: 'main', owner: attempt.operations.accept, token: 0 },
            Date.now(),
            actor,
          ),
        );
      const claim = await claimReadyLanding(ctx, {
        ...input,
        channel: 'main',
        owner: attempt.operations.accept,
      });
      return canonicalPayload(
        claim
          ? await publishAcceptance(ctx, claim, Date.now(), actor)
          : { status: 'pending', reason: 'queued' },
      );
    } catch (error) {
      return report(error);
    }
  },
});
export const publish = internalMutation({
  args: { ...selection, channel: v.literal('main'), owner: v.string(), token: v.number() },
  returns: v.string(),
  handler: async (ctx, input) => canonicalPayload(await publishAcceptance(ctx, input)),
});
export const complete = internalMutation({
  args: { projectId: v.id('hostedProjects'), receiptId: v.string() },
  returns: v.object({ complete: v.boolean() }),
  handler: completeAcceptedHeads,
});
export const receipt = query({
  args: { projectId: v.id('hostedProjects'), receiptId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read acceptance evidence.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const row = await acceptanceRow(ctx, input);
      invariant(row, 'NOT_FOUND', 'Accepted receipt not found.');
      const plan = await acceptancePlan(ctx, input);
      return canonicalPayload({
        receipt: JSON.parse(row.value),
        completion: plan && {
          appliedPage: plan.appliedPage,
          appliedEntry: plan.appliedEntry,
          pages: plan.inputPages,
        },
      });
    } catch (error) {
      return report(error);
    }
  },
});

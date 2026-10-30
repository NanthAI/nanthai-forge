// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import { controlHostedActions } from './projectHostedActions';
import { writableHostedCheck, type CheckIdentity } from './projectHostedCheckStore';
import { receiveHostedCheckCallback } from './projectHostedCheckCallbacks';
import { actionsMappingMatches, hostedActionsMappingSchema } from '../src/hosted-actions';
import { hostedCheckCallbackSchema } from '../src/hosted-check-evidence';
import { hostedCheckTerminal } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

const evidenceSchema = z
  .object({
    owner: z.uuid(),
    token: z.number().safe().nonnegative(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    callback: hostedCheckCallbackSchema,
    signature: z.string(),
  })
  .strict();
/** Internal fixed-worker boundary. Every call rechecks current project/actor,
 * controller lease, exact State AND export commit; no provider/source bytes. */
export async function applyActionsEvidence(
  ctx: MutationCtx,
  input: CheckIdentity & { evidence: unknown },
  key: (id: string) => string,
  now = Date.now(),
) {
  const e = evidenceSchema.parse(input.evidence);
  const { run } = await writableHostedCheck(ctx, input);
  const row = await ctx.db
    .query('projectHostedActionsExports')
    .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
    .unique();
  invariant(row, 'EVIDENCE_CHANGED', 'Retain the Actions export before recording evidence.');
  const m = hostedActionsMappingSchema.parse(JSON.parse(row.value));
  actionsMappingMatches(m, run);
  invariant(
    m.lease.owner === e.owner &&
      m.lease.token === e.token &&
      m.lease.until > now &&
      m.export?.commit === e.commit &&
      m.run !== null &&
      e.callback.runId === input.runId &&
      e.callback.executionId === String(m.run) &&
      e.callback.provider === 'github-actions',
    'EVIDENCE_CHANGED',
    'Actions evidence selected a stale lease, State, commit or execution.',
  );
  return receiveHostedCheckCallback(
    ctx,
    { projectId: input.projectId, callback: e.callback, signature: e.signature },
    key,
    now,
  );
}
export async function claimActionsReconciliation(
  ctx: MutationCtx,
  input: CheckIdentity & { owner: string },
  now = Date.now(),
) {
  const { run } = await writableHostedCheck(ctx, input);
  // No mapping creation, provider call, schedule or recurring scan for idle/finished runs.
  if ((hostedCheckTerminal(run) && run.status !== 'cancelled') || !run.dispatchStarted)
    return { run, mapping: null, acquired: false };
  if (run.status === 'cancelled') {
    const mapping = await ctx.db
      .query('projectHostedActionsExports')
      .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
      .unique();
    if (!mapping) return { run, mapping: null, acquired: false };
  }
  const claim = await controlHostedActions(
    ctx,
    { ...input, command: { kind: 'claim', owner: input.owner } },
    now,
  );
  return { run, ...claim };
}
export const claim = internalMutation({
  args: { projectId: v.id('hostedProjects'), runId: v.string(), owner: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return canonicalPayload(await claimActionsReconciliation(ctx, input));
    } catch (error) {
      return report(error);
    }
  },
});
export const evidence = internalMutation({
  args: { projectId: v.id('hostedProjects'), runId: v.string(), evidence: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return canonicalPayload(
        await applyActionsEvidence(ctx, { ...input, evidence: JSON.parse(input.evidence) }, id => {
          const key = process.env[`FORGE_HOSTED_CHECK_KEY_${id}`];
          invariant(key, 'RUNNER_UNAVAILABLE', 'Trusted check callback key is unavailable.');
          return key;
        }),
      );
    } catch (error) {
      return report(error);
    }
  },
});

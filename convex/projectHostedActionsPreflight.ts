// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ConvexError, v, type Infer } from 'convex/values';
import { mutation, query, type QueryCtx, type MutationCtx } from './cliServer';
import { loadHostedCheck } from './projectHostedCheckStore';
import { hostedWriteProject } from './projectHostedRecords';
import { directActions, directActionsWatchdogMs } from './projectHostedActionsDirect';
import { outputSigningKey } from './projectHostedOutputApi';
import { actionsPreflightBindingSchema, verifyActionsPreflight } from '../src/hosted-actions-preflight';
import { invariant } from '../src/errors';
import { LANDING_STALL_MS } from '../src/landing-stall';
import { notifyLandingCheck } from './projectHostedLandingCheckWake';

const request = v.object({
  projectId: v.id('hostedProjects'),
  runId: v.string(),
  fence: v.number(),
  signature: v.string(),
});
const reply = v.object({ status: v.union(v.literal('active'), v.literal('cancelled')) });
async function authorize(ctx: QueryCtx | MutationCtx, input: Infer<typeof request>) {
  const selected = await loadHostedCheck(ctx, input);
  const { run } = selected;
  verifyActionsPreflight(run, input.signature, outputSigningKey(run.keyId));
  await hostedWriteProject(ctx, input.projectId, run.actor, run.request.authorityEpoch);
  invariant(
    directActions(run) && run.plan && run.executionId && run.fence === input.fence,
    'EVIDENCE_CHANGED',
    'Use the original prepared Actions execution.',
  );
  return {
    ...selected,
    status: run.cancelRequested || run.status === 'cancelled' ? ('cancelled' as const) : ('active' as const),
  };
}

/** Earlier runners and operations that only need a cancellation check use this one query. */
export const check = query({
  args: request.fields,
  returns: reply,
  handler: async (ctx, input) => ({ status: (await authorize(ctx, input)).status }),
});

/** The same one-call preflight records an exact shard start on current runners. The
 * signed original-dispatch ticket is retained only by the fixed supervisor. */
export const start = mutation({
  args: { ...request.fields, shard: v.string(), timeoutMinutes: v.number(), binding: v.string() },
  returns: reply,
  handler: async (ctx, input) => {
    // Authenticate the fixed supervisor before accessing any project or run.
    // The retained run and current project authority are then checked again.
    try {
      const binding = actionsPreflightBindingSchema.parse(JSON.parse(input.binding));
      verifyActionsPreflight(binding, input.signature, outputSigningKey(binding.keyId));
      invariant(
        binding.projectId === input.projectId && binding.id === input.runId && binding.fence === input.fence,
        'EVIDENCE_CHANGED',
        'Use the original shard preflight ticket.',
      );
    } catch {
      throw new ConvexError({
        code: 'PROJECT_UNAVAILABLE',
        message: 'Shard preflight requires a valid supervisor ticket.',
      });
    }
    const { row, run, status } = await authorize(ctx, input);
    if (status === 'cancelled' || run.status !== 'running' || !run.plan || !run.actions) return { status };
    const shard = input.shard === 'static' ? run.plan.shardCount - 1 : Number(input.shard);
    invariant(
      (input.shard === 'static' || /^(0|[1-9]\d*)$/.test(input.shard)) &&
        Number.isSafeInteger(shard) &&
        shard >= 0 &&
        shard < run.plan.shardCount,
      'EVIDENCE_CHANGED',
      'Select a planned shard.',
    );
    const activity = row.shardActivity;
    if (activity?.started.includes(shard)) return { status };
    const at = Date.now();
    const minutes =
      Number.isFinite(input.timeoutMinutes) && input.timeoutMinutes > 0 ? input.timeoutMinutes : 0;
    const until = Math.min(at + minutes * 60_000, run.actions.reservedAt + directActionsWatchdogMs);
    await ctx.db.patch(row._id, {
      shardStartedAt: row.shardStartedAt ?? at,
      shardActivity: {
        at,
        until: Math.max(activity?.until ?? at, until),
        started: [...(activity?.started ?? []), shard],
      },
    });
    // Fast starts are picked up by existing landing activity or the original alarm.
    // A late start may have outlived that alarm, so it can wake the bound landing.
    if (at - Date.parse(run.at) >= LANDING_STALL_MS)
      await notifyLandingCheck(ctx, {
        projectId: row.projectId,
        runId: run.id,
        terminal: false,
        shardStarted: true,
        // A plan can arrive after an admission alarm already fired. Let that
        // admission recover even when the shard starts soon after its plan.
        ...(row.plannedAt !== undefined && at - row.plannedAt < LANDING_STALL_MS
          ? { onlyStalled: true as const }
          : {}),
      });
    return { status };
  },
});

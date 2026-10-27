// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation, type MutationCtx } from './_generated/server';
import { writableHostedCheck, type CheckIdentity } from './projectHostedCheckStore';
import {
  hostedActionsMappingSchema,
  actionsMappingMatches,
  type HostedActionsMapping,
} from '../src/hosted-actions';
import { hostedCheckTerminal, type HostedCheckRun } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

export const actionsFallbackMs = 5 * 60_000;
/** A run with no provider callback for this long stops its watchdog; a terminal
 * callback or cancellation re-arms it. Bounds a stuck run to a finite wake count. */
export const actionsQuietLimitMs = 24 * 60 * 60_000;
const actionsMaxFallbackMs = 60 * 60_000;
const args = { projectId: v.id('hostedProjects'), runId: v.string(), generation: v.number() };
/** Only called for one adopted outstanding run. Generation deduplicates delayed
 * provider events and scheduler deliveries without a project/history scan. */
export async function armActionsWake(
  ctx: MutationCtx,
  id: CheckIdentity,
  mapping: HostedActionsMapping,
  at: number,
) {
  mapping.wakeGeneration++;
  mapping.wakeAt = at;
  await ctx.scheduler.runAfter(
    Math.max(0, at - Date.now()),
    makeFunctionReference<'action'>('projectHostedActionsWake:observe'),
    {
      projectId: id.projectId,
      runId: id.runId,
      generation: mapping.wakeGeneration,
    },
  );
}
export async function prepareActionsWake(
  ctx: MutationCtx,
  input: CheckIdentity & { generation: number },
  now = Date.now(),
) {
  const { run } = await writableHostedCheck(ctx, input);
  if (run.configuration.provider !== 'github-actions') return null;
  const row = await ctx.db
    .query('projectHostedActionsExports')
    .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
    .unique();
  if (!row) return null;
  const m = hostedActionsMappingSchema.parse(JSON.parse(row.value));
  actionsMappingMatches(m, run);
  if (!m.run || m.deleted || input.generation !== m.wakeGeneration) return null;
  // Callbacks update progress directly. A single coalesced watchdog handles
  // lost callbacks, postponed to the last real progress instead of polling.
  const terminal = hostedCheckTerminal(run);
  const due =
    terminal || run.cancelRequested
      ? now
      : m.reconciliation.settles > 0
        ? m.wakeAt
        : Math.max(m.wakeAt, m.lastCallbackAt + actionsFallbackMs);
  const busy = m.lease.until > now || m.nextAt > now || due > now;
  if (!m.adoptedAt) m.adoptedAt = now; // mappings adopted before this field
  // The watchdog backs off with quiet time and stops after a day without callbacks,
  // so a lost provider or unavailable controller never becomes a permanent timer.
  const quiet = now - Math.max(m.adoptedAt, m.lastCallbackAt);
  if (!busy && quiet >= actionsQuietLimitMs) {
    await ctx.db.patch(row._id, { value: canonicalPayload(m) });
    return null;
  }
  const fallback = Math.min(actionsMaxFallbackMs, Math.max(actionsFallbackMs, Math.floor(quiet / 4)));
  // Retain takeover BEFORE HTTP, including terminal cleanup after a lost reply.
  await armActionsWake(
    ctx,
    input,
    m,
    busy ? Math.max(due, m.lease.until, m.nextAt, now + 1) : now + fallback,
  );
  await ctx.db.patch(row._id, { value: canonicalPayload(m) });
  return busy ? null : { projectId: input.projectId, runId: run.id, dispatchKey: run.dispatchKey };
}
/** Called only after authenticated exact provider evidence or an authorized
 * cancellation. Repeated callback receipts return before reaching this seam. */
export async function notifyActionsProgress(ctx: MutationCtx, run: HostedCheckRun, now = Date.now()) {
  if (run.configuration.provider !== 'github-actions') return;
  const id = { projectId: run.projectId as CheckIdentity['projectId'], runId: run.id };
  const row = await ctx.db
    .query('projectHostedActionsExports')
    .withIndex('by_project_and_run', q => q.eq('projectId', id.projectId).eq('runId', id.runId))
    .unique();
  if (!row) return;
  const m = hostedActionsMappingSchema.parse(JSON.parse(row.value));
  actionsMappingMatches(m, run);
  if (!m.run || m.deleted) return;
  invariant(
    !run.executionId || run.executionId === String(m.run),
    'EVIDENCE_CHANGED',
    'Callback selected another Actions execution.',
  );
  m.lastCallbackAt = now;
  if (hostedCheckTerminal(run) || run.cancelRequested) {
    // Provider completion/cancel supersedes an old reconciliation delay.
    m.nextAt = 0;
    await armActionsWake(ctx, id, m, now);
  }
  await ctx.db.patch(row._id, { value: canonicalPayload(m) });
}
export const prepare = internalMutation({
  args,
  returns: v.union(
    v.null(),
    v.object({ projectId: v.id('hostedProjects'), runId: v.string(), dispatchKey: v.string() }),
  ),
  handler: prepareActionsWake,
});
/** Fixed worker ingress owns its existing credential resolver, not project code.
 * It runs one dispatch/adoption/reconciliation tick and terminal branch cleanup.
 * This action never waits for an Actions job, downloads logs or handles source. */
export const observe = internalAction({
  args,
  returns: v.null(),
  handler: async (ctx, input) => {
    const selected = (await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedActionsWake:prepare'),
      input,
    )) as { projectId: string; runId: string; dispatchKey: string } | null;
    if (!selected) return null;
    const endpoint = process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_URL,
      key = process.env.FORGE_HOSTED_ACTIONS_CONTROLLER_KEY;
    invariant(
      endpoint && key && new URL(endpoint).protocol === 'https:',
      'RUNNER_UNAVAILABLE',
      'Configure the fixed Actions controller ingress.',
    );
    // Bounded request only; next durable wake already exists if HTTP fails.
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: canonicalPayload(selected),
    });
    invariant(
      response.ok,
      'RUNNER_UNAVAILABLE',
      'Actions controller observation is pending; its next wake is retained.',
    );
    return null;
  },
});

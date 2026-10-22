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
import { hostedCheckTerminal } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

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
  if (hostedCheckTerminal(run) || run.configuration.provider !== 'github-actions') return null;
  const row = await ctx.db
    .query('projectHostedActionsExports')
    .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
    .unique();
  if (!row) return null;
  const m = hostedActionsMappingSchema.parse(JSON.parse(row.value));
  actionsMappingMatches(m, run);
  if (!m.run || m.deleted || input.generation !== m.wakeGeneration) return null;
  // Rearm BEFORE worker HTTP: a lost action/worker response still has a takeover
  // observation. A finished run turns that one pending wake into a read-only no-op.
  const busy = m.lease.until > now || m.nextAt > now;
  await armActionsWake(ctx, input, m, Math.max(now + 10_000, m.lease.until, m.nextAt));
  await ctx.db.patch(row._id, { value: canonicalPayload(m) });
  return busy ? null : { projectId: input.projectId, runId: run.id, dispatchKey: run.dispatchKey };
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

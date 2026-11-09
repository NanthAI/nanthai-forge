// SPDX-License-Identifier: Apache-2.0
import { convexFetch } from './networkFetch';
import { z } from 'zod';
import { v } from 'convex/values';
import { internalMutation, internalAction } from './server';
import { makeFunctionReference } from 'convex/server';
import { writableHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { directActions, settleDirectActions, requestDirectCancel } from './projectHostedActionsDirect';
import { checkFailureKind } from '../src/hosted-landing-admission';
import { hostedCheckTerminal } from '../src/hosted-check';
import { actionsToken, githubAppRequest } from './githubAppToken';
import { runnerTokenScope, type RunnerScope } from './githubBindingAccess';
import { invariant } from '../src/errors';
import { applyConclusion } from './projectHostedActionsVerdict';
const payloadSchema = z.object({
  action: z.enum(['requested', 'in_progress', 'completed']),
  repository: z.object({ full_name: z.string() }),
  workflow_run: z.object({
    id: z.number().safe().positive(),
    run_attempt: z.literal(1),
    display_title: z.string(),
    event: z.literal('workflow_dispatch'),
    path: z.literal('.github/workflows/forge-check.yml'),
    head_branch: z.literal('main'),
    head_sha: z.string().regex(/^[a-f0-9]{40}$/),
    created_at: z.iso.datetime(),
    conclusion: z.string().nullable(),
  }),
});
/** Only called by the existing HMAC-verified webhook, never by a public mutation. */
export const receive = internalMutation({
  args: { payload: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const parsed = payloadSchema.safeParse(JSON.parse(input.payload));
    if (!parsed.success) return null; // Other workflows/events are unrelated.
    const payload = parsed.data,
      workflow = payload.workflow_run;
    const match = /^forge-check\/([a-f0-9-]{36})$/.exec(workflow.display_title);
    if (!match) return null;
    const row = await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_run', q => q.eq('runId', match[1]!))
      .unique();
    if (!row) return null;
    const selected = await writableHostedCheck(ctx, { projectId: row.projectId, runId: row.runId }),
      { run } = selected;
    invariant(
      directActions(run) &&
        run.configuration.provider === 'github-actions' &&
        run.configuration.repository === payload.repository.full_name &&
        run.actions &&
        run.actions.fence === run.fence &&
        Date.parse(workflow.created_at) >= Math.floor(run.actions.reservedAt / 1000) * 1000,
      'EVIDENCE_CHANGED',
      'Webhook differs from the original Actions dispatch.',
    );
    invariant(
      !run.executionId || run.executionId === String(workflow.id),
      'EVIDENCE_CHANGED',
      'Webhook selected another Actions execution.',
    );
    // The dispatch response's run id is the binding. A webhook may bind only after the dispatch was
    // observed without one; earlier (or after a rejection) it is ignored, so a run another actor
    // titled `forge-check/<runId>` cannot take the binding.
    if (!run.executionId && !run.actions.dispatchedWithoutId) return null;
    if (hostedCheckTerminal(run)) {
      if (run.status === 'cancelled' && payload.action !== 'completed' && !run.executionId) {
        run.executionId = String(workflow.id);
        await writeHostedCheck(ctx, selected.row._id, run);
        await requestDirectCancel(ctx, run);
      }
      return null;
    }
    invariant(
      !run.actions.workflowSha || run.actions.workflowSha === workflow.head_sha,
      'EVIDENCE_CHANGED',
      'Workflow revision changed.',
    );
    run.executionId = String(workflow.id);
    run.actions.workflowSha = workflow.head_sha;
    if (payload.action === 'completed' && run.actions.verdictPending) {
      // Every shard reported passing: GitHub's own conclusion decides (src/hosted-check-verdict.ts).
      await applyConclusion(ctx, selected, workflow.conclusion);
    } else if (payload.action === 'completed') {
      const conclusion = workflow.conclusion;
      // Workflow failure is not Candidate evidence: OIDC/source/setup can fail
      // before tests run. Only an authenticated failed shard proves a check failed.
      await settleDirectActions(
        ctx,
        selected,
        conclusion === 'cancelled'
          ? 'cancelled'
          : run.counts.failed > 0 || checkFailureKind(run, { conflicts: [] }) === 'tests'
            ? 'failed'
            : 'runner-unavailable',
        `Actions completed (${conclusion ?? 'unknown'}) without complete job evidence.`,
      );
    } else {
      await writeHostedCheck(ctx, selected.row._id, run);
      await requestDirectCancel(ctx, run);
    }
    return null;
  },
});
export const cancellation = internalMutation({
  args: { projectId: v.id('hostedProjects'), runId: v.string() },
  // JSON text (Issue 0c457ae4): a cancelled run keeps its per-file reports.
  returns: v.string(),
  handler: async (ctx, input) => {
    const { row, run } = await writableHostedCheck(ctx, input);
    if (!run.actions || !run.cancelRequested || !run.executionId || run.actions.cancelScheduled !== true)
      return 'null';
    // Consume before IO. Replays/duplicate action deliveries never resend an
    // unknown outcome; true = scheduled, false = attempted, absent = unscheduled.
    run.actions.cancelScheduled = false;
    await writeHostedCheck(ctx, row._id, run);
    const runnerScope =
      run.configuration.provider === 'github-actions'
        ? await runnerTokenScope(ctx, input.projectId, run.configuration.repository)
        : null;
    return JSON.stringify({ ...run, runnerScope });
  },
});
export const cancel = internalAction({
  args: { projectId: v.id('hostedProjects'), runId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const run = JSON.parse(
      await ctx.runMutation(
        makeFunctionReference<'mutation'>('projectHostedActionsWebhook:cancellation'),
        input,
      ),
    ) as (import('../src/hosted-check').HostedCheckRun & { runnerScope?: RunnerScope | null }) | null;
    if (!run || run.configuration.provider !== 'github-actions') return null;
    const token = await actionsToken(ctx, input.projectId, run.configuration.repository, run.runnerScope);
    await githubAppRequest(
      `repos/${run.configuration.repository}/actions/runs/${run.executionId}/cancel`,
      token,
      // A completed workflow is already stopped. Keep all other failures explicit.
      async (url, init) => {
        const response = await convexFetch(url, init);
        return response.status === 409 ? new Response(null, { status: 204 }) : response;
      },
      {},
    );
    return null;
  },
});

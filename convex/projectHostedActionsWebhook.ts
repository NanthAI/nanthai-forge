// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { v } from 'convex/values';
import { internalMutation, internalAction } from './_generated/server';
import { makeFunctionReference } from 'convex/server';
import { writableHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { directActions, settleDirectActions, requestDirectCancel } from './projectHostedActionsDirect';
import { hostedCheckTerminal } from '../src/hosted-check';
import { installationToken, githubAppRequest, actionsPermissions } from './githubAppToken';
import { invariant } from '../src/errors';
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
    if (hostedCheckTerminal(run)) return null;
    invariant(
      !run.actions.workflowSha || run.actions.workflowSha === workflow.head_sha,
      'EVIDENCE_CHANGED',
      'Workflow revision changed.',
    );
    run.executionId = String(workflow.id);
    run.actions.workflowSha = workflow.head_sha;
    if (payload.action === 'completed') {
      const conclusion = workflow.conclusion;
      await settleDirectActions(
        ctx,
        selected,
        conclusion === 'cancelled' ? 'cancelled' : conclusion === 'failure' ? 'failed' : 'interrupted',
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
  returns: v.any(),
  handler: async (ctx, input) => {
    const { run } = await writableHostedCheck(ctx, input);
    return run.actions && run.cancelRequested && run.executionId && !hostedCheckTerminal(run) ? run : null;
  },
});
export const cancel = internalAction({
  args: { projectId: v.id('hostedProjects'), runId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const run = (await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedActionsWebhook:cancellation'),
      input,
    )) as import('../src/hosted-check').HostedCheckRun | null;
    if (!run || run.configuration.provider !== 'github-actions') return null;
    const token = await installationToken(
      ctx,
      input.projectId,
      run.configuration.repository,
      actionsPermissions,
    );
    await githubAppRequest(
      `repos/${run.configuration.repository}/actions/runs/${run.executionId}/cancel`,
      token,
      fetch,
      {},
    );
    return null;
  },
});

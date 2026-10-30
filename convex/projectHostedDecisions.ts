import { digest } from '../src/portable-hash';
import { z } from 'zod';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { recordCaller, recordRequest, replayRequest, recordPageOptions } from './projectHostedFrictionStore';
import { applyTrustDelegation } from './projectHostedTrust';
import { appendDecision, decisionRow, decisionTargetKey } from './projectHostedDecisionsStore';
import { decideInputSchema, decisionRecordSchema, decisionsInputSchema } from '../src/decision-types';
import { canonicalPayload } from '../src/hosted-source-operation';
import { recordHead } from './projectHostedRecords';
import { invariant } from '../src/errors';
import { report } from './errors';
export const decide = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, request: input }) => {
    try {
      const { actor, project } = await recordCaller(ctx, projectId, true, true);
      const parsed = decideInputSchema.required({ operationId: true }).safeParse(JSON.parse(input));
      invariant(parsed.success, 'BAD_ARGUMENT', 'Send the original decision inputs and operation UUID.');
      const old = await decisionRow(ctx, projectId, parsed.data.operationId);
      const prior = old ? decisionRecordSchema.parse(JSON.parse(old.value)) : null;
      const conversation = parsed.data.conversation ?? prior?.conversation;
      const command = { ...parsed.data, ...(conversation ? { conversation } : {}) },
        request = digest(JSON.stringify(decideInputSchema.required({ operationId: true }).parse(command)));
      if (old) {
        replayRequest(old.request, request);
        return old.value;
      }
      if (command.target.kind === 'intent')
        invariant(
          await recordHead(ctx, projectId, 'intent', command.target.intentId),
          'NOT_FOUND',
          'Intent not found.',
        );
      for (const id of new Set([
        command.supersedes,
        command.overrides?.kind === 'decision' ? command.overrides.decisionId : undefined,
      ]))
        if (id) invariant(await decisionRow(ctx, projectId, id), 'NOT_FOUND', 'Earlier decision not found.');
      invariant(
        !command.delegation || project.owner === actor,
        'PROJECT_UNAVAILABLE',
        'Only the project owner delegates trust areas to an actor.',
      );
      const at = new Date().toISOString();
      const record = decisionRecordSchema.parse({
        ...command,
        schema: 1,
        kind: 'decision',
        id: command.operationId,
        request,
        at,
        decidedAt: command.decidedAt ?? at,
        actor: {
          kind: 'agent',
          name: command.actor ?? actor,
          ...(command.tool ? { tool: command.tool } : {}),
        },
        requester: { kind: 'agent', name: actor },
        ...(command.overrides
          ? { overrides: command.overrides }
          : command.supersedes
            ? { overrides: { kind: 'decision', decisionId: command.supersedes } }
            : {}),
      });
      if (await appendDecision(ctx, projectId, actor, record))
        await applyTrustDelegation(ctx, projectId, record);
      return canonicalPayload(record);
    } catch (error) {
      return report(error);
    }
  },
});
/** Raw immutable records: derive supersession after consuming the required pages,
 * including replacements outside the selected target/page. No history is rewritten. */
export const list = query({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.union(v.string(), v.null()),
    target: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, cursor, target }) => {
    try {
      await recordCaller(ctx, projectId);
      const parsed = decisionsInputSchema.safeParse(
        target === undefined ? {} : { target: JSON.parse(target) },
      );
      invariant(parsed.success, 'BAD_ARGUMENT', 'Choose a project or Intent decision target.');
      const key = parsed.data.target ? decisionTargetKey(parsed.data.target) : undefined;
      const rows =
        key === undefined
          ? ctx.db.query('projectHostedDecisions').withIndex('by_project', q => q.eq('projectId', projectId))
          : ctx.db
              .query('projectHostedDecisions')
              .withIndex('by_project_and_target', q => q.eq('projectId', projectId).eq('target', key));
      const page = await rows.paginate(recordPageOptions(cursor));
      return canonicalPayload({ ...page, page: page.page.map(row => JSON.parse(row.value)) });
    } catch (error) {
      return report(error);
    }
  },
});
/** Explicit, narrow permission; never borrows the guidance maintainer grant. */
export const setMaintainer = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    actor: v.string(),
    enabled: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const caller = await recordCaller(ctx, input.projectId, true);
      invariant(
        caller.project.owner === caller.actor,
        'PROJECT_UNAVAILABLE',
        'Only the project owner assigns decision maintainers.',
      );
      invariant(z.uuid().safeParse(input.operationId).success, 'BAD_ARGUMENT', 'Use an operation UUID.');
      const request = recordRequest(input);
      const old = await ctx.db
        .query('projectHostedDecisionMaintainers')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      if (old) replayRequest(old.request, request);
      else await ctx.db.insert('projectHostedDecisionMaintainers', { ...input, request });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

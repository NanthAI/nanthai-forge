import { needsFix } from '../src/culprit-bisect';
import { hostedPaths } from '../src/hosted-paths';
// SPDX-License-Identifier: Apache-2.0
import { effectivePolicy } from '../src/autonomy-policy';
import { v } from 'convex/values';
import { query } from './cliServer';
import { briefArgs, briefingResult } from './agentBriefFields';
import { accessibleProject } from './projectAuthority';
import { hostedBriefRecords, readBriefState, readBriefParents } from './projectBriefingContext';
import { briefInputSchema, type BriefState } from '../src/agent-brief-types';
import { briefingContext, selectBrief } from '../src/agent-brief-context';
import { renderBriefing } from '../src/agent-brief-render';
import { invariant } from '../src/errors';
import { report } from './errors';
export const brief = query({
  args: { projectId: v.id('hostedProjects'), ...briefArgs },
  returns: briefingResult,
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read agent briefings.');
      const project = await accessibleProject(ctx, input.projectId, user.subject);
      const parsed = briefInputSchema.safeParse(input);
      invariant(parsed.success, 'BAD_ARGUMENT', 'Choose a briefing situation, records and agent variant.');
      const { records, generation, coverage } = await hostedBriefRecords(ctx, project, parsed.data);
      const selected = selectBrief(parsed.data, records);
      const states = new Map<string, BriefState>(),
        missing = new Set<string>();
      const roots = [
        ...new Set(
          [
            selected.lane?.head,
            selected.lane?.base,
            selected.view?.head,
            selected.view?.base,
            ...(selected.view?.inputs.map(i => i.head) ?? []),
            selected.intent?.base,
            ...records.channels.map(c => c.head),
          ].filter((id): id is string => !!id),
        ),
      ];
      const pending: string[] = [];
      for (const head of roots) {
        const state = await readBriefState(ctx, project._id, generation.backupId, head);
        if (state) {
          states.set(head, state);
          pending.push(...state.parents);
        } else missing.add(head);
      }
      while (pending.length) {
        const head = pending.pop()!;
        if (states.has(head) || missing.has(head)) continue;
        const state = await readBriefParents(ctx, project._id, generation.backupId, head);
        if (state) {
          states.set(head, state);
          pending.push(...state.parents);
        } else missing.add(head);
      }
      const personal = await ctx.db
        .query('agentUserSettings')
        .withIndex('by_actor', q => q.eq('actor', user.subject))
        .unique();
      const context = briefingContext(
        parsed.data,
        records,
        id => states.get(id),
        { project: project.agentGuidance ?? '', personal: personal?.agentGuidance ?? '' },
        id => {
          const run = records.runs.find(r => r.id === id) as { failureSummary?: string } | undefined;
          return (
            run?.failureSummary ??
            'Failure summary is not retained in this hosted checkpoint; read the local run logs.'
          );
        },
      );
      context.autonomyPolicy = effectivePolicy(project);
      const pendingFixes = needsFix(project);
      if (pendingFixes.length)
        context.guidance.project +=
          '\nWork needing a fix:\n' +
          pendingFixes
            .map(
              n =>
                `${n.state}: Intent ${n.intentId}. ${n.summary} Undo: ${n.undo}. Start a fix: nforge agent ROOT start '${JSON.stringify({ intentId: n.intentId })}'`,
            )
            .join('\n');
      context.coverage.push(...coverage);
      return hostedPaths(
        renderBriefing(
          parsed.data,
          context,
          'ROOT',
          new Date().toISOString(),
          {
            projectId: project._id,
            deployment: 'DEPLOYMENT',
          },
          selected.lane?.setup ?? { machine: null, mcpConfigured: false },
        ),
      );
    } catch (error) {
      return report(error);
    }
  },
});

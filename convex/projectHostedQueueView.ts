// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { report } from './errors';
import { hostedRecordBody } from './projectHostedRecords';
import { landingRow } from './projectHostedLandingStore';
import { loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { finishRow } from './projectHostedFinishWake';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { hostedFinishSchema } from '../src/hosted-finish';
import { hostedRecordSchema } from '../src/hosted-records';
import { landingSuspect } from '../src/hosted-landing-suspect';
import { invariant } from '../src/errors';
import type { QueueStatusKey } from '../src/hosted-queue-status';
import { QUEUE_VIEW_LIMIT, QUEUE_VIEW_PAGES } from '../src/hosted-queue-view';

/** One bounded read of the landing queue (09e637f7 minimal slice): who is in it,
 * in dispatch order, with Lane, Intent title, phase, last failing test files
 * and how many generations each entry went through. Reads the maintained queue
 * directory (at most QUEUE_VIEW_PAGES pages) plus about six indexed rows per
 * listed entry; no queue scan, history, source bytes, scheduler or idle work. */
export const read = query({
  args: { projectId: v.id('hostedProjects'), limit: v.optional(v.number()) },
  returns: v.string(),
  handler: async (ctx, { projectId, limit }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read the landing queue.');
      await accessibleProject(ctx, projectId, user.subject);
      const take = Math.max(1, Math.min(QUEUE_VIEW_LIMIT, Math.floor(limit ?? QUEUE_VIEW_LIMIT)));
      const queue = await ctx.db
        .query('projectHostedLandingQueues')
        .withIndex('by_project_and_channel', q => q.eq('projectId', projectId).eq('channel', 'main'))
        .unique();
      const pages = await ctx.db
        .query('projectHostedLandingQueueStatus')
        .withIndex('by_project_and_page', q => q.eq('projectId', projectId))
        .order('asc')
        .take(QUEUE_VIEW_PAGES);
      const keys = pages
        .flatMap(page => JSON.parse(page.value) as QueueStatusKey[])
        .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
      const train = new Set(queue?.train ?? []);
      const entries = [];
      for (const key of keys.slice(0, take)) {
        const row = await landingRow(ctx, { projectId, submissionId: key.id });
        if (!row) continue;
        const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
        const attempt = await loadLandingAttempt(ctx, { projectId, attemptId: state.attemptId });
        const finish = await finishRow(ctx, { projectId, submissionId: state.id });
        const intentId = finish ? hostedFinishSchema.parse(JSON.parse(finish.value)).source.intentId : null;
        const intent = intentId
          ? await ctx.db
              .query('projectHostedRecordHeads')
              .withIndex('by_project_and_kind_and_key', q =>
                q.eq('projectId', projectId).eq('kind', 'intent').eq('key', intentId),
              )
              .unique()
          : null;
        const record = intent ? await ctx.db.get(intent.recordId) : null;
        // A title is display only: an unreadable body leaves it null, not the view failed.
        const body = record ? await hostedRecordBody(ctx, record).catch(() => null) : null;
        const parsed = body ? hostedRecordSchema.safeParse(JSON.parse(body)) : null;
        const lanes = intentId
          ? await ctx.db
              .query('projectHostedRecordHeads')
              .withIndex('by_project_and_kind_and_parent', q =>
                q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId),
              )
              .take(2)
          : [];
        const failed = state.testFiles?.failed.length
          ? state.testFiles.failed.map(file => file.file)
          : (state.batchDiagnostic?.failedTests ?? []);
        entries.push({
          position: key.position ?? null,
          submissionId: state.id,
          laneId: lanes[0]?.key ?? null,
          ...(lanes.length > 1 ? { moreLanes: true } : {}),
          intentId,
          intentTitle: parsed?.success && parsed.data.kind === 'intent' ? parsed.data.outcome : null,
          phase: state.phase,
          priority: state.priority ?? 'normal',
          batchId: state.batchId ?? null,
          inTrain: train.has(state.id),
          suspect: landingSuspect(state),
          lastFailingTests: failed.slice(0, 10),
          ...(failed.length > 10 ? { moreFailingTests: failed.length - 10 } : {}),
          // Every recompose or recheck generation inserts one landing attempt.
          recomposeCount: Math.max(0, attempt.number - 1),
          submittedAt: state.at,
          lastProgressAt: state.timing?.ciProgressAt ?? state.timing?.selectedAt ?? state.at,
          ...(state.error ? { error: state.error.code } : {}),
        });
      }
      return JSON.stringify({
        total: queue?.status?.total ?? keys.length,
        listed: entries.length,
        more: (queue?.status?.total ?? keys.length) > entries.length,
        train: queue?.train?.length ?? 0,
        entries,
      });
    } catch (error) {
      return report(error);
    }
  },
});

// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { report } from './errors';
import { hostedRecordBody } from './projectHostedRecords';
import { landingRow } from './projectHostedLandingStore';
import { readWouldConflict } from './projectHostedLandingWouldConflict';
import { syncRequiredAdvice, syncRequiredNext } from '../src/hosted-would-conflict';
import { loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { finishRow } from './projectHostedFinishWake';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { hostedFinishSchema } from '../src/hosted-finish';
import { hostedRecordSchema } from '../src/hosted-records';
import { landingSuspect } from '../src/hosted-landing-suspect';
import { landingHold } from '../src/hosted-landing-hold';
import { invariant } from '../src/errors';
import type { QueueStatusKey } from '../src/hosted-queue-status';
import { QUEUE_VIEW_LIMIT, QUEUE_VIEW_PAGES } from '../src/hosted-queue-view';

/** One bounded read of the landing queue (09e637f7 minimal slice): who is in it,
 * in dispatch order, with Lane, Intent title, phase, last failing test files
 * and how many generations each entry went through. Reads the maintained queue
 * directory (at most QUEUE_VIEW_PAGES pages) plus about seven indexed rows per
 * listed entry; no queue scan, history, source bytes, scheduler or idle work. Entries held
 * for a person or a dependency follow the dispatch order with no position and a `hold`. */
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
        // The Lane this landing composed (friction a0faf3a9): its compose selection, one indexed read.
        // A resolution Lane shares its origin's Intent, so the Intent's first Lane can be the wrong one.
        const composed = state.request.finish?.composeOperationId
          ? await ctx.db
              .query('projectHostedComposeSelections')
              .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
                q
                  .eq('projectId', projectId)
                  .eq('actor', state.actor)
                  .eq('operationId', state.request.finish!.composeOperationId!)
                  .eq('kind', 'inputs'),
              )
              .take(2)
          : [];
        const laneId = composed.length === 1 ? composed[0]!.key : (lanes[0]?.key ?? null);
        const hold = landingHold(state, laneId ?? undefined);
        // Main already took files this entry changes: it needs its Lane synced, not more waiting (f7539ebb).
        const sync = syncRequiredAdvice(state.phase === 'queued' ? readWouldConflict(row) : undefined);
        const failed = state.testFiles?.failed.length
          ? state.testFiles.failed.map(file => file.file)
          : (state.batchDiagnostic?.failedTests ?? []);
        entries.push({
          position: key.position ?? null,
          submissionId: state.id,
          laneId,
          ...(lanes.length > 1 ? { moreLanes: true } : {}),
          intentId,
          intentTitle: parsed?.success && parsed.data.kind === 'intent' ? parsed.data.outcome : null,
          phase: sync ? 'needs-sync' : state.phase,
          ...(sync
            ? {
                needsSync: {
                  paths: sync.paths,
                  ...(sync.more ? { more: sync.more } : {}),
                  landedSubmissionId: sync.landedSubmissionId,
                  next: syncRequiredNext({ ...sync, laneId: sync.laneId ?? laneId ?? undefined }),
                },
              }
            : {}),
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
          // Held entries stay listed, after dispatch order, naming what releases them (5c59940b).
          ...(hold ? { hold } : {}),
        });
      }
      const held = queue?.status ? (queue.status.held ?? 0) : keys.filter(key => key.held).length;
      const total = queue?.status?.total ?? keys.length - held;
      return JSON.stringify({
        total,
        ...(held ? { held } : {}),
        listed: entries.length,
        more: total + held > entries.length,
        train: queue?.train?.length ?? 0,
        entries,
      });
    } catch (error) {
      return report(error);
    }
  },
});

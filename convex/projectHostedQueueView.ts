// SPDX-License-Identifier: Apache-2.0
import { ciDownMessage, ciDownTripped } from './projectHostedLandingCiDown';
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
import { storedLandingStateSchema } from '../src/hosted-landing';
import { hostedFinishSchema } from '../src/hosted-finish';
import { hostedRecordSchema } from '../src/hosted-records';
import { landingSuspect } from '../src/hosted-landing-suspect';
import { landingHold } from '../src/hosted-landing-hold';
import { landingStateField } from '../src/landing-state';
import { urgentNotApplied } from '../src/receipt-slim';
import { invariant } from '../src/errors';
import { sourceStepFailureField } from '../src/hosted-source-retry';
import { preparingSourceStep } from './projectHostedPreparingSource';
import { QUEUE_VIEW_LIMIT } from '../src/hosted-queue-view';
import { queueComposeLanes, queueIntentLanes, queueViewKeys } from './projectHostedQueueEntries';
import { auditRow, mainRedField } from './projectHostedMainAuditState';
import { usualCheck } from './projectFailureCause';
import { landingOrderWaitForReader } from './projectHostedLandingOrder';
import { readProviderDelay } from './projectHostedLandingCheckProgress';

/** One bounded read of the landing queue (09e637f7 minimal slice): who is in it,
 * in dispatch order, with Lane, Intent title, phase, last failing test files
 * and how many generations each entry went through. Reads the maintained queue
 * directory (at most QUEUE_VIEW_PAGES pages) plus about seven indexed rows per
 * listed entry; no queue scan, history, source bytes, scheduler or idle work. Entries held
 * for a person or a dependency follow the dispatch order with no position and a `hold`.
 * A checking entry carries its check's start (from the landing row already read); while any does, the reply carries
 * the project's usual check times, one more indexed read of the landing-speed row (Item ecd6e610). */
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
      const keys = await queueViewKeys(ctx, projectId);
      const train = new Set(queue?.train ?? []);
      const entries = [];
      for (const key of keys.slice(0, take)) {
        const row = await landingRow(ctx, { projectId, submissionId: key.id });
        if (!row) continue;
        const state = storedLandingStateSchema.parse(JSON.parse(row.value));
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
        const [composed, lanes] = await Promise.all([
          queueComposeLanes(ctx, projectId, state),
          queueIntentLanes(ctx, projectId, intentId),
        ]);
        const laneId = composed.length === 1 ? composed[0]!.key : (lanes[0]?.key ?? null);
        const hold = landingHold(state, laneId ?? undefined);
        // Main already took files this entry changes: it needs its Lane synced, not more waiting (f7539ebb).
        const sync = syncRequiredAdvice(state.phase === 'queued' ? readWouldConflict(row) : undefined);
        const failed = state.testFiles?.failed.length
          ? state.testFiles.failed.map(file => file.file)
          : (state.batchDiagnostic?.failedTests ?? []);
        entries.push({
          // A held entry has no queue position: main-red included (B3), whose directory key predates it.
          position: hold ? null : (key.position ?? null),
          // A passed entry parked behind an older one says so, naming it (43b51a5e): from the row in hand.
          // A check-infrastructure wait says since when (0d8a85a3): one run read, pending-infra entries only.
          landingState: landingStateField(
            {
              ...state,
              orderWait: landingOrderWaitForReader(row, state),
              ...(await readProviderDelay(ctx, row, state)),
            },
            laneId ?? undefined,
          ),
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
                  ...('landedSubmissionId' in sync
                    ? { landedSubmissionId: sync.landedSubmissionId }
                    : { predecessor: sync.predecessor }),
                  next: syncRequiredNext({ ...sync, laneId: sync.laneId ?? laneId ?? undefined }),
                },
              }
            : {}),
          priority: state.priority ?? 'normal',
          // An urgent request queued at normal says so (friction 596b75a3); from the row already read.
          ...(urgentNotApplied(state) ? { urgentNotApplied: urgentNotApplied(state) } : {}),
          batchId: state.batchId ?? null,
          inTrain: train.has(state.id),
          suspect: landingSuspect(state),
          lastFailingTests: failed.slice(0, 10),
          ...(failed.length > 10 ? { moreFailingTests: failed.length - 10 } : {}),
          // Every recompose or recheck generation inserts one landing attempt.
          recomposeCount: Math.max(0, attempt.number - 1),
          submittedAt: state.at,
          lastProgressAt: state.timing?.ciProgressAt ?? state.timing?.selectedAt ?? state.at,
          // When its check was reserved: the start the usual check time counts from (Item ecd6e610).
          ...(state.phase === 'checking' && state.timing?.checkReservedAt
            ? { checkStartedAt: state.timing.checkReservedAt }
            : {}),
          ...(state.error ? { error: state.error.code } : {}),
          // Held entries stay listed, after dispatch order, naming what releases them (5c59940b).
          ...(hold ? { hold } : {}),
          // The submission a dependency hold lands after (Item 9e748e41), from the finish row read above: no
          // extra read, one fixed-size field on dependency-held entries only.
          ...(hold?.kind === 'dependency' && finish?.parentSubmissionId
            ? { dependsOn: { submissionId: finish.parentSubmissionId } }
            : {}),
        });
      }
      // Preparation precedes admission: no dispatch rank or peer can block it.
      // The sparse index excludes retained terminal history; no timer or writes.
      const preparing = await ctx.db
        .query('projectHostedLandingDesired')
        .withIndex('by_project_and_preparing', q => q.eq('projectId', projectId).eq('preparing', true))
        .take(take + 1);
      const preparationEntries = [];
      for (const row of preparing.slice(0, Math.max(0, take - entries.length))) {
        const state = storedLandingStateSchema.parse(JSON.parse(row.value));
        const inputs = await ctx.db
          .query('projectHostedComposeSelections')
          .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
            q
              .eq('projectId', projectId)
              .eq('actor', row.actor)
              .eq('operationId', row.composeOperationId)
              .eq('kind', 'inputs'),
          )
          .take(2);
        // Source progress (incident e62d834b): the source step and its last commit, two indexed reads.
        const step = await preparingSourceStep(ctx, projectId, row.actor, row.composeOperationId);
        const progressAt = step?.timing?.scheduledAt;
        const sourceFailure = step ? sourceStepFailureField(step) : undefined;
        preparationEntries.push({
          position: null,
          landingState: landingStateField(state),
          submissionId: state.id,
          operationId: state.operationId,
          laneId: inputs.length === 1 ? inputs[0]!.key : null,
          phase: state.phase,
          waitingOn: {
            kind: 'source-preparation',
            composeOperationId: row.composeOperationId,
            ...(step ? { sourceStep: step.step } : {}),
            // A failed or fenced step and its cause, from the same row (no extra read).
            ...(sourceFailure ? { sourceFailure } : {}),
          },
          submittedAt: state.at,
          lastProgressAt:
            progressAt !== undefined && progressAt > Date.parse(state.at)
              ? new Date(progressAt).toISOString()
              : state.at,
        });
      }
      // The gate parks main-red entries without rewriting the directory, so the listed rows say so (B3).
      const parked = entries.filter(
        entry => entry.hold?.kind === 'main-red' || entry.hold?.kind === 'ci-down',
      ).length;
      const held = (queue?.status ? (queue.status.held ?? 0) : keys.filter(key => key.held).length) + parked;
      const total = (queue?.status?.total ?? keys.length - held + parked) - parked;
      // One indexed read: main red and why, in this reply (Item 687d1eda), so no landing is blamed by guess.
      const red = (await auditRow(ctx, projectId))?.red;
      const usual = entries.some(entry => entry.checkStartedAt)
        ? await usualCheck(ctx, projectId)
        : undefined;
      return JSON.stringify({
        total,
        ...(usual !== undefined ? { usualCheck: usual } : {}),
        ...(held ? { held } : {}),
        ...(red ? { mainRed: mainRedField(red) } : {}),
        // The CI-down hold (e62d834b line 5), from the queue row already read: one reason for the queue.
        ...(queue?.ciDown && ciDownTripped(queue.ciDown)
          ? {
              ciDown: {
                cause: queue.ciDown.cause,
                since: new Date(queue.ciDown.since).toISOString(),
                streak: queue.ciDown.streak,
                ...(queue.ciDown.probeAt
                  ? { nextProbeAt: new Date(queue.ciDown.probeAt).toISOString() }
                  : {}),
                reason: ciDownMessage(queue.ciDown),
              },
            }
          : {}),
        listed: entries.length + preparationEntries.length,
        preparing: preparing.length,
        more: total + held > entries.length || preparing.length > preparationEntries.length,
        train: queue?.train?.length ?? 0,
        // Dispatch order first, then held entries.
        entries: [
          ...entries.filter(entry => !entry.hold),
          ...entries.filter(entry => entry.hold),
          ...preparationEntries,
        ],
      });
    } catch (error) {
      return report(error);
    }
  },
});

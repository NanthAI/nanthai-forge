// SPDX-License-Identifier: Apache-2.0
import { cancelPendingTask } from './schedulerCancel';
import { cancelStaleLandingChecks } from './projectHostedLandingStaleChecks';
import { wakeLandingCapsule } from './projectLandingCapsuleWake';
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import {
  acceptanceRow,
  acceptancePlan,
  acceptancePage,
  type ReceiptIdentity,
} from './projectHostedAcceptanceStore';
import {
  independentIntentItem,
  readHostedRecord,
  recordHead,
  writeHostedRecord,
} from './projectHostedRecords';
import { retireLandedOverlapLanes } from './projectHostedOverlapLanded';
import { completeIntentWhenLanesDone } from './projectHostedIntentCompletion';
import { completeResolutionOrigins, noteResolutionOrigins } from './projectHostedResolutionOrigin';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { validateComposePage, composeLaneSchema } from '../src/hosted-compose';
import { recordLandedFeedPage } from './projectFeedTerminal';
import { hostedLaneSchema } from '../src/hosted-lane';
import { invariant } from '../src/errors';
import { scheduleLandingPrecompose } from './projectHostedLandingPrecompose';
import { LANDING_STALL_MS } from '../src/landing-stall';
import { canonicalPayload } from '../src/hosted-source-operation';
import { effectivePolicy } from '../src/autonomy-policy';
import { effectiveAgentDefaults } from '../src/agent-parallel-defaults';
import type { LandingNote } from '../src/intent-landing-note';
import { postIntentLandingNote } from './projectIntentLandingNotes';
import { acceptanceWorkItems } from './projectHostedAcceptanceFields';
type CompletionInput = ReceiptIdentity & {
  precompose?: { receiptIds: string[]; paths?: string[] };
};
const COMPLETE = makeFunctionReference<'mutation'>('projectHostedAcceptance:complete');
const GUARD = makeFunctionReference<'mutation'>('projectHostedAcceptance:guard');
const FOLD_WORK = makeFunctionReference<'mutation'>('projectInitiativeWorkFold:fold');
export const ACCEPTANCE_COMPLETION_STALLED = 'ACCEPTANCE_COMPLETION_STALLED';
type Plan = NonNullable<Awaited<ReturnType<typeof acceptancePlan>>>;
const armGuard = (ctx: MutationCtx, input: ReceiptIdentity) =>
  ctx.scheduler.runAfter(LANDING_STALL_MS, GUARD, {
    projectId: input.projectId,
    receiptId: input.receiptId,
  });
/** Only an accepted marker activates the staged landed-head ledger. Canonical
 * Lane status is a bounded projection of that ledger. No source/Intent changes.
 * Issue 13c63abe: the tick and a stall guard one window out are retained on the
 * plan. The tick cancels the guard when it completes, so a healthy landing runs
 * no extra function; a lost or crashing tick is replayed by the guard. */
export async function scheduleAcceptanceCompletion(
  ctx: MutationCtx,
  planId: Id<'projectHostedAcceptancePlans'>,
  input: CompletionInput,
  alarm?: Id<'_scheduled_functions'>,
  landedBy?: LandingNote['landedBy'],
  feedCompletion?: Plan['feedCompletion'],
) {
  const tick = await ctx.scheduler.runAfter(0, COMPLETE, input);
  await ctx.db.patch(planId, {
    completion: { tick, guard: await armGuard(ctx, input), ...(alarm ? { alarm } : {}) },
    // Publication already emitted the feed events using these staged Lane pins.
    feedLanes: undefined,
    ...(feedCompletion ? { feedCompletion } : {}),
    // Issue 3a733ee8: in the same patch, so the Item notes cost publication no extra write.
    ...(landedBy ? { landedBy } : {}),
  });
}
/** The plan's completion ended: cancel its pending guard and drop the retained
 * tick. A plan with nothing retained (legacy or already complete) writes nothing. */
async function settleCompletion(ctx: MutationCtx, plan: Plan, patch: Partial<Plan> = {}) {
  if (plan.completion?.guard) await cancelPendingTask(ctx, plan.completion.guard);
  if (plan.capsuleWake) await wakeLandingCapsule(ctx, { projectId: plan.projectId, ...plan.capsuleWake });
  // `landedBy` only carries the publisher to the notes of the completion ticks (Issue 3a733ee8); the
  // landing capsule keeps the settled plan for good, so it leaves with the completion.
  if (
    plan.completion ||
    plan.capsuleWake ||
    plan.landedBy ||
    plan.feedCompletion ||
    Object.keys(patch).length
  )
    await ctx.db.patch(plan._id, {
      ...patch,
      completion: undefined,
      capsuleWake: undefined,
      landedBy: undefined,
      feedCompletion: undefined,
      workItemIds: undefined,
    });
  return { complete: true };
}
/** The stall guard (Issue 13c63abe), one stall window after publication or its
 * last replay. A live tick re-arms it; a lost one (failed, cancelled, gone) is
 * replayed once from its own arguments. Lost again at the same position, the
 * completion ends visibly: a typed status on the receipt read and an owner
 * alert naming the next command. Accepted work is never rewound. */
export async function guardAcceptanceCompletion(ctx: MutationCtx, input: ReceiptIdentity) {
  const plan = await acceptancePlan(ctx, input);
  const retained = plan?.completion;
  if (!plan || !retained || retained.stalled) return null;
  const task = await ctx.db.system.get(retained.tick);
  if (task?.state.kind === 'pending' || task?.state.kind === 'inProgress') {
    await ctx.db.patch(plan._id, { completion: { ...retained, guard: await armGuard(ctx, input) } });
    return null;
  }
  const at = { page: plan.appliedPage, entry: plan.appliedEntry };
  if (retained.replayed?.page !== at.page || retained.replayed.entry !== at.entry) {
    const args = (task?.args[0] as CompletionInput | undefined) ?? {
      projectId: input.projectId,
      receiptId: input.receiptId,
    };
    const tick = await ctx.scheduler.runAfter(0, COMPLETE, args);
    await ctx.db.patch(plan._id, {
      completion: { ...retained, tick, guard: await armGuard(ctx, input), replayed: at },
    });
    return null;
  }
  const message =
    `Receipt ${input.receiptId} landed, but completing its Lanes and Intent failed again after Forge ` +
    `replayed it (input page ${at.page + 1} of ${plan.inputPages}). Main and the receipt are correct; ` +
    "nothing is rewound. Run nforge x ROOT complete-merged '{}' to complete the landed Lanes " +
    '(their Intent completes with its last Lane); if a Lane stays open, the failing step needs a fix first.';
  const stalled = { code: ACCEPTANCE_COMPLETION_STALLED, message, at: new Date().toISOString() } as const;
  await ctx.db.patch(plan._id, { completion: { ...retained, guard: null, stalled } });
  const project = await ctx.db.get(input.projectId);
  const settings = project && effectiveAgentDefaults(effectivePolicy(project).agentDefaults).stallAlerts;
  if (project && settings?.enabled)
    await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'action'>('projectHostedLandingStallAlert:deliver'),
      {
        subject: `[Forge] Landing completion stalled: ${project.name}`,
        text: [`Landing completion stalled: ${project.name}, submission ${plan.submissionId}.`, message].join(
          '\n',
        ),
        settings: canonicalPayload(settings),
      },
    );
  return null;
}
export async function completeAcceptedHeads(ctx: MutationCtx, input: CompletionInput) {
  const row = await acceptanceRow(ctx, input);
  invariant(row, 'NOT_FOUND', 'Completion requires an actual accepted receipt.');
  const receipt = hostedAcceptanceSchema.parse(JSON.parse(row.value));
  const plan = await acceptancePlan(ctx, input);
  invariant(
    plan && plan.root === receipt.completion.root,
    'SOURCE_UNAVAILABLE',
    'The accepted completion ledger differs.',
  );
  // Publication transfers its pending deadline to this existing durable tick.
  // Cancelling it here keeps scheduler cleanup outside the main CAS. A failed
  // tick rolls back the cancellation and the guard retains the same alarm.
  if (plan.completion?.alarm) await cancelPendingTask(ctx, plan.completion.alarm);
  // Reuse the already scheduled post-publication tick. No queue query or new
  // scheduling write belongs in the acceptance CAS, including an empty queue.
  if (input.precompose && plan.appliedPage === 0 && plan.appliedEntry === 0) {
    await cancelStaleLandingChecks(ctx, {
      projectId: input.projectId,
      sequence: receipt.snapshot.revision,
      receiptIds: input.precompose.receiptIds,
      head: receipt.candidate.head,
      candidate: { id: receipt.candidate.id, actor: receipt.actor.id, digest: receipt.candidate.digest },
    });
    await scheduleLandingPrecompose(ctx, {
      projectId: input.projectId,
      receiptIds: input.precompose.receiptIds,
      candidate: { id: receipt.candidate.id, actor: receipt.actor.id, digest: receipt.candidate.digest },
    });
  }
  // Landed work leaves the open-overlap index on the first tick, even when completion is off (keepOpen)
  // or skips a Lane whose pins moved after finish. Idempotent and bounded to one input page.
  const landed = {
    commit: receipt.candidate.head,
    at: receipt.at,
    sequence: row.sequence,
    ...(receipt.mainRedHolds ? { mainRedHolds: receipt.mainRedHolds } : {}),
  };
  // Landing declares the Intents of its Lanes even when the Lanes themselves stay open (completeOnAccept off or
  // keepOpen): `closeIntents` completes them in this same tick, and the planning read closes the Issue if its
  // Done-when lines are ticked. Refs-only landings and closeOnLand off leave the Intent alone.
  const lanesDone = receipt.completion.enabled,
    declares = receipt.completion.closeIntents ?? lanesDone;
  if (plan.appliedPage === plan.inputPages) return settleCompletion(ctx, plan);
  // A landing that neither completes Lanes nor declares Intents (closes:false) still tells its Items
  // (Issue 3a733ee8): the same head-only walk as keepOpen, notes only, no record writes.
  const notesOnly = !lanesDone && !declares;
  const resolutionCandidates = new Set<string>();
  if (plan.appliedEntry === 0)
    await retireLandedOverlapLanes(
      ctx,
      input,
      landed,
      plan.appliedPage,
      lanesDone ? undefined : resolutionCandidates,
    );
  const project = await ctx.db.get(input.projectId);
  if (notesOnly && !project) return settleCompletion(ctx, plan);
  invariant(
    project &&
      (notesOnly ||
        (project.sourceAuthority?.mode === 'server' &&
          project.sourceAuthority.epoch === receipt.authorityEpoch)),
    'SOURCE_AUTHORITY_CHANGED',
    'Retain pending completion across authority changes for reconciliation.',
  );
  const page = await acceptancePage(ctx, { ...input, kind: 'inputs', index: plan.appliedPage });
  invariant(page, 'SOURCE_UNAVAILABLE', 'The accepted input page is unavailable.');
  const entries = validateComposePage(JSON.parse(page.value)).entries;
  const pageLanes = new Set(entries.flatMap(entry => ('laneId' in entry ? [entry.laneId] : [])));
  // A byte-sized source page can contain 100 inputs. Materialize at most 20
  // canonical records per tick; counters are transaction windows, not Lane caps.
  const end = Math.min(entries.length, plan.appliedEntry + 20);
  const window = entries.slice(plan.appliedEntry, end);
  if (plan.feedCompletion)
    await recordLandedFeedPage(
      ctx,
      {
        ...plan.feedCompletion,
        projectId: plan.projectId,
        submissionId: plan.submissionId,
        receiptId: plan.receiptId,
        actor: plan.actor,
      },
      window.map(value => {
        const { laneId } = composeLaneSchema.parse(value);
        return { laneId, actor: page.laneActors?.[laneId] };
      }),
    );
  const finished = new Set<string>();
  // The first landed Lane of each Intent: earlier quiet attempts of that Intent leave presence and
  // advisory notices when the Intent completion reads its sibling heads (friction b7f93deb).
  const supersededBy = new Map<string, string>();
  // Issue 3a733ee8: the Intents this page landed, from the Lane reads below (no extra read), each with
  // its Lanes and, for an original reached through another Intent's resolution Lane, that Lane.
  const noted = new Map<string, { laneIds: string[]; viaLaneId?: string }>();
  const note = (intentId: string, laneId: string, viaLaneId?: string) => {
    const entry = noted.get(intentId) ?? { laneIds: [] };
    if (!entry.laneIds.includes(laneId)) entry.laneIds.push(laneId);
    if (viaLaneId && !entry.viaLaneId) entry.viaLaneId = viaLaneId;
    noted.set(intentId, entry);
  };
  for (const value of window) {
    const entry = composeLaneSchema.parse(value);
    if (!lanesDone) {
      // Lanes stay as they are: the head row (parent, status, pin) is the whole read, no record body.
      const row = await recordHead(ctx, input.projectId, 'lane', entry.laneId);
      if (row) note(row.parent, entry.laneId);
      if (row && row.status === 'active' && !row.pinned) finished.add(row.parent);
      continue;
    }
    const current = await readHostedRecord(ctx, {
      projectId: input.projectId,
      actor: project.owner,
      kind: 'lane',
      key: entry.laneId,
    });
    invariant(current, 'SOURCE_UNAVAILABLE', 'An accepted Lane is unavailable.');
    const lane = hostedLaneSchema.parse(JSON.parse(current.value));
    // The receipt carried this Lane's work whatever its record says now (pinned, saved again).
    note(lane.intentId, lane.id);
    // The landed work is the saved head, its source version and its lifecycle (a reopened Lane stays open).
    // A later record write that carries none of those (a bare version bump) must not leave an accepted
    // Lane open forever, producing overlap notices.
    if (
      lane.state !== 'active' ||
      lane.pinned ||
      lane.head !== entry.head ||
      lane.sourceVersion !== entry.sourceVersion ||
      lane.lifecycleVersion !== entry.lifecycleVersion
    )
      continue;
    await writeHostedRecord(ctx, {
      projectId: input.projectId,
      actor: project.owner,
      authorityEpoch: receipt.authorityEpoch,
      expectedVersion: lane.version,
      record: {
        ...lane,
        version: lane.version + 1,
        lifecycleVersion: lane.lifecycleVersion + 1,
        state: 'completed',
        at: receipt.at,
      },
    });
    finished.add(lane.intentId);
    if (!supersededBy.has(lane.intentId)) supersededBy.set(lane.intentId, lane.id);
    // A resolution Lane carries its conflicted original's work: complete that Lane too.
    if (lane.resolution?.origin)
      for (const intentId of await completeResolutionOrigins(
        ctx,
        {
          projectId: input.projectId,
          owner: project.owner,
          authorityEpoch: receipt.authorityEpoch,
          receiptId: input.receiptId,
          commit: landed.commit,
          at: receipt.at,
          ...(landed.mainRedHolds ? { mainRedHolds: landed.mainRedHolds } : {}),
        },
        lane,
        origin => note(origin.intentId, origin.id, origin.intentId === lane.intentId ? undefined : lane.id),
      ))
        finished.add(intentId);
  }
  // Retirement already read the whole input page. Note its origins once, even when the resolution
  // Lane's own record is handled by a later tick of this page.
  if (resolutionCandidates.size)
    for (const entry of entries)
      if ('laneId' in entry && resolutionCandidates.has(entry.laneId))
        await noteResolutionOrigins(ctx, input.projectId, entry, note);
  const currentWorkItems = [];
  for (const [intentId, { laneIds, viaLaneId }] of noted) {
    const head = await recordHead(ctx, input.projectId, 'intent', intentId);
    if (head?.planningItemId) currentWorkItems.push(head.planningItemId);
    // Unmarked legacy Intents may belong to an Item. Remove their fallback once no
    // open unmarked legacy Intents remain.
    if (head?.planningItemId !== independentIntentItem)
      await postIntentLandingNote(ctx, input.projectId, {
        intentId,
        receiptId: receipt.id,
        kind: 'landed',
        at: receipt.at,
        laneIds,
        commit: receipt.candidate.head,
        sequence: receipt.snapshot.revision,
        actor: receipt.actor.id,
        agentRun: receipt.agentRun,
        agentClient: receipt.agentClient,
        landedBy: plan.landedBy,
        viaLaneId,
      });
    // Reuse the Intent head when its last Lane lets the planning read close the Issue.
    if (declares && finished.has(intentId))
      await completeIntentWhenLanesDone(
        ctx,
        {
          projectId: input.projectId,
          actor: project.owner,
          authorityEpoch: receipt.authorityEpoch,
          intentId,
          at: receipt.at,
          ...(lanesDone ? {} : { landed: pageLanes }),
          ...(supersededBy.has(intentId)
            ? { supersededBy: { laneId: supersededBy.get(intentId)!, receiptId: input.receiptId } }
            : {}),
        },
        head,
      );
  }
  const appliedPage = end === entries.length ? plan.appliedPage + 1 : plan.appliedPage;
  const position = { appliedPage, appliedEntry: end === entries.length ? 0 : end };
  const workItemIds = acceptanceWorkItems(plan.workItemIds, currentWorkItems);
  if (appliedPage === plan.inputPages) {
    if (workItemIds.length)
      await ctx.scheduler.runAfter(0, FOLD_WORK, {
        projectId: input.projectId,
        receiptId: receipt.id,
        commit: receipt.candidate.head,
        itemIds: workItemIds,
      });
    return settleCompletion(ctx, plan, position);
  }
  // The next page's tick replaces the retained one; its guard keeps watching.
  const tick = await ctx.scheduler.runAfter(0, COMPLETE, {
    projectId: input.projectId,
    receiptId: input.receiptId,
  });
  await ctx.db.patch(plan._id, {
    ...position,
    ...(workItemIds.length ? { workItemIds } : {}),
    ...(plan.completion ? { completion: { ...plan.completion, alarm: undefined, tick } } : {}),
  });
  return { complete: false };
}

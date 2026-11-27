// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { AuthorshipClaim } from '../src/work-actor-types';
import { needsFix, fixBrief } from '../src/culprit-bisect';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { sourceAuthorship } from '../src/work-actor-types';
import { mutation, receiptMutation, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { beginHostedOperation, finishHostedOperation, hostedOperationRow } from './projectHostedOperations';
import { readHostedRecord, recordHead, writeHostedRecord } from './projectHostedRecords';
import { hostedStartMain } from './projectHostedChannels';
import {
  hostedStartSchema,
  hostedIntentSchema,
  hostedLaneSchema,
  hostedLaneSelectionSchema,
  hostedStartResultSchema,
} from '../src/hosted-lane';
import { canonicalPayload, hostedOperationSchema, hostedPayloadHash } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import type { GuardCandidates } from '../src/hosted-lane';
import { guardSetReply } from './projectLandingSpeed';
import { effectivePolicy } from '../src/autonomy-policy';
import { sessionIdentity as provenance } from './projectSessionIdentity';
import { digest } from '../src/state/hash';
import { report } from './errors';
import { isStored } from './projectObjectFields';
import { findObject } from './projectObjectFind';
import { openSiblingLanes } from './projectHostedStartPeers';
import { dormantCutoff } from './projectHostedDormancy';
import { intentFinished, successorIntentId } from '../src/hosted-intent-chain';
import { stagePlanningCapture } from './projectPlanningCapture';
import { wakePlanningCaptures } from './projectPlanningCaptureWake';
import { selectedGeneration } from './projectWorkIndexStore';
import { latestItemIntentHead } from './projectItemIntentHeads';
import { itemIntentPage } from './projectItemIntentPages';
import { agentHooks } from './projectHostedRecordFields';
import type { AgentHooks } from '../src/hosted-lane';

const args = {
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  authorship: v.optional(
    v.object({
      kind: v.union(v.literal('agent'), v.literal('person')),
      declaration: v.optional(v.union(v.literal('unknown'), v.literal('not-declared'))),
    }),
  ),
  agentClient: v.optional(v.string()),
  noticeVersion: v.optional(v.literal(1)),
  planningItemIdVersion: v.optional(v.literal(1)),
  openLanesVersion: v.optional(v.union(v.literal(1), v.literal(2), v.literal(3))),
  /** The guard-set revision the caller holds (feature preflight-guard-set, 13ea93bf). */
  guardRevision: v.optional(v.string()),
  /** The calling agent session's slug (feature agent-slug, c29d0780); not part of the payload. */
  agent: v.optional(v.string()),
  hooks: v.optional(agentHooks),
  session: v.optional(
    v.object({
      app: v.optional(v.string()),
      identityFrom: v.optional(v.union(v.literal('app-thread'), v.literal('declared'), v.literal('process'))),
    }),
  ),
  holderSessionId: v.optional(v.string()),
  authorityEpoch: v.number(),
  expectedMain: v.object({ head: v.string(), receiptId: v.string() }),
  initialHead: v.optional(v.string()),
  stackOn: v.optional(v.string()),
  stackEntry: v.optional(v.string()),
  intent: v.union(
    v.object({ kind: v.literal('new'), outcome: v.string(), constraints: v.optional(v.string()) }),
    v.object({ kind: v.literal('existing'), intentId: v.string() }),
    v.object({
      kind: v.literal('planned'),
      intentId: v.string(),
      outcome: v.string(),
      constraints: v.optional(v.string()),
    }),
  ),
};
type Input = {
  projectId: Id<'hostedProjects'>;
  operationId: string;
  authorship?: AuthorshipClaim;
  agentClient?: string;
  noticeVersion?: 1;
  planningItemIdVersion?: 1;
  openLanesVersion?: 1 | 2 | 3;
  guardRevision?: string;
  agent?: string;
  hooks?: AgentHooks;
  authorityEpoch: number;
  expectedMain: { head: string; receiptId: string };
  initialHead?: string;
  stackOn?: string;
  stackEntry?: string;
  intent:
    | { kind: 'new'; outcome: string; constraints?: string }
    | { kind: 'existing'; intentId: string }
    | { kind: 'planned'; intentId: string; outcome: string; constraints?: string };
};

function startReply(
  value: unknown,
  noticeVersion?: 1,
  openLanesVersion?: 1 | 2 | 3,
  guardSet?: GuardCandidates | null,
  laneTitle?: string,
  planningItemIdVersion?: 1,
) {
  const { openLanes, planningItemId, ...parsed } = hostedStartResultSchema.parse(value);
  // Reply-only: never part of the stored result a replayed start returns.
  const result = {
    ...parsed,
    ...(planningItemIdVersion && planningItemId ? { planningItemId } : {}),
    ...(guardSet ? { guardSet } : {}),
    ...(openLanesVersion === 3 && laneTitle ? { laneTitle } : {}),
  };
  // Older strict clients reject unknown reply fields: each one is sent only when the client asked.
  const listed =
    openLanesVersion === 2 || openLanesVersion === 3
      ? openLanes
      : openLanes?.map(({ resolves: _resolves, ...lane }) => lane);
  const current = openLanesVersion && listed ? { ...result, openLanes: listed } : result;
  if (noticeVersion === 1) return current;
  const { fixBrief: brief, needsFix: notices, ...legacy } = current;
  void brief;
  void notices;
  return legacy;
}

/** One mutation commits the Intent, Lane and original result, with no global revision write. */
async function execute(
  ctx: MutationCtx & { forgeDevice?: import('./_generated/dataModel').Doc<'cliCredentials'> | null },
  input: Input,
  action: 'start' | 'intent',
) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to start hosted work.');
  const actor = user.subject,
    project = await activeProject(ctx, input.projectId, actor);
  // Parse only the public payload, leaving the typed Convex project ID outside the strict schema.
  const { projectId, ...command } = input;
  const validated = hostedStartSchema.safeParse(command);
  invariant(
    validated.success,
    'BAD_ARGUMENT',
    'Send a hosted start with an operation UUID and exact main pins.',
  );
  invariant(
    validated.data.authorship?.kind !== 'agent' ||
      validated.data.authorship.declaration === 'unknown' ||
      Boolean(validated.data.agentClient?.includes(':')),
    'BAD_ARGUMENT',
    'Agent start requires model. Set model or FORGE_AGENT_MODEL; use "unknown" when unknown.',
  );
  // The agent slug only labels the Lane for other agents: a retry from another session is the same start.
  const {
    noticeVersion,
    planningItemIdVersion,
    openLanesVersion,
    // Never part of the payload hash: a retried start is the same start (13ea93bf).
    guardRevision,
    agent,
    hooks,
    agentClient,
    authorship,
    session,
    holderSessionId,
    ...semanticRequest
  } = validated.data;
  void agentClient;
  void authorship;
  // The learned preflight guard set rides on the reply the CLI gets anyway (13ea93bf): one indexed
  // read, sent only when the caller's revision differs, so a fresh sandbox learns on its first start.
  const guardSet = guardRevision === undefined ? null : await guardSetReply(ctx, projectId, guardRevision);
  const payload = { action, ...semanticRequest };
  invariant(action === 'start' || payload.intent.kind === 'new', 'BAD_ARGUMENT', 'Create a new Intent.');
  let overlapIntent = payload.intent.kind === 'existing' ? payload.intent.intentId : payload.intent.outcome;
  let recovery: import('../src/culprit-bisect').NeedsFix | undefined;
  let plannedExists = false;
  // The Intent a planned/existing start joins, or the successor it creates after the Issue's earlier
  // Intent finished (e4a71127). Absent for a new outcome.
  let targetIntentId = payload.intent.kind === 'new' ? undefined : payload.intent.intentId;
  let planningItemId =
    payload.intent.kind === 'planned'
      ? payload.intent.intentId
      : payload.intent.kind === 'new'
        ? null
        : undefined;
  // An Intent copied from the Work journal that no Lane has pinned yet (flip 5): this start pins it.
  let unpinned: ReturnType<typeof hostedIntentSchema.parse> | undefined;
  if (payload.intent.kind === 'existing' || payload.intent.kind === 'planned') {
    const selectedHead =
      payload.intent.kind === 'planned'
        ? ((await latestItemIntentHead(ctx, projectId, payload.intent.intentId)) ?? undefined)
        : undefined;
    const row = await readHostedRecord(ctx, {
      projectId,
      actor,
      kind: 'intent',
      key: selectedHead?.key ?? payload.intent.intentId,
      ...(selectedHead !== undefined ? { selectedHead } : {}),
    });
    invariant(!selectedHead || row, 'SOURCE_UNAVAILABLE', 'The Item’s latest Intent is unavailable.');
    plannedExists = Boolean(row);
    planningItemId ??= row?.planningItemId;
    // An Issue's Intent the planner wrote has no marker yet. Starting it by Intent id pins it: mark it with its
    // Issue (the same id) so its landing note reaches the Issue (Item fc1831eb).
    if (
      row &&
      planningItemId === undefined &&
      (await recordHead(ctx, projectId, 'issue', payload.intent.intentId))
    )
      planningItemId = payload.intent.intentId;
    invariant(
      row || payload.intent.kind === 'planned',
      'NOT_FOUND',
      'Hosted Intent not found on this project.',
    );
    if (row) {
      const intent = hostedIntentSchema.parse(JSON.parse(row.value));
      targetIntentId = intent.id;
      // A journal-owned status is planning history, not execution: the first Lane pins it as active.
      if (!intent.base?.receiptId) unpinned = intent;
      else if (payload.intent.kind === 'planned' && intentFinished(intent.status)) {
        plannedExists = false;
        targetIntentId = successorIntentId(intent.id);
      }
      if (plannedExists) overlapIntent = intent.outcome;
      if (!intentFinished(intent.status)) recovery = intent.needsFix;
      const planned = payload.intent.kind === 'planned';
      // The first Lane on an unpinned planned Intent is open to any project writer.
      let allowed =
        (unpinned && planned) ||
        project.owner === actor ||
        intent.creatorAccountId === actor ||
        intent.assigneeAccountIds.includes(actor);
      if (!allowed && planned && plannedExists && selectedHead) {
        // A concurrent start may have just created the active successor. A writer eligible on
        // its finished predecessor can join through the Item selector, without changing the
        // successor's assignees or the exact-Intent selector's access.
        const {
          heads: [previous],
        } = await itemIntentPage(
          ctx,
          projectId,
          payload.intent.intentId,
          [selectedHead._creationTime, selectedHead._id],
          1,
          'desc',
        );
        if (
          previous?.status &&
          intentFinished(previous.status) &&
          successorIntentId(previous.key) === intent.id
        ) {
          const predecessor = await readHostedRecord(ctx, {
            projectId,
            actor,
            kind: 'intent',
            key: previous.key,
            selectedHead: previous,
          });
          if (predecessor) {
            const original = hostedIntentSchema.parse(JSON.parse(predecessor.value));
            allowed =
              intentFinished(original.status) &&
              (original.creatorAccountId === actor || original.assigneeAccountIds.includes(actor));
          }
        }
      }
      if (!allowed && planned) {
        // Later Intent selection cannot invalidate this writer's own completed operation.
        // beginHostedOperation below still checks the actor-bound request and its payload hash.
        const old = await hostedOperationRow(ctx, projectId, actor, payload.operationId);
        allowed = !!(old && hostedOperationSchema.parse(JSON.parse(old.value)).terminal);
      }
      invariant(
        allowed,
        'PROJECT_UNAVAILABLE',
        'Select an Intent created by or assigned to this account on this Forge project.',
      );
    }
  }
  const expected = { authorityEpoch: payload.authorityEpoch, ...payload.expectedMain },
    at = new Date().toISOString(),
    operationId = payload.operationId;
  const holderEnabled = effectivePolicy(project).accessIdentities?.laneHolders === true;
  const sessionIdentity =
    holderSessionId ??
    (typeof user.forgeAuthSession === 'string'
      ? digest(`forge-browser:${user.forgeAuthSession}`)
      : undefined);
  const validateStart = async () => {
    const main = await hostedStartMain(ctx, projectId);
    invariant(
      main.authority.mode === project.sourceAuthority?.mode &&
        main.authority.epoch === expected.authorityEpoch,
      'SOURCE_AUTHORITY_CHANGED',
      'Hosted main and project authority differ.',
    );
    invariant(
      main.head === expected.head && main.receipt.id === expected.receiptId,
      'CHANNEL_CHANGED',
      'Hosted main changed from the expected head and receipt.',
    );
    if (payload.initialHead) {
      const object = await findObject(ctx, projectId, payload.initialHead!);
      invariant(
        object && !object.removed && isStored(object),
        'SOURCE_UNAVAILABLE',
        'Commit the selected initial State before starting its hosted Lane.',
      );
    }
    // Only a reverted change restarts from its own head over its old base (restoreBase). A fix-forward
    // notice's change is still on main, so its fix starts from main: reopening the culprit's head would add
    // its files a second time and conflict with main (friction 4a0b5e35).
    const reverted = recovery?.state === 'reverted' ? recovery : undefined;
    let initialHead = payload.initialHead ?? reverted?.head ?? main.head;
    let ownerOnly = initialHead === main.head;
    let stack: import('../src/hosted-lane').HostedLaneSelection['stack'];
    if (payload.stackOn) {
      const row = await readHostedRecord(ctx, { projectId, actor, kind: 'lane', key: payload.stackOn });
      invariant(row, 'NOT_FOUND', 'Stack parent Lane not found.');
      const parent = hostedLaneSchema.parse(JSON.parse(row.value));
      invariant(
        !payload.initialHead || payload.initialHead === parent.head,
        'WORK_STALE',
        'The saved stack parent changed.',
      );
      initialHead = parent.head;
      ownerOnly = row.ownerOnly === true;
      stack = {
        laneId: parent.id,
        head: parent.head,
        ...(payload.stackEntry ? { entryId: payload.stackEntry } : {}),
      };
    }
    invariant(
      !holderEnabled || sessionIdentity,
      'CLI_UPGRADE_REQUIRED',
      'Update Forge before starting a session-bound Lane.',
    );
    return { main, reverted, initialHead, ownerOnly, stack };
  };
  const prepared = await beginHostedOperation(ctx, {
    projectId,
    actor,
    accountChannel: 'start',
    beforeWrite: validateStart,
    payload,
    request: {
      schema: 1,
      projectId,
      actor,
      operationId,
      expected,
      payloadHash: hostedPayloadHash(payload, expected),
    },
    firstAttempt: {
      projectId,
      operationId,
      id: crypto.randomUUID(),
      parentAttemptId: null,
      at,
      expected,
      ids: {
        intent: targetIntentId ?? crypto.randomUUID(),
        lane: crypto.randomUUID(),
      },
    },
  });
  if (prepared.operation.terminal) {
    const terminal = prepared.operation.terminal.outcome;
    invariant(
      terminal.status === 'completed',
      'WORK_OPERATION_CHANGED',
      'The original operation did not complete.',
    );
    return canonicalPayload(
      startReply(
        terminal.result,
        noticeVersion,
        openLanesVersion,
        guardSet,
        overlapIntent,
        planningItemIdVersion,
      ),
    );
  }
  const { main, reverted, initialHead, ownerOnly, stack } = prepared.validated ?? (await validateStart());
  const restoreBase =
    reverted && initialHead === reverted.head && !payload.stackOn ? reverted.previousHead : undefined;
  const first = prepared.operation.firstAttempt,
    intentId = first.ids.intent!,
    laneId = first.ids.lane!;
  const base = { head: main.head, receiptId: main.receipt.id };
  // Source-only projects have no Plan to write to. Do not make those starts depend on a Work backup.
  const capture =
    action === 'start' &&
    payload.intent.kind === 'new' &&
    authorship?.kind === 'agent' &&
    project.autonomyPolicy?.autoCreatePlanningItem !== false
      ? await selectedGeneration(ctx, project)
      : null;
  if (capture && payload.intent.kind === 'new') {
    await stagePlanningCapture(ctx, project, capture, {
      itemId: intentId,
      operationId: first.id,
      title: payload.intent.outcome,
      at: first.at,
      agent,
      agentClient,
    });
    planningItemId = intentId;
    await wakePlanningCaptures(ctx, projectId);
  }
  // From the pin on, hosted paths own the Intent's status; the journal copy leaves it (projectWorkStore).
  const pin = action === 'start' ? unpinned : undefined;
  if (pin)
    await writeHostedRecord(ctx, {
      projectId,
      actor,
      authorityEpoch: expected.authorityEpoch,
      expectedVersion: pin.version,
      planningItemId,
      record: {
        ...pin,
        version: pin.version + 1,
        at: first.at,
        base,
        status: 'active',
        ...(pin.creatorAccountId === actor || pin.assigneeAccountIds.includes(actor)
          ? {}
          : { assigneeAccountIds: [...pin.assigneeAccountIds, actor] }),
      },
    });
  if (payload.intent.kind === 'new' || (payload.intent.kind === 'planned' && !plannedExists))
    await writeHostedRecord(ctx, {
      projectId,
      actor,
      authorityEpoch: expected.authorityEpoch,
      expectedVersion: null,
      planningItemId,
      record: {
        kind: 'intent',
        id: intentId,
        version: 0,
        at: first.at,
        outcome: payload.intent.outcome,
        constraints: payload.intent.constraints,
        creatorAccountId: actor,
        assigneeAccountIds: [],
        base,
        status: 'active',
      },
    });
  const holder = holderEnabled
    ? {
        actor,
        ...(agent ? { agent } : {}),
        sessionId: sessionIdentity!,
        since: Date.parse(first.at),
        lastSeen: Date.parse(first.at),
      }
    : undefined;
  const lane =
    action === 'start'
      ? hostedLaneSelectionSchema.parse({
          schema: 2,
          ...sourceAuthorship({ ...validated.data, ...(agent ? { agentRun: agent } : {}) }),
          projectId,
          laneId,
          intentId,
          base,
          head: initialHead,
          ...(stack ? { stack } : {}),
          version: 0,
          sourceVersion: 0,
          lifecycleVersion: 0,
          state: 'active',
          ...(holder ? { holder } : {}),
          authority: main.authority,
        })
      : null;
  if (lane)
    await writeHostedRecord(ctx, {
      projectId,
      actor,
      authorityEpoch: expected.authorityEpoch,
      expectedVersion: null,
      planningItemId,
      ownerOnly,
      overlap: {
        baseSequence: main.sourceRevision,
        intent: overlapIntent,
        ...(agent ? { agent } : {}),
        ...(agent && hooks ? { hooks } : {}),
        ...(holderEnabled && sessionIdentity
          ? { session: provenance(sessionIdentity, session, Date.parse(first.at), ctx.forgeDevice) }
          : {}),
      },
      record: {
        kind: 'lane',
        ...sourceAuthorship({ ...validated.data, ...(agent ? { agentRun: agent } : {}) }),
        id: laneId,
        ...(restoreBase ? { restoreBase } : {}),
        intentId,
        actor,
        version: 0,
        at: first.at,
        base,
        head: initialHead,
        ...(stack ? { stack } : {}),
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        ...(holder ? { holder } : {}),
        authorityEpoch: expected.authorityEpoch,
      },
    });
  const pendingFixes = needsFix(project);
  // A new Intent has no other Lanes: no read.
  const openLanes =
    lane && (payload.intent.kind === 'existing' || plannedExists)
      ? await openSiblingLanes(ctx, projectId, intentId, laneId, actor, dormantCutoff(project))
      : [];
  const result = hostedStartResultSchema.parse({
    schema: 1,
    operationId,
    intentId,
    ...(capture ? { planningItemId: intentId } : {}),
    lane,
    at: first.at,
    ...(recovery ? { fixBrief: fixBrief(recovery) } : {}),
    ...(pendingFixes.length ? { needsFix: pendingFixes } : {}),
    ...(openLanes.length ? { openLanes } : {}),
  });
  await finishHostedOperation(ctx, {
    projectId,
    actor,
    operationId,
    receipt: { attemptId: first.id, at: first.at, outcome: { status: 'completed', result } },
  });
  // A member's start of a planned Item: planning writes are the owner's, so the server moves an open Issue to in
  // progress (projectPlanningStart.ts checks the kind and status), after this start commits. The owner's client does
  // it, with the claim, in one write.
  if (action === 'start' && lane && payload.intent.kind === 'planned')
    await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectPlanningStart:move'), {
      projectId,
      owner: project.owner,
      itemId: payload.intent.intentId,
      actor,
      startOperationId: operationId,
    });
  return canonicalPayload(
    startReply(result, noticeVersion, openLanesVersion, guardSet, overlapIntent, planningItemIdVersion),
  );
}

export const start = receiptMutation({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return await execute(ctx, input, 'start');
    } catch (error) {
      return report(error);
    }
  },
});
/** Planned hosted Intent creation uses the same atomic retry envelope without a Lane. */
export const createIntent = mutation({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return await execute(ctx, input, 'intent');
    } catch (error) {
      return report(error);
    }
  },
});

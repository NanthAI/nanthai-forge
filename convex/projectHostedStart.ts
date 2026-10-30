// SPDX-License-Identifier: Apache-2.0
import { needsFix, fixBrief } from '../src/culprit-bisect';
import { v } from 'convex/values';
import { mutation, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { beginHostedOperation, finishHostedOperation } from './projectHostedOperations';
import { readHostedRecord, writeHostedRecord } from './projectHostedRecords';
import { hostedStartMain } from './projectHostedChannels';
import {
  hostedStartSchema,
  hostedIntentSchema,
  hostedLaneSchema,
  hostedLaneSelectionSchema,
  hostedStartResultSchema,
} from '../src/hosted-lane';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { isStored } from './projectObjectFields';

const args = {
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  noticeVersion: v.optional(v.literal(1)),
  authorityEpoch: v.number(),
  expectedMain: v.object({ head: v.string(), receiptId: v.string() }),
  initialHead: v.optional(v.string()),
  stackOn: v.optional(v.string()),
  stackEntry: v.optional(v.string()),
  intent: v.union(
    v.object({ kind: v.literal('new'), outcome: v.string(), constraints: v.optional(v.string()) }),
    v.object({ kind: v.literal('existing'), intentId: v.string() }),
  ),
};
type Input = {
  projectId: Id<'hostedProjects'>;
  operationId: string;
  noticeVersion?: 1;
  authorityEpoch: number;
  expectedMain: { head: string; receiptId: string };
  initialHead?: string;
  stackOn?: string;
  stackEntry?: string;
  intent: { kind: 'new'; outcome: string; constraints?: string } | { kind: 'existing'; intentId: string };
};

function startReply(value: unknown, noticeVersion?: 1) {
  const result = hostedStartResultSchema.parse(value);
  if (noticeVersion === 1) return result;
  const { fixBrief: brief, needsFix: notices, ...legacy } = result;
  void brief;
  void notices;
  return legacy;
}

/** One mutation commits the Intent, Lane and original result, with no global revision write. */
async function execute(ctx: MutationCtx, input: Input, action: 'start' | 'intent') {
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
  const { noticeVersion, ...semanticRequest } = validated.data;
  const payload = { action, ...semanticRequest };
  invariant(action === 'start' || payload.intent.kind === 'new', 'BAD_ARGUMENT', 'Create a new Intent.');
  let overlapIntent = payload.intent.kind === 'new' ? payload.intent.outcome : payload.intent.intentId;
  let recovery: import('../src/culprit-bisect').NeedsFix | undefined;
  if (payload.intent.kind === 'existing') {
    const row = await readHostedRecord(ctx, {
      projectId,
      actor,
      kind: 'intent',
      key: payload.intent.intentId,
    });
    invariant(row, 'NOT_FOUND', 'Hosted Intent not found on this project.');
    const intent = hostedIntentSchema.parse(JSON.parse(row.value));
    overlapIntent = intent.outcome;
    if (!['abandoned', 'completed'].includes(intent.status)) recovery = intent.needsFix;
    invariant(
      project.owner === actor ||
        intent.creatorAccountId === actor ||
        intent.assigneeAccountIds.includes(actor),
      'PROJECT_UNAVAILABLE',
      'Select an Intent created by or assigned to this account on this Forge project.',
    );
  }
  const expected = { authorityEpoch: payload.authorityEpoch, ...payload.expectedMain },
    at = new Date().toISOString(),
    operationId = payload.operationId;
  const prepared = await beginHostedOperation(ctx, {
    projectId,
    actor,
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
        intent: payload.intent.kind === 'existing' ? payload.intent.intentId : crypto.randomUUID(),
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
    return canonicalPayload(startReply(terminal.result, noticeVersion));
  }
  const main = await hostedStartMain(ctx, projectId);
  invariant(
    main.authority.mode === project.sourceAuthority?.mode && main.authority.epoch === expected.authorityEpoch,
    'SOURCE_AUTHORITY_CHANGED',
    'Hosted main and project authority differ.',
  );
  invariant(
    main.head === expected.head && main.receipt.id === expected.receiptId,
    'CHANNEL_CHANGED',
    'Hosted main changed from the expected head and receipt.',
  );
  if (payload.initialHead) {
    const object = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q =>
        q.eq('projectId', projectId).eq('digest', payload.initialHead!),
      )
      .unique();
    invariant(
      object && !object.removed && isStored(object),
      'SOURCE_UNAVAILABLE',
      'Commit the selected initial State before starting its hosted Lane.',
    );
  }
  let initialHead = payload.initialHead ?? recovery?.head ?? main.head;
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
  const restoreBase =
    recovery && initialHead === recovery.head && !payload.stackOn ? recovery.previousHead : undefined;
  const first = prepared.operation.firstAttempt,
    intentId = first.ids.intent!,
    laneId = first.ids.lane!;
  const base = { head: main.head, receiptId: main.receipt.id };
  if (payload.intent.kind === 'new')
    await writeHostedRecord(ctx, {
      projectId,
      actor,
      authorityEpoch: expected.authorityEpoch,
      expectedVersion: null,
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
  const lane =
    action === 'start'
      ? hostedLaneSelectionSchema.parse({
          schema: 2,
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
          authority: main.authority,
        })
      : null;
  if (lane)
    await writeHostedRecord(ctx, {
      projectId,
      actor,
      authorityEpoch: expected.authorityEpoch,
      expectedVersion: null,
      ownerOnly,
      overlap: { baseSequence: main.sourceRevision, intent: overlapIntent },
      record: {
        kind: 'lane',
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
        authorityEpoch: expected.authorityEpoch,
      },
    });
  const pendingFixes = needsFix(project);
  const result = hostedStartResultSchema.parse({
    schema: 1,
    operationId,
    intentId,
    lane,
    at: first.at,
    ...(recovery ? { fixBrief: fixBrief(recovery) } : {}),
    ...(pendingFixes.length ? { needsFix: pendingFixes } : {}),
  });
  await finishHostedOperation(ctx, {
    projectId,
    actor,
    operationId,
    receipt: { attemptId: first.id, at: first.at, outcome: { status: 'completed', result } },
  });
  return canonicalPayload(startReply(result, noticeVersion));
}

export const start = mutation({
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

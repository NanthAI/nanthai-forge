// SPDX-License-Identifier: Apache-2.0
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
  hostedLaneSelectionSchema,
  hostedStartResultSchema,
} from '../src/hosted-lane';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

const args = {
  projectId: v.id('hostedProjects'),
  operationId: v.string(),
  authorityEpoch: v.number(),
  expectedMain: v.object({ head: v.string(), receiptId: v.string() }),
  intent: v.union(
    v.object({ kind: v.literal('new'), outcome: v.string(), constraints: v.optional(v.string()) }),
    v.object({ kind: v.literal('existing'), intentId: v.string() }),
  ),
};
type Input = {
  projectId: Id<'hostedProjects'>;
  operationId: string;
  authorityEpoch: number;
  expectedMain: { head: string; receiptId: string };
  intent: { kind: 'new'; outcome: string; constraints?: string } | { kind: 'existing'; intentId: string };
};

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
  const payload = { action, ...validated.data };
  invariant(action === 'start' || payload.intent.kind === 'new', 'BAD_ARGUMENT', 'Create a new Intent.');
  if (payload.intent.kind === 'existing') {
    const row = await readHostedRecord(ctx, {
      projectId,
      actor,
      kind: 'intent',
      key: payload.intent.intentId,
    });
    invariant(row, 'NOT_FOUND', 'Hosted Intent not found on this project.');
    const intent = hostedIntentSchema.parse(JSON.parse(row.value));
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
    return canonicalPayload(terminal.result);
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
          head: main.head,
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
      record: {
        kind: 'lane',
        id: laneId,
        intentId,
        actor,
        version: 0,
        at: first.at,
        base,
        head: main.head,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        authorityEpoch: expected.authorityEpoch,
      },
    });
  const result = hostedStartResultSchema.parse({ schema: 1, operationId, intentId, lane, at: first.at });
  await finishHostedOperation(ctx, {
    projectId,
    actor,
    operationId,
    receipt: { attemptId: first.id, at: first.at, outcome: { status: 'completed', result } },
  });
  return canonicalPayload(result);
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

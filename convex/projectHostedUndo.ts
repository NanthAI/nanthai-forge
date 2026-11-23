// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ConvexError, v } from 'convex/values';
import type { z } from 'zod';
import { guard, receiptMutation, type MutationCtx } from './cliServer';
import { internalMutation } from './server';
import { report } from './errors';
import { laneFinishActiveMessage, laneFinishes, supersedeLaneFinishes } from './projectHostedLaneFinish';
import { laneSession, requireLaneHolder } from './projectLaneHolder';
import { requireLaneSourceAuthority } from './projectLaneAuthority';
import { beginHostedOperation, finishHostedOperation } from './projectHostedOperations';
import { hostedRecordBody, readHostedRecord, recordVersion, writeHostedRecord } from './projectHostedRecords';
import {
  saveLaneRecord,
  sameSaveLane,
  saveObject,
  saveRow,
  type SaveIdentity,
} from './projectHostedSaveStore';
import { syncLaneSelection } from './projectHostedSyncUpToDate';
import { JournalNeeded, parseLoadedJournalSegment } from './projectJournalStore';
import { hostedLaneSchema } from '../src/hosted-lane';
import { hostedRecordSchema } from '../src/hosted-records';
import { saveRequestSchema } from '../src/hosted-save';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { undoReceiptSchema, undoRequestSchema } from '../src/hosted-undo';
import { invariant } from '../src/errors';
import { decodeRequest } from './publicWorkReads';

type HostedLane = z.infer<typeof hostedLaneSchema>;

const args = { projectId: v.id('hostedProjects'), request: v.string() };

/** Reuse the exact retained State and its source context in one Lane CAS. */
export const undo = receiptMutation({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return await restore(ctx, input);
    } catch (error) {
      // Throwing rolls back the operation reservation. The action reads the archive privately,
      // then retries the same payload and CAS.
      if (error instanceof JournalNeeded)
        throw new ConvexError({
          code: 'SOURCE_UNAVAILABLE',
          message: 'The undo target needs a retained history read.',
          undoHistory: true,
        });
      return report(error);
    }
  },
});

export const archived = internalMutation({
  args: { ...args, segments: v.array(v.string()) },
  returns: v.string(),
  handler: async (ctx, { segments, ...input }) => {
    const selected = {
      ...ctx,
      ...(await guard(ctx, 'cli')),
      journalPrivate: true,
      journalLoaded: segments.map(parseLoadedJournalSegment),
    };
    try {
      return await restore(selected, input);
    } catch (error) {
      if (error instanceof JournalNeeded) throw new ConvexError({ index: canonicalPayload(error.index) });
      return report(error);
    }
  },
});

async function restore(ctx: MutationCtx, input: { projectId: SaveIdentity['projectId']; request: string }) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to undo a Lane save.');
  const parsed = undoRequestSchema.safeParse(decodeRequest(input.request));
  invariant(parsed.success, 'BAD_ARGUMENT', 'Select the exact Lane pins and an optional saved target.');
  const request = parsed.data;
  const auth = { projectId: input.projectId, actor: user.subject, operationId: request.operationId };
  const expected = {
    authorityEpoch: request.authorityEpoch,
    head: request.expected.head,
    resourceId: request.laneId,
    resourceVersion: request.expected.version,
    sourceRevision: request.expected.sourceVersion,
  };
  const prepared = await beginHostedOperation(ctx, {
    ...auth,
    payload: request,
    request: { schema: 1, ...auth, expected, payloadHash: hostedPayloadHash(request, expected) },
    firstAttempt: {
      projectId: auth.projectId,
      operationId: auth.operationId,
      id: crypto.randomUUID(),
      parentAttemptId: null,
      at: new Date().toISOString(),
      expected,
      ids: {},
    },
  });
  const { firstAttempt, terminal } = prepared.operation;
  if (prepared.replayed) {
    invariant(
      terminal?.outcome.status === 'completed',
      'SOURCE_UNAVAILABLE',
      'The undo receipt is unavailable.',
    );
    return canonicalPayload(terminal.outcome.result);
  }
  const { lane, ownerOnly } = await saveLaneRecord(ctx, { ...auth, laneId: request.laneId });
  requireLaneSourceAuthority(prepared.project, lane, auth.actor);
  requireLaneHolder(lane, auth.actor, await laneSession(ctx, request.holderSessionId));
  invariant(lane.state === 'active', 'LANE_NOT_ACTIVE', 'Open this Lane before restoring an earlier save.');
  invariant(
    sameSaveLane(lane, request.expected),
    'WORK_STALE',
    'The Lane changed. Open its latest head, then start undo with a fresh operation ID.',
  );
  const target = await undoTarget(ctx, auth, lane, request);
  invariant(target.version <= lane.version, 'NOT_FOUND', 'Select a retained version of this Lane.');
  const row = await recordVersion(ctx, auth.projectId, 'lane', lane.id, target.version);
  invariant(row, 'NOT_FOUND', 'The selected version of this Lane is unavailable.');
  const previous = hostedLaneSchema.parse(JSON.parse(await hostedRecordBody(ctx, row)));
  invariant(
    target.head === undefined || target.head === previous.head,
    'SOURCE_HASH_MISMATCH',
    'The saved head differs from its recorded Lane version.',
  );
  const { id, head, version, sourceVersion, lifecycleVersion } = lane;
  let updated = lane;
  if (canonicalPayload(sourceContext(lane)) !== canonicalPayload(sourceContext(previous))) {
    const finishes = await laneFinishes(ctx, {
      projectId: auth.projectId,
      laneId: id,
      headWrittenAt: lane.at,
    });
    if (finishes.live) invariant(false, 'LANE_FINISH_ACTIVE', laneFinishActiveMessage(id, finishes.live));
    await saveObject(ctx, auth.projectId, { sha256: previous.head });
    updated = {
      ...lane,
      version: version + 1,
      sourceVersion: sourceVersion + 1,
      at: firstAttempt.at,
    };
    for (const field of ['stack', 'resolution', 'earlyResolution', 'restoreBase'] as const)
      delete updated[field];
    Object.assign(updated, sourceContext(previous));
    await writeHostedRecord(ctx, {
      ...auth,
      authorityEpoch: request.authorityEpoch,
      expectedVersion: version,
      ownerOnly: ownerOnly && row.ownerOnly === true,
      record: updated,
      // The prior changed-path evidence no longer describes this head. Later readers can fall
      // back to its exact State; no source I/O belongs in this transaction.
      overlap: { complete: false, savedBy: auth.actor },
    });
    if (finishes.syncRequired.length)
      await supersedeLaneFinishes(ctx, {
        projectId: auth.projectId,
        laneId: id,
        head: updated.head,
        submissionIds: finishes.syncRequired,
      });
  }
  const result = undoReceiptSchema.parse({
    operationId: auth.operationId,
    at: firstAttempt.at,
    lane: await syncLaneSelection(ctx, auth.projectId, updated),
    from: { laneId: id, head, version, sourceVersion, lifecycleVersion },
    restored: {
      head: previous.head,
      version: previous.version,
      ...(target.saveId ? { saveId: target.saveId } : {}),
    },
  });
  await finishHostedOperation(ctx, {
    ...auth,
    receipt: { attemptId: firstAttempt.id, at: firstAttempt.at, outcome: { status: 'completed', result } },
  });
  return canonicalPayload(result);
}

/** Restore the pins that describe the old tree, without rolling back the Lane's current holder or lifecycle. */
const sourceContext = (lane: HostedLane) => ({
  head: lane.head,
  base: lane.base,
  ...(lane.stack ? { stack: lane.stack } : {}),
  ...(lane.resolution ? { resolution: lane.resolution } : {}),
  ...(lane.earlyResolution ? { earlyResolution: lane.earlyResolution } : {}),
  ...(lane.restoreBase ? { restoreBase: lane.restoreBase } : {}),
});

async function undoTarget(
  ctx: MutationCtx,
  auth: SaveIdentity,
  lane: HostedLane,
  request: ReturnType<typeof undoRequestSchema.parse>,
): Promise<{ version: number; head?: string; saveId?: string }> {
  if (request.version !== undefined) return { version: request.version };
  const recent = request.saveId
    ? null
    : await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_parent', q =>
          q.eq('projectId', auth.projectId).eq('kind', 'save').eq('parent', lane.id),
        )
        .order('desc')
        .first();
  const key = request.saveId ?? recent?.key;
  invariant(key, 'NOT_FOUND', 'This Lane has no save to undo.');
  const selected = await readHostedRecord(ctx, { ...auth, kind: 'save', key });
  invariant(selected?.parent === lane.id, 'NOT_FOUND', 'Select a save from this Lane.');
  const save = hostedRecordSchema.options[2].parse(JSON.parse(selected.value));
  const operation = await saveRow(ctx, { ...auth, actor: save.actor, operationId: save.operationId });
  invariant(operation, 'SOURCE_UNAVAILABLE', 'The save’s original Lane pins are unavailable.');
  const pins = saveRequestSchema.parse(JSON.parse(operation.value).request);
  invariant(
    pins.laneId === lane.id &&
      pins.expected.head === save.expectedHead &&
      pins.expected.sourceVersion === save.expectedSourceVersion,
    'SOURCE_HASH_MISMATCH',
    'The save differs from its original Lane pins.',
  );
  const rollingBack = request.saveId === undefined;
  return {
    version: pins.expected.version + (!rollingBack && save.head !== save.expectedHead ? 1 : 0),
    head: rollingBack ? save.expectedHead : save.head,
    saveId: save.id,
  };
}

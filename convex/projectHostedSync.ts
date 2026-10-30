import { sourceProgress } from './projectSourceProgress';
import { loadLanding } from './projectHostedLandingStore';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query, type QueryCtx, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { beginHostedOperation } from './projectHostedOperations';
import { readHostedRecord } from './projectHostedRecords';
import { hostedStartMain } from './projectHostedChannels';
import { saveLane, sameSaveLane, saveObject } from './projectHostedSaveStore';
import { syncRow, loadSync, hostedSyncInput, type SyncState } from './projectHostedSyncStore';
import { prepareHostedRevert } from './projectHostedRevert';
import { syncRequestSchema } from '../src/hosted-sync';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
const identity = { projectId: v.id('hostedProjects'), operationId: v.string() };
async function caller(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; operationId: string },
) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to sync hosted source.');
  await activeProject(ctx, input.projectId, user.subject);
  return { projectId: input.projectId, operationId: input.operationId, actor: user.subject };
}
/** Pin once. No current-source substitution on retry, and no source bytes in this mutation. */
export const prepare = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = syncRequestSchema.parse(JSON.parse(input.request)),
        auth = await caller(ctx, { projectId: input.projectId, operationId: request.operationId });
      const expected = {
        authorityEpoch: request.authorityEpoch,
        ...('expected' in request
          ? {
              head: request.expected.head,
              resourceId: request.laneId,
              resourceVersion: request.expected.version,
            }
          : request.kind === 'revert'
            ? {
                resourceId:
                  request.target.kind === 'receipt' ? request.target.receiptId : request.target.submissionId,
              }
            : { resourceId: request.candidateId }),
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
          ids: {
            intent: crypto.randomUUID(),
            lane: crypto.randomUUID(),
            job: crypto.randomUUID(),
            jobOperation: crypto.randomUUID(),
          },
        },
      });
      if (prepared.replayed) {
        const old = await syncRow(ctx, auth);
        invariant(old, 'SOURCE_UNAVAILABLE', 'The original sync is unavailable.');
        return canonicalPayload({ state: JSON.parse(old.value), terminal: prepared.operation.terminal });
      }
      let ownerInputs = false;
      let work: SyncState['work'],
        lane: SyncState['lane'] = null,
        intentId: string,
        base: SyncState['base'];
      const candidate = async (id: string) => {
        const row = await readHostedRecord(ctx, { ...auth, kind: 'candidate', key: id });
        invariant(row, 'NOT_FOUND', 'Select a Candidate on this project.');
        return hostedRecordSchema.options[3].parse(JSON.parse(row.value));
      };
      if (request.kind === 'revert') {
        const selected = await prepareHostedRevert(ctx, auth, request, prepared.operation.firstAttempt);
        intentId = selected.intentId;
        base = selected.base;
        work = selected.work;
      } else if (request.kind === 'resolution') {
        const selected = await candidate(request.candidateId);
        invariant(
          selected.result.status === 'conflict' &&
            canonicalPayload(selected.result.conflicts) === canonicalPayload(request.conflicts),
          'WORK_STALE',
          'Resolve the exact original Candidate conflict root.',
        );
        await saveObject(ctx, auth.projectId, request.conflicts);
        intentId = selected.intentId;
        base = selected.base;
        work = { mode: 'resolution', candidateId: selected.id, conflicts: request.conflicts };
      } else {
        lane = await saveLane(ctx, { ...auth, laneId: request.laneId });
        invariant(sameSaveLane(lane, request.expected), 'WORK_STALE', 'Select the exact saved Lane pins.');
        intentId = lane.intentId;
        base = lane.base;
        const left = await saveObject(ctx, auth.projectId, { sha256: lane.head });
        if (request.kind === 'resolve') {
          invariant(
            lane.resolution?.status === 'pending',
            'WORK_STALE',
            'Select the pending resolution Lane.',
          );
          work = { mode: 'resolve', left, resolution: lane.resolution };
        } else {
          const target = request.target;
          if (target.kind === 'main') {
            ownerInputs = true;
            const main = await hostedStartMain(ctx, auth.projectId);
            invariant(
              main.head === target.head &&
                main.receipt.id === target.receiptId &&
                main.authority.epoch === request.authorityEpoch,
              'CHANNEL_CHANGED',
              'Sync against the exact observed main head and receipt.',
            );
          } else {
            const selected = await candidate(target.candidateId);
            ownerInputs = selected.governance?.ownerInputs === true;
            invariant(
              selected.result.status === 'clean' && selected.result.head === target.head,
              'WORK_STALE',
              'Select the exact clean target Candidate.',
            );
          }
          let right = target.head;
          let stackBase, stackAfter;
          if (lane.restoreBase)
            stackBase = await saveObject(ctx, auth.projectId, { sha256: lane.restoreBase });
          if (target.kind === 'main' && lane.stack && !lane.stack.detached) {
            const parentRow = await readHostedRecord(ctx, { ...auth, kind: 'lane', key: lane.stack.laneId });
            invariant(parentRow, 'NOT_FOUND', 'Stack parent Lane not found.');
            const parent = hostedRecordSchema.options[1].parse(JSON.parse(parentRow.value));
            const entry = lane.stack.entryId
              ? (await loadLanding(ctx, { projectId: auth.projectId, submissionId: lane.stack.entryId }))
                  .state
              : null;
            const detached =
              request.ontoMain ||
              parent.state === 'abandoned' ||
              entry?.phase === 'landed' ||
              entry?.phase === 'terminal-failed';
            right = detached ? target.head : parent.head;
            ownerInputs = detached || parentRow.ownerOnly === true;
            stackBase = await saveObject(ctx, auth.projectId, { sha256: lane.stack.head });
            stackAfter = { ...lane.stack, head: right, ...(detached ? { detached: true } : {}) };
          }
          work = {
            mode: 'sync',
            left,
            right: await saveObject(ctx, auth.projectId, { sha256: right }),
            ...(stackBase ? { stackBase, stackAfter } : {}),
          };
        }
      }
      const state: SyncState = {
        ownerInputs,
        request,
        work,
        lane,
        intentId,
        base,
        resolutionLaneId: prepared.operation.firstAttempt.ids.lane!,
        jobOperationId: prepared.operation.firstAttempt.ids.jobOperation!,
        status: 'ready',
      };
      await ctx.db.insert('projectHostedSyncs', {
        ...auth,
        jobId: prepared.operation.firstAttempt.ids.job!,
        value: canonicalPayload(state),
      });
      return canonicalPayload({ state, terminal: null });
    } catch (error) {
      return report(error);
    }
  },
});
export const progress = query({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const auth = await caller(ctx, input),
        { row, state, operation } = await loadSync(ctx, auth, false);
      return canonicalPayload({
        ...(state.status === 'submitted' || state.status === 'failed'
          ? await sourceProgress(ctx, input.projectId, row.jobId)
          : {}),
        ...(operation.terminal?.outcome.status === 'failed'
          ? { status: 'failed', error: operation.terminal.outcome.error }
          : {}),
        state,
        terminal: operation.terminal,
        input: hostedSyncInput(state, operation.firstAttempt.at),
      });
    } catch (error) {
      return report(error);
    }
  },
});

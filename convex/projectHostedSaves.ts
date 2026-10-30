import { sourceProgress } from './projectSourceProgress';
// SPDX-License-Identifier: Apache-2.0
import { boundOverlapChanges, type OverlapChange } from '../src/hosted-overlap';
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { activeProject } from './projectAuthority';
import { beginHostedOperation } from './projectHostedOperations';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { saveRequestSchema, validateSavePage, savePin, saveInputSchema } from '../src/hosted-save';
import {
  loadSave,
  saveLane,
  sameSaveLane,
  saveObject,
  saveObjects,
  saveRow,
  writeSaveState,
  type SaveIdentity,
} from './projectHostedSaveStore';
import { refuseLiveLaneFinish } from './projectHostedLaneFinish';
import { invariant } from '../src/errors';
import { report } from './errors';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

const identity = { projectId: v.id('hostedProjects'), operationId: v.string() };
async function caller(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; operationId: string },
): Promise<SaveIdentity> {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to save hosted source.');
  await activeProject(ctx, input.projectId, user.subject);
  return { projectId: input.projectId, operationId: input.operationId, actor: user.subject };
}
export const prepare = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = saveRequestSchema.parse(JSON.parse(input.request)),
        auth = await caller(ctx, { projectId: input.projectId, operationId: request.operationId }),
        expected = {
          authorityEpoch: request.authorityEpoch,
          head: request.expected.head,
          resourceId: request.laneId,
          resourceVersion: request.expected.version,
          sourceRevision: request.expected.sourceVersion,
        };
      // Refuse before any operation exists so a later explicit save starts clean.
      // An empty delta never moves the head, so it keeps the live finish's proof.
      if (request.pages && !request.supersedeFinish) {
        const current = await saveLane(ctx, { ...auth, laneId: request.laneId });
        if (current.state === 'active' && sameSaveLane(current, request.expected))
          await refuseLiveLaneFinish(ctx, {
            projectId: input.projectId,
            laneId: request.laneId,
            headWrittenAt: current.at,
          });
      }
      const prepared = await beginHostedOperation(ctx, {
        ...auth,
        payload: request,
        request: { schema: 1, ...auth, expected, payloadHash: hostedPayloadHash(request, expected) },
        firstAttempt: {
          projectId: input.projectId,
          operationId: request.operationId,
          id: crypto.randomUUID(),
          parentAttemptId: null,
          at: new Date().toISOString(),
          expected,
          ids: { save: crypto.randomUUID(), job: crypto.randomUUID(), jobOperation: crypto.randomUUID() },
        },
      });
      if (prepared.replayed) {
        const old = await saveRow(ctx, auth);
        invariant(old, 'SOURCE_UNAVAILABLE', 'The original save preparation is unavailable.');
        const state = JSON.parse(old.value);
        return canonicalPayload({
          state,
          terminal: prepared.operation.terminal,
          input: request.pages ? hostedSaveInput(state, prepared.operation.firstAttempt.at) : null,
        });
      }
      const lane = await saveLane(ctx, { ...auth, laneId: request.laneId });
      invariant(
        sameSaveLane(lane, request.expected),
        'WORK_STALE',
        'Hosted Lane changed from the expected save baseline.',
      );
      const baseline = await saveObject(ctx, input.projectId, { sha256: lane.head });
      const state = {
        request,
        baseline,
        next: request.pages,
        stagedPages: 0,
        stagedChanges: 0,
        lastPath: null,
        jobOperationId: prepared.operation.firstAttempt.ids.jobOperation!,
        status: request.pages ? ('staging' as const) : ('ready' as const),
      };
      await ctx.db.insert('projectHostedSaves', {
        ...auth,
        jobId: prepared.operation.firstAttempt.ids.job!,
        value: canonicalPayload(state),
      });
      return canonicalPayload({
        state,
        terminal: null,
        input: request.pages ? hostedSaveInput(state, prepared.operation.firstAttempt.at) : null,
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const stage = mutation({
  args: { ...identity, index: v.number(), page: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const auth = await caller(ctx, input),
        { row, state, operation } = await loadSave(ctx, auth);
      const { page, lastPath } = validateSavePage(
          JSON.parse(input.page),
          input.index === state.stagedPages ? state.lastPath : null,
        ),
        pin = savePin(page);
      const old = await ctx.db
        .query('projectHostedSavePages')
        .withIndex('by_project_and_actor_and_operation_and_index', q =>
          q
            .eq('projectId', input.projectId)
            .eq('actor', auth.actor)
            .eq('operationId', input.operationId)
            .eq('index', input.index),
        )
        .unique();
      if (old) {
        invariant(old.digest === pin.sha256, 'WORK_OPERATION_CHANGED', 'Retry the original save page.');
        return canonicalPayload(state);
      }
      invariant(
        !operation.terminal &&
          state.status === 'staging' &&
          input.index === state.stagedPages &&
          state.next?.sha256 === pin.sha256 &&
          state.next.size === pin.size,
        'WORK_OPERATION_CHANGED',
        'Stage the next exact original delta page.',
      );
      const contents = page.changes.flatMap(change => (change.after ? [change.after.content] : []));
      const stored = await saveObjects(ctx, input.projectId, [pin, ...contents.map(value => value.object)]);
      for (let i = 0; i < contents.length; i++)
        invariant(
          canonicalPayload(stored[i + 1]) === canonicalPayload(contents[i]),
          'WORK_OPERATION_CHANGED',
          'Delta content differs from its committed project binding.',
        );
      const stagedPages = state.stagedPages + 1,
        stagedChanges = state.stagedChanges + page.changes.length;
      invariant(
        stagedPages <= state.request.pageCount &&
          stagedChanges <= state.request.changeCount &&
          (page.next === null) === (stagedPages === state.request.pageCount) &&
          (page.next !== null || stagedChanges === state.request.changeCount),
        'WORK_OPERATION_CHANGED',
        'Delta page counts or continuation differ from preparation.',
      );
      const overlap = boundOverlapChanges(
        [...(JSON.parse(state.overlapChanges ?? '[]') as OverlapChange[]), ...page.changes],
        state.overlapComplete !== false,
      );
      const next = {
        ...state,
        overlapChanges: overlap.changes,
        overlapComplete: overlap.complete,
        stagedPages,
        stagedChanges,
        lastPath,
        next: page.next,
        status: page.next ? ('staging' as const) : ('ready' as const),
      };
      await ctx.db.insert('projectHostedSavePages', { ...auth, index: input.index, digest: pin.sha256 });
      await writeSaveState(ctx, row._id, next);
      return canonicalPayload(next);
    } catch (error) {
      return report(error);
    }
  },
});
/** Small trusted plan; bytes and full baseline inventories stay outside Convex. */
export function hostedSaveInput(state: Awaited<ReturnType<typeof loadSave>>['state'], at: string) {
  invariant(state.request.pages, 'BAD_ARGUMENT', 'An unchanged save needs no source worker.');
  return saveInputSchema.parse({
    schema: 1,
    kind: 'forge-hosted-save-input',
    baseline: state.baseline,
    pages: state.request.pages,
    pageCount: state.request.pageCount,
    changeCount: state.request.changeCount,
    message: state.request.message,
    at,
  });
}
export const progress = query({
  args: identity,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const auth = await caller(ctx, input),
        { row, state, operation } = await loadSave(ctx, auth, false);
      return canonicalPayload({
        ...(state.status === 'submitted' || state.status === 'failed'
          ? await sourceProgress(ctx, input.projectId, row.jobId)
          : {}),
        ...(operation.terminal?.outcome.status === 'failed'
          ? { status: 'failed', error: operation.terminal.outcome.error }
          : {}),
        state,
        terminal: operation.terminal,
        input:
          state.request.pages && state.status !== 'staging'
            ? hostedSaveInput(state, operation.firstAttempt.at)
            : null,
      });
    } catch (error) {
      return report(error);
    }
  },
});

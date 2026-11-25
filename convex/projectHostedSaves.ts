// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { journalIndexAt } from './projectJournalStore';
import { sourceProgress } from './projectSourceProgress';
import { boardWake } from './projectBoardDelivery';
import { hostedSaveState } from '../src/hosted-save-state';
import { sourceAuthority } from '../src/hosted-source-authority';
import { boundOverlapChanges, type OverlapChange } from '../src/hosted-overlap';
import { withoutAuthorship } from '../src/work-actor-types';
import { sessionIdentity } from './projectSessionIdentity';
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { activeProject, requireDeviceWritePaths } from './projectAuthority';
import { beginHostedOperation } from './projectHostedOperations';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { noteText } from '../src/landing-message';
import { saveRequestSchema, validateSavePage, savePin, saveInputSchema } from '../src/hosted-save';
import { validateNotVerified } from '../src/agent-handoff-types';
import {
  clearLaneSaveFailure,
  clearSaveFailure,
  loadSave,
  saveLaneRecord,
  saveLane,
  sameSaveLane,
  saveObject,
  saveObjects,
  saveRow,
  writeSaveState,
  type SaveIdentity,
} from './projectHostedSaveStore';
import { refuseLiveLaneFinish } from './projectHostedLaneFinish';
import { requireLaneSourceAuthorityById } from './projectLaneAuthority';
import { invariant } from '../src/errors';
import { sanitizeOutside } from '../src/run-evidence';
import { requireLaneHolder, laneSession } from './projectLaneHolder';
import { report } from './errors';
import { chainProgress } from './projectHostedResolveChainProgress';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { findObject } from './projectObjectFind';
import { isR2Object, isStored } from './projectObjectFields';
import { prepareObjectTargets, type KnownObjects } from './projectObjects';
import { uploadPackProposal } from './projectObjectPacks';
import type { UploadPackProposal } from '../src/object-pack-upload';

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
const uploadPin = v.object({ digest: v.string(), size: v.number() });
/** A captured raw blob a direct save names as `{object: pin, recipe: null}` without first asking
 * the server (prepare-upload-targets) must not be stored only as a recipe, whose describe would
 * say otherwise: refused before any operation exists, and the CLI then describes it as before. */
async function refuseRecipeUploads(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  uploads: readonly { digest: string; size: number }[],
) {
  // The rows read here are handed to the target preparation in this transaction, which would
  // otherwise look up each one again (review b1448b61 N5a).
  const known: KnownObjects = new Map();
  for (const pin of uploads) {
    if (known.has(pin.digest)) continue;
    const row = await findObject(ctx, projectId, pin.digest);
    known.set(pin.digest, row);
    invariant(
      !row || !isStored(row) || row.removed || isR2Object(row),
      'SAVE_CONTENT_RECIPE',
      'A changed file is stored as a recipe; describe it before saving.',
    );
  }
  return known;
}
/** Each upload's target (`projectObjects:prepareBatch` rows), the save input's last. */
async function saveTargets(
  ctx: MutationCtx,
  auth: SaveIdentity,
  uploads: readonly { digest: string; size: number }[],
  input: { sha256: string; size: number } | null,
  pack: UploadPackProposal | undefined,
  known?: KnownObjects,
) {
  return prepareObjectTargets(
    ctx,
    auth.projectId,
    auth.actor,
    [...uploads, ...(input ? [{ digest: input.sha256, size: input.size }] : [])],
    pack,
    known,
  );
}
export const prepare = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    request: v.string(),
    /** Feature prepare-upload-targets: the pins this save will upload (its new raw blobs and its
     * delta pages, at most 99); the reply's `targets` prepares them and the save input, so the CLI
     * makes no `projectObjects:prepareBatch` call. Its raw blobs must not be recipe-only objects. */
    uploads: v.optional(v.array(uploadPin)),
    /** Feature upload-packs: send these `uploads` (indexes into them) as one pack. */
    uploadPack: v.optional(uploadPackProposal),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const parsed = saveRequestSchema.parse(JSON.parse(input.request));
      noteText(parsed.message);
      validateNotVerified(parsed.notVerified);
      const request = {
        ...parsed,
        ...(parsed.outside === undefined ? {} : { outside: sanitizeOutside(parsed.outside) }),
      };
      const auth = await caller(ctx, { projectId: input.projectId, operationId: request.operationId }),
        expected = {
          authorityEpoch: request.authorityEpoch,
          head: request.expected.head,
          resourceId: request.laneId,
          resourceVersion: request.expected.version,
          sourceRevision: request.expected.sourceVersion,
        };
      const holderSessionId = await laneSession(ctx, request.holderSessionId);
      // Refuse before any operation exists so a later explicit save starts clean.
      // An empty delta never moves the head, so it keeps the live finish's proof.
      if (request.pages && !request.supersedeFinish) {
        const current = await saveLane(ctx, { ...auth, laneId: request.laneId });
        requireLaneHolder(current, auth.actor, holderSessionId);
        await requireLaneSourceAuthorityById(ctx, input.projectId, current, auth.actor);
        if (current.state === 'active' && sameSaveLane(current, request.expected))
          await refuseLiveLaneFinish(ctx, {
            projectId: input.projectId,
            laneId: request.laneId,
            headWrittenAt: current.at,
          });
      }
      const semantic = withoutAuthorship(request);
      const prepared = await beginHostedOperation(ctx, {
        ...auth,
        accountChannel: 'save',
        payload: semantic,
        request: { schema: 1, ...auth, expected, payloadHash: hostedPayloadHash(semantic, expected) },
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
      invariant(
        !input.uploads || input.uploads.length <= 99,
        'BAD_ARGUMENT',
        'Prepare at most 99 save uploads at once.',
      );
      if (prepared.replayed) {
        const old = await saveRow(ctx, auth);
        invariant(old, 'SOURCE_UNAVAILABLE', 'The original save preparation is unavailable.');
        const state = JSON.parse(old.value);
        if (old.background && prepared.operation.terminal?.outcome.status === 'failed')
          await clearSaveFailure(ctx, {
            ...auth,
            laneId: request.laneId,
            attemptId: prepared.operation.terminal.attemptId,
          });
        const replayInput = request.pages ? hostedSaveInput(state, prepared.operation.firstAttempt.at) : null;
        return canonicalPayload({
          state,
          terminal: prepared.operation.terminal,
          input: replayInput,
          ...(input.uploads && !prepared.operation.terminal
            ? {
                targets: await saveTargets(
                  ctx,
                  auth,
                  input.uploads,
                  replayInput && savePin(replayInput),
                  input.uploadPack,
                ),
              }
            : {}),
        });
      }
      // A refusal throws, and the whole transaction (this operation included) rolls back.
      const known = input.uploads
        ? await refuseRecipeUploads(ctx, input.projectId, input.uploads)
        : undefined;
      const { lane, saveFailure } = await saveLaneRecord(ctx, { ...auth, laneId: request.laneId });
      requireLaneHolder(lane, auth.actor, holderSessionId);
      // Only the Lane author or the project owner saves over a Lane (Issue 8809fba5).
      await requireLaneSourceAuthorityById(ctx, input.projectId, lane, auth.actor);
      invariant(
        sameSaveLane(lane, request.expected),
        'WORK_STALE',
        'Hosted Lane changed from the expected save baseline.',
      );
      const baseline = await saveObject(ctx, input.projectId, { sha256: lane.head }, 'save');
      const state = {
        ...(holderSessionId && lane.holder
          ? {
              session: sessionIdentity(holderSessionId, request.session, lane.holder.since, ctx.forgeDevice),
            }
          : {}),
        request,
        baseline,
        next: request.pages,
        stagedPages: 0,
        stagedChanges: 0,
        lastPath: null,
        jobOperationId: prepared.operation.firstAttempt.ids.jobOperation!,
        status: request.pages ? ('staging' as const) : ('ready' as const),
      };
      if (saveFailure) await clearLaneSaveFailure(ctx, saveFailure);
      await ctx.db.insert('projectHostedSaves', {
        ...auth,
        laneId: lane.id,
        commitTs: ctx.db.vars.commitTs,
        jobId: prepared.operation.firstAttempt.ids.job!,
        value: canonicalPayload(state),
      });
      const saveInput = request.pages ? hostedSaveInput(state, prepared.operation.firstAttempt.at) : null;
      return canonicalPayload({
        state,
        terminal: null,
        input: saveInput,
        ...(input.uploads
          ? {
              targets: await saveTargets(
                ctx,
                auth,
                input.uploads,
                saveInput && savePin(saveInput),
                input.uploadPack,
                known,
              ),
            }
          : {}),
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
      const auth = await caller(ctx, input);
      return canonicalPayload(await stageSavePage(ctx, auth, input, await loadSave(ctx, auth)));
    } catch (error) {
      return report(error);
    }
  },
});
/** Stage the next exact original delta page (or confirm a staged one); returns the resulting save state.
 * The caller already loaded this operation and checked its write epoch in this transaction. */
export async function stageSavePage(
  ctx: MutationCtx,
  auth: SaveIdentity,
  input: { index: number; page: string },
  { row, state, operation }: Awaited<ReturnType<typeof loadSave>>,
) {
  const { page, lastPath } = validateSavePage(
      JSON.parse(input.page),
      input.index === state.stagedPages ? state.lastPath : null,
    ),
    pin = savePin(page);
  // A scoped device grant (df06081d) writes only inside its folders: refused before any byte is bound.
  await requireDeviceWritePaths(
    ctx,
    page.changes.map(change => change.path),
  );
  const old = await ctx.db
    .query('projectHostedSavePages')
    .withIndex('by_project_and_actor_and_operation_and_index', q =>
      q
        .eq('projectId', auth.projectId)
        .eq('actor', auth.actor)
        .eq('operationId', auth.operationId)
        .eq('index', input.index),
    )
    .unique();
  const archived =
    old || !operation.terminal
      ? null
      : await journalIndexAt(ctx, auth.projectId, `save:${auth.actor}:${auth.operationId}`, input.index);
  const original = old ?? archived?.savePages?.find(row => row[0] === input.index);
  if (original) {
    invariant(
      ('digest' in original ? original.digest : original[1]) === pin.sha256,
      'WORK_OPERATION_CHANGED',
      'Retry the original save page.',
    );
    return state;
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
  const stored = await saveObjects(ctx, auth.projectId, [pin, ...contents.map(value => value.object)]);
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
  await ctx.db.insert('projectHostedSavePages', {
    ...auth,
    index: input.index,
    digest: pin.sha256,
    ...(process.env.FORGE_JOURNAL_SEGMENTS === '1' ? { journalLaneId: state.request.laneId } : {}),
  });
  await writeSaveState(ctx, row._id, next);
  return next;
}
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
  args: { ...identity, board: v.optional(v.object({ laneId: v.string(), after: v.number() })) },
  returns: v.string(),
  handler: async (ctx, { board: cursor, ...input }) => {
    try {
      const auth = await caller(ctx, input),
        { row, state, project, operation } = await loadSave(ctx, auth, false);
      const board = cursor
        ? await boardWake(ctx, { projectId: input.projectId, viewer: auth.actor, ...cursor })
        : undefined;
      return canonicalPayload({
        authorityEpoch: sourceAuthority(project).epoch,
        ...(board ? { board } : {}),
        ...(state.status === 'submitted' || state.status === 'failed'
          ? await sourceProgress(ctx, input.projectId, row.jobId)
          : {}),
        ...(operation.terminal?.outcome.status === 'failed'
          ? { status: 'failed', error: operation.terminal.outcome.error }
          : {}),
        state,
        // The save's own state, label and one next step (src/hosted-save-state.ts).
        ...hostedSaveState(state.status),
        terminal: operation.terminal,
        input:
          state.request.pages && state.status !== 'staging'
            ? hostedSaveInput(state, operation.firstAttempt.at)
            : null,
        // save-then-resolve: the chained sync, so the CLI's one subscription sees it finish.
        ...(state.request.then && operation.terminal?.outcome.status === 'completed'
          ? { chain: await chainProgress(ctx, auth, state) }
          : {}),
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** Clear the exact displayed failure. Its original save receipt remains available for replay. */
export const dismissFailure = mutation({
  args: { ...identity, laneId: v.string(), attemptId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to dismiss a save failure.');
      const project = await activeProject(ctx, input.projectId, user.subject);
      return await clearSaveFailure(ctx, { ...input, actor: user.subject }, project.owner);
    } catch (error) {
      return report(error);
    }
  },
});

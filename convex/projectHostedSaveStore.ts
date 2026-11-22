// SPDX-License-Identifier: Apache-2.0
import { assertSourceStateSize, type SourceSizePhase } from '../src/source-state-size';
import { z } from 'zod';
import { sessionMetadataSchema } from '../src/hosted-lane';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { readHostedRecord, recordHead, hostedWriteProject } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { saveRequestSchema, saveWorkerObjectSchema, saveObjectSchema } from '../src/hosted-save';
import { hostedOperationSchema, canonicalPayload } from '../src/hosted-source-operation';
import { hostedOperationRow } from './projectHostedOperations';
import { isStored } from './projectObjectFields';
import { invariant } from '../src/errors';
import { hostedSaveStatuses } from '../src/hosted-save-state';
import { findStoredObject, type ObjectView } from './projectObjectFind';
import { sourceServerTimingSchema } from './projectSourceStepTiming';

export const saveStateSchema = z
  .object({
    session: sessionMetadataSchema.optional(),
    overlapChanges: z.string().optional(),
    overlapComplete: z.boolean().optional(),
    request: saveRequestSchema,
    baseline: saveWorkerObjectSchema,
    next: saveObjectSchema.nullable(),
    stagedPages: z.number(),
    stagedChanges: z.number(),
    lastPath: z.string().nullable(),
    jobOperationId: z.uuid(),
    status: z.enum(hostedSaveStatuses),
    /** Server clock at submit and the execution's step split at publication (friction f15db544). */
    submittedAt: z.number().optional(),
    clientMs: z.number().int().nonnegative().optional(),
    serverTiming: sourceServerTimingSchema.optional(),
    /** The save-then-resolve chain stopped before its submit (its error code). */
    chainFailure: z.string().optional(),
    /** The delayed scheduled chain kept only for an action that dies before it runs the chain inline. */
    chainFallbackId: z.string().optional(),
  })
  .strict();
export type SaveIdentity = { projectId: Id<'hostedProjects'>; actor: string; operationId: string };
export const saveRow = (ctx: QueryCtx | MutationCtx, input: SaveIdentity) =>
  ctx.db
    .query('projectHostedSaves')
    .withIndex('by_project_and_actor_and_operation', q =>
      q.eq('projectId', input.projectId).eq('actor', input.actor).eq('operationId', input.operationId),
    )
    .unique();
export async function loadSave(ctx: QueryCtx | MutationCtx, input: SaveIdentity, writing = true) {
  const project = await activeProject(ctx, input.projectId, input.actor);
  const row = await saveRow(ctx, input);
  invariant(row, 'NOT_FOUND', 'Prepare this original hosted save first.');
  const state = saveStateSchema.parse(JSON.parse(row.value));
  if (writing) await hostedWriteProject(ctx, input.projectId, input.actor, state.request.authorityEpoch);
  const opRow = await hostedOperationRow(ctx, input.projectId, input.actor, input.operationId);
  invariant(opRow, 'SOURCE_UNAVAILABLE', 'The original save operation is unavailable.');
  return { row, state, project, operation: hostedOperationSchema.parse(JSON.parse(opRow.value)) };
}
export async function saveLaneRecord(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; actor: string; laneId: string },
) {
  const row = await readHostedRecord(ctx, {
    ...input,
    kind: 'lane',
    key: input.laneId,
    withSaveFailure: true,
  });
  invariant(row, 'NOT_FOUND', 'Hosted Lane not found on this project.');
  return {
    lane: hostedLaneSchema.parse(JSON.parse(row.value)),
    ownerOnly: row.ownerOnly === true,
    sourceCreatedAt: row._creationTime,
    saveFailure: row.saveFailure,
  };
}
export async function saveLane(...args: Parameters<typeof saveLaneRecord>) {
  return (await saveLaneRecord(...args)).lane;
}
export const sameSaveLane = (
  lane: Pick<z.infer<typeof hostedLaneSchema>, 'head' | 'version' | 'sourceVersion' | 'lifecycleVersion'>,
  expected: z.infer<typeof saveRequestSchema>['expected'],
) =>
  lane.head === expected.head &&
  lane.version === expected.version &&
  lane.sourceVersion === expected.sourceVersion &&
  lane.lifecycleVersion === expected.lifecycleVersion;
export async function saveObject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  pin: { sha256: string; size?: number },
  phase?: SourceSizePhase,
) {
  return (await saveObjects(ctx, projectId, [pin], [], phase))[0]!;
}
/** The caller supplies one already-bounded source window. Each exact object is
 * checked and marked, but cleanup needs just one new fence for this transaction,
 * irrespective of how many source references the batch introduces. */
export async function saveObjects(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  pins: readonly { sha256: string; size?: number }[],
  /** Rows this transaction already read for the same project; they are not read again. */
  loaded: readonly ObjectView[] = [],
  phase?: SourceSizePhase,
) {
  const rows = new Map<string, ObjectView>(
    loaded.filter(row => row.projectId === projectId).map(row => [row.digest, row]),
  );
  const result = [];
  let fence: string | undefined;
  for (const pin of pins) {
    let row = rows.get(pin.sha256);
    if (!row || (!row.removed && !isStored(row)))
      row = (await findStoredObject(ctx, projectId, pin.sha256)) ?? undefined;
    invariant(
      row && !row.removed && isStored(row) && (pin.size === undefined || row.size === pin.size),
      'SOURCE_UNAVAILABLE',
      'Commit the exact project source object before staging it.',
    );
    if (phase) assertSourceStateSize(phase, row.stateSize);
    // Catalog objects are source by construction (sourceReferenced, no row).
    if ('patch' in ctx.db && !row.sourceReferenced && row._id !== undefined) {
      await ctx.db.patch(row._id, { sourceReferenced: true });
      fence = row.digest;
      row = { ...row, sourceReferenced: true };
    }
    rows.set(pin.sha256, row);
    result.push({
      object: { sha256: row.digest, size: row.size },
      recipe: row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
    });
  }
  // This append changes the latest-pin guard even when another transaction also
  // stages source. It is not a per-digest reference table. All marks and the fence
  // commit atomically, so an earlier cleanup plan must replan as before.
  if (fence && 'patch' in ctx.db)
    await ctx.db.insert('projectCheckLogSourcePins', { projectId, digest: fence });
  return result;
}
const saveFailureKind = 'projectHostedSaveFailure';
type SaveFailure = NonNullable<Doc<'projectHostedRecordHeads'>['saveFailure']>;

/** The public projection contains no worker error text or account identifiers. */
export const saveFailureSummary = ({
  operationId,
  attemptId,
  code,
  at,
}: Pick<SaveFailure, 'operationId' | 'attemptId' | 'code' | 'at'>) => ({
  operationId,
  attemptId,
  code,
  at,
});

/** Only terminal background failures do these indexed reads and writes. The latest prepared
 * save wins even if both saves used the same source pins. A newer prepare clears the old notice in
 * the same transaction that inserts its save row. */
export async function writeSaveFailure(
  ctx: MutationCtx,
  row: Doc<'projectHostedSaves'>,
  attemptId: string,
  code: string,
) {
  const { laneId } = row;
  if (!row.background || !laneId) return;
  const latest = await ctx.db
    .query('projectHostedSaves')
    .withIndex('by_project_and_lane_and_commit', q => q.eq('projectId', row.projectId).eq('laneId', laneId))
    .order('desc')
    .first();
  if (latest?._id !== row._id) return;
  const head = await recordHead(ctx, row.projectId, 'lane', laneId);
  if (!head) return;
  const failure = {
    operationId: row.operationId,
    attemptId,
    code: /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'SOURCE_WORKER_FAILED',
    at: Date.now(),
  };
  const mark = {
    kind: saveFailureKind,
    projectId: row.projectId,
    sourceId: laneId,
    sourceCreatedAt: failure.at,
    value: canonicalPayload(failure),
  };
  const existing = head.saveFailure?.boardRowId;
  if (existing) await ctx.db.replace(existing, mark);
  const boardRowId = existing ?? (await ctx.db.insert('projectFinishReadRows', mark));
  const overlap = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', row.projectId).eq('laneId', laneId))
    .unique();
  if (overlap) await ctx.db.patch(overlap._id, { saveFailure: failure });
  await ctx.db.patch(head._id, {
    saveFailure: {
      ...failure,
      actor: row.actor,
      boardRowId,
      ...(overlap ? { overlapRowId: overlap._id } : {}),
    },
  });
}

export async function clearSaveFailure(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    laneId: string;
    operationId: string;
    actor: string;
    attemptId: string;
  },
  owner?: string,
) {
  const head = await recordHead(ctx, input.projectId, 'lane', input.laneId);
  const failure = head?.saveFailure;
  if (!head || failure?.operationId !== input.operationId || failure.attemptId !== input.attemptId)
    return false;
  if (failure.actor !== input.actor && owner !== input.actor) return false;
  await clearLaneSaveFailure(ctx, { id: head._id, value: failure });
  return true;
}

export async function clearLaneSaveFailure(
  ctx: MutationCtx,
  failure: { id: Id<'projectHostedRecordHeads'>; value: SaveFailure },
) {
  const { boardRowId, overlapRowId } = failure.value;
  await ctx.db.delete(boardRowId);
  if (overlapRowId) await ctx.db.patch(overlapRowId, { saveFailure: undefined });
  await ctx.db.patch(failure.id, { saveFailure: undefined });
}

export async function projectSaveFailures(ctx: QueryCtx, projectId: Id<'hostedProjects'>, limit: number) {
  const rows = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_source_time', q =>
      q.eq('kind', saveFailureKind).eq('projectId', projectId),
    )
    .order('desc')
    .take(limit);
  return rows.map(row => ({
    laneId: row.sourceId,
    ...saveFailureSummary(JSON.parse(row.value)),
  }));
}

export async function writeSaveState(
  ctx: MutationCtx,
  id: Id<'projectHostedSaves'>,
  state: z.infer<typeof saveStateSchema>,
  background = false,
) {
  await ctx.db.patch(id, {
    value: canonicalPayload(saveStateSchema.parse(state)),
    ...(background ? { background: true, laneId: state.request.laneId } : {}),
  });
}

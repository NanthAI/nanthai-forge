// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { readHostedRecord, hostedWriteProject } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { saveRequestSchema, saveWorkerObjectSchema, saveObjectSchema } from '../src/hosted-save';
import { hostedOperationSchema, canonicalPayload } from '../src/hosted-source-operation';
import { hostedOperationRow } from './projectHostedOperations';
import { isStored } from './projectObjectFields';
import { invariant } from '../src/errors';

export const saveStateSchema = z
  .object({
    overlapChanges: z.string().optional(),
    overlapComplete: z.boolean().optional(),
    request: saveRequestSchema,
    baseline: saveWorkerObjectSchema,
    next: saveObjectSchema.nullable(),
    stagedPages: z.number(),
    stagedChanges: z.number(),
    lastPath: z.string().nullable(),
    jobOperationId: z.uuid(),
    status: z.enum(['staging', 'ready', 'submitted', 'completed', 'stale', 'failed']),
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
  await activeProject(ctx, input.projectId, input.actor);
  const row = await saveRow(ctx, input);
  invariant(row, 'NOT_FOUND', 'Prepare this original hosted save first.');
  const state = saveStateSchema.parse(JSON.parse(row.value));
  if (writing) await hostedWriteProject(ctx, input.projectId, input.actor, state.request.authorityEpoch);
  const opRow = await hostedOperationRow(ctx, input.projectId, input.actor, input.operationId);
  invariant(opRow, 'SOURCE_UNAVAILABLE', 'The original save operation is unavailable.');
  return { row, state, operation: hostedOperationSchema.parse(JSON.parse(opRow.value)) };
}
export async function saveLaneRecord(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; actor: string; laneId: string },
) {
  const row = await readHostedRecord(ctx, { ...input, kind: 'lane', key: input.laneId });
  invariant(row, 'NOT_FOUND', 'Hosted Lane not found on this project.');
  return { lane: hostedLaneSchema.parse(JSON.parse(row.value)), ownerOnly: row.ownerOnly === true };
}
export async function saveLane(...args: Parameters<typeof saveLaneRecord>) {
  return (await saveLaneRecord(...args)).lane;
}
export const sameSaveLane = (
  lane: z.infer<typeof hostedLaneSchema>,
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
) {
  return (await saveObjects(ctx, projectId, [pin]))[0]!;
}
/** The caller supplies one already-bounded source window. Each exact object is
 * checked and marked, but cleanup needs just one new fence for this transaction,
 * irrespective of how many source references the batch introduces. */
export async function saveObjects(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  pins: readonly { sha256: string; size?: number }[],
) {
  const rows = new Map<string, Doc<'projectObjects'>>();
  const result = [];
  let fence: string | undefined;
  for (const pin of pins) {
    let row = rows.get(pin.sha256);
    if (!row) {
      row =
        (await ctx.db
          .query('projectObjects')
          .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', pin.sha256))
          .unique()) ?? undefined;
    }
    invariant(
      row && !row.removed && isStored(row) && (pin.size === undefined || row.size === pin.size),
      'SOURCE_UNAVAILABLE',
      'Commit the exact project source object before staging it.',
    );
    if ('patch' in ctx.db && !row.sourceReferenced) {
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
export async function writeSaveState(
  ctx: MutationCtx,
  id: Id<'projectHostedSaves'>,
  state: z.infer<typeof saveStateSchema>,
) {
  await ctx.db.patch(id, { value: canonicalPayload(saveStateSchema.parse(state)) });
}

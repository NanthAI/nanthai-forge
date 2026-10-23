// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
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
export async function saveLane(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; actor: string; laneId: string },
) {
  const row = await readHostedRecord(ctx, { ...input, kind: 'lane', key: input.laneId });
  invariant(row, 'NOT_FOUND', 'Hosted Lane not found on this project.');
  return hostedLaneSchema.parse(JSON.parse(row.value));
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
  const row = await ctx.db
    .query('projectObjects')
    .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', pin.sha256))
    .unique();
  invariant(
    row && !row.removed && isStored(row) && (pin.size === undefined || row.size === pin.size),
    'SOURCE_UNAVAILABLE',
    'Commit the exact project source object before staging it.',
  );
  return {
    object: { sha256: row.digest, size: row.size },
    recipe: row.recipe ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
  };
}
export async function writeSaveState(
  ctx: MutationCtx,
  id: Id<'projectHostedSaves'>,
  state: z.infer<typeof saveStateSchema>,
) {
  await ctx.db.patch(id, { value: canonicalPayload(saveStateSchema.parse(state)) });
}

// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { hostedWriteProject } from './projectHostedRecords';
import { hostedOperationRow } from './projectHostedOperations';
import { hostedOperationSchema, canonicalPayload } from '../src/hosted-source-operation';
import { syncRequestSchema, syncWorkSchema, syncInputSchema, SYNC_ALGORITHM } from '../src/hosted-sync';
import { hostedLaneSchema } from '../src/hosted-lane';
import { invariant } from '../src/errors';
import type { SaveIdentity } from './projectHostedSaveStore';
export const syncStateSchema = z
  .object({
    request: syncRequestSchema,
    work: syncWorkSchema,
    intentId: z.uuid(),
    base: hostedLaneSchema.shape.base,
    lane: hostedLaneSchema.nullable(),
    resolutionLaneId: z.uuid(),
    jobOperationId: z.uuid(),
    status: z.enum(['ready', 'submitted', 'completed', 'stale', 'failed']),
  })
  .strict();
export type SyncState = z.infer<typeof syncStateSchema>;
export const syncRow = (ctx: QueryCtx | MutationCtx, input: SaveIdentity) =>
  ctx.db
    .query('projectHostedSyncs')
    .withIndex('by_project_and_actor_and_operation', q =>
      q.eq('projectId', input.projectId).eq('actor', input.actor).eq('operationId', input.operationId),
    )
    .unique();
export const syncForJob = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, jobId: string) =>
  ctx.db
    .query('projectHostedSyncs')
    .withIndex('by_project_and_job', q => q.eq('projectId', projectId).eq('jobId', jobId))
    .unique();
export async function loadSync(ctx: QueryCtx | MutationCtx, input: SaveIdentity, writing = true) {
  await activeProject(ctx, input.projectId, input.actor);
  const row = await syncRow(ctx, input);
  invariant(row, 'NOT_FOUND', 'Prepare this original hosted sync first.');
  const state = syncStateSchema.parse(JSON.parse(row.value));
  if (writing) await hostedWriteProject(ctx, input.projectId, input.actor, state.request.authorityEpoch);
  const operation = await hostedOperationRow(ctx, input.projectId, input.actor, input.operationId);
  invariant(operation, 'SOURCE_UNAVAILABLE', 'The original sync operation is unavailable.');
  return { row, state, operation: hostedOperationSchema.parse(JSON.parse(operation.value)) };
}
export async function writeSyncState(ctx: MutationCtx, id: Id<'projectHostedSyncs'>, state: SyncState) {
  await ctx.db.patch(id, { value: canonicalPayload(syncStateSchema.parse(state)) });
}
export function hostedSyncInput(state: SyncState, at: string) {
  return syncInputSchema.parse({
    schema: 1,
    kind: 'forge-hosted-sync-input',
    algorithm: SYNC_ALGORITHM,
    work: state.work,
    message: state.request.message,
    at,
  });
}

import { semanticPayload } from '../src/semantic-payload';
import { semanticPlanSchema } from '../src/intent-semantic-conflict';
import { notifyDesiredCompose } from './projectHostedLandingDesiredWake';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { activeProject } from './projectAuthority';
import { hostedWriteProject } from './projectHostedRecords';
import { hostedOperationRow } from './projectHostedOperations';
import { hostedOperationSchema } from '../src/hosted-source-operation';
import { composeRequestSchema, composeInputSchema, COMPOSE_ALGORITHM } from '../src/hosted-compose';
import { saveObjectSchema, saveWorkerObjectSchema } from '../src/hosted-save';
import { notifyFinishCompose } from './projectHostedFinishWake';
import { invariant } from '../src/errors';
import type { SaveIdentity } from './projectHostedSaveStore';
const progress = z
  .object({ next: saveObjectSchema.nullable(), pages: z.number(), count: z.number() })
  .strict();
export const composeStateSchema = z
  .object({
    semanticPlan: semanticPlanSchema.optional(),
    ownerInputs: z.boolean().optional(),
    request: composeRequestSchema,
    main: saveWorkerObjectSchema,
    inputs: progress,
    dependencies: progress,
    candidateId: z.uuid(),
    jobOperationId: z.uuid(),
    status: z.enum(['staging', 'ready', 'submitted', 'completed', 'failed']),
  })
  .strict();
export type ComposeState = z.infer<typeof composeStateSchema>;
export const composeRow = (ctx: QueryCtx | MutationCtx, input: SaveIdentity) =>
  ctx.db
    .query('projectHostedComposes')
    .withIndex('by_project_and_actor_and_operation', q =>
      q.eq('projectId', input.projectId).eq('actor', input.actor).eq('operationId', input.operationId),
    )
    .unique();
export const composeForJob = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, jobId: string) =>
  ctx.db
    .query('projectHostedComposes')
    .withIndex('by_project_and_job', q => q.eq('projectId', projectId).eq('jobId', jobId))
    .unique();
export async function loadCompose(ctx: QueryCtx | MutationCtx, input: SaveIdentity, writing = true) {
  const project = await activeProject(ctx, input.projectId, input.actor);
  const row = await composeRow(ctx, input);
  invariant(row, 'NOT_FOUND', 'Prepare this original hosted composition first.');
  const state = composeStateSchema.parse(JSON.parse(row.value));
  if (writing) await hostedWriteProject(ctx, input.projectId, input.actor, state.request.authorityEpoch);
  const operation = await hostedOperationRow(ctx, input.projectId, input.actor, input.operationId);
  invariant(operation, 'SOURCE_UNAVAILABLE', 'The original compose operation is unavailable.');
  return { row, state, project, operation: hostedOperationSchema.parse(JSON.parse(operation.value)) };
}
export async function writeComposeState(
  ctx: MutationCtx,
  id: Id<'projectHostedComposes'>,
  state: ComposeState,
) {
  await ctx.db.patch(id, { value: semanticPayload(composeStateSchema.parse(state), true) });
  if (state.status === 'completed' || state.status === 'failed') {
    const row = (await ctx.db.get(id))!;
    await notifyFinishCompose(ctx, row.projectId, row.operationId);
    await notifyDesiredCompose(ctx, row.projectId, row.operationId);
  }
}
export function hostedComposeInput(state: ComposeState, at: string) {
  return composeInputSchema.parse({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: state.request.expectedMain,
    main: state.main,
    inputs: state.request.inputs,
    dependencies: state.request.dependencies,
    algorithm: COMPOSE_ALGORITHM,
    message: state.request.message,
    at,
  });
}

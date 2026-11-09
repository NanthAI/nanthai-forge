// SPDX-License-Identifier: Apache-2.0
import { semanticPayload } from '../src/semantic-payload';
import { requireSourceAuthority, type SourceAuthority } from '../src/hosted-source-authority';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { activeProject } from './projectAuthority';
import { hostedWriteProject } from './projectHostedRecords';
import { recordMutationReceipt } from './projectSelfMetricReceiptStore';
import { callerActorKind } from './metricActorKind';
import type { MetricMutationAction } from '../src/self-metric-receipts';
import {
  prepareHostedOperation,
  completeHostedOperation,
  canonicalPayload,
  hostedOperationRequestSchema,
  hostedOperationSchema,
  hostedTerminalReceiptSchema,
  type HostedTerminalReceipt,
} from '../src/hosted-source-operation';

export const hostedOperationRow = (
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  operationId: string,
) =>
  ctx.db
    .query('projectHostedOperations')
    .withIndex('by_project_and_actor_and_operation', q =>
      q.eq('projectId', projectId).eq('actor', actor).eq('operationId', operationId),
    )
    .unique();

/** Persist original IDs/time before any external work. Authorization precedes
 * even a completed replay; callers must resolve actor from their trusted boundary. */
export async function beginHostedOperation(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    request: unknown;
    payload: unknown;
    firstAttempt: unknown;
    expectedAuthority?: SourceAuthority;
    /** Owner command counted as an intervention once it completes. */
    metricAction?: MetricMutationAction;
  },
) {
  const project = await activeProject(ctx, input.projectId, input.actor);
  const request = hostedOperationRequestSchema.parse(input.request);
  // The envelope must belong to the same authorized project and actor.
  invariant(
    request.projectId === input.projectId && request.actor === input.actor,
    'WORK_OPERATION_CHANGED',
    'Operation identity differs from the authorized caller.',
  );
  const old = await hostedOperationRow(ctx, input.projectId, input.actor, request.operationId);
  if (!old) {
    if (input.expectedAuthority) requireSourceAuthority(project, input.expectedAuthority);
    else await hostedWriteProject(ctx, input.projectId, input.actor, request.expected.authorityEpoch);
  }
  const prepared = await prepareHostedOperation(
    request,
    input.payload,
    input.firstAttempt,
    old ? JSON.parse(old.value) : undefined,
    async () => {
      await activeProject(ctx, input.projectId, input.actor);
    },
  );
  if (!old) {
    const metricAction =
      input.metricAction ??
      ((input.payload as { kind?: string }).kind === 'hosted-landing-cancel'
        ? ('cancel' as const)
        : undefined);
    // The receipt is written when the operation completes, often by a job with no caller identity.
    const metricActorKind = metricAction ? await callerActorKind(ctx, input.actor) : undefined;
    await ctx.db.insert('projectHostedOperations', {
      projectId: input.projectId,
      actor: input.actor,
      operationId: request.operationId,
      ...(metricAction ? { metricAction } : {}),
      ...(metricActorKind ? { metricActorKind } : {}),
      value: canonicalPayload(prepared.operation),
    });
  }
  return prepared;
}
export async function finishHostedOperation(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    operationId: string;
    receipt: HostedTerminalReceipt;
  },
) {
  await activeProject(ctx, input.projectId, input.actor);
  const row = await hostedOperationRow(ctx, input.projectId, input.actor, input.operationId);
  invariant(row, 'NOT_FOUND', 'Prepare the original operation before completing it.');
  const operation = completeHostedOperation(
    hostedOperationSchema.parse(JSON.parse(row.value)),
    hostedTerminalReceiptSchema.parse(JSON.parse(semanticPayload(input.receipt))),
  );
  const value = semanticPayload(operation);
  if (value !== row.value) {
    await ctx.db.patch(row._id, { value });
    if (row.metricAction && operation.terminal?.outcome.status === 'completed')
      await recordMutationReceipt(ctx, {
        projectId: input.projectId,
        actor: input.actor,
        operationId: input.operationId,
        action: row.metricAction,
        at: operation.terminal.at,
        ...(row.metricActorKind ? { actorKind: row.metricActorKind } : {}),
      });
  }
  return operation;
}

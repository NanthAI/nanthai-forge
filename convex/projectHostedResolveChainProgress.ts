// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { syncRow, syncStateSchema } from './projectHostedSyncStore';
import { hostedOperationRow } from './projectHostedOperations';
import { hostedOperationSchema } from '../src/hosted-source-operation';

/** What the save's progress shows about its chained resolve, for the CLI's one subscription. */
export async function chainProgress(
  ctx: QueryCtx | MutationCtx,
  auth: { projectId: Id<'hostedProjects'>; actor: string },
  state: { request: { then?: { operationId: string } }; chainFailure?: string },
) {
  const operationId = state.request.then!.operationId;
  if (state.chainFailure) return { status: 'failed' as const, code: state.chainFailure };
  const row = await syncRow(ctx, { ...auth, operationId });
  if (!row) return { status: 'pending' as const };
  const sync = syncStateSchema.parse(JSON.parse(row.value)),
    operation = await hostedOperationRow(ctx, auth.projectId, auth.actor, operationId);
  return {
    status: sync.status,
    state: sync,
    terminal: operation ? hostedOperationSchema.parse(JSON.parse(operation.value)).terminal : null,
  };
}

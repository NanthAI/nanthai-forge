// SPDX-License-Identifier: Apache-2.0
import { digest } from '../src/state/hash';
import { wakeJournal, journalGraceMs } from './projectJournalWake';
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
  HOSTED_OPERATION_PRUNE_BATCH,
  HOSTED_OPERATION_RETENTION_MS,
  type HostedTerminalReceipt,
} from '../src/hosted-source-operation';

export async function hostedOperationRow(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  operationId: string,
) {
  const [row] = await ctx.db
    .query('projectHostedOperations')
    .withIndex('by_project_and_actor_and_operation', q =>
      q.eq('projectId', projectId).eq('actor', actor).eq('operationId', operationId),
    )
    .order('desc')
    .take(1);
  if (!row?.journalSegment) return row ?? null;
  const { expandOperationReceipt } = await import('../src/compact-operation-receipt');
  return { ...row, value: canonicalPayload(expandOperationReceipt(row)) };
}

/** Remove this project's receipts past the retention value, oldest first, at most one batch per call.
 * Runs only inside the write that adds a new receipt, so an idle project does nothing and no timer
 * exists. The index skips legacy cancel receipts (metrics still read those by creation time), so the
 * scan reads only rows it can delete. A receipt this old belongs to a finished or dead operation: every
 * job and watchdog ends within hours, and a retry after expiry starts a new operation. */
export async function pruneExpiredHostedOperations(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  now: number,
) {
  const expired = await ctx.db
    .query('projectHostedOperations')
    .withIndex('by_project_and_metric_action', q =>
      q
        .eq('projectId', projectId)
        .eq('metricMutation.action', undefined)
        .lt('_creationTime', now - HOSTED_OPERATION_RETENTION_MS),
    )
    .take(HOSTED_OPERATION_PRUNE_BATCH);
  for (const row of expired) {
    if (row.journalSegment && row.journalReadyAt === undefined && row.journalDigest) {
      const operationId = `journal-operation:${row._id}`;
      const old = await ctx.db
        .query('projectJournalReceipts')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', projectId).eq('operationId', operationId),
        )
        .unique();
      if (!old)
        await ctx.db.insert('projectJournalReceipts', {
          projectId,
          operationId,
          hash: row.journalDigest,
          envelope: '',
        });
      await ctx.db.delete(row._id);
    } else if (row.journalSegment || process.env.FORGE_JOURNAL_SEGMENTS === '1') {
      if (row.journalReadyAt === undefined) await ctx.db.patch(row._id, { journalReadyAt: now });
    } else await ctx.db.delete(row._id);
  }
  if (expired.length)
    await wakeJournal(
      ctx,
      {
        projectId,
        operationId: `expiry:${digest(canonicalPayload(expired.map(row => [row._id, row.journalReadyAt ?? now, row.journalDigest ?? ''])))}`,
        phase: 1,
      },
      now,
    );
  return expired.length;
}

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
    await pruneExpiredHostedOperations(ctx, input.projectId, Date.now());
  }
  // Reuse this authorized snapshot within the current transaction.
  return { ...prepared, project };
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
    const dueAt = Date.now() + journalGraceMs;
    await ctx.db.patch(row._id, {
      value,
      ...(process.env.FORGE_JOURNAL_SEGMENTS === '1' ? { journalReadyAt: dueAt } : {}),
    });
    await wakeJournal(ctx, { projectId: input.projectId, operationId: `source:${row._id}` }, dueAt);
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

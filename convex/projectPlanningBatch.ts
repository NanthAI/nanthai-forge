// SPDX-License-Identifier: Apache-2.0
// Backlog batches (Item 65b0e706, src/planning-batch.ts): one person or agent action on many Items is one call. Each
// write in the batch runs through the same revision-free Work command as a single put or comment
// (projectWorkCommand executeCommand: owner gate, item version check, journal append), so the journal, replay and
// every reader stay exactly as for single writes. Each write's operation id is derived from the batch's, so a retry
// of the whole batch finds every write it already made and applies nothing twice. A write refused for its own reason
// (the Item changed meanwhile, is unknown, or the write is invalid) is reported and leaves the rest; any other
// failure rolls the whole batch back.
import { v } from 'convex/values';
import { mutation, type MutationCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { report } from './errors';
import { executeCommand } from './projectWorkCommand';
import { activeProject, activeOwnedProject } from './projectAuthority';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { commandPayloadRows, commandValues } from './projectWorkCommandRows';
import { liveCloseChildren } from './projectPlanningCloseRows';
import { beginHostedOperation, finishHostedOperation, hostedOperationRow } from './projectHostedOperations';
import { ForgeError, invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { sourceAuthority } from '../src/hosted-source-authority';
import { hostedOperationSchema, hostedPayloadHash } from '../src/hosted-source-operation';
import {
  batchUndo,
  detachAfterClose,
  planningBatchLimit,
  undoableFields,
  type BatchBefore,
  type BatchPut,
  type BatchResult,
  type BatchWrite,
} from '../src/planning-batch';

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** The operation id of write `index` of batch `operationId`: stable, so a replay finds the original write. */
export function batchWriteOperationId(operationId: string, index: number) {
  const hex = digest(`planning-batch:${operationId.toLowerCase()}:${index}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Refusals that happen before a write touches the database, so the batch can report them and go on. */
const ownRefusals = new Set(['ITEM_CHANGED', 'NOT_FOUND', 'BAD_ARGUMENT', 'INTENT_CLOSED']);

/** Whether this write's operation already ran (a replay): two indexed lookups, no journal read. */
async function written(ctx: MutationCtx, projectId: Id<'hostedProjects'>, operationId: string) {
  for (const table of ['projectWorkEvents', 'projectHostedRecordBodies'] as const)
    if (
      await ctx.db
        .query(table)
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', projectId).eq('operationId', operationId),
        )
        .unique()
    )
      return true;
  return false;
}

async function storedItem(ctx: MutationCtx, projectId: Id<'hostedProjects'>, user: string, itemId: string) {
  const project = await activeProject(ctx, projectId, user);
  const generation = await selectedGeneration(ctx, project);
  if (!generation) return null;
  const partition = recordPartition(generation);
  const rows = [await record(ctx, partition, 'planningItems', itemId)];
  if (!rows[0]) return null;
  await commandPayloadRows(rows, keys =>
    Promise.all(keys.map(key => record(ctx, partition, key.collection, key.key))),
  );
  return (commandValues(rows, 'planningItems')[0] as Record<string, unknown> | undefined) ?? null;
}

type BatchInput = {
  projectId: Id<'hostedProjects'>;
  operationId: string;
  writes: string;
  close?: true;
  undoClose?: string;
};

async function applyWrites(
  ctx: MutationCtx,
  input: BatchInput,
  actor: string,
  writes: readonly BatchWrite[],
  offset = 0,
  atomic = false,
) {
  const results: BatchResult[] = [];
  for (const [position, write] of writes.entries()) {
    invariant(
      write &&
        typeof write === 'object' &&
        (write.action === 'put-planning-item' || write.action === 'comment-planning-item') &&
        typeof write.itemId === 'string',
      'BAD_ARGUMENT',
      'Each batch write is a put-planning-item or comment-planning-item with an itemId.',
    );
    const index = offset + position;
    const operationId = batchWriteOperationId(input.operationId, index);
    const base = { index, itemId: write.itemId, action: write.action } as const;
    const replayed = await written(ctx, input.projectId, operationId);
    const before =
      !replayed && write.action === 'put-planning-item' && write.expectedVersion > 0
        ? await storedItem(ctx, input.projectId, actor, write.itemId)
        : null;
    try {
      await executeCommand(ctx, {
        projectId: input.projectId,
        operationId,
        command: JSON.stringify({ ...write, operationId }),
      });
    } catch (error) {
      if (atomic || !(error instanceof ForgeError) || !ownRefusals.has(error.code)) throw error;
      results.push({
        ...base,
        outcome: 'refused',
        code: error.code,
        message: error.message,
        ...(typeof error.recovery?.currentVersion === 'number'
          ? { currentVersion: error.recovery.currentVersion }
          : {}),
      });
      continue;
    }
    if (write.action === 'comment-planning-item') {
      results.push({ ...base, outcome: replayed ? 'replayed' : 'applied' });
      continue;
    }
    const version = write.expectedVersion + 1;
    if (replayed) {
      results.push({ ...base, outcome: 'replayed', version });
      continue;
    }
    const kept: BatchBefore = {};
    if (before)
      for (const field of undoableFields)
        if (field in write && (write as Record<string, unknown>)[field] !== undefined)
          (kept as Record<string, unknown>)[field] = before[field] ?? null;
    results.push({ ...base, outcome: 'applied', version, before: kept });
  }
  return results;
}

type CloseReceipt = {
  kind: 'planning-close' | 'planning-undo-close';
  operationId: string;
  results: BatchResult[];
  detached: number;
  undo: BatchPut[];
};

async function closeBatch(ctx: MutationCtx, input: BatchInput, actor: string, writes: BatchWrite[]) {
  const { projectId, operationId, undoClose } = input;
  const project = await activeOwnedProject(ctx, projectId, actor);
  const old = await hostedOperationRow(ctx, projectId, actor, operationId);
  const authority = sourceAuthority(project);
  const expected = old
    ? hostedOperationSchema.parse(JSON.parse(old.value)).expected
    : { authorityEpoch: authority.epoch };
  const at = new Date().toISOString();
  const kind = undoClose ? 'planning-undo-close' : 'planning-close';
  const payload = undoClose ? { kind, undoClose } : { kind, writes };
  const { operation } = await beginHostedOperation(ctx, {
    projectId,
    actor,
    expectedAuthority: authority,
    request: {
      schema: 1,
      projectId,
      operationId,
      actor,
      expected,
      payloadHash: hostedPayloadHash(payload, expected),
    },
    payload,
    firstAttempt: { projectId, operationId, id: operationId, parentAttemptId: null, at, expected, ids: {} },
  });
  if (operation.terminal) {
    invariant(
      operation.terminal.outcome.status === 'completed',
      'WORK_OPERATION_CHANGED',
      'Reconcile the original close operation.',
    );
    return JSON.stringify(operation.terminal.outcome.result);
  }

  const result: CloseReceipt = { kind, operationId, results: [], detached: 0, undo: [] };
  const requireFresh = (results: readonly BatchResult[]) => {
    invariant(
      results.every(row => row.outcome !== 'replayed'),
      'WORK_OPERATION_CHANGED',
      'The original close or Undo receipt is unavailable; no new changes were made.',
    );
  };
  const applyPages = async (entries: BatchPut[], offset: number) => {
    const results: BatchResult[] = [];
    for (let start = 0; start < entries.length; start += planningBatchLimit)
      results.push(
        ...(await applyWrites(
          ctx,
          input,
          actor,
          entries.slice(start, start + planningBatchLimit),
          offset + start,
          true,
        )),
      );
    requireFresh(results);
    return results;
  };
  if (undoClose) {
    const saved = await hostedOperationRow(ctx, projectId, actor, undoClose);
    invariant(saved, 'NOT_FOUND', 'The original close receipt is unavailable.');
    const terminal = hostedOperationSchema.parse(JSON.parse(saved.value)).terminal?.outcome;
    const close = terminal?.status === 'completed' ? (terminal.result as CloseReceipt) : null;
    invariant(
      close?.kind === 'planning-close' && close.undo.length,
      'BAD_ARGUMENT',
      'Select a close that has changes to undo.',
    );
    result.results = await applyPages(close.undo, 0);
  } else {
    const selected = new Set(writes.map(write => write?.itemId));
    invariant(
      selected.size === writes.length &&
        writes.every(
          write =>
            write?.action === 'put-planning-item' &&
            typeof write.itemId === 'string' &&
            Number.isSafeInteger(write.expectedVersion) &&
            write.expectedVersion > 0 &&
            write.status === 'closed' &&
            Object.keys(write).every(key =>
              ['action', 'itemId', 'expectedVersion', 'status', 'reason'].includes(key),
            ),
        ),
      'BAD_ARGUMENT',
      'Select individual Items and their versions to close.',
    );
    const generation = await selectedGeneration(ctx, project);
    invariant(
      generation,
      'PROJECT_WORK_INDEX_MISSING',
      'Prepare the hosted Work index before closing Items.',
    );
    const children = await liveCloseChildren(ctx, generation, selected);
    result.results = await applyWrites(ctx, input, actor, writes);
    requireFresh(result.results);
    const closed = new Set(result.results.filter(row => row.outcome !== 'refused').map(row => row.itemId));
    const detach = detachAfterClose(closed, children);
    const detached = await applyPages(detach, writes.length);
    result.detached = detached.length;
    result.undo = batchUndo([...writes, ...detach], [...result.results, ...detached]).undo;
  }
  // One retained receipt keeps the exact Undo available after a lost reply. It holds only
  // IDs, versions, outcomes, status and parent changes, without Item bodies or notes.
  await finishHostedOperation(ctx, {
    projectId,
    actor,
    operationId,
    receipt: {
      attemptId: operation.firstAttempt.id,
      at,
      outcome: { status: 'completed', result: JSON.parse(JSON.stringify(result)) },
    },
  });
  return JSON.stringify(result);
}

export async function applyBatch(ctx: MutationCtx, input: BatchInput) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use your Forge project.');
  invariant(uuid.test(input.operationId), 'BAD_ARGUMENT', 'Use an original batch operation UUID.');
  let writes: BatchWrite[];
  try {
    writes = JSON.parse(input.writes);
  } catch {
    invariant(false, 'BAD_ARGUMENT', 'Send the batch as a JSON list of planning writes.');
  }
  invariant(
    Array.isArray(writes) &&
      (input.undoClose
        ? !input.close && uuid.test(input.undoClose) && writes.length === 0
        : writes.length >= 1 && writes.length <= planningBatchLimit),
    'BAD_ARGUMENT',
    `A batch holds 1 to ${planningBatchLimit} planning writes. A close Undo names its original operation.`,
  );
  if (input.close || input.undoClose) return closeBatch(ctx, input, user.subject, writes);
  const results = await applyWrites(ctx, input, user.subject, writes);
  return JSON.stringify({ operationId: input.operationId, results });
}

/** One batch of planning writes (at most 100), retry-safe by its operation id. Returns JSON
 * `{operationId, results: BatchResult[]}` (src/planning-batch.ts); batchUndo turns it into the one Undo. */
export const apply = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    writes: v.string(),
    close: v.optional(v.literal(true)),
    undoClose: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return await applyBatch(ctx, input);
    } catch (error) {
      return report(error);
    }
  },
});

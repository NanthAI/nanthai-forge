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
import { activeProject } from './projectAuthority';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { commandPayloadRows, commandValues } from './projectWorkCommandRows';
import { ForgeError, invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import {
  planningBatchLimit,
  undoableFields,
  type BatchBefore,
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

export async function applyBatch(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; operationId: string; writes: string },
) {
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
    Array.isArray(writes) && writes.length >= 1 && writes.length <= planningBatchLimit,
    'BAD_ARGUMENT',
    `A batch holds 1 to ${planningBatchLimit} planning writes.`,
  );
  const results: BatchResult[] = [];
  for (const [index, write] of writes.entries()) {
    invariant(
      write &&
        typeof write === 'object' &&
        (write.action === 'put-planning-item' || write.action === 'comment-planning-item') &&
        typeof write.itemId === 'string',
      'BAD_ARGUMENT',
      'Each batch write is a put-planning-item or comment-planning-item with an itemId.',
    );
    const operationId = batchWriteOperationId(input.operationId, index);
    const base = { index, itemId: write.itemId, action: write.action } as const;
    const replayed = await written(ctx, input.projectId, operationId);
    const before =
      !replayed && write.action === 'put-planning-item' && write.expectedVersion > 0
        ? await storedItem(ctx, input.projectId, user.subject, write.itemId)
        : null;
    try {
      await executeCommand(ctx, {
        projectId: input.projectId,
        operationId,
        command: JSON.stringify({ ...write, operationId }),
      });
    } catch (error) {
      if (!(error instanceof ForgeError) || !ownRefusals.has(error.code)) throw error;
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
  return JSON.stringify({ operationId: input.operationId, results });
}

/** One batch of planning writes (at most 100), retry-safe by its operation id. Returns JSON
 * `{operationId, results: BatchResult[]}` (src/planning-batch.ts); batchUndo turns it into the one Undo. */
export const apply = mutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), writes: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return await applyBatch(ctx, input);
    } catch (error) {
      return report(error);
    }
  },
});

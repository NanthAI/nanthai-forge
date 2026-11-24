// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Backlog batches (Item 65b0e706, src/planning-batch.ts): one person or agent action on many Items is one call. Each
// write in the batch runs through the same revision-free Work command as a single put or comment
// (projectWorkCommand executeCommand: owner gate, item version check, journal append), so the journal, replay and
// every reader stay exactly as for single writes. Each write's operation id is derived from the batch's, so a retry
// of the whole batch finds every write it already made and applies nothing twice. A write refused for its own reason
// (the Item changed meanwhile, is unknown, or the write is invalid) is reported and leaves the rest; any other
// failure rolls the whole batch back.
import { v } from 'convex/values';
import { mutation, type MutationCtx } from './cliServer';
import { report } from './errors';
import { applyWrites, type BatchInput } from './projectPlanningBatchWrites';
import { closeBatch } from './projectPlanningClose';
import { invariant } from '../src/errors';
import { planningBatchLimit, type BatchWrite } from '../src/planning-batch';
import { isPlanningTick } from '../src/planning-line-evidence';

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
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
  const evidence = writes.find(
    write => write?.action === 'comment-planning-item' && write.line !== undefined,
  );
  if (evidence?.action === 'comment-planning-item' && evidence.line) {
    const [put, comment] = writes;
    invariant(
      writes.length === 2 &&
        put?.action === 'put-planning-item' &&
        typeof put.body === 'string' &&
        comment === evidence &&
        comment.decision === true &&
        put.itemId === comment.itemId,
      'BAD_ARGUMENT',
      'Tick one Done-when line with its evidence in the same batch.',
    );
    const results = await applyWrites(ctx, input, user.subject, writes, { atomic: true, planningTick: true });
    const before = results[0]?.before?.body;
    invariant(
      results.every(result => result.outcome === 'replayed') ||
        (typeof before === 'string' && isPlanningTick(before, put.body, evidence.line)),
      'BAD_ARGUMENT',
      'The evidence must name the open line this batch ticks.',
    );
    return JSON.stringify({ operationId: input.operationId, results });
  }
  const results = await applyWrites(ctx, input, user.subject, writes, { atomic: input.atomic === true });
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
    atomic: v.optional(v.literal(true)),
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

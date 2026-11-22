// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, type MutationCtx } from './server';
import { report } from './errors';
import { cancelPendingTask } from './schedulerCancel';
import {
  pendingPlanningApply,
  type Operation,
  type Progress,
  type Receipt,
} from './projectPlanningCloseProgress';
import { activeOwnedProject } from './projectAuthority';
import { beginHostedOperation, finishHostedOperation, hostedOperationRow } from './projectHostedOperations';
import { applyWrites, type BatchInput } from './projectPlanningBatchWrites';
import { liveCloseChildren } from './projectPlanningCloseRows';
import { planningWriteContext, type PlanningWriteContext } from './projectWorkCommandContext';
import { commandPayloadRows, commandValues } from './projectWorkCommandRows';
import {
  batchUndo,
  detachAfterClose,
  type BatchPut,
  type BatchResult,
  type BatchWrite,
} from '../src/planning-batch';
import { ForgeError, invariant } from '../src/errors';
import { sourceAuthority } from '../src/hosted-source-authority';
import { hostedOperationSchema, hostedPayloadHash } from '../src/hosted-source-operation';
import { isLive } from '../src/planning-model';
import type { PlanningItem } from '../src/work-planning-types';

const transactionRangeBudget = 2_048;
// Full pages in both layouts use about 17 ranges per version. Reserve room for
// parent writes, discovery, the receipt, and projection maintenance.
const reservedRanges = 256;
const rangesPerWrite = 18;
const pageSize = Math.floor((transactionRangeBudget - reservedRanges) / rangesPerWrite);

function requireFresh(results: readonly BatchResult[]) {
  invariant(
    results.every(row => row.outcome !== 'replayed'),
    'WORK_OPERATION_CHANGED',
    'The original close or Undo receipt is unavailable; no new changes were made.',
  );
}

const current = async (planning: PlanningWriteContext, itemId: string) => {
  const rows = [await planning.record('planningItems', itemId)];
  await commandPayloadRows(rows, keys =>
    Promise.all(keys.map(({ collection, key }) => planning.record(collection, key))),
  );
  return (commandValues(rows, 'planningItems')[0] ?? null) as PlanningItem | null;
};

async function markParents(
  ctx: MutationCtx,
  planning: PlanningWriteContext,
  parents: readonly BatchPut[],
  operationId: string | undefined,
) {
  for (const { itemId } of parents) {
    for (const collection of ['planningItems', 'planningSearch']) {
      const row = await planning.record(collection, itemId);
      if (row) await ctx.db.patch(row._id, { planningClose: operationId });
      planning.invalidate(collection, itemId);
    }
  }
}

const receiptFor = (progress: Progress) => ({ ...progress.receipt, pending: true });

async function finish(ctx: MutationCtx, operation: Operation, result: Receipt) {
  if (operation.planningApply !== undefined) await ctx.db.patch(operation._id, { planningApply: undefined });
  const prepared = hostedOperationSchema.parse(JSON.parse(operation.value));
  await finishHostedOperation(ctx, {
    projectId: operation.projectId,
    actor: operation.actor,
    operationId: operation.operationId,
    receipt: {
      attemptId: prepared.firstAttempt.id,
      at: new Date().toISOString(),
      outcome: { status: 'completed', result: JSON.parse(JSON.stringify(result)) },
    },
  });
  return result;
}

async function schedulePage(ctx: MutationCtx, operation: Operation, progress: Progress) {
  progress.task = await ctx.scheduler.runAfter(0, internal.projectPlanningClose.continueApply, {
    operation: operation._id,
    offset: progress.offset,
  });
  await ctx.db.patch(operation._id, { planningApply: JSON.stringify(progress) });
}

async function applyPage(
  ctx: MutationCtx,
  operation: Operation,
  planning: PlanningWriteContext,
  progress: Progress,
  limit: number,
) {
  const { actor, operationId, projectId } = operation;
  const input = { projectId, operationId, writes: '' };
  const { parents, receipt } = progress;
  const offset = progress.offset;
  const until = Math.min(offset + limit, progress.children.length);
  if (progress.kind === 'close') {
    const children = progress.children.slice(offset, until);
    const writes = children.map<BatchPut>(([itemId]) => ({
      action: 'put-planning-item',
      itemId,
      expectedVersion: 0,
      parentId: null,
    }));
    const detached = await applyWrites(ctx, input, actor, writes, {
      offset: progress.firstChild + offset,
      planning,
      atomic: true,
      prepare: async (write, index) => {
        const item = await current(planning, write.itemId);
        return item && item.parentId === children[index]![1] && isLive(item)
          ? { ...write, expectedVersion: item.version }
          : null;
      },
    });
    requireFresh(detached);
    receipt.detached += detached.length;
    for (const row of detached) {
      const parentId = children[row.index - progress.firstChild - offset]![1];
      receipt.undo.push({
        action: 'put-planning-item',
        itemId: row.itemId,
        expectedVersion: row.version!,
        parentId,
      });
    }
  } else {
    const restored = await applyWrites(ctx, input, actor, progress.children.slice(offset, until), {
      offset: parents.length + offset,
      planning,
      restore: operationId,
    });
    requireFresh(restored);
    receipt.results.push(...restored);
  }
  progress.offset = until;
  if (
    until < progress.children.length ||
    (progress.kind === 'undo' && until > offset && until - offset + parents.length > pageSize)
  ) {
    await schedulePage(ctx, operation, progress);
    return receiptFor(progress);
  }
  if (progress.kind === 'undo') {
    // The status can only change here while Undo holds the marker. A content
    // edit made after Undo began keeps its fields and gets the next version.
    const restored = await applyWrites(ctx, input, actor, parents, {
      planning,
      lock: operationId,
      atomic: true,
      prepare: async write => {
        const item = await current(planning, write.itemId);
        invariant(item?.status === 'closed', 'WORK_STALE', 'The parent changed during Undo.');
        return { ...write, expectedVersion: item.version };
      },
    });
    requireFresh(restored);
    receipt.results.unshift(...restored);
  }
  if (operation.planningApply !== undefined) await markParents(ctx, planning, parents, undefined);
  return finish(ctx, operation, receipt);
}

async function startUndo(
  ctx: MutationCtx,
  operation: Operation,
  planning: PlanningWriteContext,
  originalId: string,
  receipt: Receipt,
) {
  const original = await hostedOperationRow(ctx, operation.projectId, operation.actor, originalId);
  invariant(original, 'NOT_FOUND', 'The original close receipt is unavailable.');
  const applying = pendingPlanningApply(original);
  const terminal = hostedOperationSchema.parse(JSON.parse(original.value)).terminal?.outcome;
  const close = applying?.receipt ?? (terminal?.status === 'completed' ? (terminal.result as Receipt) : null);
  invariant(
    close?.kind === 'planning-close' && close.undo.length && !original.planningUndoneBy,
    'BAD_ARGUMENT',
    'Select a close that still has changes to undo.',
  );
  const parents = close.undo.filter(write => write.status !== undefined);
  const children = close.undo.filter(write => write.status === undefined);
  for (const parent of parents) {
    const item = await current(planning, parent.itemId);
    if (item?.version !== parent.expectedVersion || item.status !== 'closed')
      throw new ForgeError('ITEM_CHANGED', 'A closed Item changed after this close.', undefined, {
        recovery: {
          kind: 'issue',
          id: parent.itemId,
          expectedVersion: parent.expectedVersion,
          currentVersion: item?.version ?? 0,
        },
      });
  }
  await ctx.db.patch(original._id, { planningUndoneBy: operation.operationId });
  if (applying) {
    await cancelPendingTask(ctx, applying.task);
    await finish(ctx, original, close);
  }
  const progress: Progress = {
    kind: 'undo',
    parents,
    children,
    offset: 0,
    firstChild: parents.length,
    receipt,
    ...(applying?.kind === 'close' ? { untouched: applying.children.slice(applying.offset) } : {}),
  };
  if (applying || children.length + parents.length > pageSize) {
    await markParents(ctx, planning, parents, operation.operationId);
    // The transition from the close and its scheduled page to the Undo is one transaction.
    operation = { ...operation, planningApply: JSON.stringify(progress) };
  }
  return applyPage(ctx, operation, planning, progress, Math.max(pageSize - parents.length, 0));
}

export async function closeBatch(ctx: MutationCtx, input: BatchInput, actor: string, writes: BatchWrite[]) {
  const { projectId, operationId, undoClose } = input;
  const project = await activeOwnedProject(ctx, projectId, actor);
  const old = await hostedOperationRow(ctx, projectId, actor, operationId);
  const authority = sourceAuthority(project);
  const expected = old
    ? hostedOperationSchema.parse(JSON.parse(old.value)).expected
    : { authorityEpoch: authority.epoch };
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
    firstAttempt: {
      projectId,
      operationId,
      id: operationId,
      parentAttemptId: null,
      at: new Date().toISOString(),
      expected,
      ids: {},
    },
  });
  const terminal = operation.terminal?.outcome;
  if (terminal) {
    invariant(
      terminal.status === 'completed',
      'WORK_OPERATION_CHANGED',
      'Reconcile the original close operation.',
    );
    return JSON.stringify(terminal.result);
  }
  const row = old ?? (await hostedOperationRow(ctx, projectId, actor, operationId));
  invariant(row, 'NOT_FOUND', 'The original close operation is unavailable.');
  const applying = pendingPlanningApply(row);
  if (applying) {
    const task = applying.task ? await ctx.db.system.get(applying.task) : null;
    // A permanent scheduler error leaves the cursor committed at the preceding page.
    // An original-request retry replaces that failed wake inside the same operation.
    if (!task || task.state.kind === 'failed' || task.state.kind === 'canceled')
      await schedulePage(ctx, row, applying);
    return JSON.stringify(receiptFor(applying));
  }
  const receipt: Receipt = { kind, operationId, results: [], detached: 0, undo: [] };
  const planning = await planningWriteContext(ctx, project);
  if (undoClose) return JSON.stringify(await startUndo(ctx, row, planning, undoClose, receipt));

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
  receipt.results = await applyWrites(ctx, input, actor, writes, { planning });
  requireFresh(receipt.results);
  const parents = batchUndo(writes, receipt.results).undo;
  receipt.undo = [...parents];
  const closed = new Set(parents.map(write => write.itemId));
  const children = await liveCloseChildren(ctx, planning.selected, closed);
  const targets = detachAfterClose(closed, children);
  const parentOf = new Map(children.map(child => [child.id, child.parentId!]));
  const progress: Progress = {
    kind: 'close',
    parents,
    offset: 0,
    firstChild: writes.length,
    receipt,
    children: targets.map(({ itemId }) => [itemId, parentOf.get(itemId)!]),
  };
  const limit = Math.max(pageSize - writes.length, 0);
  if (targets.length > limit) await markParents(ctx, planning, parents, operationId);
  return JSON.stringify(await applyPage(ctx, row, planning, progress, limit));
}

/** A continuation owns one cursor. A replay, or a close cancelled by Undo, is a no-op. */
export const continueApply = internalMutation({
  args: { operation: v.id('projectHostedOperations'), offset: v.number() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const row = await ctx.db.get(input.operation);
      const progress = row && pendingPlanningApply(row);
      if (!row || !progress || progress.offset !== input.offset) return null;
      const project = await activeOwnedProject(ctx, row.projectId, row.actor);
      const planning = await planningWriteContext(ctx, project);
      await applyPage(ctx, row, planning, progress, pageSize);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

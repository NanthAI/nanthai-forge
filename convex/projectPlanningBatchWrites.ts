// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { executeCommand } from './projectWorkCommand';
import type { PlanningWriteContext } from './projectWorkCommandContext';
import { ForgeError, invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { undoableFields, type BatchBefore, type BatchResult, type BatchWrite } from '../src/planning-batch';
import type { PlanningItem } from '../src/work-planning-types';

/** The operation id of write `index` of batch `operationId`: stable, so a replay finds the original write. */
export function batchWriteOperationId(operationId: string, index: number) {
  const hex = digest(`planning-batch:${operationId.toLowerCase()}:${index}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Refusals that happen before a write touches the database, so the batch can report them and go on. */
const ownRefusals = new Set(['ITEM_CHANGED', 'NOT_FOUND', 'BAD_ARGUMENT', 'INTENT_CLOSED']);

export type BatchInput = {
  projectId: Id<'hostedProjects'>;
  operationId: string;
  writes: string;
  close?: true;
  atomic?: true;
  undoClose?: string;
};

export async function applyWrites(
  ctx: MutationCtx,
  input: BatchInput,
  actor: string,
  writes: readonly BatchWrite[],
  options: {
    offset?: number;
    planning?: PlanningWriteContext;
    lock?: string;
    restore?: string;
    prepare?: (write: BatchWrite, position: number) => Promise<BatchWrite | null>;
    atomic?: boolean;
    planningTick?: true;
    /** Child writes a close or its Undo derives from the parents the caller chose: not charged
     * to the account limiter (the chosen writes are). */
    derived?: true;
  } = {},
) {
  const results: BatchResult[] = [];
  for (const [position, original] of writes.entries()) {
    const write = options.prepare ? await options.prepare(original, position) : original;
    if (options.prepare && !write) continue;
    invariant(
      write &&
        typeof write === 'object' &&
        (write.action === 'put-planning-item' || write.action === 'comment-planning-item') &&
        typeof write.itemId === 'string',
      'BAD_ARGUMENT',
      'Each batch write is a put-planning-item or comment-planning-item with an itemId.',
    );
    const index = (options.offset ?? 0) + position;
    const operationId = batchWriteOperationId(input.operationId, index);
    const base = { index, itemId: write.itemId, action: write.action } as const;
    const prior: { item?: PlanningItem | null; replayed?: true; notice?: string } = {};
    try {
      await executeCommand(
        ctx,
        {
          projectId: input.projectId,
          operationId,
          command: JSON.stringify({ ...write, operationId }),
        },
        actor,
        {
          planning: options.planning,
          planningClose: options.lock,
          planningRestore: options.restore,
          ...(options.planningTick ? { planningTick: true as const } : {}),
          ...(options.derived ? { server: true as const } : {}),
          onPlanningBatchState: state => {
            if ('replayed' in state) prior.replayed = true;
            else prior.item = state.before;
            if (state.notice) prior.notice = state.notice;
          },
        },
      );
    } catch (error) {
      if (options.atomic || !(error instanceof ForgeError) || !ownRefusals.has(error.code)) throw error;
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
      results.push({ ...base, outcome: prior.replayed ? 'replayed' : 'applied' });
      continue;
    }
    const version = write.expectedVersion + 1;
    if (prior.replayed) {
      results.push({
        ...base,
        outcome: 'replayed',
        version,
        ...(prior.notice ? { message: prior.notice } : {}),
      });
      continue;
    }
    const kept: BatchBefore = {};
    if (prior.item)
      for (const field of undoableFields)
        if (field in write && (write as Record<string, unknown>)[field] !== undefined)
          (kept as Record<string, unknown>)[field] = prior.item[field] ?? null;
    results.push({
      ...base,
      outcome: 'applied',
      version,
      before: kept,
      ...(prior.notice ? { message: prior.notice } : {}),
    });
  }
  return results;
}

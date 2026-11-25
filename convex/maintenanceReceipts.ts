// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx, QueryCtx } from './server';
import { invariant } from '../src/errors';

/** Retry receipts for one-off maintenance pages. The table keeps its original name
 * (`legacyStorageCleanupPages`) because operational expiry and the landing capsule also store
 * their own receipts in it; a rename moves rows and capsule pointers (Item c0af6cfa follow-up). */
export async function cleanupReceipt(ctx: QueryCtx, operationId: string, part: string, request: string) {
  const old = await ctx.db
    .query('legacyStorageCleanupPages')
    .withIndex('by_operation_and_part', q => q.eq('operationId', operationId).eq('part', part))
    .unique();
  invariant(!old || old.request === request, 'OPERATION_REUSED', 'Replay the original cleanup page.');
  return old ? JSON.parse(old.result) : null;
}
export async function recordCleanup(
  ctx: MutationCtx,
  operationId: string,
  part: string,
  request: string,
  result: unknown,
) {
  await ctx.db.insert('legacyStorageCleanupPages', {
    operationId,
    part,
    request,
    result: JSON.stringify(result),
  });
}

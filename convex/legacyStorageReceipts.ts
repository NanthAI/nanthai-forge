// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import { invariant } from '../src/errors';
export async function cleanupReceipt(ctx: MutationCtx, operationId: string, part: string, request: string) {
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
export function recentCleanup(value: string, since: number, window: number) {
  const at = Date.parse(value);
  return Number.isFinite(at) && at >= since && at <= Date.now() && Date.now() - at <= window;
}

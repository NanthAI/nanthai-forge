// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './server';
import { digest } from '../src/state/hash';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
/** Reuse durable auth receipts: no new table, index, retention policy or bearer storage. */
export async function deviceOperation(
  ctx: QueryCtx | MutationCtx,
  owner: string,
  operationId: string,
  request: unknown,
) {
  const identity = await ctx.auth.getUserIdentity();
  const userId =
    identity?.subject === owner && typeof identity.forgeAuthUser === 'string'
      ? ctx.db.normalizeId('users', identity.forgeAuthUser)
      : undefined;
  const user = userId
    ? await ctx.db.get(userId)
    : await ctx.db
        .query('users')
        .withIndex('by_accountKey', q => q.eq('accountKey', owner))
        .unique();
  invariant(user && user.accountKey === owner, 'AUTH_REQUIRED', 'The device account is unavailable.');
  const hash = digest(canonicalPayload(request));
  const previous = await ctx.db
    .query('authLinkEvents')
    .withIndex('by_user_and_operation', q => q.eq('userId', user._id).eq('operationId', operationId))
    .unique();
  if (previous) {
    invariant(previous.kind === 'device', 'AUTH_OPERATION_CHANGED', 'Retain the original device operation.');
    const receipt = JSON.parse(previous.request) as { hash: string; result: Record<string, unknown> };
    invariant(receipt.hash === hash, 'AUTH_OPERATION_CHANGED', 'Retain the original device operation.');
    return { userId: user._id, hash, result: receipt.result };
  }
  return { userId: user._id, hash, result: null };
}
export async function finishDeviceOperation(
  ctx: MutationCtx,
  receipt: Awaited<ReturnType<typeof deviceOperation>>,
  operationId: string,
  deviceId: string,
  result: Record<string, unknown>,
) {
  await ctx.db.insert('authLinkEvents', {
    userId: receipt.userId,
    operationId,
    request: canonicalPayload({ hash: receipt.hash, result }),
    kind: 'device',
    sessionId: operationId,
    identityId: deviceId,
    at: Date.now(),
  });
}

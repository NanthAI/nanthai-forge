// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { takeDeviceBudget } from './deviceBudget';
import { deviceOperation, finishDeviceOperation } from './deviceOperation';
import { invariant } from '../src/errors';
import { deviceApprovalExpired, deviceSignInExpiry } from './deviceFields';
const args = {
  credentialId: v.string(),
  key: v.string(),
  operationId: v.string(),
  at: v.number(),
  proofHash: v.string(),
};
async function selected(
  ctx: import('./server').QueryCtx | import('./server').MutationCtx,
  input: { credentialId: string; key: string },
) {
  const row = await ctx.db
    .query('cliCredentials')
    .withIndex('by_credentialId', q => q.eq('credentialId', input.credentialId))
    .unique();
  invariant(
    row && row.deviceKey === input.key,
    'AUTH_REQUIRED',
    'This device key is not approved. Run nforge login.',
  );
  return row;
}
/** Budget and reserve the original operation before signing; lost replies spend no second allowance. */
export const renewal = internalMutation({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    const row = await ctx.db
      .query('cliCredentials')
      .withIndex('by_credentialId', q => q.eq('credentialId', input.credentialId))
      .unique();
    if (!row || row.deviceKey !== input.key) {
      const allowed = await takeDeviceBudget(ctx);
      return JSON.stringify({ row: null, result: { status: allowed ? 'unapproved' : 'slow_down' } });
    }
    const receipt = await deviceOperation(ctx, row.owner, input.operationId, input);
    if (receipt.result) {
      const status = row.removed
        ? 'removed'
        : row.revoked
          ? 'signed-out'
          : deviceApprovalExpired(row)
            ? 'approval-expired'
            : receipt.result.status === 'approved' && row.renewal?.operationId !== input.operationId
              ? 'superseded'
              : null;
      return JSON.stringify(status ? { row: null, result: { status } } : { row, result: receipt.result });
    }
    if (!(await takeDeviceBudget(ctx))) return JSON.stringify({ row: null, result: { status: 'slow_down' } });
    const issuedAt = Math.floor(Date.now() / 1000) * 1000;
    const reserved = { status: 'reserved', issuedAt, expiresAt: deviceSignInExpiry(row, issuedAt) };
    await finishDeviceOperation(ctx, receipt, input.operationId, row.credentialId, reserved);
    return JSON.stringify({ row, result: reserved });
  },
});
export const renew = internalMutation({
  args: { ...args, issuedAt: v.number(), tokenHash: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const row = await selected(ctx, input);
    const { issuedAt, tokenHash, ...request } = input;
    const receipt = await deviceOperation(ctx, row.owner, input.operationId, request);
    const expiresAt = Math.min(
      deviceSignInExpiry(row, issuedAt),
      typeof receipt.result?.expiresAt === 'number' ? receipt.result.expiresAt : Infinity,
    );
    if (receipt.result && receipt.result.status !== 'reserved') {
      const status = row.removed
        ? 'removed'
        : row.revoked
          ? 'signed-out'
          : deviceApprovalExpired(row)
            ? 'approval-expired'
            : receipt.result.status === 'approved' && row.renewal?.operationId !== input.operationId
              ? 'superseded'
              : null;
      if (status) return JSON.stringify({ status });
      if (
        !row.revoked &&
        !row.removed &&
        row.renewal?.operationId === input.operationId &&
        receipt.result.status === 'approved' &&
        receipt.result.issuedAt === issuedAt &&
        (row.tokenHash !== tokenHash || row.expiresAt !== expiresAt)
      )
        await ctx.db.patch(row._id, { tokenHash, expiresAt });
      return JSON.stringify(
        receipt.result.status === 'approved' ? { ...receipt.result, expiresAt } : receipt.result,
      );
    }
    const status = row.removed
      ? 'removed'
      : row.revoked
        ? 'signed-out'
        : deviceApprovalExpired(row)
          ? 'approval-expired'
          : Math.abs(Date.now() - input.at) > 600_000
            ? 'proof-expired'
            : 'approved';
    const result: Record<string, unknown> =
      status === 'approved'
        ? {
            status,
            owner: row.owner,
            credentialId: row.credentialId,
            issuedAt,
            expiresAt,
            signInId: input.operationId,
          }
        : { status };
    if (status === 'approved')
      await ctx.db.patch(row._id, {
        issuedAt,
        expiresAt,
        tokenHash,
        deviceLastSeen: Date.now(),
        renewal: { operationId: input.operationId, requestHash: receipt.hash, issuedAt },
      });
    await finishDeviceOperation(ctx, receipt, input.operationId, row.credentialId, result);
    return JSON.stringify(result);
  },
});

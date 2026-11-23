// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation } from './server';
import { takeDeviceBudget } from './deviceBudget';
import { takeVisitorDevice } from './visitorBudget';
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
/** The visitor key the site forwarded (convex/visitorBudget.ts); charged before the deployment budget. */
async function allowed(ctx: import('./server').MutationCtx, client: string | undefined) {
  const refused = await takeVisitorDevice(ctx, client, () => takeDeviceBudget(ctx));
  // A renewal keeps its `status: 'slow_down'` answer; the visitor sentence rides along for the CLI.
  if (!refused) return null;
  const { error_description } = refused as { error_description?: string };
  return { status: 'slow_down' as const, ...(error_description ? { error_description } : {}) };
}
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
  args: { ...args, client: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, { client, ...input }) => {
    const row = await ctx.db
      .query('cliCredentials')
      .withIndex('by_credentialId', q => q.eq('credentialId', input.credentialId))
      .unique();
    if (!row || row.deviceKey !== input.key) {
      const refused = await allowed(ctx, client);
      return JSON.stringify({ row: null, result: refused ?? { status: 'unapproved' } });
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
    const refused = await allowed(ctx, client);
    if (refused) return JSON.stringify({ row: null, result: refused });
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

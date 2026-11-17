// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery, internalMutation } from './server';
import { deviceOperation, finishDeviceOperation } from './deviceOperation';
import { invariant } from '../src/errors';
import { CLI_TOKEN_LIFETIME } from '../src/device-lifetime';
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
/** Read one durable receipt and the current key binding. The Node signer receives no private device key. */
export const renewal = internalQuery({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    const row = await selected(ctx, input);
    const receipt = await deviceOperation(ctx, row.owner, input.operationId, input);
    return JSON.stringify({ row, result: receipt.result });
  },
});
export const renew = internalMutation({
  args: { ...args, issuedAt: v.number(), tokenHash: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const row = await selected(ctx, input);
    const { issuedAt, tokenHash, ...request } = input;
    const receipt = await deviceOperation(ctx, row.owner, input.operationId, request);
    if (receipt.result) {
      if (
        !row.revoked &&
        !row.removed &&
        row.renewal?.operationId === input.operationId &&
        receipt.result.issuedAt === issuedAt &&
        row.tokenHash !== tokenHash
      )
        await ctx.db.patch(row._id, { tokenHash });
      return JSON.stringify(receipt.result);
    }
    const status = row.removed
      ? 'removed'
      : row.revoked
        ? 'signed-out'
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
            expiresAt: issuedAt + CLI_TOKEN_LIFETIME,
            signInId: input.operationId,
          }
        : { status };
    if (status === 'approved')
      await ctx.db.patch(row._id, {
        issuedAt,
        expiresAt: issuedAt + CLI_TOKEN_LIFETIME,
        tokenHash,
        deviceLastSeen: Date.now(),
        renewal: { operationId: input.operationId, requestHash: receipt.hash, issuedAt },
      });
    await finishDeviceOperation(ctx, receipt, input.operationId, row.credentialId, result);
    return JSON.stringify(result);
  },
});

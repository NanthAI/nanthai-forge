// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internalAction } from './server';
import { internal } from './_generated/api';
import { beginDeviceLogin, deviceConfig } from './deviceActions';
import { deviceProof, deviceScope, deviceSignInExpiry } from './deviceFields';
import { verifyDeviceProof, issueDeviceToken, deviceHash } from '../src/device-token';
import { invariant } from '../src/errors';
type Proof = { id: string; key: string; at: number; proof: string };
/** The HTTP handler supplies the actual request origin; it is not taken from request JSON. */
async function renewVerified(
  ctx: import('./server').ActionCtx,
  operationId: string,
  device: Proof,
  client: string | undefined,
) {
  const request = {
    credentialId: device.id,
    key: device.key,
    operationId,
    at: device.at,
    proofHash: deviceHash(device.proof),
  };
  const selected = JSON.parse(
    await ctx.runMutation(internal.deviceStableStore.renewal, { ...request, ...(client ? { client } : {}) }),
  );
  if (!selected.row) return selected.result;
  const issuedAt =
    typeof selected.result?.issuedAt === 'number'
      ? selected.result.issuedAt
      : Math.floor(Date.now() / 1000) * 1000;
  const expiresAt = Math.min(
    deviceSignInExpiry(selected.row, issuedAt),
    typeof selected.result?.expiresAt === 'number' ? selected.result.expiresAt : Infinity,
  );
  const { key, issuer } = deviceConfig();
  const token = (owner: string, time: number) =>
    issueDeviceToken(key, issuer, {
      owner,
      credentialId: device.id,
      issuedAt: time,
      expiresAt,
      signInId: operationId,
    });
  const proposed = token(selected.row.owner, issuedAt);
  const result = JSON.parse(
    await ctx.runMutation(internal.deviceStableStore.renew, {
      ...request,
      issuedAt,
      tokenHash: deviceHash(proposed),
    }),
  );
  if (result.status !== 'approved') return result;
  return {
    status: 'approved',
    token: result.issuedAt === issuedAt ? proposed : token(result.owner, result.issuedAt),
    credentialId: device.id,
    deviceId: device.id,
    deviceCode: selected.row.deviceCode,
    name: selected.row.name,
    scope: selected.row.scope,
    signInId: result.signInId,
    expiresAt: result.expiresAt,
  };
}
export const renew = internalAction({
  args: { origin: v.string(), operationId: v.string(), device: deviceProof, client: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    invariant(
      verifyDeviceProof(input.origin, 'renew', input.operationId, input.device),
      'AUTH_REQUIRED',
      'Use this device’s own key to renew.',
    );
    return JSON.stringify(await renewVerified(ctx, input.operationId, input.device, input.client));
  },
});
export const start = internalAction({
  args: {
    origin: v.string(),
    operationId: v.string(),
    clientNonce: v.string(),
    name: v.string(),
    scope: deviceScope,
    projectId: v.optional(v.string()),
    device: deviceProof,
    /** The visitor key the site forwarded (convex/visitorBudget.ts); the HTTP route sets it, never request JSON. */
    client: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    const extra = {
      clientNonce: input.clientNonce,
      name: input.name,
      scope: input.scope,
      projectId: input.projectId ?? null,
    };
    invariant(
      verifyDeviceProof(input.origin, 'start', input.operationId, input.device, extra) &&
        Math.abs(Date.now() - input.device.at) <= 600_000,
      'AUTH_REQUIRED',
      'Use the fresh proposal from this device’s terminal.',
    );
    const result = await beginDeviceLogin(ctx, { ...input, stable: input.device, forceApproval: true });
    if (result && 'known' in result) return JSON.stringify({ status: 'removed' });
    return JSON.stringify(result);
  },
});

// SPDX-License-Identifier: Apache-2.0
'use node';
import { randomUUID } from 'node:crypto';
import { v } from 'convex/values';
import { action, internalAction, isDeviceIdentity } from './cliServer';
import { internal } from './_generated/api';
import { deviceScope } from './deviceFields';
import {
  deviceSecret,
  deviceHash,
  userCode,
  normalizedCode,
  equalHash,
  issueDeviceToken,
  tokenKeys,
  CLI_TOKEN_LIFETIME,
} from '../src/device-token';
import { invariant } from '../src/errors';
function config() {
  const key = process.env.FORGE_CLI_PRIVATE_KEY,
    issuer = process.env.FORGE_CLI_ISSUER,
    web = process.env.FORGE_WEB_URL;
  invariant(key && issuer && web, 'AUTH_CONFIGURATION', 'Device login is not configured.');
  invariant(
    new URL(issuer).protocol === 'https:' &&
      new URL(issuer).origin === issuer &&
      issuer !== process.env.CLERK_JWT_ISSUER_DOMAIN &&
      new URL(web).protocol === 'https:',
    'AUTH_CONFIGURATION',
    'Configure HTTPS login endpoints.',
  );
  return { key, issuer, web };
}
const uuid = (value: string) =>
  invariant(/^[0-9a-f-]{36}$/i.test(value), 'BAD_ARGUMENT', 'Use an operation UUID.');
async function browserOwner(ctx: import('./_generated/server').ActionCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user && !isDeviceIdentity(user), 'AUTH_REQUIRED', 'Sign in to Forge in your browser.');
  const allowed: boolean = await ctx.runMutation(internal.deviceStore.attempt, { owner: user.subject });
  invariant(allowed, 'AUTH_SLOW_DOWN', 'Try again in a minute.');
  return user.subject;
}
export const start = internalAction({
  args: { operationId: v.string(), clientNonce: v.string(), name: v.string(), scope: deviceScope },
  returns: v.object({
    device_code: v.string(),
    user_code: v.string(),
    verification_uri: v.string(),
    verification_uri_complete: v.string(),
    expires_in: v.number(),
    interval: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  }> => {
    const { key, web } = config();
    uuid(args.operationId);
    invariant(
      /^[0-9a-f]{64}$/.test(args.clientNonce) && args.name.trim().length > 0,
      'BAD_ARGUMENT',
      'Use a login nonce and device name.',
    );
    const deviceCode = deviceSecret(key, args.operationId, args.clientNonce);
    const code = userCode(key, args.operationId, deviceCode),
      verification = new URL('/device', web).href;
    const row = await ctx.runMutation(internal.deviceStore.start, {
      operationId: args.operationId,
      name: args.name,
      scope: args.scope,
      request: JSON.stringify({ name: args.name, scope: args.scope }),
      deviceHash: deviceHash(deviceCode),
      userHash: deviceHash(normalizedCode(code)),
      expiresAt: Date.now() + 600_000,
      nextPollAt: 0,
      state: 'pending',
      credentialId: randomUUID(),
      // The bearer secret is never persisted.
    });
    return {
      device_code: deviceCode,
      user_code: code,
      verification_uri: verification,
      verification_uri_complete: `${verification}?code=${code}`,
      expires_in: Math.max(0, Math.floor((row.expiresAt - Date.now()) / 1000)),
      interval: 5,
    };
  },
});
export const poll = internalAction({
  args: { deviceCode: v.string(), operationId: v.string() },
  returns: v.object({
    status: v.string(),
    token: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    credentialId: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ status: string; token?: string; expiresAt?: number; credentialId?: string }> => {
    const { key, issuer } = config();
    uuid(args.operationId);
    invariant(/^[0-9a-f]{64}$/.test(args.deviceCode), 'BAD_ARGUMENT', 'Use the original device code.');
    const hashed = deviceHash(args.deviceCode);
    const result = await ctx.runMutation(internal.deviceStore.poll, {
      deviceHash: hashed,
      operationId: args.operationId,
    });
    if (!result.device) return { status: result.status };
    const row = result.device;
    invariant(
      equalHash(hashed, row.deviceHash) && row.owner && row.issuedAt !== undefined,
      'AUTH_REQUIRED',
      'Device approval is unavailable.',
    );
    const token = issueDeviceToken(key, issuer, {
      owner: row.owner,
      credentialId: row.credentialId,
      issuedAt: row.issuedAt,
    });
    const expiresAt = row.issuedAt + CLI_TOKEN_LIFETIME;
    await ctx.runMutation(internal.deviceStore.issue, {
      owner: row.owner,
      name: row.name,
      scope: row.scope,
      credentialId: row.credentialId,
      issuedAt: row.issuedAt,
      expiresAt,
      tokenHash: deviceHash(token),
      revoked: false,
    });
    return { status: 'approved', token, expiresAt, credentialId: row.credentialId };
  },
});
const approvalView = v.object({
  name: v.string(),
  scope: deviceScope,
  expiresAt: v.number(),
  state: v.string(),
});
export const inspect = action({
  args: { code: v.string() },
  returns: approvalView,
  handler: async (
    ctx,
    { code },
  ): Promise<{ name: string; scope: 'cli' | 'coordination'; expiresAt: number; state: string }> => {
    await browserOwner(ctx);
    const hash = deviceHash(normalizedCode(code));
    const row = await ctx.runQuery(internal.deviceStore.lookup, { userHash: hash });
    invariant(
      row && row.expiresAt > Date.now() && equalHash(row.userHash, hash),
      'AUTH_EXPIRED',
      'This device code expired or is unavailable.',
    );
    return { name: row.name, scope: row.scope, expiresAt: row.expiresAt, state: row.state };
  },
});
export const decide = action({
  args: { code: v.string(), approve: v.boolean(), operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    uuid(args.operationId);
    const owner = await browserOwner(ctx);
    const hash = deviceHash(normalizedCode(args.code));
    const row = await ctx.runQuery(internal.deviceStore.lookup, { userHash: hash });
    invariant(
      row && equalHash(row.userHash, hash),
      'AUTH_EXPIRED',
      'This device code expired or is unavailable.',
    );
    await ctx.runMutation(internal.deviceStore.decide, {
      userHash: hash,
      owner,
      approve: args.approve,
      operationId: args.operationId,
    });
    return null;
  },
});
let cachedJwks: { key: string; body: string } | undefined;
export const jwks = internalAction({
  args: {},
  returns: v.string(),
  handler: async () => {
    const { key } = config();
    if (cachedJwks?.key !== key) cachedJwks = { key, body: JSON.stringify({ keys: [tokenKeys(key).jwk] }) };
    return cachedJwks.body;
  },
});

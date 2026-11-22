// SPDX-License-Identifier: Apache-2.0
'use node';
import { v, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { accountAction, internalAction, isDeviceIdentity } from './cliServer';
import { internal } from './_generated/api';
import { deviceScope, deviceSettings } from './deviceFields';
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
export function deviceConfig() {
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
/** Returned instead of a login when too many device logins started this minute. */
export const startSlowDown = { error: 'slow_down' as const, interval: 60 };
type DeviceFlow = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};
type SlowDown = { error: 'slow_down'; interval: number; error_description?: string };
export async function beginDeviceLogin(
  ctx: import('./_generated/server').ActionCtx,
  args: {
    operationId: string;
    clientNonce: string;
    name: string;
    scope: 'cli' | 'coordination';
    projectId?: string;
    stable: { id: string; key: string };
    forceApproval?: true;
    /** The visitor key the site forwarded (convex/visitorBudget.ts). */
    client?: string;
  },
): Promise<DeviceFlow | SlowDown | { known: Doc<'cliCredentials'> }> {
  const { key, web } = deviceConfig();
  uuid(args.operationId);
  const name = args.name.trim();
  invariant(
    /^[0-9a-f]{64}$/.test(args.clientNonce) && name.length > 0 && name.length <= 80,
    'BAD_ARGUMENT',
    'Use a login nonce and a device name of 1 to 80 characters.',
  );
  const deviceCode = deviceSecret(key, args.operationId, args.clientNonce);
  const code = userCode(key, args.operationId, deviceCode),
    verification = new URL('/device', web).href;
  const row = await ctx.runMutation(internal.deviceStore.start, {
    operationId: args.operationId,
    ...(args.forceApproval ? { forceApproval: true } : {}),
    ...(args.client ? { client: args.client } : {}),
    // Stored as checked: trimmed (review R-07).
    name,
    scope: args.scope,
    request: JSON.stringify({
      name,
      scope: args.scope,
      deviceVersion: 1,
      projectId: args.projectId ?? null,
      deviceKey: args.stable.key,
    }),
    deviceHash: deviceHash(deviceCode),
    userHash: deviceHash(normalizedCode(code)),
    expiresAt: Date.now() + 600_000,
    nextPollAt: 0,
    state: 'pending',
    credentialId: args.stable.id,
    deviceKey: args.stable.key,
    // The bearer secret is never persisted.
  });
  if (!row) return startSlowDown;
  if ('error' in row) return row;
  if ('known' in row) return { known: row.known };
  return {
    device_code: deviceCode,
    user_code: code,
    verification_uri: verification,
    verification_uri_complete: `${verification}?code=${code}`,
    expires_in: Math.max(0, Math.floor((row.expiresAt - Date.now()) / 1000)),
    interval: 5,
  };
}
const pollView = v.object({
  status: v.string(),
  token: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  credentialId: v.optional(v.string()),
  deviceId: v.optional(v.string()),
  deviceCode: v.optional(v.string()),
  name: v.optional(v.string()),
  scope: v.optional(deviceScope),
  signInId: v.optional(v.string()),
});
export const poll = internalAction({
  args: { deviceCode: v.string(), operationId: v.string() },
  returns: pollView,
  handler: async (ctx, args): Promise<Infer<typeof pollView>> => {
    const { key, issuer } = deviceConfig();
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
    const expiresAt = row.signInExpiresAt ?? row.issuedAt + CLI_TOKEN_LIFETIME;
    const token = issueDeviceToken(key, issuer, {
      owner: row.owner,
      credentialId: row.credentialId,
      issuedAt: row.issuedAt,
      expiresAt,
      ...(row.deviceKey ? { signInId: row.decisionId } : {}),
    });
    const credential = await ctx.runMutation(internal.deviceStore.issue, {
      owner: row.owner,
      name: row.name,
      scope: row.scope,
      credentialId: row.credentialId,
      issuedAt: row.issuedAt,
      expiresAt,
      tokenHash: deviceHash(token),
      revoked: false,
      ...(row.deviceKey ? { deviceKey: row.deviceKey, signInId: row.decisionId } : {}),
    });
    return {
      ...(credential.deviceKey
        ? {
            deviceId: credential.credentialId,
            deviceCode: credential.deviceCode,
            name: credential.name,
            scope: credential.scope,
            signInId: credential.renewal?.operationId,
          }
        : {}),
      status: 'approved',
      token,
      expiresAt: credential.expiresAt,
      credentialId: row.credentialId,
    };
  },
});
const approvalView = v.union(
  v.object({ needsCode: v.literal(true) }),
  v.object({
    name: v.string(),
    needsConfirmation: v.optional(v.boolean()),
    /** With needsConfirmation: whether this account has a linked GitHub identity to check with. */
    github: v.optional(v.boolean()),
    scope: deviceScope,
    expiresAt: v.number(),
    state: v.string(),
    device: v.optional(
      v.object({
        id: v.string(),
        code: v.string(),
        known: v.boolean(),
        approvedAt: v.union(v.number(), v.null()),
        settings: deviceSettings,
        projectName: v.union(v.string(), v.null()),
      }),
    ),
  }),
);
export const inspect = accountAction('same')({
  args: { code: v.optional(v.string()), requestId: v.optional(v.string()) },
  returns: approvalView,
  handler: async (ctx, args): Promise<Infer<typeof approvalView>> => {
    const owner = await browserOwner(ctx);
    invariant(
      Boolean(args.code) !== Boolean(args.requestId),
      'BAD_ARGUMENT',
      'Choose the terminal code or your remembered-device request.',
    );
    return JSON.parse(
      await ctx.runQuery(internal.deviceApprovalStore.inspect, {
        owner,
        ...(args.requestId
          ? { requestId: args.requestId }
          : { userHash: deviceHash(normalizedCode(args.code!)) }),
      }),
    );
  },
});
export const decide = accountAction('same')({
  args: {
    code: v.optional(v.string()),
    requestId: v.optional(v.string()),
    approve: v.boolean(),
    operationId: v.string(),
    name: v.optional(v.string()),
    settings: v.optional(deviceSettings),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    uuid(args.operationId);
    const owner = await browserOwner(ctx);
    invariant(
      Boolean(args.code) || (!args.approve && Boolean(args.requestId)),
      args.approve ? 'AUTH_REQUIRED' : 'BAD_ARGUMENT',
      'Type the code from your terminal before approving.',
    );
    await ctx.runMutation(internal.deviceStore.decide, {
      owner,
      approve: args.approve,
      operationId: args.operationId,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.settings ? { settings: args.settings } : {}),
      ...(args.requestId ? { requestId: args.requestId } : {}),
      ...(args.code ? { userHash: deviceHash(normalizedCode(args.code)) } : {}),
    });
    return null;
  },
});
let cachedJwks: { key: string; body: string } | undefined;
export const jwks = internalAction({
  args: {},
  returns: v.string(),
  handler: async () => {
    const { key } = deviceConfig();
    if (cachedJwks?.key !== key) cachedJwks = { key, body: JSON.stringify({ keys: [tokenKeys(key).jwk] }) };
    return cachedJwks.body;
  },
});

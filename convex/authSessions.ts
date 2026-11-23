// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, accountMutation } from './cliServer';
import { authComponents as components } from './authComponents';
import { linkAccount, confirmationOptions, confirmAccount, digest } from './authLinkAccount';
import { authenticationResponse, requestOptions } from './authPasskeyWire';
import { displayPasskey, passkeyPosition } from './authPasskeyPage';
import { browserInactivitySeconds, browserLifetimeSeconds } from './accessPolicy';
import { deviceSettings, deviceApprovalExpired } from './deviceFields';
import { endAccountDevices } from './deviceEndAll';
import { invariant } from '../src/errors';
const PURPOSE = 'forge:end-other-sessions';
const session = v.object({
  sessionId: v.string(),
  creationTime: v.number(),
  lastRefreshedAt: v.number(),
  current: v.boolean(),
});
const device = v.object({
  credentialId: v.string(),
  name: v.string(),
  scope: v.string(),
  issuedAt: v.number(),
  expiresAt: v.number(),
  revoked: v.boolean(),
  code: v.optional(v.string()),
  approvedAt: v.optional(v.number()),
  removed: v.optional(v.boolean()),
  approvalExpired: v.optional(v.boolean()),
  settings: v.optional(deviceSettings),
});
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    sessions: v.array(session),
    passkeys: v.array(displayPasskey),
    passkeysContinueAfter: v.union(passkeyPosition, v.null()),
    devices: v.array(device),
    github: v.union(v.string(), v.null()),
    deviceNotice: v.optional(v.object({ at: v.number(), credentialId: v.string(), signInId: v.string() })),
    notice: v.union(v.object({ at: v.number(), passkeyId: v.string() }), v.null()),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const { user, sessionId } = await linkAccount(ctx);
    const [sessions, passkeys, devices] = await Promise.all([
      ctx.runQuery(components.auth.public.listSessions, { userId: user._id }),
      ctx.runQuery(components.authPasskey.accountPasskeys.first, { userId: user._id }),
      ctx.db
        .query('cliCredentials')
        .withIndex('by_owner', q => q.eq('owner', user.accountKey))
        .order('desc')
        .paginate(args.paginationOpts),
    ]);
    const now = Date.now();
    return {
      sessions: sessions
        .filter(
          row =>
            row.creationTime + browserLifetimeSeconds * 1000 > now &&
            row.lastRefreshedAt + browserInactivitySeconds * 1000 > now,
        )
        .map(row => ({ ...row, current: row.sessionId === sessionId })),
      passkeys: passkeys.page,
      passkeysContinueAfter: passkeys.continueAfter,
      devices: devices.page.map(
        ({
          credentialId,
          name,
          scope,
          issuedAt,
          expiresAt,
          revoked,
          deviceCode,
          deviceApprovedAt,
          deviceKey,
          removed,
          settings,
        }) => ({
          ...(deviceCode ? { code: deviceCode } : {}),
          ...(deviceKey && deviceApprovalExpired({ deviceApprovedAt, expiresAt })
            ? { approvalExpired: true }
            : {}),
          ...(deviceApprovedAt !== undefined ? { approvedAt: deviceApprovedAt } : {}),
          ...(removed !== undefined ? { removed } : {}),
          ...(settings ? { settings } : {}),
          credentialId,
          name,
          scope,
          issuedAt,
          expiresAt,
          revoked,
        }),
      ),
      github: user.githubConflict ? null : (user.githubLogin ?? null),
      notice: user.passkeyNotice ?? null,
      ...(user.deviceNotice ? { deviceNotice: user.deviceNotice } : {}),
      isDone: devices.isDone,
      continueCursor: devices.continueCursor,
    };
  },
});

export const morePasskeys = query({
  args: { after: passkeyPosition, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(displayPasskey),
  handler: async (ctx, args) => {
    const { user } = await linkAccount(ctx);
    return ctx.runQuery(components.authPasskey.accountPasskeys.more, { ...args, userId: user._id });
  },
});

export const startConfirmation = accountMutation('same')({
  args: {},
  returns: requestOptions,
  handler: async ctx => {
    const { user } = await linkAccount(ctx);
    return confirmationOptions(ctx, user, PURPOSE);
  },
});
export const revokeOthers = accountMutation('same')({
  args: {
    response: authenticationResponse,
    operationId: v.string(),
    includeDevices: v.optional(v.boolean()),
  },
  returns: v.number(),
  handler: async (ctx, { response, operationId, includeDevices }) => {
    const { user, sessionId } = await linkAccount(ctx);
    invariant(operationId.trim(), 'BAD_ARGUMENT', 'Retain the session sign-out operation id.');
    const proofHash = 'done:' + (await digest(JSON.stringify(response)));
    // Receipt lives on the existing account, bound to this browser and this operation.
    if (
      user.sessionEnd?.operationId === operationId &&
      user.sessionEnd.sessionId === sessionId &&
      user.sessionEnd.stateHash.startsWith('done:')
    ) {
      invariant(
        user.sessionEnd.stateHash === proofHash &&
          Boolean(user.sessionEnd.includeDevices) === Boolean(includeDevices),
        'WORK_OPERATION_CHANGED',
        'Retry the original session sign-out proof.',
      );
      return user.sessionEnd.revokedCount ?? 0;
    }
    await confirmAccount(ctx, user, PURPOSE, response);
    const sessions = await ctx.runQuery(components.auth.public.listSessions, { userId: user._id });
    const revoked = await ctx.runMutation(components.auth.public.revokeSessions, {
      sessionIds: sessions.filter(row => row.sessionId !== sessionId).map(row => row.sessionId),
    });
    if (includeDevices)
      await endAccountDevices(ctx, user.accountKey, user, { markSealed: true, issuer: sessionId });
    await ctx.db.patch(user._id, {
      sessionEnd: {
        operationId,
        sessionId,
        stateHash: proofHash,
        revokedCount: revoked.length,
        ...(includeDevices ? { includeDevices: true } : {}),
        verifiedUntil: 0,
      },
    });
    return revoked.length;
  },
});

const DEVICE_PURPOSE = 'forge:approve-device';
export const startDeviceConfirmation = accountMutation('same')({
  args: {},
  returns: requestOptions,
  handler: async ctx => {
    const { user } = await linkAccount(ctx);
    return confirmationOptions(ctx, user, DEVICE_PURPOSE);
  },
});
export const confirmDeviceApproval = accountMutation('same')({
  args: { response: authenticationResponse },
  returns: v.null(),
  handler: async (ctx, { response }) => {
    const { user, sessionId } = await linkAccount(ctx);
    await confirmAccount(ctx, user, DEVICE_PURPOSE, response);
    await ctx.db.patch(user._id, { deviceApprovalProof: { sessionId, verifiedUntil: Date.now() + 600000 } });
    return null;
  },
});

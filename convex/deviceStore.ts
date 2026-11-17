// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { publicAbuseBudgets } from './publicAbuseBudgets';
import { internalMutation, internalQuery } from './server';
import {
  deviceDocument,
  deviceFields,
  credentialDocument,
  credentialFields,
  deviceSettings,
  currentCredential,
} from './deviceFields';
import { accessibleProject } from './projectAuthority';
import { deviceApproval } from './deviceApproval';
import { deviceOperation, finishDeviceOperation } from './deviceOperation';
import { CLI_TOKEN_LIFETIME } from '../src/device-lifetime';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
import { isDeviceIdentity } from './cliServer';
/** New device logins per minute for the whole deployment, and expired login rows
 * removed by each new start. Retries of an existing start are not counted. */
export const deviceStartLimit = { perMinute: 120, cleanup: 4 };
/** Returns null when the start limit is reached. */
export const start = internalMutation({
  args: { ...deviceFields, forceApproval: v.optional(v.literal(true)) },
  returns: v.union(deviceDocument, v.object({ known: credentialDocument }), v.null()),
  handler: async (ctx, args) => {
    const { forceApproval, ...proposed } = args;
    const old = await ctx.db
      .query('deviceCodes')
      .withIndex('by_operationId', q => q.eq('operationId', args.operationId))
      .unique();
    if (old) {
      invariant(
        (() => {
          const request = JSON.parse(old.request);
          delete request.rememberedDevice;
          return JSON.stringify(request);
        })() === args.request &&
          old.deviceHash === args.deviceHash &&
          old.userHash === args.userHash,
        'AUTH_OPERATION_CHANGED',
        'Retain the original login request.',
      );
      return old;
    }
    let known;
    if (args.deviceKey) {
      known = await ctx.db
        .query('cliCredentials')
        .withIndex('by_credentialId', q => q.eq('credentialId', args.credentialId))
        .unique();
      invariant(
        !known || known.deviceKey === args.deviceKey,
        'AUTH_REQUIRED',
        'Use the approved key for this device.',
      );
      if (known && (known.removed || !forceApproval)) return { known };
    }
    const now = Date.now();
    const limit = publicAbuseBudgets()?.deviceStartsPerMinute ?? deviceStartLimit.perMinute;
    // Reuse the bounded attempt-counter table: one point read, independent of the start rate.
    const scope = 'system:device-start';
    const recent = await ctx.db
      .query('deviceAttempts')
      .withIndex('by_owner', q => q.eq('owner', scope))
      .unique();
    const fresh = !recent || now < recent.windowAt || now - recent.windowAt >= 60_000;
    if (!fresh && recent.count >= limit) return null;
    // Expired login rows are removed a few at a time by later starts; no scheduled job runs.
    const expired = await ctx.db
      .query('deviceCodes')
      .withIndex('by_expiresAt', q => q.lte('expiresAt', now))
      .take(deviceStartLimit.cleanup);
    for (const row of expired) await ctx.db.delete(row._id);
    const collision = await ctx.db
      .query('deviceCodes')
      .withIndex('by_userHash', q => q.eq('userHash', args.userHash))
      .unique();
    invariant(!collision, 'AUTH_CODE_COLLISION', 'Retry login with a new operation.');
    const budget = {
      owner: scope,
      windowAt: fresh ? now : recent.windowAt,
      count: fresh ? 1 : recent.count + 1,
    };
    if (recent) await ctx.db.patch(recent._id, budget);
    else await ctx.db.insert('deviceAttempts', budget);
    const id = await ctx.db.insert('deviceCodes', {
      ...proposed,
      ...(args.deviceKey
        ? { request: JSON.stringify({ ...JSON.parse(args.request), rememberedDevice: Boolean(known) }) }
        : {}),
      ...(known ? { owner: known.owner } : {}),
    });
    return (await ctx.db.get(id))!;
  },
});
export const attempt = internalMutation({
  args: { owner: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { owner }) => {
    const old = await ctx.db
      .query('deviceAttempts')
      .withIndex('by_owner', q => q.eq('owner', owner))
      .unique();
    const now = Date.now(),
      fresh = !old || now - old.windowAt >= 60_000;
    if (!fresh && old.count >= 10) return false;
    const value = { owner, windowAt: fresh ? now : old.windowAt, count: fresh ? 1 : old.count + 1 };
    if (old) await ctx.db.patch(old._id, value);
    else await ctx.db.insert('deviceAttempts', value);
    return true;
  },
});
export const lookup = internalQuery({
  args: { userHash: v.string() },
  returns: v.union(deviceDocument, v.null()),
  handler: (ctx, { userHash }) =>
    ctx.db
      .query('deviceCodes')
      .withIndex('by_userHash', q => q.eq('userHash', userHash))
      .unique(),
});
export const decide = internalMutation({
  args: {
    userHash: v.optional(v.string()),
    requestId: v.optional(v.string()),
    owner: v.string(),
    approve: v.boolean(),
    operationId: v.string(),
    name: v.optional(v.string()),
    settings: v.optional(deviceSettings),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = args.requestId
      ? await ctx.db
          .query('deviceCodes')
          .withIndex('by_operationId', q => q.eq('operationId', args.requestId!))
          .unique()
      : await ctx.db
          .query('deviceCodes')
          .withIndex('by_userHash', q => q.eq('userHash', args.userHash!))
          .unique();
    invariant(
      row && row.expiresAt > Date.now(),
      'AUTH_EXPIRED',
      'This device code expired or is unavailable.',
    );
    const device = await deviceApproval(ctx, row, args.owner);
    if (args.requestId)
      invariant(
        device?.current && !device.current.removed,
        'AUTH_REQUIRED',
        'A new device needs its terminal code.',
      );
    const stable = device?.enabled === true;
    const receipt = stable
      ? await deviceOperation(ctx, args.owner, args.operationId, {
          action: 'approve',
          requestId: row.operationId,
          approve: args.approve,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.settings ? { settings: args.settings } : {}),
        })
      : null;
    if (receipt?.result) return null;
    if (row.decisionId === args.operationId) {
      invariant(
        row.owner === args.owner && (row.state !== 'denied') === args.approve,
        'AUTH_OPERATION_CHANGED',
        'Retain the approving account and original decision.',
      );
      return null;
    }
    invariant(row.state === 'pending', 'AUTH_CODE_USED', 'This device code already has a decision.');
    // An action's final session check cannot roll back this committed write.
    // Resolve the live approver inside the transaction that grants the device.
    const approver = await ctx.auth.getUserIdentity();
    invariant(
      approver && !isDeviceIdentity(approver) && approver.subject === args.owner,
      'AUTH_REQUIRED',
      'Sign in to Forge in your browser.',
    );
    let issuedAt: number | undefined;
    const credentialId = stable
      ? device!.credentialId
      : device?.foreign
        ? crypto.randomUUID()
        : row.credentialId;
    if (args.approve && stable) {
      invariant(device, 'AUTH_REQUIRED', 'Use the proposed device.');
      invariant(!device.current?.removed, 'AUTH_REVOKED', 'Approve a new key after removing a device.');
      const name = device.current?.name ?? args.name?.trim() ?? row.name;
      invariant(
        name.length > 0 && name.length <= 80,
        'BAD_ARGUMENT',
        'Use a device name of 1 to 80 characters.',
      );
      const proposal = JSON.parse(row.request) as { projectId: string };
      const settings = device.current?.settings ??
        args.settings ?? {
          source: row.scope === 'coordination' ? ('coordination' as const) : ('write' as const),
          projects: { kind: 'project' as const, projectId: proposal.projectId },
        };
      if (settings.projects.kind === 'project' && !device.current) {
        const id = ctx.db.normalizeId('hostedProjects', settings.projects.projectId);
        invariant(id, 'PROJECT_UNAVAILABLE', 'Select an available project.');
        await accessibleProject(ctx, id, args.owner);
      }
      issuedAt = Math.floor(Date.now() / 1000) * 1000;
      const value = {
        owner: args.owner,
        name,
        scope: settings.source === 'coordination' ? ('coordination' as const) : ('cli' as const),
        credentialId,
        deviceKey: row.deviceKey,
        deviceCode: `dv-${digest(row.deviceKey!).slice(0, 10)}`,
        deviceApprovedAt: device.current?.deviceApprovedAt ?? Date.now(),
        deviceLastSeen: Date.now(),
        settings,
        issuedAt,
        expiresAt: issuedAt + CLI_TOKEN_LIFETIME,
        tokenHash: '',
        revoked: false,
        renewal: { operationId: args.operationId, requestHash: receipt!.hash, issuedAt },
      };
      if (device.current) await ctx.db.patch(device.current._id, value);
      else await ctx.db.insert('cliCredentials', value);
    }
    await ctx.db.patch(row._id, {
      ...(issuedAt !== undefined ? { issuedAt } : {}),
      ...(!stable ? { deviceKey: undefined } : {}),
      ...(args.approve ? { credentialId } : {}),
      state: args.approve ? 'approved' : 'denied',
      owner: args.owner,
      decisionId: args.operationId,
    });
    if (receipt)
      await finishDeviceOperation(ctx, receipt, args.operationId, credentialId, { approved: args.approve });
    return null;
  },
});
export const poll = internalMutation({
  args: { deviceHash: v.string(), operationId: v.string() },
  returns: v.object({ status: v.string(), device: v.union(deviceDocument, v.null()) }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('deviceCodes')
      .withIndex('by_deviceHash', q => q.eq('deviceHash', args.deviceHash))
      .unique();
    const result = (status: string) => ({ status, device: null });
    if (!row || row.expiresAt <= Date.now()) return result('expired_token');
    if (row.state === 'denied') return result('access_denied');
    if (row.state === 'consumed' && row.redemptionId !== args.operationId) return result('invalid_grant');
    if (row.nextPollAt > Date.now()) return result('slow_down');
    await ctx.db.patch(row._id, { nextPollAt: Date.now() + 5000 });
    if (row.state === 'pending') return result('authorization_pending');
    const update = {
      state: 'consumed' as const,
      redemptionId: args.operationId,
      issuedAt: row.issuedAt ?? Math.floor(Date.now() / 1000) * 1000,
    };
    await ctx.db.patch(row._id, update);
    return { status: 'approved', device: { ...row, ...update } };
  },
});
export const issue = internalMutation({
  args: { ...credentialFields, signInId: v.optional(v.string()) },
  returns: credentialDocument,
  handler: async (ctx, args) => {
    const old = await ctx.db
      .query('cliCredentials')
      .withIndex('by_credentialId', q => q.eq('credentialId', args.credentialId))
      .unique();
    if (old && args.deviceKey) {
      invariant(
        old.owner === args.owner &&
          old.deviceKey === args.deviceKey &&
          !old.revoked &&
          !old.removed &&
          old.renewal?.operationId === args.signInId &&
          old.issuedAt === args.issuedAt,
        'AUTH_REVOKED',
        'This device sign-in changed before its token was returned.',
      );
      if (old.tokenHash !== args.tokenHash) await ctx.db.patch(old._id, { tokenHash: args.tokenHash });
      return { ...old, tokenHash: args.tokenHash };
    }
    if (old) {
      invariant(
        old.owner === args.owner && old.tokenHash === args.tokenHash,
        'AUTH_OPERATION_CHANGED',
        'Retain the original credential.',
      );
      invariant(!old.revoked, 'AUTH_REVOKED', 'This credential has been revoked.');
      return old;
    }
    const { signInId: _signInId, ...credential } = args;
    void _signInId;
    const id = await ctx.db.insert('cliCredentials', credential);
    return (await ctx.db.get(id))!;
  },
});
export const authorize = internalQuery({
  args: { credentialId: v.string(), owner: v.string(), scope: v.string(), signInId: v.optional(v.string()) },
  returns: credentialDocument,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('cliCredentials')
      .withIndex('by_credentialId', q => q.eq('credentialId', args.credentialId))
      .unique();
    invariant(
      currentCredential(row, args.owner, args.signInId),
      'AUTH_REVOKED',
      'Forge login expired or was revoked. Run nforge login.',
    );
    invariant(
      row.scope === 'cli' || args.scope === 'coordination',
      'AUTH_SCOPE_DENIED',
      'This credential grants coordination only.',
    );
    return row;
  },
});

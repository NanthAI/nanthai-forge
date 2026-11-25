// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, coordinationQuery, isDeviceIdentity, accountMutation } from './cliServer';
// Reviewed exception: self-revocation remains retryable after revocation and only removes
// authority (and asks sealed holders to remove the device, Gate B2 M3). Every other export uses the guarded cliServer builders.
import { mutation as revocationMutation } from './server';
import { grantEndsAt, grantStamp, keepsDeviceSettings, maySeeDeviceName } from './accessPolicy';
import { deviceOperation, finishDeviceOperation } from './deviceOperation';
import { currentCredential, deviceSettings, deviceScope, deviceApprovalExpired } from './deviceFields';
import { accessibleProject, memberProject } from './projectAuthority';
import { projectRole } from './projectRole';
import { accountFor } from './urlIdentity';
import { invariant } from '../src/errors';
import { markEndedSignIn } from './sealedSecretMarkers';
const item = v.object({
  id: v.id('cliCredentials'),
  credentialId: v.string(),
  name: v.string(),
  scope: deviceScope,
  expiresAt: v.number(),
  revoked: v.boolean(),
});
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(item),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'AUTH_REQUIRED', 'Sign in to list devices.');
    const rows = await ctx.db
      .query('cliCredentials')
      .withIndex('by_owner', q => q.eq('owner', user.subject))
      .order('desc')
      .paginate(args.paginationOpts);
    return {
      ...rows,
      page: rows.page.map(row => ({
        id: row._id,
        credentialId: row.credentialId,
        name: row.name,
        scope: row.scope,
        expiresAt: row.expiresAt,
        revoked: row.revoked,
      })),
    };
  },
});
export const revoke = revocationMutation({
  args: {
    credentialId: v.string(),
    operationId: v.string(),
    action: v.optional(v.union(v.literal('signout'), v.literal('remove'))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    const row = await ctx.db
      .query('cliCredentials')
      .withIndex('by_credentialId', q => q.eq('credentialId', args.credentialId))
      .unique();
    invariant(user && row?.owner === user.subject, 'AUTH_REQUIRED', 'Select your own device credential.');
    const fromDevice = isDeviceIdentity(user);
    invariant(
      !fromDevice || user.forgeCredential === row.credentialId,
      'AUTH_SCOPE_DENIED',
      'A CLI device can revoke itself.',
    );
    const action = args.action ?? 'signout';
    const { credentialId } = row;
    // Removal clears the key but retains the approval timestamp and its receipt history.
    const receipt =
      row.deviceKey || row.deviceApprovedAt !== undefined
        ? await deviceOperation(ctx, row.owner, args.operationId, { credentialId, action })
        : null;
    if (receipt?.result) return null;
    const keyRemoved = row.removed && !row.deviceKey;
    // Preserve the no-op reply without letting a removed CLI sign-in create a receipt.
    if (receipt && keyRemoved && fromDevice) return null;
    invariant(
      !row.deviceKey || !fromDevice || currentCredential(row, user.subject, user.forgeSignIn),
      'AUTH_REVOKED',
      'This device sign-in ended. Retry the original sign-out operation or sign in again.',
    );
    const keep = keepsDeviceSettings(action);
    if (!receipt || !keyRemoved) {
      await ctx.db.patch(row._id, {
        revoked: true,
        ...(!keep
          ? {
              removed: true,
              name: '',
              settings: undefined,
              grant: undefined,
              deviceKey: undefined,
              deviceCode: undefined,
              sealed: undefined,
            }
          : {}),
      });
      // Gate B2 M3: a sign-in ended from elsewhere (a lost laptop) or removed marks its sealed device in each
      // project it wrote or joined in. `nforge logout` on the device itself keeps it: the person holds the device.
      if (row.sealed && (!fromDevice || action === 'remove'))
        await markEndedSignIn(ctx, row.owner, row.sealed);
    }
    if (receipt) await finishDeviceOperation(ctx, receipt, args.operationId, credentialId, { ended: action });
    return null;
  },
});
export const rename = accountMutation('same')({
  args: {
    credentialId: v.string(),
    name: v.string(),
    operationId: v.string(),
    settings: v.optional(deviceSettings),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await ctx.auth.getUserIdentity();
    const row = await ctx.db
      .query('cliCredentials')
      .withIndex('by_credentialId', q => q.eq('credentialId', args.credentialId))
      .unique();
    invariant(user && row?.owner === user.subject, 'AUTH_REQUIRED', 'Select your own device credential.');
    invariant(
      !isDeviceIdentity(user) || user.forgeCredential === row.credentialId,
      'AUTH_SCOPE_DENIED',
      'A CLI device can rename itself.',
    );
    const name = args.name.trim();
    invariant(
      name.length > 0 && name.length <= 80,
      'BAD_ARGUMENT',
      'Use a device name of 1 to 80 characters.',
    );
    invariant(!row.removed, 'AUTH_REVOKED', 'This device was removed. Approve a new key to use it again.');
    invariant(
      !args.settings || (!isDeviceIdentity(user) && Boolean(row.deviceKey)),
      'AUTH_SCOPE_DENIED',
      'Change settings for an approved device key from your Forge browser.',
    );
    const receipt = row.deviceKey
      ? await deviceOperation(ctx, row.owner, args.operationId, {
          action: 'configure',
          credentialId: row.credentialId,
          name,
          ...(args.settings ? { settings: args.settings } : {}),
        })
      : null;
    if (receipt?.result) return null;
    // Saving settings in the browser gives a folder grant again; settings without paths end it.
    const stamp = args.settings ? grantStamp(args.settings) : {};
    if (args.settings?.projects.kind === 'project') {
      const id = ctx.db.normalizeId('hostedProjects', args.settings.projects.projectId);
      invariant(id, 'PROJECT_UNAVAILABLE', 'Select an available project.');
      await accessibleProject(ctx, id, row.owner);
    }
    if (row.name !== name || args.settings)
      await ctx.db.patch(row._id, {
        name,
        ...(args.settings
          ? {
              settings: args.settings,
              ...stamp,
              scope: args.settings.source === 'coordination' ? ('coordination' as const) : ('cli' as const),
            }
          : {}),
      });
    if (receipt)
      await finishDeviceOperation(ctx, receipt, args.operationId, row.credentialId, { configured: true });
    return null;
  },
});
export const status = coordinationQuery({
  args: {},
  // The account is named by its Forge handle; the auth subject never leaves the deployment.
  returns: v.object({
    handle: v.union(v.string(), v.null()),
    credentialId: v.union(v.string(), v.null()),
    /** The account still has to pick or keep its handle once. */
    pick: v.optional(v.literal(true)),
    device: v.optional(
      v.object({
        id: v.string(),
        code: v.string(),
        name: v.string(),
        approvedAt: v.number(),
        expiresAt: v.number(),
        settings: deviceSettings,
        /** A folder grant's end: 7 days after its last write or 30 days after it was given. */
        grantEndsAt: v.optional(v.number()),
      }),
    ),
  }),
  handler: async ctx => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'AUTH_REQUIRED', 'Sign in to Forge.');
    const device = ctx.forgeDevice;
    return {
      ...(device?.deviceCode && device.deviceApprovedAt !== undefined && device.settings
        ? {
            device: {
              id: device.credentialId,
              code: device.deviceCode,
              name: device.name,
              approvedAt: device.deviceApprovedAt,
              expiresAt: device.expiresAt,
              settings: device.settings,
              ...(device.settings.paths && device.grant ? { grantEndsAt: grantEndsAt(device.grant) } : {}),
            },
          }
        : {}),
      ...(await (async () => {
        const account = await accountFor(ctx, user.subject);
        return { handle: account?.handle ?? null, ...(account?.handlePrompt ? { pick: true as const } : {}) };
      })()),
      credentialId: typeof user.forgeCredential === 'string' ? user.forgeCredential : null,
    };
  },
});

/** Folded devices for one roster person: one indexed account page, never one RPC per device. */
export const project = coordinationQuery({
  args: { projectId: v.id('hostedProjects'), person: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      id: v.string(),
      code: v.string(),
      approvedAt: v.number(),
      name: v.optional(v.string()),
      state: v.union(
        v.literal('signed-in'),
        v.literal('signed-out'),
        v.literal('expired'),
        v.literal('removed'),
      ),
    }),
  ),
  handler: async (ctx, input) => {
    const viewer = await ctx.auth.getUserIdentity();
    invariant(viewer, 'PROJECT_UNAVAILABLE', 'Sign in to see project devices.');
    const selected = await memberProject(ctx, input.projectId, viewer.subject);
    invariant(
      await projectRole(ctx, selected, input.person),
      'PROJECT_UNAVAILABLE',
      'This person is unavailable in this project.',
    );
    const page = await ctx.db
      .query('cliCredentials')
      .withIndex('by_owner', q => q.eq('owner', input.person))
      .order('desc')
      .paginate({
        ...input.paginationOpts,
        numItems: Math.min(input.paginationOpts.numItems, 25),
        maximumRowsRead: 100,
        maximumBytesRead: 64 * 1024,
      });
    return {
      ...page,
      page: page.page.flatMap(row =>
        row.deviceCode &&
        row.deviceApprovedAt !== undefined &&
        (row.settings?.projects.kind === 'all' || row.settings?.projects.projectId === input.projectId)
          ? [
              {
                id: row.credentialId,
                code: row.deviceCode,
                approvedAt: row.deviceApprovedAt,
                ...(maySeeDeviceName(viewer.subject, row.owner) ? { name: row.name } : {}),
                state: row.removed
                  ? ('removed' as const)
                  : row.revoked
                    ? ('signed-out' as const)
                    : row.expiresAt <= Date.now() || deviceApprovalExpired(row)
                      ? ('expired' as const)
                      : ('signed-in' as const),
              },
            ]
          : [],
      ),
    };
  },
});

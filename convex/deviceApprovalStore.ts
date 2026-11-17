// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery } from './server';
import { freshDeviceApproval } from './authDeviceFresh';
import { deviceApprovalExpired } from './deviceFields';
import { deviceApproval } from './deviceApproval';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
/** One account-authorized projection replaces the old code lookup, without another RPC. */
export const inspect = internalQuery({
  args: { userHash: v.optional(v.string()), requestId: v.optional(v.string()), owner: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const row = input.requestId
      ? await ctx.db
          .query('deviceCodes')
          .withIndex('by_operationId', q => q.eq('operationId', input.requestId!))
          .unique()
      : await ctx.db
          .query('deviceCodes')
          .withIndex('by_userHash', q => q.eq('userHash', input.userHash!))
          .unique();
    invariant(
      row && row.expiresAt > Date.now(),
      'AUTH_EXPIRED',
      'This device code expired or is unavailable.',
    );
    const device = await deviceApproval(ctx, row, input.owner);
    if (input.requestId && !device?.current) return JSON.stringify({ needsCode: true });
    const proposal = JSON.parse(row.request) as { projectId?: string };
    const current = device?.current;
    if (current?.removed)
      return JSON.stringify({
        name: current.name,
        scope: current.scope,
        expiresAt: row.expiresAt,
        state: 'removed',
      });
    const identity = await ctx.auth.getUserIdentity();
    return JSON.stringify({
      ...(device?.enabled &&
      (!current || deviceApprovalExpired(current)) &&
      !freshDeviceApproval(identity ?? {})
        ? { needsConfirmation: true }
        : {}),
      name: current?.name ?? row.name,
      scope: current?.scope ?? row.scope,
      expiresAt: row.expiresAt,
      state: current?.removed ? 'removed' : row.state,
      ...(device?.enabled
        ? {
            device: {
              id: row.credentialId,
              code: `dv-${digest(row.deviceKey!).slice(0, 10)}`,
              known: Boolean(current),
              approvedAt: current?.deviceApprovedAt ?? null,
              settings: current?.settings ?? {
                source: row.scope === 'coordination' ? 'coordination' : 'write',
                projects: { kind: 'project', projectId: proposal.projectId },
              },
              projectName: device.projectName,
            },
          }
        : {}),
    });
  },
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalQuery } from './server';
import type { QueryCtx } from './_generated/server';
import type { UserIdentity } from 'convex/server';
import { freshDeviceApproval } from './authDeviceFresh';
import { deviceApprovalExpired } from './deviceFields';
import { deviceApproval } from './deviceApproval';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { currentSweep } from './sealedSecretMarkers';
/** The signed-in account has a linked, unconflicted GitHub identity (one indexed read). */
export async function linkedGithub(ctx: QueryCtx, identity: UserIdentity | null) {
  const id =
    typeof identity?.forgeAuthUser === 'string' ? ctx.db.normalizeId('users', identity.forgeAuthUser) : null;
  const user = id && (await ctx.db.get(id));
  return Boolean(user?.githubId && !user.githubConflict);
}
/** The approving browser's account row (one read), as deviceStore.decide resolves it. */
async function browserAccount(ctx: QueryCtx, identity: UserIdentity, owner: string) {
  const id =
    typeof identity.forgeAuthUser === 'string' ? ctx.db.normalizeId('users', identity.forgeAuthUser) : null;
  const user = id
    ? await ctx.db.get(id)
    : await ctx.db
        .query('users')
        .withIndex('by_accountKey', q => q.eq('accountKey', owner))
        .unique();
  return user?.accountKey === owner ? user : null;
}
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
    // Sole-owner follow-up: one account read, only for a known device with sealed links.
    const sealedKeep = Boolean(
      current?.sealed?.length &&
      typeof identity?.forgeAuthSession === 'string' &&
      currentSweep(await browserAccount(ctx, identity, input.owner))?.sessionId === identity.forgeAuthSession,
    );
    // A known device signs in again without a check, but only a checked approval clears its mark: ask for one.
    const needsConfirmation =
      device?.enabled &&
      (!current || deviceApprovalExpired(current) || sealedKeep) &&
      !freshDeviceApproval(identity ?? {});
    return JSON.stringify({
      // The GitHub check is offered only to an account with a linked GitHub identity (one read, only here).
      ...(needsConfirmation ? { needsConfirmation: true, github: await linkedGithub(ctx, identity) } : {}),
      ...(sealedKeep ? { sealedKeep: true } : {}),
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

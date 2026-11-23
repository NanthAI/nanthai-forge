// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './server';
import { publicAbuseBudgets } from './publicAbuseBudgets';
/** Login starts and renewals share the owner-approved deployment budget. */
export const deviceStartLimit = { perMinute: 120, cleanup: 4 };
export async function takeDeviceBudget(ctx: MutationCtx) {
  const now = Date.now(),
    scope = 'system:device-start';
  const recent = await ctx.db
    .query('deviceAttempts')
    .withIndex('by_owner', q => q.eq('owner', scope))
    .unique();
  const fresh = !recent || now < recent.windowAt || now - recent.windowAt >= 60_000;
  if (!fresh && recent.count >= (publicAbuseBudgets()?.deviceStartsPerMinute ?? deviceStartLimit.perMinute))
    return false;
  const value = {
    owner: scope,
    windowAt: fresh ? now : recent.windowAt,
    count: fresh ? 1 : recent.count + 1,
  };
  if (recent) await ctx.db.patch(recent._id, value);
  else await ctx.db.insert('deviceAttempts', value);
  return true;
}

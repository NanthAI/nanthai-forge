// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ConvexError } from 'convex/values';
import type { MutationCtx } from './server';

/** Interim passkey budgets; admission policy remains the phase 8 owner decision.
 * Two rows, reset on demand. Visitors share the global allowance, including autofill.
 * The global count also bounds the exact per-handle list, with no hash collisions. */
export const PASSKEY_BUDGET = {
  windowMs: 60_000,
  starts: { global: 120, handle: 6 },
  signups: { global: 20, handle: 3 },
} as const;

export async function chargePasskey(
  ctx: MutationCtx,
  kind: 'starts' | 'signups',
  handle?: string,
  now = Date.now(),
) {
  const owner = `system:passkey-${kind}`;
  const row = await ctx.db
    .query('deviceAttempts')
    .withIndex('by_owner', q => q.eq('owner', owner))
    .unique();
  const windowAt = now - (now % PASSKEY_BUDGET.windowMs);
  const current = row?.windowAt === windowAt;
  const count = current ? row.count : 0;
  const handles = current ? [...(row.handles ?? [])] : [];
  const index = handle === undefined ? -1 : handles.findIndex(value => value.handle === handle);
  const used = index < 0 ? 0 : handles[index]!.count;
  const limit = PASSKEY_BUDGET[kind];
  if (count >= limit.global || (handle !== undefined && used >= limit.handle))
    throw new ConvexError({
      code: 'RATE_LIMITED',
      message: 'Too many passkey attempts. Try again in a minute.',
      retryAt: windowAt + PASSKEY_BUDGET.windowMs,
    });
  if (handle !== undefined) {
    if (index < 0) handles.push({ handle, count: 1 });
    else handles[index] = { handle, count: used + 1 };
  }
  const next = { owner, windowAt, count: count + 1, handles };
  if (row) await ctx.db.patch(row._id, next);
  else await ctx.db.insert('deviceAttempts', next);
}

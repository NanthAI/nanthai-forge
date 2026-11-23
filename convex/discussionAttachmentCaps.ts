// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { invariant } from '../src/errors';
import { attachmentDownloadCaps, keepDays, usageDay, usageRow } from './gitServeWorkerStore';
import { internalMutation } from './server';

/** Daily download egress caps for discussion attachments (Issue 9a3d6f5f). One mutation checks
 * and reserves the bytes before R2 is read, so two downloads racing for the last bytes cannot
 * both pass: Convex runs the mutations one after the other. Counters are `gitWorkerUsage`
 * rows keyed by UTC day under an `attachments:` scope, so the day rolling over starts a fresh
 * row, with no cron and no sweep; a new row deletes at most two of its scope's rows older than
 * a week. `packs` counts downloads.
 *
 * Reservations are not leases, on purpose: a lease would need a row per download and a sweep.
 * A reservation is given back only by the handler that made it (one `release` per failed read,
 * never replayed). It stays counted when the action is killed or the client drops before the
 * handler reaches its `finally`, when the refund itself fails, and in the short window where
 * access is revoked between the first resolve and the reservation (the second resolve then
 * refunds it). Each errs toward the cap until 00:00 UTC, costing one download's bytes per leak, and
 * never toward unbilled egress. The R2 read stops after 30 s, so a stalled read refunds itself. */
const scopeOf = (scope: string) => `attachments:${scope}`;

const label = (bytes: number) => `${bytes / 1_000_000_000} GB`;

/** The cap a download of `bytes` would pass: this project first, then all projects. */
function overCap(used: { project: number; all: number }, bytes: number) {
  for (const scope of ['project', 'all'] as const) {
    const cap = attachmentDownloadCaps[scope];
    if (used[scope] + bytes > cap)
      return `Forge's daily attachment download limit for ${scope === 'project' ? 'this project' : 'all projects'} (${label(cap)}) is used up. Downloads resume at 00:00 UTC.`;
  }
  return null;
}

export const reserve = internalMutation({
  args: { projectId: v.id('hostedProjects'), bytes: v.number() },
  returns: v.union(
    v.object({ granted: v.literal(true), day: v.string() }),
    v.object({ granted: v.literal(false), message: v.string(), retryAfterSeconds: v.number() }),
  ),
  handler: async (ctx, { projectId, bytes }) => {
    invariant(
      Number.isSafeInteger(bytes) && bytes >= 0,
      'BAD_ARGUMENT',
      'Reserve the exact attachment byte count.',
    );
    const now = Date.now();
    const day = usageDay(now);
    const scopes = [scopeOf(projectId), scopeOf('*')] as const;
    const [project, all] = await Promise.all(scopes.map(scope => usageRow(ctx, scope, day)));
    const message = overCap({ project: project?.bytes ?? 0, all: all?.bytes ?? 0 }, bytes);
    if (message) {
      const midnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
      return { granted: false as const, message, retryAfterSeconds: Math.ceil((midnight - now) / 1000) };
    }
    for (const [scope, row] of [
      [scopes[0], project],
      [scopes[1], all],
    ] as const) {
      if (row) await ctx.db.patch(row._id, { packs: row.packs + 1, bytes: row.bytes + bytes });
      else {
        await ctx.db.insert('gitWorkerUsage', { scope, day, packs: 1, bytes });
        const cutoff = usageDay(now - keepDays * 86_400_000);
        const old = await ctx.db
          .query('gitWorkerUsage')
          .withIndex('by_scope_and_day', q => q.eq('scope', scope).lt('day', cutoff))
          .take(2);
        for (const stale of old) await ctx.db.delete(stale._id);
      }
    }
    return { granted: true as const, day };
  },
});

/** Gives a reservation back when no bytes were served: a failed or mismatched R2 read, or
 * access revoked while the bytes were in flight. `day` is the reserved day, so a download
 * that crossed 00:00 UTC refunds the row it charged. */
export const release = internalMutation({
  args: { projectId: v.id('hostedProjects'), day: v.string(), bytes: v.number() },
  returns: v.null(),
  handler: async (ctx, { projectId, day, bytes }) => {
    invariant(
      Number.isSafeInteger(bytes) && bytes >= 0,
      'BAD_ARGUMENT',
      'Release the exact attachment byte count.',
    );
    for (const scope of [scopeOf(projectId), scopeOf('*')]) {
      const row = await usageRow(ctx, scope, day);
      if (row)
        await ctx.db.patch(row._id, {
          packs: Math.max(0, row.packs - 1),
          bytes: Math.max(0, row.bytes - bytes),
        });
    }
    return null;
  },
});

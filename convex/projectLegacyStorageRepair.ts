// SPDX-License-Identifier: Apache-2.0
// Bounded, owner-scoped repair for R2-native project objects: rows inserted
// already committed to R2 (location r2, r2Committed, a legacy storageId) never
// went through the backfill flip, so r2BackfilledAt is unset and cleanup refuses
// them (OWNER_BACKFILL_UNSET). After the operator re-hashes the R2 copy, this
// records the verification time as the backfill time. It never deletes or moves
// bytes, and it is an ordinary paused write (refused during a cleanup pause).
import { internalMutation, internalQuery } from './server';
import type { QueryCtx } from './server';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { activeOwnedProject } from './projectAuthority';
import { storageDigest } from './storageDigest';
import { recentCleanup as recent } from './legacyStorageReceipts';
import { invariant } from '../src/errors';

const repairRow = v.object({
  id: v.id('projectObjects'),
  storageId: v.id('_storage'),
  digest: v.string(),
  size: v.number(),
  /** When the operator re-hashed the full R2 copy against `digest`. */
  r2VerifiedAt: v.string(),
});
const scope = { projectId: v.id('hostedProjects'), actor: v.string(), rows: v.array(repairRow) };
const outcome = v.array(v.object({ id: v.string(), code: v.union(v.string(), v.null()) }));
type Row = {
  id: Id<'projectObjects'>;
  storageId: Id<'_storage'>;
  digest: string;
  size: number;
  r2VerifiedAt: string;
};

async function repairCode(ctx: QueryCtx, projectId: Id<'hostedProjects'>, pin: Row) {
  const [row, file] = await Promise.all([ctx.db.get(pin.id), ctx.db.system.get(pin.storageId)]);
  if (!row || row.projectId !== projectId) return 'OUT_OF_SCOPE';
  if (
    row.storageId !== pin.storageId ||
    row.digest !== pin.digest ||
    row.size !== pin.size ||
    row.location !== 'r2' ||
    !row.r2Committed ||
    row.r2ConvexPurged ||
    row.r2Key !== `v1/p/${projectId}/o/${pin.digest}`
  )
    return 'ROW_CHANGED';
  if (!file || file.size !== pin.size || storageDigest(file.sha256) !== pin.digest) return 'FILE_CHANGED';
  const verifiedAt = Date.parse(pin.r2VerifiedAt);
  // The R2 hash must be fresh and later than the row, so the copy it proves existed.
  if (!recent(pin.r2VerifiedAt, row._creationTime, 10 * 60_000)) return 'R2_VERIFY_REQUIRED';
  if (row.r2BackfilledAt !== undefined)
    return row.r2BackfilledAt <= verifiedAt ? 'ALREADY_SET' : 'ROW_CHANGED';
  return null;
}
async function check(ctx: QueryCtx, args: { projectId: Id<'hostedProjects'>; actor: string; rows: Row[] }) {
  await activeOwnedProject(ctx, args.projectId, args.actor);
  invariant(
    args.rows.length > 0 &&
      args.rows.length <= 100 &&
      new Set(args.rows.map(r => r.id)).size === args.rows.length,
    'BAD_ARGUMENT',
    'Repair at most 100 unique rows of one project.',
  );
  const codes = [];
  for (const row of args.rows) codes.push({ id: row.id, code: await repairCode(ctx, args.projectId, row) });
  return codes;
}
/** Dry run: the exact checks apply makes, no writes. */
export const plan = internalQuery({ args: scope, returns: outcome, handler: check });
/** Patches only rows whose check passed (code null); everything else is reported. */
export const apply = internalMutation({
  args: { ...scope, operationId: v.string() },
  returns: outcome,
  handler: async (ctx, args) => {
    const codes = await check(ctx, args);
    for (const [index, { code }] of codes.entries()) {
      if (code) continue;
      const row = args.rows[index]!;
      await ctx.db.patch(row.id, {
        r2BackfilledAt: Date.parse(row.r2VerifiedAt),
        r2BackfillOperationId: args.operationId,
      });
    }
    return codes;
  },
});

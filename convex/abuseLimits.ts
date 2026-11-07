// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { ForgeError } from '../src/errors';

const minute = 60_000,
  MiB = 1024 ** 2,
  GiB = 1024 ** 3;

/** Signed-out reads and signing on one public project (Issue a91b9b69). Convex does not
 * expose a client address, so signed-out callers share one budget per public project;
 * signed-in callers are never counted. Proposed defaults, pending owner approval. */
export const ANONYMOUS_READ_BUDGET = { windowMs: minute, calls: 600, shards: 4 } as const;

/** Reserved storage (Issue a91b9b69). Counted when a new object is reserved, from the
 * first reservation after this change. Proposed defaults, pending owner approval. */
export const STORAGE_QUOTA = {
  objectBytes: 1 * GiB,
  project: { bytes: 200 * GiB, objects: 4_000_000 },
  account: { bytes: 500 * GiB, objects: 10_000_000 },
  shards: 8,
  /** A project shard adds its new usage to the account total once it reaches this, so the
   * account check costs one read and one write per roll-up rather than per batch. */
  rollup: { objects: 1_000, bytes: 256 * MiB },
} as const;

const pickShard = (shards: number) => Math.min(shards - 1, Math.floor(Math.random() * shards));
const share = (total: number, shards: number) => Math.ceil(total / shards);
const gib = (bytes: number) => `${Math.round(bytes / GiB)} GiB`;

/** One point read and one write on a random shard; signed-in callers cost nothing.
 * Over budget it throws RATE_LIMITED and the calling mutation writes and signs nothing. */
export async function chargeAnonymousRead(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  now = Date.now(),
) {
  if (await ctx.auth.getUserIdentity()) return;
  const { windowMs, calls, shards } = ANONYMOUS_READ_BUDGET;
  const shard = pickShard(shards),
    windowStart = now - (now % windowMs);
  const row = await ctx.db
    .query('projectReadBudgets')
    .withIndex('by_project_and_shard', q => q.eq('projectId', projectId).eq('shard', shard))
    .unique();
  const current = row?.windowStart === windowStart;
  if (current && row.count >= share(calls, shards)) {
    const retryAt = windowStart + windowMs;
    throw new ForgeError(
      'RATE_LIMITED',
      `Signed-out reads of this public project are at their limit. Sign in (nforge login) or retry after ${Math.max(1, Math.ceil((retryAt - now) / 1000))} s.`,
      retryAt,
    );
  }
  if (!row) await ctx.db.insert('projectReadBudgets', { projectId, shard, windowStart, count: 1 });
  else await ctx.db.patch(row._id, current ? { count: row.count + 1 } : { windowStart, count: 1 });
}

/** Refuses one new object over the per-object size limit before anything is reserved. */
export function checkObjectSize(size: number) {
  if (size > STORAGE_QUOTA.objectBytes)
    throw new ForgeError(
      'QUOTA_EXCEEDED',
      `A stored object can be at most ${gib(STORAGE_QUOTA.objectBytes)}; this one is ${size} bytes.`,
    );
}

type Usage = { objects: number; bytes: number };
function overQuota(scope: string, used: Usage, add: Usage, cap: Usage, shards = 1) {
  if (
    used.objects + add.objects > share(cap.objects, shards) ||
    used.bytes + add.bytes > share(cap.bytes, shards)
  )
    throw new ForgeError(
      'QUOTA_EXCEEDED',
      `This ${scope} has reached its storage quota (${gib(cap.bytes)} or ${cap.objects.toLocaleString('en-US')} objects). Nothing was reserved.`,
    );
}

/** Charges newly reserved objects to the project: one point read and one write on a random
 * shard, only when the batch reserves something. Every `rollup` of new usage the shard also
 * adds its pending part to the owner's account total (one more read and write) and checks
 * the account quota. Over a quota it throws QUOTA_EXCEEDED and the calling mutation
 * reserves nothing. */
export async function chargeStorage(
  ctx: MutationCtx,
  project: Pick<Doc<'hostedProjects'>, '_id' | 'owner'>,
  sizes: number[],
) {
  if (!sizes.length) return;
  const add = { objects: sizes.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
  const { shards, rollup } = STORAGE_QUOTA;
  const shard = pickShard(shards);
  const row = await ctx.db
    .query('projectStorageUsage')
    .withIndex('by_project_and_shard', q => q.eq('projectId', project._id).eq('shard', shard))
    .unique();
  overQuota('project', row ?? { objects: 0, bytes: 0 }, add, STORAGE_QUOTA.project, shards);
  let pending = {
    objects: (row?.pendingObjects ?? 0) + add.objects,
    bytes: (row?.pendingBytes ?? 0) + add.bytes,
  };
  if (pending.objects >= rollup.objects || pending.bytes >= rollup.bytes) {
    const account = await ctx.db
      .query('accountStorageUsage')
      .withIndex('by_account', q => q.eq('account', project.owner))
      .unique();
    overQuota('account', account ?? { objects: 0, bytes: 0 }, pending, STORAGE_QUOTA.account);
    const total = {
      objects: (account?.objects ?? 0) + pending.objects,
      bytes: (account?.bytes ?? 0) + pending.bytes,
    };
    if (account) await ctx.db.patch(account._id, total);
    else await ctx.db.insert('accountStorageUsage', { account: project.owner, ...total });
    pending = { objects: 0, bytes: 0 };
  }
  const next = {
    objects: (row?.objects ?? 0) + add.objects,
    bytes: (row?.bytes ?? 0) + add.bytes,
    pendingObjects: pending.objects,
    pendingBytes: pending.bytes,
  };
  if (row) await ctx.db.patch(row._id, next);
  else await ctx.db.insert('projectStorageUsage', { projectId: project._id, shard, ...next });
}

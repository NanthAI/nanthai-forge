// SPDX-License-Identifier: Apache-2.0
// Loose ends details (Item fc1831eb): the stored size a leftover-projects row shows, kept on the project's existing
// live-line summary row (`size`). It is the sum of the project's projectStorageUsage shards, measured when the summary
// row is already being written by a Lane's set-aside (at most once per SIZE_REFRESH_MS) and by the one-time backfill.
// A Lane start does not write it (concurrent starts must not contend on a shared row, tests/hosted-lanes.test.mjs) and a
// landing reads no shards (the landing cost guard holds its reads), so a size is as of its last measurement and says
// so by its time; a project never measured says "not recorded". Nothing here is guessed.
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { STORAGE_QUOTA } from './abuseLimits';

type Db = MutationCtx['db'];
export type OpenSummary = { size?: { bytes: number; at: number } };
/** A size read costs one indexed range of at most STORAGE_QUOTA.shards rows, so it is read at most this often. */
const SIZE_REFRESH_MS = 10 * 60_000;

export async function projectBytes(db: Pick<Db, 'query'>, projectId: Id<'hostedProjects'>) {
  const shards = await db
    .query('projectStorageUsage')
    .withIndex('by_project_and_shard', q => q.eq('projectId', projectId))
    .take(STORAGE_QUOTA.shards);
  return shards.reduce((sum, shard) => sum + shard.bytes, 0);
}

/** Re-measure the size when it is missing or older than SIZE_REFRESH_MS. Mutates `value`, which the caller writes. */
export async function measureSize(
  db: Pick<Db, 'query'>,
  projectId: Id<'hostedProjects'>,
  value: OpenSummary,
  now: number,
) {
  if (value.size && now - value.size.at < SIZE_REFRESH_MS) return;
  value.size = { bytes: await projectBytes(db, projectId), at: now };
}

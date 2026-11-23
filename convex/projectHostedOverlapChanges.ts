// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './server';
import { byPath, type OverlapChange } from '../src/hosted-overlap';

/** Saved change evidence of a Lane, split by path hash (Item 411727ba, Fable verdict dc29dc4f).
 * A row of projectHostedOverlapLanes either holds the whole JSON list inline (`changes`) or is slim
 * and its entries live in up to OVERLAP_BUCKETS rows of projectHostedOverlapChanges. A reader that needs one
 * path reads one bucket row (~2 KB for a sweep-size Lane) instead of every peer's whole list (~131 KB). */
export const OVERLAP_BUCKETS = 64;
/** Few distinct buckets are read one by one; beyond this the whole range is one cheaper read. */
const POINT_READ_BUCKETS = 16;

/** Switch FORGE_OVERLAP_CHANGE_BUCKETS (off by default): the Lane record write stores slim rows and bucket rows.
 * Readers accept both forms at all times, so turning it off again stays safe: the next write of a Lane
 * stores the inline form and deletes its bucket rows. */
export const overlapBucketsOn = () => process.env.FORGE_OVERLAP_CHANGE_BUCKETS === '1';

/** FNV-1a over the path's UTF-16 units: stable on every runtime, no async digest. */
export function overlapBucket(path: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index++) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % OVERLAP_BUCKETS;
}

/** Entries as `boundOverlapChanges` produced them, grouped by bucket; each group keeps the list's order. */
export function splitOverlapChanges(changes: string) {
  const groups = new Map<number, OverlapChange[]>();
  for (const change of JSON.parse(changes) as OverlapChange[]) {
    const bucket = overlapBucket(change.path);
    groups.set(bucket, [...(groups.get(bucket) ?? []), change]);
  }
  return new Map([...groups].map(([bucket, entries]) => [bucket, JSON.stringify(entries)] as const));
}

/** The whole list a Lane's buckets hold: same entries, same sort as `mergeOverlapChanges` leaves them. */
export function joinOverlapBuckets(buckets: readonly string[]) {
  return JSON.stringify(buckets.flatMap(bucket => JSON.parse(bucket) as OverlapChange[]).sort(byPath));
}

/** The entries of a list whose path is in `paths`, in list order. */
export const filterOverlapEntries = (changes: string, paths: ReadonlySet<string>) =>
  JSON.stringify((JSON.parse(changes) as OverlapChange[]).filter(change => paths.has(change.path)));

type Reader = { db: QueryCtx['db'] };
type Lane = Pick<Doc<'projectHostedOverlapLanes'>, 'projectId' | 'laneId' | 'changes'>;

/** A Lane's bucket rows, at most OVERLAP_BUCKETS (one indexed range). */
export const overlapBucketRows = (ctx: Reader, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectHostedOverlapChanges')
    .withIndex('by_project_and_lane_and_bucket', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .take(OVERLAP_BUCKETS);

/** The Lane's whole saved change list as the JSON string the inline form holds. */
export async function overlapLaneChanges(ctx: Reader, row: Lane): Promise<string> {
  if (row.changes !== undefined) return row.changes;
  return joinOverlapBuckets(
    (await overlapBucketRows(ctx, row.projectId, row.laneId)).map(bucket => bucket.changes),
  );
}

/** The entries of the Lane whose path is in `paths`, in list order, as a JSON string. Inline rows are
 * filtered in memory; bucketed rows read only the buckets those paths hash to. */
export async function overlapLaneEntries(
  ctx: Reader,
  row: Lane,
  paths: ReadonlySet<string>,
): Promise<string> {
  if (row.changes !== undefined) return filterOverlapEntries(row.changes, paths);
  const wanted = [...new Set([...paths].map(overlapBucket))];
  const parts =
    wanted.length > POINT_READ_BUCKETS
      ? (await overlapBucketRows(ctx, row.projectId, row.laneId)).map(bucket => bucket.changes)
      : (
          await Promise.all(
            wanted.map(bucket =>
              ctx.db
                .query('projectHostedOverlapChanges')
                .withIndex('by_project_and_lane_and_bucket', q =>
                  q.eq('projectId', row.projectId).eq('laneId', row.laneId).eq('bucket', bucket),
                )
                .unique(),
            ),
          )
        ).flatMap(bucket => (bucket ? [bucket.changes] : []));
  return filterOverlapEntries(joinOverlapBuckets(parts), paths);
}

/** True when any entry carries usable cross-file symbol links: only then can a peer's other entries
 * produce a cross-file note, so only then does a default read need the peer's whole list. */
export const hasSymbolFacts = (changes: string) =>
  (JSON.parse(changes) as OverlapChange[]).some(
    change => change.evidence?.symbolLinks && !('unavailable' in change.evidence.symbolLinks),
  );

/** Replaces a Lane's bucket rows with `changes`: writes only the buckets whose text differs, inserts new
 * ones and deletes the ones that emptied. `current` are the rows already read (or null to read them). */
export async function writeOverlapBuckets(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  changes: string,
  current?: Doc<'projectHostedOverlapChanges'>[],
) {
  const rows = current ?? (await overlapBucketRows(ctx, projectId, laneId));
  const next = splitOverlapChanges(changes);
  const known = new Map(rows.map(row => [row.bucket, row]));
  for (const [bucket, text] of next) {
    const row = known.get(bucket);
    if (!row)
      await ctx.db.insert('projectHostedOverlapChanges', { projectId, laneId, bucket, changes: text });
    else if (row.changes !== text) await ctx.db.patch(row._id, { changes: text });
  }
  for (const [bucket, row] of known) if (!next.has(bucket)) await ctx.db.delete(row._id);
}

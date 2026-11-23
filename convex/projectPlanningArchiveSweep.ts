// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { stream } from 'convex-helpers/server/stream';
import schema from './schema';
import {
  archivedSegmentRows,
  archivedTargetPage,
  archiveIndexPageSize,
  type ArchiveTarget,
  type TargetCursor,
} from './projectPlanningArchiveIndex';

type Cursor = TargetCursor & { records?: true };
type Targets = { ids: string[]; intentKeys: string[] };
type RecordTarget = { kind: Exclude<ArchiveTarget['kind'], 'events'>; itemId: string };
const initial: Cursor = { target: 0, after: null };

function recordTargets({ ids, intentKeys }: Targets): RecordTarget[] {
  return [
    ...intentKeys.map(itemId => ({ kind: 'intent' as const, itemId })),
    ...ids.map(itemId => ({ kind: 'issue' as const, itemId })),
    ...[...new Set([...ids, ...intentKeys])].flatMap(itemId => [
      { kind: 'comment' as const, itemId },
      { kind: 'lifecycle' as const, itemId },
    ]),
  ];
}

/** Stable target order plus the actual page cursor, so tied index positions cannot hide a version. */
export async function indexedSweepPage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  targets: Targets,
  after: string | null,
) {
  const records = recordTargets(targets);
  let cursor: Cursor = after === null ? initial : JSON.parse(after);
  const keys: string[] = [];
  if (!cursor.records) {
    const legacy: ArchiveTarget[] = [
      ...targets.ids.map(itemId => ({ kind: 'events' as const, itemId })),
      ...records,
    ];
    const page = await archivedTargetPage(ctx, projectId, legacy, cursor, true);
    keys.push(...page.keys);
    cursor = page.done ? { ...initial, records: true } : page.next;
    if (!page.done)
      return {
        entries: await archivedSegmentRows(ctx, projectId, keys),
        after: JSON.stringify(cursor),
        done: false,
      };
  }
  let target = cursor.target;
  let next = cursor.after;
  let remaining = archiveIndexPageSize - keys.length;
  let bytes = 256 * 1024;
  const db = stream(ctx.db, schema);
  for (
    let reads = 0;
    reads < archiveIndexPageSize && remaining > 0 && bytes > 0 && target < records.length;
    reads++
  ) {
    const { kind, itemId } = records[target]!;
    const source = db.query('projectHostedRecords');
    const page = await (
      kind === 'issue' || kind === 'intent'
        ? source.withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
            q.eq('projectId', projectId).eq('kind', kind).eq('key', itemId),
          )
        : source.withIndex('by_project_and_kind_and_parent', q =>
            q.eq('projectId', projectId).eq('kind', kind).eq('parent', itemId),
          )
    ).paginate({
      cursor: next,
      numItems: remaining,
      maximumRowsRead: remaining,
      maximumBytesRead: bytes,
    });
    if (page.isDone) {
      target++;
      next = null;
    } else next = page.continueCursor;
    remaining -= page.page.length;
    for (const row of page.page) {
      bytes -= new TextEncoder().encode(JSON.stringify(row)).length;
      if (row.journalSegment && /^[0-9a-f]{64}$/.test(row.journalSegment)) keys.push(row.journalSegment);
    }
  }
  // Modern archived records retain their pointers on the already-indexed record headers.
  return {
    entries: await archivedSegmentRows(ctx, projectId, keys),
    after: JSON.stringify({ target, after: next, records: true }),
    done: target === records.length,
  };
}

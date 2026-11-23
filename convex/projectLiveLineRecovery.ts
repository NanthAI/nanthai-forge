// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './server';
import { FLOW_HOURS, HOUR_MS, rebuildFlowLandings, utcDayStart, type FlowDay } from '../src/flow-day';

type Reader = Pick<QueryCtx['db'], 'query'>;
const PAGE_ROWS = 100;
const PAGE_BYTES = 1024 * 1024;
const PAGES = 3;

/** Read the same UTC receipt window as `landings`, with Convex cursors so tied batch times are counted once. */
export async function readFlowLandings(
  db: Reader,
  projectId: Id<'hostedProjects'>,
  now: number,
  day: FlowDay,
  beforeSequence?: number,
) {
  const start = utcDayStart(now);
  const byHour = Array<number>(FLOW_HOURS).fill(0);
  let cursor: string | null = null;
  let receipts = 0;
  let complete = false;
  let split = false;
  let first = Infinity;
  let last = -Infinity;
  let firstAt = Infinity;
  let lastAt = -Infinity;
  let counted = 0;
  for (let pageIndex = 0; pageIndex < PAGES; pageIndex++) {
    const page = await db
      .query('projectHostedAcceptances')
      .withIndex('by_project', q =>
        q
          .eq('projectId', projectId)
          .gte('_creationTime', start)
          .lt('_creationTime', start + FLOW_HOURS * HOUR_MS),
      )
      .paginate({ cursor, numItems: PAGE_ROWS, maximumRowsRead: PAGE_ROWS, maximumBytesRead: PAGE_BYTES });
    for (const row of page.page) {
      // The publish caller adds its own receipts from the inputs it just committed.
      if (beforeSequence !== undefined && row.sequence >= beforeSequence) continue;
      const hour = Math.floor((row._creationTime - start) / HOUR_MS);
      byHour[hour] = byHour[hour]! + 1;
      first = Math.min(first, row.sequence);
      last = Math.max(last, row.sequence);
      firstAt = Math.min(firstAt, row._creationTime);
      lastAt = Math.max(lastAt, row._creationTime);
      counted++;
    }
    receipts += page.page.length;
    split = page.pageStatus === 'SplitRequired';
    complete = page.isDone && !split;
    if (complete || split) break;
    cursor = page.continueCursor;
  }
  if (!complete && !split && firstAt < lastAt && last - first + 1 === counted) {
    // A full final page has no exhaustion signal. The channel sequence proves completeness
    // when all observed receipts are consecutive and reach the snapshot's last published receipt.
    const through = beforeSequence === undefined ? await channelSequence(db, projectId) : beforeSequence - 1;
    complete = last === through;
  }
  return { day: rebuildFlowLandings(day, start, byHour, complete), receipts };
}

async function channelSequence(db: Reader, projectId: Id<'hostedProjects'>): Promise<number | undefined> {
  const row = await db
    .query('projectHostedChannels')
    .withIndex('by_project_and_name', q => q.eq('projectId', projectId).eq('name', 'main'))
    .unique();
  return row ? JSON.parse(row.selection).sourceRevision : undefined;
}

/** The gate's actual verdict, including older projects whose Flow writer never saw a state change.
 * A pending or inconclusive run leaves the previous verdict in force; without one there is no result. */
export async function retainedMainVerdict(
  db: Reader,
  projectId: Id<'hostedProjects'>,
): Promise<Pick<FlowDay, 'main' | 'audit'>> {
  const audit = await db
    .query('projectHostedMainAudits')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  if (audit?.red) {
    const since = Date.parse(audit.red.since);
    return Number.isFinite(since) ? { main: { red: true, since } } : { audit: { red: true } };
  }
  if (!audit?.lastGreen) return {};
  const row = await db
    .query('projectHostedCheckRuns')
    .withIndex('by_project_and_run', q => q.eq('projectId', projectId).eq('runId', audit.lastGreen!.runId))
    .unique();
  const endedAt = Date.parse(row ? JSON.parse(row.value).endedAt : '');
  // lastGreen is the latest verified pass, not the start of the green streak.
  return { audit: { red: false, ...(Number.isFinite(endedAt) ? { at: endedAt } : {}) } };
}

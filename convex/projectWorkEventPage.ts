// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getDocumentSize } from 'convex/values';
import { journalIndexAfter, requireJournal, loadedJournalRows } from './projectJournalStore';
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { eventDocument, type StoredWorkEvent } from './projectWorkEventStore';
import { invariant } from '../src/errors';
import { verifyPurgedEvents } from './projectWorkPurgedRows';
/** One bounded logical event window, including any archived bodies in that window. */
export async function retainedEventPage(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  input: {
    initialRevision: number;
    revision: number;
    paginationOpts: {
      cursor: string | null;
      numItems: number;
      maximumBytesRead?: number;
      maximumRowsRead?: number;
    };
  },
) {
  const after = input.paginationOpts.cursor
    ? Number(input.paginationOpts.cursor.replace(/^work-events:/, ''))
    : input.initialRevision;
  invariant(
    Number.isSafeInteger(after) && after >= input.initialRevision && after <= input.revision,
    'WORK_STALE',
    'Read the selected Work event page again.',
  );
  const { numItems, maximumRowsRead = numItems, maximumBytesRead = 500000 } = input.paginationOpts;
  let end = Math.min(after + Math.min(numItems, maximumRowsRead), input.revision);
  const selected = new Map<number, StoredWorkEvent>();
  const archived = new Map<number, Doc<'projectHostedRecordBodies'>>();
  if (end > after) {
    const rows = ctx.db
      .query('projectHostedRecordBodies')
      .withIndex('by_project_and_revision', q =>
        q.eq('projectId', project._id).gt('revision', after).lte('revision', end),
      );
    let documents = 0,
      bytes = 0;
    for await (const row of rows) {
      const revision = row.revision!;
      if (!row.journalSegment) selected.set(revision, eventDocument(row));
      documents++;
      bytes += getDocumentSize(row);
      if (documents >= maximumRowsRead || bytes >= maximumBytesRead) {
        end = revision;
        break;
      }
    }
    if (selected.size < end - after) {
      let known = after;
      while (known < end) {
        const index = await journalIndexAfter(ctx, project._id, 'events', known, end);
        if (!index) break;
        requireJournal(ctx, index);
        known = index.through;
      }
      for (const row of loadedJournalRows(ctx, 'projectHostedRecordBodies'))
        if (row.revision !== undefined && row.revision > after && row.revision <= end)
          archived.set(row.revision, row);
    }
  }
  const page: StoredWorkEvent[] = [];
  let replyBytes = 0;
  for (let revision = after + 1; revision <= end; revision++) {
    const body = archived.get(revision);
    const row = body ? eventDocument(body) : selected.get(revision);
    invariant(row, 'INVALID_WORK_JOURNAL', 'Hosted Work operation coverage is incomplete.');
    replyBytes += getDocumentSize(body ?? row);
    page.push(row);
    if (replyBytes >= maximumBytesRead) break;
  }
  await verifyPurgedEvents(ctx, project._id, page);
  const through = after + page.length;
  return { page, isDone: through === input.revision, continueCursor: `work-events:${through}` };
}

// SPDX-License-Identifier: Apache-2.0
import { journalIndexAfter, requireJournal, loadedJournalRows } from './projectJournalStore';
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { eventDocument, type StoredWorkEvent } from './projectWorkEventStore';
import { invariant } from '../src/errors';
/** Read the unbounded command side first. The other side contains bounded metadata commands.
 * Fill across migration epochs inside this one query, so a flag change adds no client page call. */
export async function retainedEventPage(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  input: {
    initialRevision: number;
    revision: number;
    paginationOpts: { cursor: string | null; numItems: number; maximumBytesRead?: number };
  },
) {
  let after = input.paginationOpts.cursor
    ? Number(input.paginationOpts.cursor.replace(/^work-events:/, ''))
    : input.initialRevision;
  invariant(
    Number.isSafeInteger(after) && after >= input.initialRevision && after <= input.revision,
    'WORK_STALE',
    'Read the selected Work event page again.',
  );
  const page: StoredWorkEvent[] = [];
  let bytes = 0;
  const epochs = project.workStoreEventWindows ?? [];
  while (
    after < input.revision &&
    page.length < input.paginationOpts.numItems &&
    bytes < (input.paginationOpts.maximumBytesRead ?? 500000)
  ) {
    const remaining = input.paginationOpts.numItems - page.length;
    const nextEpoch = epochs.find(epoch => epoch.revision > after);
    const epoch = epochs.filter(epoch => epoch.revision <= after).at(-1);
    let end = Math.min(after + remaining, input.revision, nextEpoch?.revision ?? Infinity);
    const legacy = () =>
      ctx.db
        .query('projectWorkEvents')
        .withIndex('by_project_and_revision', q =>
          q.eq('projectId', project._id).gt('revision', after).lte('revision', end),
        )
        .order('asc');
    const stored = () =>
      ctx.db
        .query('projectHostedRecordBodies')
        .withIndex('by_project_and_revision', q =>
          q.eq('projectId', project._id).gt('revision', after).lte('revision', end),
        )
        .order('asc');
    const budget = input.paginationOpts.maximumBytesRead ?? 500000;
    // A Convex query supports only one .paginate() call. Stream the unbounded side instead:
    // each row is consumed once, with the same soft byte boundary as the old event page.
    let firstBytes = 0;
    const batch: StoredWorkEvent[] = [];
    if (epoch?.storeFirst) {
      for await (const body of stored()) {
        if (!body.journalSegment) batch.push(eventDocument(body));
        firstBytes += new TextEncoder().encode(JSON.stringify(body)).length;
        if (firstBytes >= budget || batch.length === remaining) {
          end = body.revision!;
          break;
        }
      }
      batch.push(...(await legacy().take(remaining)));
    } else {
      for await (const event of legacy()) {
        batch.push(event);
        firstBytes += new TextEncoder().encode(JSON.stringify(event)).length;
        if (firstBytes >= budget || batch.length === remaining) {
          end = event.revision;
          break;
        }
      }
      batch.push(...(await stored().take(remaining)).filter(row => !row.journalSegment).map(eventDocument));
    }
    if (project.journalRevision) {
      let selected = after;
      while (selected < end) {
        const index = await journalIndexAfter(ctx, project._id, 'events', selected, end);
        if (!index) break;
        requireJournal(ctx, index);
        selected = index.through;
      }
      batch.push(
        ...loadedJournalRows(ctx, 'projectHostedRecordBodies')
          .filter(row => row.revision !== undefined && row.revision > after && row.revision <= end)
          .map(eventDocument),
      );
    }
    const unique = [...new Map(batch.map(row => [row.revision, row])).values()];
    batch.splice(0, batch.length, ...unique);
    batch.sort((a, b) => a.revision - b.revision);
    invariant(
      batch.length === end - after && batch.every((event, i) => event.revision === after + i + 1),
      'INVALID_WORK_JOURNAL',
      'Hosted Work operation coverage is incomplete.',
    );
    page.push(...batch);
    bytes += batch.reduce((total, row) => total + new TextEncoder().encode(JSON.stringify(row)).length, 0);
    after = end;
  }
  return { page, isDone: after === input.revision, continueCursor: `work-events:${after}` };
}

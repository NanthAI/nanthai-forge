// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';
import type { HostedRecordKind } from '../src/hosted-records';
import { journalIndexAfter, journalScope, loadedJournalRows, requireJournal } from './projectJournalStore';
import { invariant } from '../src/errors';
const prefix = 'journal-records-v1:';
/** Version positions survive physical relocation and never substitute a different immutable version. */
export async function journalRecordPage(
  ctx: QueryCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    kind: HostedRecordKind;
    key: string;
    through: number;
    cursor: string | null;
    limit: number;
  },
) {
  const after = input.cursor?.startsWith(prefix) ? Number(input.cursor.slice(prefix.length)) : -1;
  invariant(
    input.cursor === null || (input.cursor.startsWith(prefix) && Number.isSafeInteger(after) && after >= -1),
    'BAD_ARGUMENT',
    'Continue the original record history page.',
  );
  const scope = journalScope(input.kind, input.key);
  let scanned = after;
  // Load only segments intersecting this bounded version window. Lifecycle preparation rows do not
  // create gaps in the accepted version sequence; duplicate physical copies are merged by identity.
  const end = Math.min(input.through, after + input.limit + 1);
  while (scanned < end) {
    const index = await journalIndexAfter(ctx, input.projectId, scope, Math.max(0, scanned), end);
    if (!index) break;
    requireJournal(ctx, index);
    scanned = index.through;
  }
  const live = await ctx.db
    .query('projectHostedRecords')
    .withIndex('by_project_and_kind_and_key_and_version', q =>
      q
        .eq('projectId', input.projectId)
        .eq('kind', input.kind)
        .eq('key', input.key)
        .gt('version', after)
        .lte('version', input.through),
    )
    .order('asc')
    .take(input.limit + 1);
  const rows = new Map<string, Doc<'projectHostedRecords'>>();
  for (const row of [...loadedJournalRows(ctx, 'projectHostedRecords'), ...live]) {
    if (
      row.projectId === input.projectId &&
      row.kind === input.kind &&
      row.key === input.key &&
      row.version > after &&
      row.version <= input.through &&
      !row.lifecyclePlanId
    )
      rows.set(row._id, row);
  }
  const ordered = [...rows.values()].sort((a, b) => a.version - b.version);
  const page = ordered.slice(0, input.limit);
  return {
    page,
    isDone: ordered.length <= input.limit,
    continueCursor: prefix + (page.at(-1)?.version ?? after),
  };
}

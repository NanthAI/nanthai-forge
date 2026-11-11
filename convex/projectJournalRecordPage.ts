// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';
import type { HostedRecordKind } from '../src/hosted-records';
import {
  journalIndexAfter,
  journalIndexBefore,
  journalScope,
  loadedJournalRows,
  requireJournal,
} from './projectJournalStore';
import { invariant } from '../src/errors';
const prefix = 'journal-records-v1:';
/** Version positions survive physical relocation, including sparse imported history. */
export async function journalRecordPage(
  ctx: QueryCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    kind: HostedRecordKind;
    key: string;
    through: number;
    cursor: string | null;
    limit: number;
    newestFirst?: boolean;
  },
) {
  if (input.through < 0) return { page: [], isDone: true, continueCursor: '' };
  const descending = !!input.newestFirst,
    cursorPrefix = prefix + (descending ? 'before:' : '');
  const position = input.cursor?.startsWith(cursorPrefix)
    ? Number(input.cursor.slice(cursorPrefix.length))
    : descending
      ? input.through + 1
      : -1;
  invariant(
    input.cursor === null || input.cursor.startsWith(cursorPrefix),
    'CLI_UPGRADE_REQUIRED',
    'This history cursor predates journal support. Run nforge update and retry.',
  );
  invariant(
    input.cursor === null ||
      (input.cursor.startsWith(cursorPrefix) &&
        Number.isSafeInteger(position) &&
        position >= (descending ? 0 : -1)),
    'BAD_ARGUMENT',
    'Continue the original record history page.',
  );
  const live = await ctx.db
    .query('projectHostedRecords')
    .withIndex('by_project_and_kind_and_key_and_version', q => {
      const selected = q.eq('projectId', input.projectId).eq('kind', input.kind).eq('key', input.key);
      return descending
        ? selected.lt('version', position)
        : selected.gt('version', position).lte('version', input.through);
    })
    .order(descending ? 'desc' : 'asc')
    .take(input.limit + 1);
  const scope = journalScope(input.kind, input.key);
  const selected = () => {
    const rows = new Map<string, Doc<'projectHostedRecords'>>();
    for (const row of [...loadedJournalRows(ctx, 'projectHostedRecords'), ...live])
      if (
        row.projectId === input.projectId &&
        row.kind === input.kind &&
        row.key === input.key &&
        row.version <= input.through &&
        (descending ? row.version < position : row.version > position) &&
        !row.lifecyclePlanId
      )
        rows.set(row._id, row);
    return [...rows.values()].sort((a, b) => (descending ? -1 : 1) * (a.version - b.version));
  };
  let scanned = position,
    blockedAt: number | undefined;
  for (;;) {
    const ordered = selected(),
      bound = ordered[input.limit]?.version ?? (descending ? 0 : input.through);
    const index = descending
      ? await journalIndexBefore(ctx, input.projectId, scope, scanned)
      : await journalIndexAfter(ctx, input.projectId, scope, scanned, bound);
    if (!index || (descending && index.through < bound && ordered.length > input.limit)) break;
    const preceding = ordered.filter(row =>
      descending ? row.version > index.through : row.version < index.from,
    );
    if (preceding.length && preceding.reduce((n, row) => n + row.bytes, 0) >= 128 * 1024) {
      blockedAt = descending ? index.through : index.from;
      break;
    }
    requireJournal(ctx, index);
    scanned = descending ? index.from : index.through;
    if (ordered.length > input.limit && (descending ? scanned <= bound : scanned >= bound)) break;
  }
  const ordered = selected().filter(
    row => blockedAt === undefined || (descending ? row.version > blockedAt : row.version < blockedAt),
  );
  const page: Doc<'projectHostedRecords'>[] = [];
  let bytes = 0;
  for (const row of ordered.slice(0, input.limit)) {
    if (page.length && bytes + row.bytes > 128 * 1024) break;
    page.push(row);
    bytes += row.bytes;
  }
  return {
    page,
    isDone: blockedAt === undefined && ordered.length === page.length,
    continueCursor: cursorPrefix + (page.at(-1)?.version ?? position),
  };
}

// SPDX-License-Identifier: Apache-2.0
// Flip 5 S4 (Issue 0695ab24): with `workStore: 'records'` the planning reads (Issues, their versions and
// their comments) and an Intent's notes and status moves come from the record store instead of the journal index, for the web and agents alike
// (both read `projectWorkIndex:records` and `:detail`). One head per item and no project-wide row, so a
// write re-runs only the page that holds it. Rows keep the journal's shape: the whole item or comment
// (never a payload header), in the journal's append order (the order the heads were created).
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { PaginationOptions } from 'convex/server';
import { hostedRecordBody, recordHead, recordVersion } from './projectHostedRecords';
import { noteRecordId } from '../src/work-store-records';

type Row = { id: string; position: number; value: unknown };
type Page = { page: Row[]; isDone: boolean; continueCursor: string };

/** Whether this read comes from the record store. Other collections, and shapes the store does not
 * index the same way (a parent filter on Issues, all comments of a project), stay on the journal. */
export function readsStore(project: Doc<'hostedProjects'>, collection: string, parentId?: string) {
  if (project.workStore !== 'records') return false;
  if (collection === 'planningItems') return parentId === undefined;
  return parentId !== undefined && byParent.includes(collection);
}
const byParent = ['planningComments', 'planningVersions', 'notes', 'lifecycle'];

type Stored = {
  item?: unknown;
  comment?: unknown;
  note?: object;
  entry?: object;
  parent?: string;
  position?: number;
};
/** A stored record in the journal row's shape: notes and moves carry their Intent and index again. */
function journalValue(collection: string, record: Stored | null) {
  if (!record) return null;
  if (collection === 'planningItems' || collection === 'planningVersions') return record.item ?? null;
  if (collection === 'planningComments') return record.comment ?? null;
  const value = collection === 'notes' ? record.note : record.entry;
  return value ? { ...value, intentId: record.parent, index: record.position } : null;
}

async function body(ctx: QueryCtx, row: Doc<'projectHostedRecords'> | null) {
  return row ? JSON.parse(await hostedRecordBody(ctx, row)) : null;
}

/** One page in the journal's shape. Comments share kind `comment` with Intent notes on the same parent;
 * notes are left out of the page, so a page can hold fewer rows than asked (its cursor still moves). */
export async function storePage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  input: { collection: string; parentId?: string; newestFirst?: boolean; paginationOpts: PaginationOptions },
): Promise<Page> {
  const order = input.newestFirst ? 'desc' : 'asc';
  if (input.collection === 'planningVersions') {
    const page = await ctx.db
      .query('projectHostedRecords')
      .withIndex('by_project_and_kind_and_key_and_version', q =>
        q.eq('projectId', projectId).eq('kind', 'issue').eq('key', input.parentId!),
      )
      .order(order)
      .paginate(input.paginationOpts);
    const rows: Row[] = [];
    for (const row of page.page) {
      const item = (await body(ctx, row)).item;
      rows.push({ id: item.operationId, position: row.version, value: item });
    }
    return { ...page, page: rows };
  }
  const collection = input.collection,
    kind = collection === 'planningItems' ? 'issue' : collection === 'lifecycle' ? 'lifecycle' : 'comment';
  // Comments, notes and moves are insert-only (one version each), so their record rows are read
  // directly, by parent: two documents per row. An Issue needs its head (the current version) first.
  const page =
    kind === 'issue'
      ? await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind', q => q.eq('projectId', projectId).eq('kind', kind))
          .order(order)
          .paginate(input.paginationOpts)
      : await ctx.db
          .query('projectHostedRecords')
          .withIndex('by_project_and_kind_and_parent', q =>
            q.eq('projectId', projectId).eq('kind', kind).eq('parent', input.parentId!),
          )
          .order(order)
          .paginate(input.paginationOpts);
  const rows: Row[] = [];
  for (const head of page.page) {
    const row = 'recordId' in head ? await ctx.db.get(head.recordId) : head;
    const value = journalValue(collection, await body(ctx, row));
    if (!value) continue;
    // Notes and moves keep the journal's key (Intent and index) and order within their Intent.
    const indexed = collection === 'notes' || collection === 'lifecycle';
    rows.push({
      id: indexed ? `${input.parentId}:${(value as { index: number }).index}` : head.key,
      position: indexed ? (value as { index: number }).index : head._creationTime,
      value,
    });
  }
  return { ...page, page: rows };
}

/** The current Issue or Initiative, as the journal's `planningItems` detail returns it. */
export async function storeItem(ctx: QueryCtx, projectId: Id<'hostedProjects'>, id: string) {
  const head = await recordHead(ctx, projectId, 'issue', id);
  return head ? ((await body(ctx, await ctx.db.get(head.recordId)))?.item ?? null) : null;
}

/** Order-free JSON, so a reader compare does not depend on key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}
export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** What the store reader returns for one journal row, for the S4 compare: the full journal value has to
 * come back field for field (a field the record schema dropped would show up here). */
export async function storeReadOf(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  collection: 'planningItems' | 'planningVersions' | 'planningComments' | 'notes' | 'lifecycle',
  value: { id?: string; version?: number; intentId?: string; index?: number },
) {
  if (collection === 'planningItems') return storeItem(ctx, projectId, value.id!);
  if (collection === 'planningVersions')
    return journalValue(
      collection,
      await body(ctx, await recordVersion(ctx, projectId, 'issue', value.id!, value.version!)),
    );
  const kind = collection === 'lifecycle' ? 'lifecycle' : 'comment';
  const id =
    collection === 'planningComments'
      ? value.id!
      : collection === 'notes'
        ? (value.id ?? noteRecordId(value.intentId!, value.index!))
        : noteRecordId(value.intentId!, value.index!, 'lifecycle');
  const head = await recordHead(ctx, projectId, kind, id);
  return head ? journalValue(collection, await body(ctx, await ctx.db.get(head.recordId))) : null;
}

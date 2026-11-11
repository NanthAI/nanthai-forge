// SPDX-License-Identifier: Apache-2.0
// Flip 5 S4 (Issue 0695ab24): with `workStore: 'records'` the planning reads (Issues, their versions and
// their comments) and an Intent's notes and status moves come from the record store instead of the journal index, for the web and agents alike
// (both read `projectWorkIndex:records` and `:detail`). One head per item and no project-wide row, so a
// write re-runs only the page that holds it. Rows keep the journal's shape: the whole item or comment
// (never a payload header), in the journal's append order (the order the heads were created).
import { journalRecordPage } from './projectJournalRecordPage';
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

/** A head's current value in the journal row's shape: inline on the head (one document), or from its
 * record and body for a head stored before heads kept it (the copy brings those up to date). */
async function headValue(ctx: QueryCtx, collection: string, head: Doc<'projectHostedRecordHeads'>) {
  if (head.value === undefined)
    return journalValue(collection, await body(ctx, await ctx.db.get(head.recordId)));
  const value = JSON.parse(head.value);
  // An Intent note is a `comment` too; an older head may still carry a note kind as its status.
  const note = head.status === 'note' || (value as { intentId?: string }).intentId !== undefined;
  if (collection === 'planningComments' ? note : collection === 'notes' && !note) return null;
  return note ? { ...value, intentId: head.parent } : value;
}

/** One page in the journal's shape, one head per row. A planning comment and an Intent note on the same
 * id are both `comment` heads; their status (`comment` or `note`) keeps the two pages apart. */
export async function storePage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  input: { collection: string; parentId?: string; newestFirst?: boolean; paginationOpts: PaginationOptions },
): Promise<Page> {
  const order = input.newestFirst ? 'desc' : 'asc';
  if (input.collection === 'planningVersions') {
    const head = await recordHead(ctx, projectId, 'issue', input.parentId!);
    const page = await journalRecordPage(ctx, {
      projectId,
      kind: 'issue',
      key: input.parentId!,
      through: head?.version ?? -1,
      cursor: input.paginationOpts.cursor,
      limit: input.paginationOpts.numItems,
      ...(input.newestFirst === undefined ? {} : { newestFirst: input.newestFirst }),
    });
    const rows: Row[] = [];
    for (const row of page.page) {
      const item = (await body(ctx, row)).item;
      rows.push({ id: item.operationId, position: row.version, value: item });
    }
    return { ...page, page: rows };
  }
  const collection = input.collection,
    parent = input.parentId!,
    heads = ctx.db.query('projectHostedRecordHeads');
  const range =
    collection === 'planningItems'
      ? heads.withIndex('by_project_and_kind', q => q.eq('projectId', projectId).eq('kind', 'issue'))
      : collection === 'lifecycle'
        ? heads.withIndex('by_project_and_kind_and_parent', q =>
            q.eq('projectId', projectId).eq('kind', 'lifecycle').eq('parent', parent),
          )
        : heads.withIndex('by_project_and_kind_and_parent_and_status', q =>
            q
              .eq('projectId', projectId)
              .eq('kind', 'comment')
              .eq('parent', parent)
              .eq('status', collection === 'notes' ? 'note' : 'comment'),
          );
  const page = await range.order(order).paginate(input.paginationOpts);
  const rows: Row[] = [];
  for (const head of page.page) {
    const value = await headValue(ctx, collection, head);
    if (!value) continue;
    // Notes and moves keep the journal's key (Intent and index) and order within their Intent.
    const indexed = collection === 'notes' || collection === 'lifecycle';
    rows.push({
      id: indexed ? `${parent}:${(value as { index: number }).index}` : head.key,
      position: indexed ? (value as { index: number }).index : head._creationTime,
      value,
    });
  }
  return { ...page, page: rows };
}

/** The current Issue or Initiative, as the journal's `planningItems` detail returns it. */
export async function storeItem(ctx: QueryCtx, projectId: Id<'hostedProjects'>, id: string) {
  const head = await recordHead(ctx, projectId, 'issue', id);
  return head ? await headValue(ctx, 'planningItems', head) : null;
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
 * come back field for field (a field the record schema dropped would show up here). The compare also opens
 * the body: a body that fails its digest throws, and an inline value that is not what the body reads back
 * as comes back as both, so it shows as different. */
export async function storeReadOf(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  collection: 'planningItems' | 'planningVersions' | 'planningComments' | 'notes' | 'lifecycle',
  value: { id?: string; version?: number; intentId?: string; index?: number },
) {
  if (collection === 'planningVersions')
    return journalValue(
      collection,
      await body(ctx, await recordVersion(ctx, projectId, 'issue', value.id!, value.version!)),
    );
  const kind =
    collection === 'planningItems' ? 'issue' : collection === 'lifecycle' ? 'lifecycle' : 'comment';
  const id =
    collection === 'planningItems' || collection === 'planningComments'
      ? value.id!
      : collection === 'notes'
        ? (value.id ?? noteRecordId(value.intentId!, value.index!))
        : noteRecordId(value.intentId!, value.index!, 'lifecycle');
  const head = await recordHead(ctx, projectId, kind, id);
  if (!head) return null;
  const read = await headValue(ctx, collection, head),
    stored = journalValue(collection, await body(ctx, await ctx.db.get(head.recordId)));
  return sameValue(read, stored) ? read : { read, stored };
}

// SPDX-License-Identifier: Apache-2.0
// The Plan view in the address (Item e0a23825): scope, filters, sort, layout and find are query parameters, so a
// view survives a refresh, a link and the browser's Back. Saved views are a name for one of these addresses, kept on
// this browser only (a personal shortcut; the agent `planning` read takes the same filter fields). Pure.
import { planFilterMatch, type PlanFilter } from '../../../../src/planning-filter';
import type { PlanRow } from '../../../../src/planning-model';

export type Scope = 'open' | 'closed' | 'all' | 'archived' | 'deleted';
export type Sort = 'hand' | 'title' | 'status' | 'owner' | 'type';
export type Layout = 'list' | 'tree' | 'board';
export type PlanQuery = PlanFilter & {
  scope: Scope;
  sort: Sort;
  layout: Layout;
  initiative?: string | undefined;
  find: string;
};

const scopes: readonly Scope[] = ['open', 'closed', 'all', 'archived', 'deleted'];
const sorts: readonly Sort[] = ['hand', 'title', 'status', 'owner', 'type'];
const layouts: readonly Layout[] = ['list', 'tree', 'board'];
const relations = ['depends-on', 'duplicate-of', 'related', 'none'] as const;
const pick = <T extends string>(value: string | null, from: readonly T[], fallback: T): T =>
  value && (from as readonly string[]).includes(value) ? (value as T) : fallback;
const text = (value: string | null, max: number) => {
  const trimmed = value?.trim().slice(0, max);
  return trimmed || undefined;
};

export function readQuery(search: URLSearchParams): PlanQuery {
  return {
    scope: pick(search.get('scope'), scopes, 'open'),
    sort: pick(search.get('sort'), sorts, 'hand'),
    layout: pick(search.get('view'), layouts, 'list'),
    type: text(search.get('type'), 32),
    owner: text(search.get('owner'), 200),
    relation: pick(search.get('relation'), [...relations, ''] as const, '') || undefined,
    initiative: text(search.get('initiative'), 36),
    find: search.get('q')?.slice(0, 200) ?? '',
  };
}

/** The query string of a view; defaults are left out, so the plain Plan address stays plain. */
export function writeQuery(query: Partial<PlanQuery>) {
  const params = new URLSearchParams();
  if (query.scope && query.scope !== 'open') params.set('scope', query.scope);
  if (query.type) params.set('type', query.type);
  if (query.owner) params.set('owner', query.owner);
  if (query.relation) params.set('relation', query.relation);
  if (query.initiative) params.set('initiative', query.initiative);
  if (query.sort && query.sort !== 'hand') params.set('sort', query.sort);
  if (query.layout && query.layout !== 'list') params.set('view', query.layout);
  if (query.find?.trim()) params.set('q', query.find);
  const out = params.toString();
  return out ? `?${out}` : '';
}

/** The filter part only: what narrows rows (not sort or layout). */
export const filtered = (query: PlanQuery) =>
  Boolean(query.type || query.owner || query.relation || query.initiative || query.find.trim());

/** Everything shows every Item but Archived and Deleted ones. A list with no status returns exactly that; a search
 * with no status returns open work only, so with Find the command says `"all"`, which adds both shelves. */
const everythingSearch = (query: PlanQuery) => query.scope === 'all' && Boolean(query.find.trim());
/** The agent read a view is a shortcut to (saved views stay a web shortcut to this call). */
export function agentRead(query: PlanQuery) {
  const input: Record<string, unknown> =
    query.scope === 'all' && !everythingSearch(query)
      ? {}
      : {
          status:
            query.scope === 'open'
              ? 'active'
              : query.scope === 'closed'
                ? ['closed', 'abandoned']
                : query.scope,
        };
  if (query.scope === 'closed') input.kind = 'issue';
  if (query.type) input.type = query.type;
  if (query.owner) input.owner = query.owner;
  if (query.relation) input.relation = query.relation;
  if (query.initiative) input.initiativeId = query.initiative;
  if (query.find.trim()) input.search = query.find.trim();
  return `nforge agent . planning '${JSON.stringify(input)}'`;
}
/** What the command returns beyond the view, said under it; empty when they match. */
export const agentReadNote = (query: PlanQuery) =>
  everythingSearch(query) ? 'With a search, "all" also lists Archived and Deleted Items.' : '';

const statusRank: Record<PlanRow['status'], number> = {
  'in-progress': 0,
  open: 1,
  proposed: 2,
  closed: 3,
  abandoned: 4,
  archived: 5,
  deleted: 6,
};
/** Rows the filters keep (find and Initiative are checked by the caller with its own match rules). */
export const keeps = (row: PlanRow, query: PlanQuery) =>
  planFilterMatch(row, query) &&
  (!query.initiative || row.initiativeId === query.initiative || row.id === query.initiative);

/** Another order than by hand: hand order numbers and dragging go away (the caller disables the list). */
export function sortRows<T extends { row: PlanRow }>(lines: readonly T[], sort: Sort): T[] {
  if (sort === 'hand') return [...lines];
  const key = (row: PlanRow): string | number =>
    sort === 'title'
      ? row.title.toLowerCase()
      : sort === 'status'
        ? statusRank[row.status]
        : sort === 'owner'
          ? (row.owner ?? '￿').toLowerCase()
          : (row.type ?? '￿').toLowerCase();
  return [...lines].sort((left, right) => {
    const a = key(left.row),
      b = key(right.row);
    return a < b ? -1 : a > b ? 1 : left.row.position - right.row.position;
  });
}

// ---- Saved views (this browser only) ----------------------------------------------------------------------------
export type SavedView = { name: string; query: string };
const storageKey = (projectId: string) => `forge.plan.views.${projectId}`;
export const SAVED_LIMIT = 20;

export function loadViews(projectId: string): SavedView[] {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(projectId)) ?? '[]');
    return Array.isArray(raw)
      ? raw
          .filter(view => typeof view?.name === 'string' && typeof view?.query === 'string')
          .slice(0, SAVED_LIMIT)
      : [];
  } catch {
    return [];
  }
}

/** Saves (or renames over the same name) one view; false when the browser keeps nothing. */
export function saveView(projectId: string, views: readonly SavedView[], view: SavedView) {
  const next = [view, ...views.filter(entry => entry.name !== view.name)].slice(0, SAVED_LIMIT);
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

export function removeView(projectId: string, views: readonly SavedView[], name: string) {
  const next = views.filter(entry => entry.name !== name);
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(next));
  } catch {
    /* Nothing kept on this browser; the list still updates for this visit. */
  }
  return next;
}

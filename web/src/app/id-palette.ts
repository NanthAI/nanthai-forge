// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Go to or run (⌘K) finds what an id names (Item ee9899ca): paste an 8-character prefix or a full UUID of an Item,
// a Lane or a landing receipt and the palette offers it. The palette holds no records, so an id costs one debounced
// lookup through three existing bounded reads (the planning search's id match, the Lane id resolver, the receipt
// read), sent together and cached per id. Nothing runs while the palette is closed or the search is not an id.
import { useEffect, useMemo, useReducer } from 'react';
import { useConvex, type ConvexReactClient } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { PaletteGroup } from '../ds';
import {
  IdLookup,
  idMatches,
  idPrefix,
  idRef,
  itemsById,
  landingsById,
  lookupEach,
  type IdItem,
  type IdLanding,
} from '../id-search';
import { hrefFor, type AppRoute } from './paths';
import { navigate } from './router';

type ProjectRoute = Extract<AppRoute, { frame: 'project' }>;
export type IdRow = { group: 'Items' | 'Lanes' | 'Landings'; id: string; label: string; href: string };
/** The client's one-shot read (ConvexReactClient.query): never a subscription. */
type Query = ConvexReactClient['query'];

/** One lookup's rows for this project's addresses: an Item opens in Plan, a Lane its page, a receipt its landing. */
export function idRows(text: string, route: ProjectRoute, projectId: Id<'hostedProjects'>, query: Query) {
  const at = (place: 'plan' | 'lanes' | 'code', rest: string) =>
    hrefFor({ ...route, place, section: '', rest });
  const ref = idRef(text);
  return lookupEach<IdRow>([
    query(api.projectHostedPlanningSearch.search, {
      projectId,
      text,
      omittedTerms: 0,
      status: 'all',
      cursor: null,
      limit: 5,
    }).then(raw =>
      itemsById(raw).map((item: IdItem) => ({
        group: 'Items' as const,
        id: item.id,
        label: `${item.id.slice(0, 8)} · ${item.title ?? 'Item'}`,
        href: at('plan', item.id),
      })),
    ),
    // The resolver takes a prefix of up to 35 characters; a full UUID's first 35 still name only it.
    query(api.projectHostedLaneHistory.resolveLaneId, { projectId, prefix: ref.slice(0, 35) }).then(raw =>
      ((JSON.parse(raw) as { ids?: string[] }).ids ?? []).map(id => ({
        group: 'Lanes' as const,
        id,
        label: `Lane ${id.slice(0, 8)}`,
        href: at('lanes', id),
      })),
    ),
    landingsById(query(api.projectHostedLandings.read, { projectId, receiptId: ref })).then(rows =>
      rows.map((row: IdLanding) => ({
        group: 'Landings' as const,
        id: row.receiptId,
        label: `${row.receiptId.slice(0, 8)} · ${row.title || 'Landing'}`,
        // Its Lane page reads any Lane directly; Code's History finds a receipt only in the pages it loaded.
        href: row.laneId ? at('lanes', row.laneId) : at('code', row.receiptId),
      })),
    ),
  ]);
}

/** The palette's groups for what the rows name under the current search, in Items, Lanes, Landings order. */
export function idGroups(rows: readonly IdRow[] | undefined, prefix: string | undefined): PaletteGroup[] {
  const named = (rows ?? []).filter(row => idMatches([row.id], prefix));
  return (['Items', 'Lanes', 'Landings'] as const).flatMap(title => {
    const entries = named
      .filter(row => row.group === title)
      .map(row => ({
        id: `id-${row.group}-${row.id}`,
        label: row.label,
        // Typing matches the full id, so the palette's own filter keeps the result for any prefix or case.
        text: `${row.id} ${row.label}`,
        onAction: () => navigate(row.href),
      }));
    return entries.length ? [{ title, entries }] : [];
  });
}

/** What an id search finds in this project, and what the palette says while there is nothing to show. */
export function useIdPalette(
  projectId: Id<'hostedProjects'> | null | undefined,
  route: AppRoute,
  open: boolean,
  query: string,
) {
  const client = useConvex();
  const [, answered] = useReducer((n: number) => n + 1, 0);
  const project = route.frame === 'project' ? route : null;
  const lookup = useMemo(
    () =>
      open && projectId && project
        ? new IdLookup<IdRow>(text => idRows(text, project, projectId, client.query.bind(client)), answered)
        : null,
    // Answers last one opening of the palette, so an id filed since is found on the next open. The route's handle
    // and project make the hrefs.
    [open, client, projectId, project?.handle, project?.project],
  );
  const prefix = idPrefix(query);
  useEffect(() => lookup?.want(prefix, false), [lookup, prefix]);
  useEffect(() => () => lookup?.cancel(), [lookup]);
  const groups = idGroups(lookup?.found(prefix), prefix);
  const empty =
    !lookup || !prefix
      ? undefined
      : lookup.pending(prefix)
        ? `Looking up ${prefix.slice(0, 13)}…`
        : lookup.failed(prefix)
          ? 'Could not look up this id. Edit the search to try again.'
          : `Nothing in this project has id ${prefix.slice(0, 13)}.`;
  return { groups, empty };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readQuery, writeQuery, type PlanQuery, type SavedView } from './query';

export type PlanViewCounts = { open: number; mine: number; unowned: number };
export type PlanViewLink = SavedView & {
  id: string;
  n?: number | undefined;
  saved?: boolean;
  seam?: boolean;
};

export function planViewLinks(
  base: string,
  query: PlanQuery,
  viewer: string | undefined,
  saved: readonly SavedView[],
  counts?: PlanViewCounts,
) {
  const builtIn: PlanViewLink[] = [
    { id: 'open', name: 'Open work', query: '', n: counts?.open },
    ...(viewer
      ? [
          {
            id: 'mine',
            name: 'Mine',
            query: writeQuery({ owner: `@${viewer.replace(/^@/, '')}` }),
            n: counts?.mine,
          },
        ]
      : []),
    { id: 'unowned', name: 'No owner', query: writeQuery({ owner: 'none' }), n: counts?.unowned },
    { id: 'closed', name: 'Closed', query: writeQuery({ scope: 'closed' }), seam: true },
    { id: 'all', name: 'Everything', query: writeQuery({ scope: 'all' }) },
    { id: 'archived', name: 'Archive', query: writeQuery({ scope: 'archived' }) },
    { id: 'deleted', name: 'Deleted', query: writeQuery({ scope: 'deleted' }) },
  ];
  const all: PlanViewLink[] = [
    ...builtIn,
    ...saved.map(view => ({ ...view, id: `saved:${view.name}`, saved: true })),
  ];
  const filters = (value: PlanQuery) =>
    writeQuery({ ...value, sort: 'hand', layout: 'list', group: 'initiative', find: '' });
  const current = filters(query);
  const parsed = (value: string) => readQuery(new URLSearchParams(value));
  return {
    all,
    on: all.find(view => filters(parsed(view.query)) === current),
    href: (value: string) =>
      base + writeQuery({ ...parsed(value), sort: query.sort, layout: query.layout, group: query.group }),
  };
}

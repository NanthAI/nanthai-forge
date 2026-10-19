// SPDX-License-Identifier: Apache-2.0
import { intentProgress } from '../../../src/work-intent-progress';
import { age } from '../ui/status';
import { cockpitLanes, type CockpitWork } from '../cockpit/model';
import { cleanUrl, routeUrlState } from './location';
export type SearchItem = {
  id: string;
  kind: 'Intent' | 'Lane' | 'View' | 'File';
  title: string;
  href: string;
  at?: string;
  secondary?: string;
};
/** Scope every destination to this project, clearing stale drill-down state. */
export function searchHref(hosted: boolean, params: Record<string, string>) {
  const url = routeUrlState();
  for (const key of [
    'tab',
    'projectTab',
    'intent',
    'intentTab',
    'lane',
    'review',
    'reviewView',
    'viewId',
    'workPage',
    'activity',
    'file',
    'view',
    'legacy',
    'collection',
    'laneId',
    'state',
    'sourceHead',
    'sourceBackup',
  ])
    url.searchParams.delete(key);
  if (hosted) url.searchParams.set('surface', 'projects');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return cleanUrl(url);
}
export function workSearchItems(work: CockpitWork, hosted: boolean, now = Date.now()): SearchItem[] {
  const lanes = cockpitLanes(work);

  return [
    ...work.intents.map(intent => {
      const linked = lanes.filter(lane => lane.intentId === intent.id);
      return {
        id: `intent:${intent.id}`,
        kind: 'Intent' as const,
        title: intent.outcome,
        secondary: linked.length
          ? `${linked.length === 1 ? 'Lane' : 'Lanes'} · ${linked
              .map(lane =>
                lane.name === intent.outcome
                  ? [lane.label, age(lane.lastAt, now)].filter(Boolean).join(' · ')
                  : lane.name,
              )
              .join(' / ')}`
          : intentProgress(intent.status ?? 'active', 0),
        href: searchHref(
          hosted,
          hosted ? { projectTab: 'intent', intent: intent.id } : { tab: 'intents', intent: intent.id },
        ),
        ...(intent.createdAt ? { at: intent.createdAt } : {}),
      };
    }),
    ...work.lanes
      .filter(lane => !work.intents.some(intent => intent.id === lane.intentId))
      .map(lane => ({
        id: `lane:${lane.id}`,
        kind: 'Lane' as const,
        title: lane.name,
        href: searchHref(
          hosted,
          hosted ? { projectTab: 'lanes', lane: lane.id } : { tab: 'intents', lane: lane.id },
        ),
        ...(lane.lastCheckpointAt ? { at: lane.lastCheckpointAt } : {}),
      })),
    ...work.views.map((view, i) => ({
      id: `view:${view.id}`,
      kind: 'View' as const,
      title:
        work.intents.find(intent => intent.id === view.intentId)?.outcome ||
        (view.inputs?.length === 1
          ? work.lanes.find(lane => lane.id === view.inputs?.[0]?.laneId)?.name
          : '') ||
        `main + ${view.inputs?.length ?? 0} ${(view.inputs?.length ?? 0) === 1 ? 'Lane' : 'Lanes'}`,
      secondary: `View ${i + 1}`,
      href: searchHref(
        hosted,
        hosted ? { projectTab: 'views', viewId: view.id } : { tab: 'intents', viewId: view.id },
      ),
      at: view.at,
    })),
  ];
}
export function rankSearchItems(items: readonly SearchItem[], query: string, recent: readonly string[]) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items
    .filter(item =>
      words.every(word =>
        `${item.kind} ${item.title} ${item.secondary ?? ''}`.toLocaleLowerCase().includes(word),
      ),
    )
    .sort((a, b) => {
      const ai = recent.indexOf(a.id),
        bi = recent.indexOf(b.id);
      if (ai >= 0 || bi >= 0) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
      return (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0) || a.title.localeCompare(b.title);
    });
}

/** Empty search stays short; query groups expose only their first five until opened. */
export function searchGroups(
  items: readonly SearchItem[],
  query: string,
  recent: readonly string[],
  needs: readonly string[],
  expanded?: string,
) {
  const ranked = rankSearchItems(items, query, recent);
  if (query.trim())
    return (['Intent', 'Lane', 'View', 'File'] as const)
      .map(kind => {
        const matches = ranked.filter(item => item.kind === kind);
        return {
          name: `${kind}s`,
          items: expanded === kind ? matches : matches.slice(0, 5),
          total: matches.length,
          kind,
        };
      })
      .filter(group => group.total);
  const waiting = needs
    .map(id => items.find(item => item.id === id))
    .filter((item): item is SearchItem => !!item)
    .slice(0, 4);
  const recentItems = ranked
    .filter(
      item =>
        !waiting.some(other => other.id === item.id) && (recent.includes(item.id) || item.kind !== 'File'),
    )
    .slice(0, 8 - waiting.length);
  return [
    { name: 'Needs you', items: waiting, total: waiting.length, kind: '' },
    { name: 'Recent', items: recentItems, total: recentItems.length, kind: '' },
  ].filter(group => group.total);
}

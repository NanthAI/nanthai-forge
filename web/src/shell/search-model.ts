// SPDX-License-Identifier: Apache-2.0
import { intentProgress } from '../../../src/work-intent-progress';
import { age } from '../ui/status';
import { cockpitLanes, type CockpitWork } from '../cockpit/model';
import { cleanUrl, routeUrlState } from './location';
import { idMatches, idPrefix } from '../id-search';
import { planningDestination } from './route';
export type SearchItem = {
  id: string;
  kind: 'Intent' | 'Item' | 'Lane' | 'Candidate' | 'File';
  title: string;
  href: string;
  at?: string;
  secondary?: string;
  /** Record ids that name this result when a query is an id prefix. */
  ids?: readonly string[];
  /** Results folded into this one (an Intent's Lanes) that an id query opens directly. */
  named?: readonly SearchItem[];
};
const laneHref = (hosted: boolean, id: string) =>
  searchHref(hosted, hosted ? { projectTab: 'lanes', lane: id } : { tab: 'intents', lane: id });
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
        ids: [intent.id],
        named: linked.map(lane => ({
          id: `lane:${lane.id}`,
          kind: 'Lane' as const,
          title: lane.name,
          secondary: intent.outcome,
          href: laneHref(hosted, lane.id),
          ids: [lane.id],
        })),
      };
    }),
    ...work.lanes
      .filter(lane => !work.intents.some(intent => intent.id === lane.intentId))
      .map(lane => ({
        id: `lane:${lane.id}`,
        kind: 'Lane' as const,
        title: lane.name,
        href: laneHref(hosted, lane.id),
        ...(lane.lastCheckpointAt ? { at: lane.lastCheckpointAt } : {}),
        ids: [lane.id],
      })),
    ...work.views.map((view, i) => ({
      id: `view:${view.id}`,
      kind: 'Candidate' as const,
      title:
        work.intents.find(intent => intent.id === view.intentId)?.outcome ||
        (view.inputs?.length === 1
          ? work.lanes.find(lane => lane.id === view.inputs?.[0]?.laneId)?.name
          : '') ||
        `main + ${view.inputs?.length ?? 0} ${(view.inputs?.length ?? 0) === 1 ? 'Lane' : 'Lanes'}`,
      secondary: `Candidate ${i + 1}`,
      href: searchHref(
        hosted,
        hosted ? { projectTab: 'views', viewId: view.id } : { tab: 'intents', viewId: view.id },
      ),
      at: view.at,
      ids: [view.id],
    })),
  ];
}
/** Planning Items the id lookup returned (projectHostedPlanningSearch:search summaries). */
export function itemSearchItems(
  summaries: readonly { id: string; kind?: string; title?: string; status?: string; at?: string }[],
  hosted: boolean,
): SearchItem[] {
  return summaries.map(item => ({
    id: `item:${item.id}`,
    kind: 'Item',
    title: item.title ?? item.id,
    ...(item.status ? { secondary: item.status } : {}),
    href: searchHref(
      hosted,
      planningDestination({ kind: item.kind === 'initiative' ? 'initiative' : 'planning', id: item.id }),
    ),
    ...(item.at ? { at: item.at } : {}),
    ids: [item.id],
  }));
}
/** Whether a result on the page already answers this id query (so no lookup is needed). */
export const idOnPage = (items: readonly SearchItem[], prefix: string | undefined) =>
  items.some(item => idMatches(item.ids, prefix) || item.named?.some(other => idMatches(other.ids, prefix)));
/** An id query lists the records it names first, then any titles that merely contain the text. */
export function rankSearchItems(items: readonly SearchItem[], query: string, recent: readonly string[]) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const order = (a: SearchItem, b: SearchItem) => {
    const ai = recent.indexOf(a.id),
      bi = recent.indexOf(b.id);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    return (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0) || a.title.localeCompare(b.title);
  };
  const text = items
    .filter(item =>
      words.every(word =>
        `${item.kind} ${item.title} ${item.secondary ?? ''}`.toLocaleLowerCase().includes(word),
      ),
    )
    .sort(order);
  const prefix = idPrefix(query);
  if (!prefix) return text;
  const named = items
    .flatMap(item => [item, ...(item.named ?? [])])
    .filter(item => idMatches(item.ids, prefix))
    .sort(order);
  const seen = new Set(named.map(item => item.id));
  return [...named, ...text.filter(item => !seen.has(item.id))];
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
    return (
      (['Intent', 'Item', 'Lane', 'Candidate', 'File'] as const)
        .map(kind => {
          const matches = ranked.filter(item => item.kind === kind);
          return {
            name: `${kind}s`,
            items: expanded === kind ? matches : matches.slice(0, 5),
            total: matches.length,
            kind,
          };
        })
        .filter(group => group.total)
        // An id match leads: its group comes before groups that only matched the text.
        .sort((a, b) => (idPrefix(query) ? ranked.indexOf(a.items[0]!) - ranked.indexOf(b.items[0]!) : 0))
    );
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

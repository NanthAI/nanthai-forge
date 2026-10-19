// SPDX-License-Identifier: Apache-2.0
import type { WorkData, Lane, PlanningItem } from '../../src/work-types';
export type PortfolioItem = {
  id: string;
  title: string;
  kind: 'Intent' | 'Lane' | 'View' | 'Plan';
  status: string;
  at?: string;
  intentId?: string;
  laneId?: string;
  viewId?: string;
  planId?: string;
  detail: string;
};
export type PortfolioInput = {
  intents: WorkData['intents'];
  lanes: Lane[];
  views: WorkData['views'];
  plans: PlanningItem[];
};
/** Attention reflects explicit recorded states; an active item is not an inferred request for human intervention. */
export function portfolioWork({ intents, lanes, views, plans }: PortfolioInput) {
  const intentItems: PortfolioItem[] = intents.map(intent => ({
    id: `intent:${intent.id}`,
    title: intent.outcome,
    kind: 'Intent',
    status: intent.status,
    at: intent.createdAt,
    intentId: intent.id,
    detail: intent.status === 'ready' ? 'Marked ready for review' : 'Desired outcome',
  }));
  const laneItems: PortfolioItem[] = lanes.map(lane => ({
    id: `lane:${lane.id}`,
    title: lane.name,
    kind: 'Lane',
    status: lane.state,
    intentId: lane.intentId,
    laneId: lane.id,
    detail: [
      lane.assignment || 'Nobody working',
      intents.find(intent => intent.id === lane.intentId)?.outcome ?? 'Linked Intent',
    ].join(' · '),
  }));
  const latestViews = new Map<string, WorkData['views'][number]>();
  for (const view of views) {
    const current = latestViews.get(view.intentId);
    if (!current || view.at >= current.at) latestViews.set(view.intentId, view);
  }
  const viewItems: PortfolioItem[] = views.map(view => ({
    id: `view:${view.id}`,
    title: intents.find(intent => intent.id === view.intentId)?.outcome ?? 'Retained source View',
    kind: 'View',
    status: view.status,
    at: view.at,
    intentId: view.intentId,
    viewId: view.id,
    detail:
      view.status === 'conflict' ? 'Source composition has unresolved conflicts' : 'Combined source recorded',
  }));
  const activeIntents = new Set(
    intents.filter(intent => ['active', 'ready'].includes(intent.status)).map(intent => intent.id),
  );
  const attention = [
    ...intentItems.filter(item => item.status === 'ready'),
    ...laneItems.filter(item => item.status === 'ready'),
    ...viewItems.filter(
      item =>
        item.status === 'conflict' &&
        activeIntents.has(item.intentId!) &&
        latestViews.get(item.intentId!)?.id === item.viewId,
    ),
  ];
  const active = [
    ...intentItems.filter(item => ['active', 'ready'].includes(item.status)),
    ...laneItems.filter(item => item.status !== 'completed'),
  ];
  const completed = [...intentItems, ...laneItems].filter(item => item.status === 'completed');
  const recentCandidates = [
    ...viewItems,
    ...plans.map((plan): PortfolioItem => ({
      id: `plan:${plan.id}`,
      title: plan.title,
      kind: 'Plan',
      status: plan.status,
      at: plan.at,
      planId: plan.id,
      detail: `${plan.kind} · ${plan.intentIds.length} linked Intents`,
    })),
  ].sort((a, b) => b.at!.localeCompare(a.at!));
  const seen = new Set<string>();
  const recent = recentCandidates.filter(item => {
    const key = item.intentId ? `intent:${item.intentId}` : item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { attention, active, completed, recent };
}
export function projectWorkLink(projectId: string, item?: PortfolioItem) {
  const params = new URLSearchParams({ surface: 'projects', collection: 'projects', project: projectId });
  if (item?.laneId) {
    params.set('projectTab', 'lanes');
    params.set('lane', item.laneId);
  } else if (item?.planId) {
    params.set('projectTab', 'planning');
    params.set('planningItem', item.planId);
  } else if (item?.intentId) {
    params.set('projectTab', 'intent');
    params.set('intent', item.intentId);
    params.set('intentTab', item.viewId || item.status === 'ready' ? 'delivery' : 'discussion');
    if (item.viewId) params.set('reviewView', item.viewId);
  }
  return `?${params}`;
}

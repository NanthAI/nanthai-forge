// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** What a visitor may see of a project (Items 76be0714, 8947a779). Every public read (the cached public page, explore,
 * profiles, share cards, the sitemap and the agent lookup) passes through these functions.
 *
 * The plan fields and their rule belong to the planning contract (Item d3357f40, docs/planning.md "Public plan"): an
 * Item's `hidden`, the project's `planVisibility` and `publicPlanVisible` in src/planning-model.ts.
 *
 * Open Lane titles are this Lane's own setting: shown only when the project opts in; otherwise visitors get counts.
 * Pure: no reads, no clock. */

export type PlanVisibility = 'public' | 'members';
export type ProjectVisibility = {
  visibility?: 'public' | 'private';
  removal?: unknown;
  /** From the planning contract; absent means public. */
  planVisibility?: PlanVisibility;
};
export const isPublicProject = (project: ProjectVisibility | null | undefined): boolean =>
  project?.visibility === 'public' && !project.removal;

import { publicPlanVisible } from '../src/planning-model';
export { publicPlanVisible } from '../src/planning-model';
type Hideable = { hidden?: boolean; status?: string; initiativeId?: string | null; parentId?: string | null };

export type PlanRow = Hideable & { id: string; kind: string };
/** The plan rows a visitor may see, in their given order. `known` holds every looked-up row by id (Initiatives and
 * parents included); a row naming an id that was not looked up stays hidden. */
export function visiblePlan<T extends PlanRow>(
  project: ProjectVisibility | null | undefined,
  rows: readonly T[],
  known: ReadonlyMap<string, PlanRow> = new Map(rows.map(row => [row.id, row])),
): T[] {
  if (!isPublicProject(project)) return [];
  const look = (id: string | null | undefined) => (id ? (known.get(id) ?? undefined) : null);
  return rows.filter(row => {
    const parent = look(row.parentId);
    return publicPlanVisible({
      projectVisibility: 'public',
      ...(project!.planVisibility ? { planVisibility: project!.planVisibility } : {}),
      item: row,
      initiative: look(row.initiativeId),
      parent,
      parentInitiative: parent ? look(parent.initiativeId) : undefined,
    });
  });
}

/** Open Lanes as a visitor sees them: titles only when the project opted in; Lane ids never. */
export function visibleLanes<T extends { title?: string; laneId?: string }>(
  project: ProjectVisibility | null | undefined,
  laneTitles: boolean,
  lanes: readonly T[],
): Array<Omit<T, 'title' | 'laneId'> & { title?: string }> {
  if (!isPublicProject(project)) return [];
  return lanes.map(lane => {
    const rest: Omit<T, 'title' | 'laneId'> & { title?: string; laneId?: string } = { ...lane };
    delete rest.title;
    delete rest.laneId;
    return laneTitles && lane.title ? { ...rest, title: lane.title } : rest;
  });
}

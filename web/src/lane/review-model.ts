// SPDX-License-Identifier: Apache-2.0
import type { FileProvenancePlan } from '../../../src/view-provenance-plan';
import type { ViewReadModel } from '../../../src/view-read-model';
export type ReviewFile = FileProvenancePlan & {
  additions?: number | null;
  deletions?: number | null;
  why?: {
    intentId: string;
    outcome: string | null;
    notes: { id: string; kind: string; excerpt: string; at: string }[];
  }[];
};
export type ReviewRead = ViewReadModel & {
  files: { items: ReviewFile[]; nextOffset?: number | null; nextCursor?: string | null; total: number };
  available?: boolean;
  reason?: string;
};
export type ReviewGroup = {
  id: string;
  laneId: string;
  message: string;
  at: string;
  saveIndex: number;
  actor: string;
  paths: string[];
};
/** One cohort per recorded save, ordered within each pinned Lane. No inferred purpose or authorship. */
export function reviewGroups(files: readonly ReviewFile[]): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const file of files)
    for (const contributor of file.contributors)
      for (const save of contributor.saves) {
        const id = `${contributor.laneId}:${save.head}`;
        let group = groups.get(id);
        if (!group) {
          group = {
            id,
            laneId: contributor.laneId,
            message: save.message || 'Saved changes',
            at: save.at,
            saveIndex: save.saveIndex,
            actor:
              save.actor?.name && save.actor.name !== 'Agent workflow' && !save.actor.name.includes('_')
                ? save.actor.name
                : '—',
            paths: [],
          };
          groups.set(id, group);
        }
        if (!group.paths.includes(file.path)) group.paths.push(file.path);
      }
  return [...groups.values()].sort(
    (a, b) => a.at.localeCompare(b.at) || a.laneId.localeCompare(b.laneId) || a.saveIndex - b.saveIndex,
  );
}

export function reviewViewLabel(
  views: readonly { id: string; at: string; intentId: string }[],
  viewId: string,
) {
  const selected = views.find(view => view.id === viewId);
  const ordered = views
    .filter(view => view.intentId === selected?.intentId)
    .slice()
    .sort((a, b) => a.at.localeCompare(b.at));
  const index = ordered.findIndex(view => view.id === viewId);
  return index < 0 ? 'View' : `View ${index + 1}`;
}

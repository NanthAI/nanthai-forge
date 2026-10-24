// SPDX-License-Identifier: Apache-2.0
import type { WorkData, WorkView } from './work-types.js';
import { viewContributors } from './view-read-model.js';

export type ProvenanceFile = { path: string; blob: string; mode: string };
export function provenancePlan(
  data: WorkData,
  view: WorkView,
  states: ReadonlyMap<string, readonly ProvenanceFile[]>,
  fileMaps = new Map<string, Map<string, ProvenanceFile>>(),
) {
  if (!view.head || view.status === 'conflict') return [];
  const original = states.get(view.base),
    selected = states.get(view.head);
  if (!original || !selected) return null;
  const a = new Map(original.map(file => [file.path, file])),
    b = new Map(selected.map(file => [file.path, file]));
  const contributors = viewContributors(data, view);
  const historyComplete =
    view.inputs.every(input => data.lanes.some(lane => lane.id === input.laneId)) &&
    contributors.every(c => c.saves.every(({ save }) => states.has(save.parent) && states.has(save.head)));
  const files = (head: string) => {
    let result = fileMaps.get(head);
    const state = states.get(head);
    if (!result && state) {
      result = new Map(state.map(file => [file.path, file]));
      fileMaps.set(head, result);
    }
    return result;
  };
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap(path => {
    const before = a.get(path) ?? null,
      after = b.get(path) ?? null;
    if (before?.blob === after?.blob && before?.mode === after?.mode) return [];
    return [
      {
        path,
        status: !before ? ('added' as const) : !after ? ('deleted' as const) : ('modified' as const),
        before,
        after,
        historyComplete,
        contributors: contributors.flatMap(contributor => {
          const lane = data.lanes.find(lane => lane.id === contributor.laneId)!;
          const saves = contributor.saves.flatMap(({ saveIndex, save }) => {
            const parent = files(save.parent),
              head = files(save.head);
            if (!parent || !head) return [];
            const before = parent.get(path) ?? null,
              after = head.get(path) ?? null;
            if (before?.blob === after?.blob && before?.mode === after?.mode) return [];
            return [
              {
                saveIndex,
                head: save.head,
                parent: save.parent,
                message: save.message,
                at: save.at,
                actor: save.actor ?? null,
                actorSource: save.actor ? ('save' as const) : ('not-recorded' as const),
                laneActor: contributor.laneActor,
                operationId: save.operation?.id ?? null,
                kind: save.sync ? ('sync' as const) : ('checkpoint' as const),
                sync: save.sync ?? null,
                undoSync: save.undoSync ?? null,
                before,
                after,
              },
            ];
          });
          if (!saves.length) return [];
          const intent = data.intents.find(intent => intent.id === lane.intentId);
          return [
            {
              viewId: contributor.viewId,
              laneId: lane.id,
              head: contributor.head,
              intentId: lane.intentId,
              outcome: intent?.outcome ?? null,
              version: files(contributor.head)?.get(path) ?? null,
              saves,
            },
          ];
        }),
      },
    ];
  });
}
export type FileProvenancePlan = NonNullable<ReturnType<typeof provenancePlan>>[number];

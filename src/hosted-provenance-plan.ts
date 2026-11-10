// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { provenanceHistoryReply } from './hosted-provenance-schema.js';
import type { NativeState } from './state/format.js';
import type { FileProvenancePlan, ProvenanceFile } from './view-provenance-plan.js';

type History = z.infer<typeof provenanceHistoryReply>;
/** Same selected-file plan as the retained native reader, from canonical versions rather than Work.
 * Authenticated requester accounts are separate from an executor identity that was not retained. */
export function canonicalProvenancePlan(
  path: string,
  before: ProvenanceFile | null,
  after: ProvenanceFile | null,
  history: History,
  states: ReadonlyMap<string, Pick<NativeState, 'files' | 'message' | 'parents'>>,
  complete: boolean,
) {
  let historyComplete = complete;
  const contributors: FileProvenancePlan['contributors'] = [];
  for (const item of history.histories) {
    const lane = item.selected;
    let previous = item.previous;
    let contiguous = item.complete && item.versions[0]?.lane.sourceVersion === 0;
    const saves = [];
    for (const { lane: version, operation } of item.versions) {
      if (
        previous &&
        version.sourceVersion !== previous.sourceVersion &&
        version.sourceVersion !== previous.sourceVersion + 1
      )
        contiguous = false;
      if (previous && version.head !== previous.head) {
        const parent = states.get(previous.head),
          saved = states.get(version.head);
        if (!parent || !saved) {
          contiguous = false;
          previous = version;
          continue;
        }
        const a = parent.files.find(f => f.path === path) ?? null;
        const b = saved.files.find(f => f.path === path) ?? null;
        if (a?.blob !== b?.blob || a?.mode !== b?.mode)
          saves.push({
            saveIndex: version.sourceVersion - 1,
            head: version.head,
            parent: previous.head,
            message: operation?.message ?? saved.message,
            at: version.at,
            actor: null,
            actorSource: 'not-recorded' as const,
            laneActor: null,
            // The public account handle is an operation requester, not a guessed executor identity.
            requester: operation?.actor ?? null,
            operationId: operation?.operationId ?? null,
            kind: operation?.kind ?? (saved.parents.length > 1 ? ('sync' as const) : ('checkpoint' as const)),
            sync: null,
            undoSync: null,
            before: a,
            after: b,
          });
      }
      previous = version;
    }
    contiguous &&= previous?.sourceVersion === lane.sourceVersion && previous?.head === lane.head;
    historyComplete &&= contiguous;
    if (saves.length)
      contributors.push({
        viewId: history.candidate.id,
        laneId: lane.id,
        head: lane.head,
        intentId: lane.intentId,
        outcome: history.why.find(value => value.intentId === lane.intentId)?.outcome ?? null,
        version: states.get(lane.head)?.files.find(f => f.path === path) ?? null,
        saves,
      });
  }
  return {
    path,
    status: !before ? ('added' as const) : !after ? ('deleted' as const) : ('modified' as const),
    before,
    after,
    historyComplete,
    contributors,
  } satisfies FileProvenancePlan;
}

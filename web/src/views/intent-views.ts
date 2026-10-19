// SPDX-License-Identifier: Apache-2.0
import type { ViewRow } from '../intents/IntentDetail';
import { latestRun, type CockpitWork } from '../cockpit/model';
/** Same Intent + Lane identities is the H17 supersession family; heads can change. */
export function intentViews(work: CockpitWork, intentId: string): ViewRow[] {
  const family = (view: CockpitWork['views'][number]) =>
    JSON.stringify([view.intentId, (view.inputs ?? []).map(i => i.laneId).sort()]);
  const latest = new Map(work.views.map(view => [family(view), view.id]));
  return work.views
    .filter(view => view.intentId === intentId)
    .map(view => {
      const run = view.head
        ? latestRun(
            work.runs.filter(run => run.head === view.head),
            view.id,
          )
        : undefined;
      return {
        id: view.id,
        at: view.at,
        status: view.status,
        lanes: (view.inputs ?? [])
          .map(input => work.lanes.find(l => l.id === input.laneId)?.name ?? 'Lane')
          .join(' + '),
        inputs: (view.inputs ?? []).map(input => {
          const lane = work.lanes.find(l => l.id === input.laneId);
          const saved = lane?.checkpoints
            ?.map(s => (s.at <= view.at ? s.head : null))
            .lastIndexOf(input.head);
          const saveIndex =
            saved !== undefined
              ? saved
              : lane?.head === input.head && lane.lastCheckpointAt && lane.lastCheckpointAt <= view.at
                ? (lane.checkpointCount ?? 0) - 1
                : undefined;
          return { ...input, ...(saveIndex !== undefined ? { saveIndex } : {}) };
        }),
        supersededBy: latest.get(family(view)) !== view.id ? latest.get(family(view)) : null,
        acceptedAt: (work.channelMoves ?? []).find(
          move => move.viewId === view.id && move.status === 'accepted',
        )?.at,
        accepted: (work.channelMoves ?? []).some(
          move => move.viewId === view.id && move.status === 'accepted',
        ),
        ...(run
          ? { check: run.status, checkHead: run.head, checkName: run.checkName ?? run.check?.name }
          : {}),
        ...(view.head ? { head: view.head } : {}),
      };
    });
}

/** Review only current evidence on a retained candidate, never accepted or superseded history. */
export function canReviewView(view: ViewRow): boolean {
  return (
    view.status === 'clean' &&
    !view.accepted &&
    !view.supersededBy &&
    view.check === 'passed' &&
    Boolean(view.head) &&
    view.checkHead === view.head
  );
}

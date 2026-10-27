// SPDX-License-Identifier: Apache-2.0
import type { Lane } from './work-types.js';
import { metricSavedHead, type Requester } from './self-metrics-journal.js';
import { recordMetricObservation } from './self-metrics-observations.js';
/** Reuse the active/unlanded selection and source summaries already read for a save. */
export function recordMetricOverlapSave(
  directory: string,
  focus: Lane,
  lanes: Lane[],
  paths: (lane: Lane) => string[],
  complete: boolean,
) {
  try {
    metricSavedHead(focus.id, focus.head);
    const changed = new Set(paths(focus));
    const overlaps = lanes
      .filter(lane => lane.id !== focus.id)
      .flatMap(lane => {
        const shared = paths(lane).filter(path => changed.has(path));
        return shared.length ? [{ laneId: lane.id, head: lane.head, paths: shared }] : [];
      });
    recordMetricObservation(directory, {
      type: 'save',
      id: `save:${focus.id}:${focus.head}`,
      at: focus.checkpoints?.at(-1)?.at ?? new Date().toISOString(),
      laneId: focus.id,
      head: focus.head,
      parent: focus.checkpoints?.at(-1)?.parent,
      overlaps,
      complete,
    });
  } catch {
    // Observation cannot invalidate a committed save. Missing records remain partial.
    process.emitWarning('Overlap metric could not be recorded.', { code: 'METRIC_RECEIPT_UNAVAILABLE' });
  }
}
export function recordLifecycleOverlap(
  directory: string,
  input: unknown,
  response: unknown,
  requester: Requester,
  name: string,
) {
  if (name !== 'self-metrics.jsonl') return;
  const command = input as { laneId?: string };
  const result = (
    response as {
      result?: {
        head?: string;
        parent?: string;
        peers?: {
          overlaps?: { via: string; paths: string[] }[];
          inbox?: { noticeId: string; file: string }[];
        };
      };
    }
  )?.result;
  const laneId = requester.savedHead?.laneId ?? command.laneId;
  const head = requester.savedHead?.head ?? result?.head;
  if (!laneId || !head || (result?.head === result?.parent && !requester.savedHead)) return;
  const paths = [
    ...new Set([
      ...(result?.peers?.overlaps ?? []).filter(peer => peer.via === 'edit').flatMap(peer => peer.paths),
      ...(result?.peers?.inbox ?? []).map(notice => notice.file),
    ]),
  ];
  if (!paths.length) return;
  recordMetricObservation(directory, {
    type: 'overlap-delivery',
    id: `delivery:${requester.operationId}`,
    at: new Date().toISOString(),
    laneId,
    head,
    paths,
    noticeIds: (result?.peers?.inbox ?? []).map(notice => notice.noticeId),
    via: 'lifecycle',
  });
}

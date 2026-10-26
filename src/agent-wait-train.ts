// SPDX-License-Identifier: Apache-2.0
import { CoordinationJournal } from './agent-coordination-journal.js';
import { planLandingTrain } from './landing-train-plan.js';
import type { WorkStore } from './work-store.js';
import type { WaitEvent } from './agent-wait-run.js';

/** Existing bilateral alerts are immutable history, separate from the train's
 * freshly derived submitted-head plan. Neither read starts a driver or a check. */
export function waitTrainEvents(store: WorkStore, laneIds: ReadonlySet<string>): WaitEvent[] {
  if (!laneIds.size) return [];
  const journal = new CoordinationJournal(store);
  const notices = new Map(
    [...laneIds].flatMap(id => journal.overlaps(id)).map(notice => [notice.noticeId, notice]),
  );
  const events: WaitEvent[] = [...notices.values()].map(notice => ({
    type: 'notice',
    id: notice.noticeId,
    status: 'overlap',
    terminal: false,
    ok: false,
    reason: notice.text,
    participants: notice.lanes,
    inputs: notice.lanes.map((laneId, index) => ({ laneId, head: notice.heads[index] })),
    paths: [notice.file],
    proposedOrder: notice.proposedOrder,
    historical: notice.lanes.some((id, index) => store.select('lanes', id)?.head !== notice.heads[index]),
  }));
  const tx = store.readRecords();
  const entries = tx
    ? Array.from({ length: tx.manifest.collections.landingEntries?.count ?? 0 }, (_, index) =>
        tx.at('landingEntries', index)!,
      )
    : (store.load().landingEntries ?? []);
  if (!entries.length) return events;
  const related = entries.filter(entry =>
    store.select('views', entry.viewId)?.inputs.some(pin => laneIds.has(pin.laneId)),
  );
  if (!related.length) return events;
  const data = store.load();
  for (const channel of new Set(related.map(entry => entry.channel))) {
    const train = planLandingTrain(store, data, channel);
    events.push({
      type: 'train',
      id: channel,
      status: train.pending.length || train.active.length ? 'planned' : 'idle',
      terminal: false,
      ok: false,
      channel,
      main:
        [...data.channelMoves].reverse().find(move => move.channel === channel && move.status === 'accepted')
          ?.head ?? null,
      coverage: train.plan.coverage,
      groups: train.plan.groups,
      order: train.ordered.map(entry => entry.id),
      entries: train.ordered.map(entry => ({
        entryId: entry.id,
        status: entry.status,
        inputs: data.views.find(view => view.id === entry.viewId)?.inputs ?? [],
      })),
      waits: train.waits,
      reason: train.waits.length
        ? 'Overlapping submissions compose on accepted main after their predecessors settle.'
        : 'Disjoint submissions can share a compatible batch.',
    });
  }
  return events;
}

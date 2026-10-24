// SPDX-License-Identifier: Apache-2.0
import { frictionEvents } from './friction.js';
import type { WorkStore } from './work-store.js';
import type { FrictionCapture, FrictionEvent } from './friction-types.js';
import type { WorkData, ChannelMove, WorkView } from './work-types.js';

/** Case, punctuation, spacing and word order do not split the same report. */
export const normaliseFriction = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.sort()
    .join(' ') ?? '';
type Resolution = {
  status: 'open' | 'fixed' | 'planned' | 'dropped';
  reason?: string;
  laneId?: string | undefined;
  at: string;
  order: number;
};
function resolutions(events: FrictionEvent[], moves: ChannelMove[], views: WorkView[]) {
  const result = new Map<string, Resolution>();
  const set = (id: string, next: Resolution) => {
    const old = result.get(id);
    if (!old || next.at > old.at || (next.at === old.at && next.order > old.order)) result.set(id, next);
  };
  events.forEach((event, order) => {
    if (event.kind === 'triage')
      for (const id of event.frictionIds)
        set(id, {
          status: event.status,
          ...(event.reason ? { reason: event.reason } : {}),
          ...(event.laneId ? { laneId: event.laneId } : {}),
          at: event.at,
          order,
        });
    if (event.kind !== 'cite') return;
    for (const move of moves) {
      if (move.status !== 'accepted' || move.at < event.at) continue;
      const view = views.find(view => view.id === move.viewId);
      if (!view?.inputs.some(input => input.laneId === event.laneId)) continue;
      for (const id of event.frictionIds)
        set(id, {
          status: 'fixed',
          laneId: event.laneId,
          reason: `Landed on ${move.channel}`,
          at: move.at,
          order,
        });
    }
  });
  return result;
}
export function groupFriction(events: FrictionEvent[], moves: ChannelMove[] = [], views: WorkView[] = []) {
  const counts = new Map<string, { count: number; retries: number; at: string }>();
  for (const event of events)
    if (event.kind === 'count') {
      const old = counts.get(event.frictionId);
      counts.set(event.frictionId, {
        count: Math.max(old?.count ?? 0, event.count),
        retries: Math.max(old?.retries ?? 0, event.retries),
        at: old && old.at > event.at ? old.at : event.at,
      });
    }
  const resolved = resolutions(events, moves, views),
    groups = new Map<string, FrictionCapture[]>();
  for (const event of events) {
    if (event.kind !== 'capture') continue;
    const repeated = counts.get(event.id);
    const report = repeated
      ? {
          ...event,
          count: Math.max(event.count, repeated.count),
          cost: { ...event.cost, retries: Math.max(event.cost?.retries ?? 0, repeated.retries) },
        }
      : event;
    const key = JSON.stringify([normaliseFriction(event.area), normaliseFriction(event.title)]);
    const rows = groups.get(key) ?? [];
    rows.push(report);
    groups.set(key, rows);
  }
  const statusOrder = { open: 0, planned: 1, fixed: 2, dropped: 3 };
  return [...groups]
    .map(([key, rows]) => {
      rows.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      const records = rows.map(row => ({
        ...row,
        resolution: (resolved.get(row.id) ?? {
          status: 'open',
          at: row.at,
          order: -1,
        }) as Resolution,
      }));
      const statuses = records.map(row => row.resolution.status);
      const status = statuses.reduce((a, b) => (statusOrder[a] < statusOrder[b] ? a : b));
      return {
        key,
        title: rows[0]!.title,
        area: rows[0]!.area,
        status,
        count: rows.reduce((n, row) => n + row.count, 0),
        cost: {
          minutes: rows.reduce((n, row) => n + (row.cost?.minutes ?? 0), 0),
          retries: rows.reduce((n, row) => n + (row.cost?.retries ?? 0), 0),
        },
        costReported: rows.some(row => row.cost !== undefined),
        minutesReported: rows.some(row => row.cost?.minutes !== undefined),
        retriesReported: rows.some(row => row.cost?.retries !== undefined),
        firstSeen: rows[0]!.at,
        lastSeen: rows.reduce((last, row) => [last, row.at, counts.get(row.id)?.at ?? ''].sort().at(-1)!, ''),
        fixedBy: [
          ...new Set(
            records
              .filter(row => row.resolution.status === 'fixed')
              .flatMap(row => (row.resolution.laneId ? [row.resolution.laneId] : [])),
          ),
        ].sort(),
        frictionIds: rows.map(row => row.id),
        records,
      };
    })
    .sort(
      (a, b) =>
        statusOrder[a.status] - statusOrder[b.status] ||
        b.count - a.count ||
        b.cost.minutes - a.cost.minutes ||
        b.cost.retries - a.cost.retries ||
        a.key.localeCompare(b.key),
    );
}
export function readImprovements(store: WorkStore) {
  return store.observing(() => {
    const tx = store.readRecords();
    const all = <K extends 'views' | 'channelMoves'>(name: K) =>
      tx
        ? (Array.from({ length: tx.manifest.collections[name]?.count ?? 0 }, (_, i) =>
            tx.at(name, i),
          ) as WorkData[K])
        : store.load()[name];
    const events = frictionEvents(store),
      cited = events.some(event => event.kind === 'cite');
    return {
      revision: store.revision(),
      result: { groups: groupFriction(events, cited ? all('channelMoves') : [], cited ? all('views') : []) },
    };
  });
}
export function formatImprovements(result: ReturnType<typeof readImprovements>['result']) {
  if (!result.groups.length) return 'No friction reported.\n';
  return (
    result.groups
      .map(
        (group, i) =>
          `${i + 1}. [${group.status}] ${group.area}: ${group.title}\n   ${group.count} occurrence(s) · ${group.costReported ? `${group.minutesReported ? `${group.cost.minutes} reported minutes` : 'minutes unreported'} · ${group.retriesReported ? `${group.cost.retries} reported retries` : 'retries unreported'}` : 'cost unreported'}\n   ${group.firstSeen} → ${group.lastSeen}\n   ids: ${group.frictionIds.join(', ')}${group.fixedBy.length ? `\n   fixed by: ${group.fixedBy.join(', ')}` : ''}`,
      )
      .join('\n') + '\n'
  );
}

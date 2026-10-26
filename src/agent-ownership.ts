// SPDX-License-Identifier: Apache-2.0
import { PeersCache } from './agent-peers-cache.js';
import { pageHashes, pageSize } from './work-records.js';
import { readHostState } from './host-binding.js';
import { PRESENCE, activityAt } from './presence.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';

/** Ownership is advisory; only an explicit take of another actor's Lane needs confirmation. */
export function laneOwnership(
  store: WorkStore,
  lane: Lane,
  now = Date.now(),
  presence = readHostState(store).presence,
) {
  const actor = lane.owner?.actor ?? lane.startedBy?.name;
  if (!actor) return undefined;
  const sessions = Object.values(presence ?? {}).filter(
    session => session.context.laneId === lane.id && session.name === actor,
  );
  const session = sessions.sort((a, b) => activityAt(b) - activityAt(a))[0];
  const at = session ? activityAt(session) : Date.parse(lane.owner?.at ?? '');
  const quietMs = Number.isFinite(at) ? Math.max(0, now - at) : undefined;
  return {
    actor,
    ...(session ? { sessionId: session.sessionId } : {}),
    ...(quietMs !== undefined ? { quietMs } : {}),
    state:
      session?.status === 'waiting'
        ? 'waiting'
        : quietMs !== undefined && quietMs <= PRESENCE.workingMs
          ? 'working'
          : 'quiet',
  };
}

export function duplicateStartWarnings(
  store: WorkStore,
  laneId: string,
  outcome: string,
  overlaps: { lane: string }[] = [],
) {
  const tx = store.readRecords(),
    legacy = tx ? undefined : store.load();
  const cache = new PeersCache(store.root);
  const lanes = tx
    ? (tx.manifest.collections.lanes?.pages ?? []).flatMap((hash, page) => {
        const key = `lane-fields-v1:${hash}`;
        const cached = cache.read<Lane[]>(key);
        if (cached) return cached;
        const rows = Array.from(
          { length: Math.min(pageSize, tx.manifest.collections.lanes!.count - page * pageSize) },
          (_, offset) => tx.fieldsAt('lanes', page * pageSize + offset).record,
        );
        cache.write(key, rows);
        return rows;
      })
    : legacy!.lanes;
  const outcomes = new Map<string, string>();
  if (tx) {
    const intents = tx.manifest.collections.intents;
    for (const [page, hash] of (intents?.pages ?? []).entries()) {
      const key = `ownership-intents-v1:${hash}`;
      let rows = cache.read<{ id: string; outcome: string }[]>(key);
      if (!rows || rows.length !== Math.min(pageSize, intents!.count - page * pageSize)) {
        const slot = `ownership-intent-slot-v1:${page}`,
          hashes = pageHashes(store.directory, hash);
        const prior = cache.read<{ hashes: string[]; rows: { id: string; outcome: string }[] }>(slot);
        rows = hashes.map((id, offset) => {
          if (prior?.hashes[offset] === id && prior.rows[offset]) return prior.rows[offset]!;
          const intent = tx.fieldsAt('intents', page * pageSize + offset).record;
          return { id: intent.id, outcome: intent.outcome };
        });
        cache.write(slot, { hashes, rows });
        cache.write(key, rows);
      }
      for (const row of rows) outcomes.set(row.id, row.outcome);
    }
  } else for (const intent of legacy!.intents) outcomes.set(intent.id, intent.outcome);
  const ids = new Set(overlaps.map(item => item.lane));
  const normalized = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const lane of lanes) {
    if (lane.id === laneId || !['active', 'paused', 'ready'].includes(lane.state)) continue;
    const other = outcomes.get(lane.intentId);
    if (other !== undefined && normalized(other) === normalized(outcome)) ids.add(lane.id);
  }
  return [...ids]
    .sort()
    .slice(0, 5)
    .map(id => `Lane ${id} already does this; take it or coordinate.`);
}

export function stalledLane(
  store: WorkStore,
  lane: Lane,
  ownership: ReturnType<typeof laneOwnership>,
  unlanded: boolean,
) {
  if (
    !unlanded ||
    !ownership ||
    ownership.quietMs === undefined ||
    ownership.quietMs <= PRESENCE.workingMs ||
    ownership.state === 'waiting' ||
    lane.state === 'paused'
  )
    return;
  const tx = store.readRecords(),
    data = tx ? undefined : store.load();
  const views = tx
    ? tx.all('views', lane.intentId, 'intentId')
    : data!.views.filter(view => view.intentId === lane.intentId);
  const ids = new Set(
    views.filter(view => view.inputs.some(input => input.laneId === lane.id)).map(view => view.id),
  );
  const runs = tx
    ? [...ids].flatMap(id => tx.all('runs', id, 'viewId'))
    : data!.runs.filter(run => ids.has(run.viewId));
  if (runs.some(run => ['queued', 'preparing', 'running'].includes(run.status) && !run.cancelRequested))
    return;
  return {
    lane: lane.id,
    actor: ownership.actor.slice(0, 200),
    quietMs: ownership.quietMs,
    offer: 'take' as const,
  };
}

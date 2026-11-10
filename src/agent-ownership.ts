// SPDX-License-Identifier: Apache-2.0
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
    // `completed` is the web's word too (presenceState): a finished session is not working (SM-C M11).
    state:
      session?.status === 'waiting'
        ? 'waiting'
        : session?.status === 'completed'
          ? 'completed'
          : quietMs !== undefined && quietMs <= PRESENCE.workingMs
            ? 'working'
            : 'quiet',
  };
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

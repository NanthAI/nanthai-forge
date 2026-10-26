// SPDX-License-Identifier: Apache-2.0
import { collapseSessions } from '../../../src/presence';
import { flattenSessions, isPersonSession, type Session } from '../coordination-view';
import type { CockpitWork } from '../cockpit/model';
import type { IntentRow } from './model';

const named = (name: string | undefined): name is string =>
  Boolean(name?.trim() && !/^agent workflow$/i.test(name.trim()));

/** Same recorded session tree and actor kinds as Now; attribution is not a claim of liveness. */
export function intentBoardFacts(
  rows: readonly IntentRow[],
  work: CockpitWork & {
    channelMoves?: readonly { viewId: string; channel: string; status?: string; at?: string }[];
  },
  sessions: readonly Session[],
): IntentRow[] {
  const agents = collapseSessions(flattenSessions(sessions)).filter(
    session => !isPersonSession(session) && named(session.name),
  );
  const byView = new Map(work.views.map(view => [view.id, view]));
  const landings = (work.channelMoves ?? [])
    .filter(move => move.channel === 'main' && (!move.status || move.status === 'accepted') && move.at)
    .map(move => {
      const included = new Set<string>();
      const pending = [move.viewId];
      while (pending.length) {
        const id = pending.pop()!;
        if (included.has(id)) continue;
        const view = byView.get(id);
        if (!view) continue;
        included.add(id);
        for (const dependency of view.dependencies ?? []) {
          if (dependency.kind === 'view' && byView.get(dependency.viewId)?.head === dependency.head)
            pending.push(dependency.viewId);
        }
      }
      return { at: move.at!, included };
    });
  return rows.map(row => {
    const laneIds = new Set(row.lanes.map(lane => lane.id));
    const people = new Map<string, { name: string; identity: string }>();
    for (const session of agents) {
      if (session.context.intentId === row.id || laneIds.has(session.context.laneId ?? ''))
        people.set(session.name, { name: session.name, identity: session.sessionId });
    }
    for (const lane of row.lanes) {
      const name = lane.session?.name ?? lane.startedBy?.name;
      const agent = lane.session ? !lane.session.person : lane.startedBy?.kind === 'agent';
      if (agent && named(name) && !people.has(name))
        people.set(name, { name, identity: lane.session?.id ?? name });
    }
    const views = new Set(
      work.views
        .filter(view => view.intentId === row.id || view.inputs?.some(input => laneIds.has(input.laneId)))
        .map(view => view.id),
    );
    const landedAt = landings
      .filter(landing => [...views].some(id => landing.included.has(id)))
      .map(landing => landing.at)
      .sort()
      .at(-1);
    return { ...row, agents: [...people.values()], ...(landedAt ? { landedAt } : {}) };
  });
}

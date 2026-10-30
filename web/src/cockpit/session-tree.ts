// SPDX-License-Identifier: Apache-2.0
import { PRESENCE, activityAt, collapseSessions, presenceState } from '../../../src/presence';
import { flattenSessions, type Session } from '../coordination-view';

/**
 * Collapse across the whole tree; unfinished descendants survive a folded/completed parent.
 * Display filter only: completed, ended-Lane and day-old sessions are left out, never deleted.
 */
export function sessionTreeRows(
  sessions: readonly Session[],
  now: number,
  showStale: boolean,
  endedLaneIds: readonly string[] = [],
  keep: ReadonlySet<string> = new Set(),
) {
  const latest = collapseSessions(flattenSessions(sessions)).filter(
    session => !/^agent workflow$/i.test(session.name.trim()),
  );
  const retained = latest.filter(
    session =>
      (keep.has(session.sessionId) || session.status !== 'completed') &&
      !endedLaneIds.includes(session.context.laneId ?? '') &&
      (keep.has(session.sessionId) || now - activityAt(session) <= PRESENCE.hideMs),
  );
  const selected = new Set(retained.map(session => session.sessionId));
  const folded = retained.filter(
    session => presenceState(session, now) === 'not-seen' && !keep.has(session.sessionId),
  );
  const visit = (nodes: readonly Session[]): Session[] =>
    nodes
      .flatMap(session => {
        const subagents = visit(session.subagents ?? []);
        if (
          !selected.has(session.sessionId) ||
          (!showStale && presenceState(session, now) === 'not-seen' && !keep.has(session.sessionId))
        )
          return subagents;
        return [{ ...session, subagents }];
      })
      .sort((a, b) => activityAt(b) - activityAt(a));
  return {
    visible: visit(sessions),
    folded,
    listed: retained.length - folded.length,
    total: retained.length,
  };
}

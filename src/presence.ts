// SPDX-License-Identifier: Apache-2.0
/** Shared display defaults; these observations never expire or complete work. */
export const PRESENCE = {
  workingMs: 15 * 60_000,
  foldMs: 90 * 60_000,
  /** Who's working stops listing a session after this; Activity still shows it. */
  hideMs: 24 * 60 * 60_000,
  touchMs: 60_000,
} as const;
export type PresenceSignal = {
  lastSeen: number;
  lastActivity?: number;
  activityKind?: string;
  status: string;
};
export const activityAt = (signal: PresenceSignal) => signal.lastActivity ?? signal.lastSeen;
export function presenceState(signal: PresenceSignal, now: number) {
  if (signal.status === 'completed') return 'completed';
  const elapsed = now - activityAt(signal);
  return elapsed <= PRESENCE.workingMs ? 'working' : elapsed <= PRESENCE.foldMs ? 'quiet' : 'not-seen';
}
/** Keep the latest observation, including completion, before filtering visible sessions. */
export function collapseSessions<
  T extends PresenceSignal & { name: string; context: { laneId?: string }; sessionId: string },
>(sessions: readonly T[]): T[] {
  const rows = new Map<string, T>();
  for (const session of sessions) {
    const key = session.context.laneId
      ? JSON.stringify([session.name, session.context.laneId])
      : session.sessionId;
    const previous = rows.get(key);
    if (!previous || activityAt(previous) <= activityAt(session)) rows.set(key, session);
  }
  return [...rows.values()].sort((a, b) => activityAt(b) - activityAt(a));
}

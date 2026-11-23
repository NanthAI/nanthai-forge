// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { AgentPresence } from '../access-contract';
export type SessionRow = Omit<AgentPresence, 'lane' | 'name'> & {
  name: string | null;
  laneId: string;
  intentId: string;
  title: string;
};
export type SessionFilters = {
  find?: string;
  person?: string;
  app?: string;
  device?: string;
  deviceId?: string;
};
export type SessionsRead = {
  observedAt: number;
  rows: SessionRow[];
  continueCursor: string;
  isDone: boolean;
};
export type HolderRead = {
  laneId: string;
  title: string;
  head: string;
  version: number;
  state: string;
  authorityEpoch: number;
  at: number;
  canTake: boolean;
  needsReason: boolean;
  browserSessionId: string | null;
  enabled: boolean;
  holder: null | {
    actor: string;
    agent?: string;
    sessionId?: string;
    since: number;
    lastSeen: number;
    change?: {
      by: string;
      kind: string;
      reason?: string;
      previous: { actor: string; agent?: string; since: number } | null;
      savedHead: string;
    };
  };
  events: { id: string; person: string; at: number; action: string }[];
  continueCursor: string;
  isDone: boolean;
};
export function seen(at: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}
export const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
/** One thread can hold several Lanes. Legacy rows have no full key, so remain separate observations. */
export function sessionGroups(rows: SessionRow[]) {
  const people = new Map<string, Map<string, SessionRow[]>>();
  for (const row of rows) {
    if (!people.has(row.person)) people.set(row.person, new Map());
    const devices = people.get(row.person)!,
      key = row.device?.id ?? '';
    if (!devices.has(key)) devices.set(key, []);
    devices.get(key)!.push(row);
  }
  return [...people].map(([person, devices]) => ({ person, devices: [...devices.values()] }));
}

export function distinctSessions(rows: SessionRow[]) {
  const sessions = new Map<string, SessionRow & { laneCount: number }>();
  for (const row of rows) {
    const key = `${row.person}:${row.sessionId ?? row.laneId}`;
    const old = sessions.get(key);
    if (old) old.laneCount++;
    else sessions.set(key, { ...row, laneCount: 1 });
  }
  return [...sessions.values()];
}

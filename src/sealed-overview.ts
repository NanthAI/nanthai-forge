// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The names-only view of a stored sealed set: what the Secrets page shows and the top bar counts. Derived from the
// signed head and roster alone (the same records every reader verifies) plus the server's own side records; it holds
// no value, no ciphertext and no key. No Buffer and no node: builtins, so it runs inside a Convex function.
import { equalBytes, hex } from './sealed-portable.js';
import { deviceFingerprint } from './sealed-join.js';
import type { Entry, Head, NameRecord, Roster } from './sealed-records.js';

/** Items one page shows: names and rotate rows per set, and people per set. */
export const OVERVIEW_PAGE = { names: 100, rotate: 100, people: 25 } as const;

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The rotate list, derived from signed records only: each live name a removed device could open, because its value
 * has not changed since that device's last epoch. The one derivation the CLI (`rotateList`) and the page share. */
export function rotateRows(roster: Roster, head: Head) {
  return head.names
    .filter(n => n.kind !== 3 && n.valueEpoch <= roster.epoch)
    .map(record => ({ record, former: roster.former.filter(f => record.valueEpoch <= f.lastEpoch) }))
    .filter(row => row.former.length)
    .sort((a, b) => byName(a.record.name, b.record.name));
}

export type MarkNote = { id: Uint8Array; at: number; handle?: string };
export type PendingFacts = {
  proposalId: Uint8Array;
  proposerId: Uint8Array;
  name: string;
  at: number;
  op?: 1 | 2 | 3;
  kind?: 1 | 2 | 3;
};
/** A stored set row, as far as the overview reads it. */
export type OverviewSet = {
  head: Head;
  roster: Roster;
  revoked: readonly Uint8Array[];
  notes: readonly MarkNote[];
  formerHandles: readonly { id: Uint8Array; handle: string }[];
  joinRequests: readonly { deviceId: Uint8Array; accountId: Uint8Array | null; at: number }[];
  proposals: readonly PendingFacts[];
};

const marked = (set: Pick<OverviewSet, 'revoked'>, id: Uint8Array) =>
  set.revoked.some(m => equalBytes(m, id));
const accountKey = (entry: Pick<Entry, 'accountId'>) => hex(entry.accountId);

/** The take-out rows: marked person entries grouped by account (machines are never taken out by Forge's markers). */
export function takeOutRows(set: OverviewSet, handleOf: (accountId: Uint8Array) => string | null) {
  const groups = new Map<string, { accountId: Uint8Array; entries: Entry[] }>();
  for (const entry of set.roster.entries) {
    if (entry.entryKind !== 1 || !entry.accountId.length || !marked(set, entry.id)) continue;
    const group: { accountId: Uint8Array; entries: Entry[] } = groups.get(accountKey(entry)) ?? {
      accountId: entry.accountId,
      entries: [],
    };
    group.entries.push(entry);
    groups.set(accountKey(entry), group);
  }
  return [...groups.values()].map(group => {
    const notes = group.entries.flatMap(e => set.notes.filter(n => equalBytes(n.id, e.id)));
    const kept = notes.find(n => n.handle)?.handle;
    return {
      handle: kept ?? handleOf(group.accountId),
      // A handle kept on the marker means the person left the project; none means a computer's sign-in ended.
      left: Boolean(kept),
      at: notes.length ? Math.min(...notes.map(n => n.at)) : null,
      codes: group.entries.map(e => deviceFingerprint(e.id)),
    };
  });
}

/** The needs-you total of one set: removed people still listed, names to rotate and waiting proposals. This is the
 * number the project's top-bar counter sums, and the number of rows the page's Needs you region draws. */
export function setNeeds(roster: Roster, head: Head, revoked: readonly Uint8Array[], proposals: number) {
  const people = new Set<string>();
  for (const entry of roster.entries)
    if (entry.entryKind === 1 && entry.accountId.length && revoked.some(m => equalBytes(m, entry.id)))
      people.add(accountKey(entry));
  return people.size + rotateRows(roster, head).length + proposals;
}

const roleWord = (entries: readonly Entry[]) => (entries.some(e => e.role === 1) ? 'owner' : 'write');
const howWord = (how: Entry['how']): 'first' | 'auto' | 'code' =>
  how === 1 ? 'first' : how === 3 ? 'auto' : 'code';

/** The holders, people first with their computers inside, then machine keys. A computer's own name is shown only to
 * its own account (`self`). A joined-automatically computer that nobody confirmed by code carries `how: 'auto'`. */
export function holderRows(
  set: OverviewSet,
  self: Uint8Array,
  handleOf: (accountId: Uint8Array) => string | null,
) {
  const people = new Map<string, Entry[]>();
  const machines: Entry[] = [];
  for (const entry of set.roster.entries) {
    if (entry.entryKind === 2) machines.push(entry);
    else if (entry.entryKind === 1)
      people.set(accountKey(entry), [...(people.get(accountKey(entry)) ?? []), entry]);
  }
  const rows = [...people.entries()].map(([key, entries]) => {
    const accountId = entries[0]!.accountId;
    const mine = equalBytes(accountId, self);
    const notes = entries.flatMap(e => set.notes.filter(n => equalBytes(n.id, e.id)));
    const left = entries.every(e => marked(set, e.id)) ? (notes.find(n => n.handle) ?? notes[0]) : undefined;
    return {
      key,
      handle: notes.find(n => n.handle)?.handle ?? handleOf(accountId),
      role: roleWord(entries) as 'owner' | 'write',
      ...(mine ? { mine: true as const } : {}),
      ...(left ? { left: true as const, leftAt: left.at } : {}),
      computers: entries
        .map(e => ({
          code: deviceFingerprint(e.id),
          how: howWord(e.how),
          ...(mine && e.displayName ? { name: e.displayName } : {}),
          ...(marked(set, e.id) ? { marked: true as const } : {}),
        }))
        .sort((a, b) => byName(a.code, b.code)),
    };
  });
  rows.sort(
    (a, b) =>
      Number(b.role === 'owner') - Number(a.role === 'owner') ||
      byName(a.handle ?? '￿', b.handle ?? '￿') ||
      byName(a.key, b.key),
  );
  const keys = machines
    .map(e => ({
      code: deviceFingerprint(e.id),
      by: handleOf(set.roster.entries.find(o => equalBytes(o.id, e.addedBy))?.accountId ?? new Uint8Array()),
    }))
    .sort((a, b) => byName(a.code, b.code));
  return { people: rows.map(({ key: _key, ...row }) => row), machines: keys };
}

/** The live names, A to Z, with each name's waiting proposals and whether it is on the rotate list. */
export function nameRows(set: OverviewSet, handleOf: (accountId: Uint8Array) => string | null) {
  const rotate = new Set(rotateRows(set.roster, set.head).map(r => r.record.name));
  const author = (record: NameRecord) => {
    const entry = set.roster.entries.find(e => equalBytes(e.id, record.changedBy));
    return entry?.accountId.length ? handleOf(entry.accountId) : null;
  };
  return set.head.names
    .filter(n => n.kind !== 3)
    .sort((a, b) => byName(a.name, b.name))
    .map(n => ({
      name: n.name,
      kind: n.kind as 1 | 2,
      version: n.valueVersion,
      at: n.changedAt,
      by: author(n),
      waits: set.proposals.filter(p => p.name === n.name).length,
      ...(rotate.has(n.name) ? { rotate: true as const } : {}),
    }));
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The server's checks on a sealed head write. Every stored fact is derived from the signed payload
// with the shared portable format code; mutation arguments are never trusted. Before storing, the server runs
// the public part of the reader's verifier (Gate B1 C20): the roster step, the head signer and its account, the
// per-name rules against the stored head, and the ciphertext and wrap bindings. The server opens no value and
// holds no key. Clients verify everything themselves and rely on none of this.
import { invariant } from '../src/errors';
import { checkSealedContents, checkSignedHead } from '../src/sealed-head';
import { checkRoster, findEntry, walkTransition } from '../src/sealed-roster';
import { checkSealedPart } from '../src/sealed-schema';
import { decodeSealedWire } from '../src/sealed-wire';
import { equalBytes, forgeSecretId, framedHash, hex } from '../src/sealed-portable';
import { headBytes, rosterBytes, type Head, type Roster, type Transition } from '../src/sealed-records';
import { AUTOMATIC_SET_KIND, decodeJoinRequest, type JoinRequest } from '../src/sealed-join';

type Payload = {
  head: Head;
  roster: Roster;
  revoked: Uint8Array[];
  proposals: unknown[];
  ciphertexts: { name: string; stored: Uint8Array }[];
  wraps: { recipientId: Uint8Array }[];
};
export type SealedJoinRequest = { deviceId: ArrayBuffer; request: ArrayBuffer; at: number };
export type StoredSealedSet = {
  setId: ArrayBuffer;
  headHash: ArrayBuffer;
  headVersion: number;
  rosterVersion: number;
  payload: ArrayBuffer;
  revoked?: ArrayBuffer[];
  joinRequests?: SealedJoinRequest[];
};
const u8 = (bytes: ArrayBuffer) => new Uint8Array(bytes);
function refuse(ok: unknown, message: string): asserts ok {
  invariant(ok, 'SECRETS_FORMAT_REFUSED', message);
}
function part<T>(kind: 'payload' | 'roster' | 'transition', bytes: ArrayBuffer): T {
  const value = decodeSealedWire(u8(bytes));
  checkSealedPart(kind, value);
  return value as T;
}

/** The head, its hash and its roster hash, bound to this project and kind. */
export function sealedWriteFacts(projectId: string, kind: 1 | 2 | 3, payload: ArrayBuffer) {
  refuse(payload.byteLength <= 512 * 1024, 'Sealed record exceeds format bounds.');
  const { head, roster, revoked, proposals, ciphertexts, wraps } = part<Payload>('payload', payload);
  const project = forgeSecretId('project', projectId),
    rosterHash = framedHash(rosterBytes(roster));
  refuse(
    [head, roster].every(
      r => equalBytes(r.projectId, project) && r.setKind === kind && equalBytes(r.setId, head.setId),
    ) &&
      head.rosterVersion === roster.rosterVersion &&
      equalBytes(head.rosterHash, rosterHash),
    'The signed head does not match this project, kind or roster.',
  );
  refuse(
    !revoked.length && !proposals.length,
    'Markers and proposals are server-owned, never part of a head.',
  );
  return { head, roster, rosterHash, headHash: framedHash(headBytes(head)), ciphertexts, wraps };
}
export type SealedWriteFacts = ReturnType<typeof sealedWriteFacts>;
/** The compare-and-swap precondition: the signed head extends the stored head (or none at genesis). */
export const extendsStored = (set: StoredSealedSet | null, facts: SealedWriteFacts) =>
  set
    ? equalBytes(u8(set.headHash), facts.head.prevHeadHash)
    : facts.head.prevHeadHash.every(byte => byte === 0);

/** Gate B1 C20: the head is signed by a device of the caller's own account, and passes the reader's head and
 * contents rules on the roster after this write against the stored head, as every reader pinned there checks it. */
function checkWriteHead(
  facts: SealedWriteFacts,
  pinned: { head: Head; roster: Roster } | null,
  revoked: readonly Uint8Array[],
  accountId: Uint8Array,
) {
  const signer = findEntry(facts.roster, facts.head.signerId);
  invariant(
    signer?.entryKind === 1 && equalBytes(signer.accountId, accountId),
    'SECRETS_ROSTER_REFUSED',
    'The head must be signed by a device of the signed-in account.',
  );
  checkSignedHead(facts.head, facts.roster, { pinned, revoked });
  checkSealedContents(facts.head, facts.roster, facts.ciphertexts, facts.wraps);
}

/** The history and side records after an accepted write. The server appends the one transition the
 * write introduces after checking that it chains from the stored roster to the signed head and that its signer
 * had the authority for its shape (the reader's walkTransition); a client never supplies the ring. A removal
 * clears its own markers; an addition answers its join request, and a step drops requests it made stale. Null
 * when an automatic addition's join request is no longer waiting. `accountId` is the caller's sealed account id. */
export function nextSealedState(input: {
  set: StoredSealedSet | null;
  facts: SealedWriteFacts;
  genesis: ArrayBuffer | null;
  transition: ArrayBuffer | null;
  stored: { genesis: ArrayBuffer; transitions: ArrayBuffer[] } | null;
  accountId: Uint8Array;
}) {
  const { set, facts, genesis, transition, stored, accountId } = input;
  refuse(facts.head.headVersion === (set?.headVersion ?? 0) + 1, 'The signed head is not the next version.');
  invariant(
    !set || equalBytes(u8(set.setId), facts.head.setId),
    'SECRETS_SET_REPLACED',
    'Replace a set through its signed replacement flow.',
  );
  let revoked = set?.revoked ?? [],
    joinRequests = set?.joinRequests ?? [];
  if (!set) {
    refuse(genesis && !transition, 'Genesis history is required.');
    const first = part<Roster>('roster', genesis!);
    refuse(
      first.rosterVersion === 1 && equalBytes(framedHash(rosterBytes(first)), facts.rosterHash),
      'A first write stores its own genesis roster.',
    );
    refuse(
      !stored || equalBytes(u8(stored.genesis), u8(genesis!)),
      'A set keeps its first genesis permanently.',
    );
    // A genesis has one owner device, checked in full like every reader's genesis.
    checkRoster(first);
    checkWriteHead(facts, null, [], accountId);
    // A first head starts its own ring; it never inherits steps from an older history row.
    return { genesis: genesis!, transitions: [], revoked, joinRequests };
  }
  refuse(genesis === null, 'A set keeps its first genesis permanently.');
  refuse(stored, 'Genesis history is required.');
  // The stored head's roster hash was bound to its roster when that head was accepted.
  const { head: current, roster: currentRoster } = decodeSealedWire(u8(set.payload)) as Payload,
    pinned = { head: current, roster: currentRoster },
    markers = revoked.map(u8);
  if (!transition) {
    refuse(
      facts.roster.rosterVersion === set.rosterVersion && equalBytes(facts.rosterHash, current.rosterHash),
      'A roster change needs its signed transition.',
    );
    checkWriteHead(facts, pinned, markers, accountId);
    return { genesis: stored.genesis, transitions: stored.transitions, revoked, joinRequests };
  }
  const t = part<Transition>('transition', transition);
  // An automatic addition answers a join request that is still waiting. Removing a person drops theirs, so a share
  // signed from an earlier read stores nothing (null: not accepted; the holder retries on its next run).
  if (t.delta.added.some(e => e.how === 3 && !joinRequests.some(j => equalBytes(u8(j.deviceId), e.id))))
    return null;
  refuse(
    t.fromVersion === set.rosterVersion &&
      equalBytes(t.fromHash, current.rosterHash) &&
      t.toVersion === t.fromVersion + 1 &&
      facts.roster.rosterVersion === t.toVersion &&
      equalBytes(t.toHash, facts.rosterHash),
    'The transition does not chain from the stored roster to the signed head.',
  );
  // The delta must be the roster change it claims: markers and join requests are cleared from it.
  const member = (id: Uint8Array) => facts.roster.entries.some(e => equalBytes(e.id, id));
  refuse(
    t.delta.removed.every(id => !member(id)) && t.delta.added.every(e => member(e.id)),
    'The transition delta does not match the signed roster.',
  );
  // The step's signer, its authority for this shape and the rebuilt roster, with the stored markers (4.8).
  walkTransition(currentRoster, t, markers);
  checkWriteHead(facts, pinned, markers, accountId);
  revoked = revoked.filter(id => !t.delta.removed.some(removed => equalBytes(removed, u8(id))));
  // A roster step also drops requests it made stale: every request once the set leaves Automatic, and one whose
  // account now has an entry. Requests were validated when stored, so only the account field is read (at most 32).
  const automatic = facts.roster.setKind === AUTOMATIC_SET_KIND && facts.roster.sharingMode === 1;
  const listed = (j: SealedJoinRequest) => {
    const accountId = (decodeSealedWire(u8(j.request)) as Partial<JoinRequest>).accountId;
    return !accountId || facts.roster.entries.some(e => equalBytes(e.accountId, accountId));
  };
  joinRequests = automatic
    ? joinRequests.filter(j => !t.delta.added.some(e => equalBytes(e.id, u8(j.deviceId))) && !listed(j))
    : [];
  return {
    genesis: stored.genesis,
    transitions: [...stored.transitions, transition],
    revoked,
    joinRequests,
  };
}

/** GB-10: when a person leaves the project, Forge asks holders to remove that account's entries (they see it).
 * Marks each of the account's entries in this set once and drops its waiting join request; a marker lasts until
 * the holder step that removes the entry. Null when nothing changes. Markers only ever name listed entries, so
 * they stay within the roster bound. A team change that removes several people marks them in one call. */
export function markersForRemovedAccount(set: StoredSealedSet, ...accountIds: Uint8Array[]) {
  const removed = (id: Uint8Array) => accountIds.some(account => equalBytes(id, account));
  const roster = (decodeSealedWire(u8(set.payload)) as Payload).roster,
    before = set.revoked ?? [],
    revoked = [...before];
  for (const entry of roster.entries)
    if (removed(entry.accountId) && !revoked.some(id => equalBytes(u8(id), entry.id)))
      revoked.push(Uint8Array.from(entry.id).buffer);
  const waiting = set.joinRequests ?? [],
    joinRequests = waiting.filter(j => {
      const id = joinAccount(j);
      return !id || !removed(id);
    });
  return revoked.length === before.length && joinRequests.length === waiting.length
    ? null
    : { revoked, joinRequests };
}
/** Gate B2 M3: one device's sign-in ended (signed out or removed elsewhere). Marks the entries of `deviceIds` that
 * belong to `accountId` (the sign-in's own account, so a link a client claimed can never mark another person) and
 * drops their waiting join requests. The set's last unmarked owner device is never marked: no device could act on it,
 * and its own reads would refuse it for good. Null when nothing changes.
 *
 * `everywhere` (the account's "Sign out everywhere", M3 follow-up and its sole-owner follow-up, owner 2026-11-23)
 * marks every entry of the account, owner devices included, in any step order. When the account holds every owner
 * device the set is then locked until one of its devices clears its own mark (clearSweptOwnerMark); `kept` lists the
 * devices that clear already kept for this sweep, which its later steps leave alone. */
export function markersForEndedDevice(
  set: StoredSealedSet,
  accountId: Uint8Array,
  deviceIds: Uint8Array[],
  { everywhere = false, kept = [] }: { everywhere?: boolean; kept?: Uint8Array[] } = {},
) {
  const ended = (id: Uint8Array) =>
    deviceIds.some(device => equalBytes(id, device)) && !kept.some(k => equalBytes(id, k));
  const roster = (decodeSealedWire(u8(set.payload)) as Payload).roster,
    owners = roster.entries.filter(e => e.entryKind === 1 && e.role === 1),
    before = set.revoked ?? [],
    revoked = [...before];
  const unmarked = (e: { id: Uint8Array }) => !revoked.some(id => equalBytes(u8(id), e.id));
  // Counting owners already marked, so ending two owner devices one at a time keeps the second.
  const survivor = () => everywhere || owners.some(o => !ended(o.id) && unmarked(o));
  for (const entry of roster.entries)
    if (ended(entry.id) && equalBytes(entry.accountId, accountId) && survivor() && unmarked(entry))
      revoked.push(Uint8Array.from(entry.id).buffer);
  const waiting = set.joinRequests ?? [],
    joinRequests = waiting.filter(j => {
      const account = joinAccount(j);
      return !ended(u8(j.deviceId)) || !account || !equalBytes(account, accountId);
    });
  return revoked.length === before.length && joinRequests.length === waiting.length
    ? null
    : { revoked, joinRequests };
}
/** Sole-owner follow-up (owner 2026-11-23): after "Sign out everywhere" no owner device of this set is unmarked, and
 * the person approves a device sign-in in the browser session that issued it (convex/sealedSecretMarkers.ts
 * clearSweptSignIn checks that). The marks on `deviceIds` that are owner-role entries of `accountId` are dropped, so
 * that device's next owner write removes the other marked devices and re-keys. Once one owner device is unmarked the
 * set is no longer locked and nothing more is cleared, so at most one sign-in per set is (one sign-in can hold a
 * second id after a new key store). Returns the markers left and the ids kept; null when nothing changes. */
export function clearSweptOwnerMark(set: StoredSealedSet, accountId: Uint8Array, deviceIds: Uint8Array[]) {
  const revoked = set.revoked ?? [];
  const marked = (id: Uint8Array) => revoked.some(r => equalBytes(u8(r), id));
  const owners = (decodeSealedWire(u8(set.payload)) as Payload).roster.entries.filter(
    e => e.entryKind === 1 && e.role === 1,
  );
  if (!owners.length || !owners.every(o => marked(o.id))) return null;
  const clear = owners.filter(
    o => equalBytes(o.accountId, accountId) && deviceIds.some(id => equalBytes(id, o.id)),
  );
  if (!clear.length) return null;
  return {
    revoked: revoked.filter(r => !clear.some(o => equalBytes(u8(r), o.id))),
    kept: clear.map(o => Uint8Array.from(o.id).buffer),
  };
}
/** Gate B2 M3: `deviceId` is a device entry of `accountId` in this set's roster (one decode of the roster). */
export const isOwnDeviceEntry = (set: StoredSealedSet, accountId: Uint8Array, deviceId: Uint8Array) =>
  (decodeSealedWire(u8(set.payload)) as Payload).roster.entries.some(
    e => e.entryKind === 1 && equalBytes(e.id, deviceId) && equalBytes(e.accountId, accountId),
  );
const joinAccount = (j: SealedJoinRequest) =>
  (decodeSealedWire(u8(j.request)) as Partial<JoinRequest>).accountId;

/** The accounts a removal could mark in this set (an entry or a waiting join request), each once. One decode of the
 * roster. A machine entry has no account (an empty id) and is never listed: no removal marks a machine. */
export function markableAccountIds(set: StoredSealedSet) {
  const ids = new Map<string, Uint8Array>();
  const add = (id: Uint8Array | undefined) => {
    if (id?.length) ids.set(hex(id), id);
  };
  for (const entry of (decodeSealedWire(u8(set.payload)) as Payload).roster.entries) add(entry.accountId);
  for (const j of set.joinRequests ?? []) add(joinAccount(j));
  return [...ids.values()];
}
/** The same accounts as hex ids: a team change checks write access only for its members listed here. */
export const markableAccounts = (set: StoredSealedSet) => markableAccountIds(set).map(id => hex(id));

/** Design 5.1 join request, stored for the next holder device's run (no timer, no polling). The request must
 * name this project and the caller's own account, and Development must be in Automatic mode with no entry for
 * that account (guards 1 and 2). One request per account, replaced by its newest device; at most 32 waiting.
 * Only the holder's roster step that adds the device clears it (nextSealedState). Returns null for a replay. */
export function nextJoinRequests(input: {
  projectId: string;
  account: string;
  kind: 1 | 2 | 3;
  set: StoredSealedSet | null;
  request: ArrayBuffer;
  at: number;
}): SealedJoinRequest[] | null {
  invariant(
    input.kind === AUTOMATIC_SET_KIND,
    'SECRETS_NOT_ALLOWED',
    'Only Development shares automatically. A Checks recipient always needs a person with a code.',
  );
  const request = decodeJoinRequest(u8(input.request));
  refuse(
    equalBytes(request.projectId, forgeSecretId('project', input.projectId)) &&
      equalBytes(request.accountId, forgeSecretId('account', input.account)),
    'A join request names this project and the signed-in account.',
  );
  const set = input.set;
  invariant(
    set,
    'SECRETS_NOT_SET_UP',
    'Development is not set up yet. The owner runs nforge secret set NAME.',
  );
  const roster = (decodeSealedWire(u8(set.payload)) as Payload).roster;
  invariant(
    roster.sharingMode === 1,
    'SECRETS_NOT_ALLOWED',
    'Development uses Confirm: a holder adds this device with a code.',
  );
  invariant(
    !roster.entries.some(e => equalBytes(e.accountId, request.accountId)),
    'SECRETS_NOT_ALLOWED',
    'This account already has a device in Development. Add this device from that one with a code.',
  );
  const waiting = set.joinRequests ?? [];
  if (waiting.some(j => equalBytes(u8(j.request), u8(input.request)))) return null;
  const others = waiting.filter(
    j => !equalBytes((decodeSealedWire(u8(j.request)) as JoinRequest).accountId, request.accountId),
  );
  invariant(
    others.length < 32,
    'SECRETS_NOT_ALLOWED',
    "32 devices are already waiting for Development; a holder device's next run shares them.",
  );
  return [...others, { deviceId: Uint8Array.from(request.id).buffer, request: input.request, at: input.at }];
}

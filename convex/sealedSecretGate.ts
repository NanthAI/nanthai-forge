// SPDX-License-Identifier: Apache-2.0
// The server's checks on a sealed head write. Every stored fact is derived from the signed payload
// with the shared portable format code; mutation arguments are never trusted. The server opens no
// value and holds no key. Clients verify everything themselves and rely on none of this.
import { invariant } from '../src/errors';
import { checkSealedPart } from '../src/sealed-schema';
import { decodeSealedWire } from '../src/sealed-wire';
import { equalBytes, forgeSecretId, framedHash } from '../src/sealed-portable';
import { headBytes, rosterBytes, type Head, type Roster, type Transition } from '../src/sealed-records';
import { AUTOMATIC_SET_KIND, decodeJoinRequest, type JoinRequest } from '../src/sealed-join';

type Payload = { head: Head; roster: Roster; revoked: Uint8Array[]; proposals: unknown[] };
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
  const { head, roster, revoked, proposals } = part<Payload>('payload', payload);
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
  return { head, roster, rosterHash, headHash: framedHash(headBytes(head)) };
}
export type SealedWriteFacts = ReturnType<typeof sealedWriteFacts>;
/** The compare-and-swap precondition: the signed head extends the stored head (or none at genesis). */
export const extendsStored = (set: StoredSealedSet | null, facts: SealedWriteFacts) =>
  set
    ? equalBytes(u8(set.headHash), facts.head.prevHeadHash)
    : facts.head.prevHeadHash.every(byte => byte === 0);

/** The history and side records after an accepted write. The server appends the one transition the
 * write introduces after checking that it chains from the stored roster to the signed head; a client
 * never supplies the ring. A removal clears its own markers; an addition answers its join request, and a step
 * drops requests it made stale. Null when an automatic addition's join request is no longer waiting. */
export function nextSealedState(input: {
  set: StoredSealedSet | null;
  facts: SealedWriteFacts;
  genesis: ArrayBuffer | null;
  transition: ArrayBuffer | null;
  stored: { genesis: ArrayBuffer; transitions: ArrayBuffer[] } | null;
}) {
  const { set, facts, genesis, transition, stored } = input;
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
    // A first head starts its own ring; it never inherits steps from an older history row.
    return { genesis: genesis!, transitions: [], revoked, joinRequests };
  }
  refuse(genesis === null, 'A set keeps its first genesis permanently.');
  refuse(stored, 'Genesis history is required.');
  // The stored head's roster hash was bound to its roster when that head was accepted.
  const current = (decodeSealedWire(u8(set.payload)) as Payload).head;
  if (!transition) {
    refuse(
      facts.roster.rosterVersion === set.rosterVersion && equalBytes(facts.rosterHash, current.rosterHash),
      'A roster change needs its signed transition.',
    );
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
 * they stay within the roster bound. */
export function markersForRemovedAccount(set: StoredSealedSet, accountId: Uint8Array) {
  const roster = (decodeSealedWire(u8(set.payload)) as Payload).roster,
    before = set.revoked ?? [],
    revoked = [...before];
  for (const entry of roster.entries)
    if (equalBytes(entry.accountId, accountId) && !revoked.some(id => equalBytes(u8(id), entry.id)))
      revoked.push(Uint8Array.from(entry.id).buffer);
  const waiting = set.joinRequests ?? [],
    joinRequests = waiting.filter(j => {
      const id = (decodeSealedWire(u8(j.request)) as Partial<JoinRequest>).accountId;
      return !id || !equalBytes(id, accountId);
    });
  return revoked.length === before.length && joinRequests.length === waiting.length
    ? null
    : { revoked, joinRequests };
}

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

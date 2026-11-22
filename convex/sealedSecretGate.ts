// SPDX-License-Identifier: Apache-2.0
// The server's checks on a sealed head write. Every stored fact is derived from the signed payload
// with the shared portable format code; mutation arguments are never trusted. The server opens no
// value and holds no key. Clients verify everything themselves and rely on none of this.
import { invariant } from '../src/errors';
import { checkSealedPart } from '../src/sealed-schema';
import { decodeSealedWire } from '../src/sealed-wire';
import { equalBytes, forgeSecretId, framedHash } from '../src/sealed-portable';
import { headBytes, rosterBytes, type Head, type Roster, type Transition } from '../src/sealed-records';

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
 * never supplies the ring. A removal clears its own markers; an addition answers its join request. */
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
  joinRequests = joinRequests.filter(j => !t.delta.added.some(e => equalBytes(e.id, u8(j.deviceId))));
  return {
    genesis: stored.genesis,
    transitions: [...stored.transitions, transition],
    revoked,
    joinRequests,
  };
}

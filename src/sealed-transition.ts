// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { framedHash } from './sealed-format.js';
import { signBytes } from './sealed-keys.js';
import { rosterBytes, transitionBytes, type Delta, type Roster, type Transition } from './sealed-records.js';
import { findEntry, ownerDevice, rosterAfterDelta, sameId, walkTransition } from './sealed-roster.js';

/** Build signed bytes with the same reconstruction and authority checks used by every reader.
 * Removal/re-key publication must still atomically include the new key, wraps and sealed head. */
export function createTransition(
  from: Roster,
  delta: Delta,
  signer: { id: Buffer; sign: Buffer },
  options: { revoked?: Buffer[]; development?: Roster } = {},
) {
  invariant(
    from.setKind === 1 || options.development,
    'SECRETS_ROSTER_REFUSED',
    'A Checks or Production transition needs the trusted Development roster.',
  );
  const next = rosterAfterDelta(from, delta);
  invariant(
    !ownerDevice(findEntry(from, signer.id)) || next.entries.some(ownerDevice),
    'SECRETS_LAST_OWNER',
    'This is the last owner device. Add another owner device first; that device then removes or lowers this one.',
  );
  const transition: Transition = {
    fromVersion: from.rosterVersion,
    fromHash: framedHash(rosterBytes(from)),
    toVersion: next.rosterVersion,
    toHash: framedHash(rosterBytes(next)),
    delta,
    signerId: signer.id,
    signature: Buffer.alloc(64),
  };
  transition.signature = signBytes(transitionBytes(from, transition), signer.sign);
  const roster = walkTransition(from, transition, options.revoked ?? [], options.development);
  return { roster, transition };
}

/** The genesis is a separate permanent record; append and trim only the transition ring. */
export function appendTransition(ring: readonly Transition[], next: Transition): Transition[] {
  const last = ring.at(-1);
  invariant(
    !last || (last.toVersion === next.fromVersion && sameId(last.toHash, next.fromHash)),
    'SECRETS_FORK',
    'New transition does not extend the retained ring.',
  );
  return [...ring, next].slice(-64);
}

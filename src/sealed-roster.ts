// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import {
  bindingBytes,
  checkAgreementKey,
  equalBytes,
  framedHash,
  hex,
  recipientId,
  verifyBytes,
} from './sealed-portable.js';
import {
  displayText,
  rosterBytes,
  transitionBytes,
  type Delta,
  type Entry,
  type Roster,
  type Transition,
} from './sealed-records.js';

export const sameId = (a: Uint8Array, b: Uint8Array) => equalBytes(a, b);
export const findEntry = (roster: Roster, id: Uint8Array) =>
  roster.entries.find(entry => sameId(entry.id, id));
/** Design 5.5: the entries Forge marked that holder `self` removes. Forge marks every device of a person who left
 * and a single device whose sign-in ended (Gate B2 M3), which can be another device of self's own account. A
 * marker on self or on a machine is server misbehaviour: `ignored`, never removed. */
export function markedEntries(roster: Roster, revoked: readonly Uint8Array[], self: Uint8Array) {
  const marked = roster.entries.filter(e => revoked.some(id => sameId(id, e.id))),
    honest = (e: Entry) => e.entryKind !== 2 && !sameId(e.id, self);
  return { remove: marked.filter(honest), ignored: marked.filter(e => !honest(e)) };
}
export const ownerDevice = (entry: Entry | undefined) => entry?.entryKind === 1 && entry.role === 1;
export const writeDevice = (entry: Entry | undefined, kind: Roster['setKind']) =>
  entry?.entryKind === 1 && (entry.role === 1 || (kind === 1 && entry.role === 2));
const refuse = (condition: unknown, rule: string) => invariant(condition, 'SECRETS_ROSTER_REFUSED', rule);
const unique = (ids: Uint8Array[]) => new Set(ids.map(hex)).size === ids.length;
export function checkEntry(entry: Entry) {
  checkAgreementKey(entry.encPub);
  refuse([1, 2, 3].includes(entry.entryKind), 'Unknown recipient kind.');
  refuse(
    (entry.entryKind === 1 && [1, 2].includes(entry.role)) ||
      (entry.entryKind === 2 && entry.role === 3) ||
      (entry.entryKind === 3 && entry.role === 4),
    'Recipient kind and role disagree.',
  );
  refuse(
    sameId(recipientId(entry.entryKind, entry.signPub, entry.encPub), entry.id),
    'Recipient id does not derive from its keys.',
  );
  refuse(
    entry.accountHandle === displayText(entry.accountHandle) &&
      entry.displayName === displayText(entry.displayName),
    'Recipient display text is not sanitized.',
  );
  if (entry.entryKind === 1)
    refuse(
      entry.accountId.length === 16 &&
        verifyBytes(
          bindingBytes(entry.accountId, entry.id, entry.signPub, entry.encPub),
          entry.bindSig,
          entry.signPub,
        ),
      'Device binding signature is invalid.',
    );
  if (entry.entryKind === 2)
    refuse(
      entry.signPub.length === 0 && entry.accountId.length === 0 && entry.bindSig.length === 0,
      'Machine has signing or account fields.',
    );
  if (entry.entryKind === 3)
    refuse(
      entry.accountId.length === 16 && entry.signPub.length === 32 && entry.bindSig.length === 0,
      'Person key fields are invalid.',
    );
}
export function checkRoster(roster: Roster, development?: Roster) {
  refuse(
    roster.rosterVersion >= 1 &&
      roster.epoch >= 1 &&
      roster.entries.length <= 100 &&
      roster.former.length <= 400,
    'Roster shape exceeds format bounds.',
  );
  refuse(
    [1, 2, 3].includes(roster.setKind) && [1, 2].includes(roster.sharingMode),
    'Unknown set kind or sharing mode.',
  );
  refuse(
    unique(roster.entries.map(e => e.id)) && unique(roster.former.map(e => e.deviceId)),
    'Duplicate recipient or former signer.',
  );
  for (const entry of roster.entries) checkEntry(entry);
  for (const former of roster.former)
    refuse(
      former.signPub.length === 32 &&
        former.lastEpoch >= 1 &&
        former.lastEpoch <= roster.epoch &&
        !findEntry(roster, former.deviceId),
      'Invalid former signer.',
    );
  refuse(roster.entries.some(ownerDevice), 'The roster must retain a full owner device.');
  refuse(
    roster.setKind === 1 || (roster.sharingMode === 2 && roster.checksPointer === null),
    'Only Development may be automatic or carry a Checks pointer.',
  );
  if (roster.setKind !== 1)
    for (const entry of roster.entries) {
      refuse(
        entry.entryKind === 2 || ownerDevice(entry),
        'Only owner devices and machines may hold this set.',
      );
      if (entry.entryKind === 1 && development)
        refuse(
          development.entries.some(e => ownerDevice(e) && sameId(e.accountId, entry.accountId)),
          'Checks owner account has no Development owner device.',
        );
    }
  if (roster.rosterVersion === 1)
    refuse(
      roster.entries.length === 1 &&
        ownerDevice(roster.entries[0]) &&
        roster.entries[0]!.how === 1 &&
        sameId(roster.entries[0]!.id, roster.entries[0]!.addedBy) &&
        roster.entries[0]!.addedAtRosterVersion === 1 &&
        roster.former.length === 0 &&
        roster.prevRosterHash.every(b => b === 0),
      'Invalid genesis roster.',
    );
}
function checkAdded(from: Roster, entry: Entry, signer: Entry, transition: Transition) {
  checkEntry(entry);
  refuse(
    sameId(entry.addedBy, signer.id) &&
      entry.addedAtRosterVersion === transition.toVersion &&
      !findEntry(from, entry.id),
    'Added recipient does not match the transition.',
  );
  const former = from.former.find(e => sameId(e.deviceId, entry.id));
  refuse(
    !former || transition.delta.droppedFormer.some(id => sameId(id, entry.id)),
    'Re-added device must leave the former list.',
  );
  const own = sameId(entry.accountId, signer.accountId),
    device = signer.entryKind === 1;
  switch (entry.how) {
    case 2:
    case 3:
      refuse(
        writeDevice(signer, 1) &&
          from.setKind === 1 &&
          entry.entryKind === 1 &&
          entry.role === 2 &&
          !from.entries.some(e => sameId(e.accountId, entry.accountId)),
        'First-device addition is invalid.',
      );
      // Gate B2 nit: a new account's first device is one addition per step, for Confirm as for Automatic.
      refuse(
        transition.delta.added.filter(e => sameId(e.accountId, entry.accountId)).length === 1,
        'One new account takes one first-device addition per step.',
      );
      if (entry.how === 3) refuse(from.sharingMode === 1, 'Automatic addition is invalid.');
      break;
    case 4:
      refuse(
        device &&
          own &&
          ((entry.entryKind === 1 && (entry.role === 2 || signer.role === 1)) ||
            (entry.entryKind === 3 && from.setKind === 1)),
        'Own-device addition exceeds its authority.',
      );
      break;
    case 5:
      refuse(
        signer.entryKind === 3 && from.setKind === 1 && own && entry.entryKind === 1 && entry.role === 2,
        'Passkey addition exceeds member authority.',
      );
      break;
    case 6:
      refuse(
        ownerDevice(signer) && (entry.entryKind === 2 || (entry.entryKind === 1 && entry.role === 1 && !own)),
        'Owner addition requires a full owner device.',
      );
      break;
    default:
      refuse(false, 'Genesis is valid only at version one.');
  }
}
/** Rebuild bytes only; walkTransition checks all authority before accepting this result. A reader
 * passes the step's checked fromHash; the default is portable bytes (no Buffer), hashed and compared only. */
export function rosterAfterDelta(
  from: Roster,
  d: Delta,
  prevRosterHash = framedHash(rosterBytes(from)) as Roster['prevRosterHash'],
): Roster {
  const created = from.entries
    .filter(e => e.entryKind === 1 && d.removed.some(id => sameId(id, e.id)))
    .map(e => ({ deviceId: e.id, signPub: e.signPub, lastEpoch: from.epoch }));
  return {
    ...from,
    rosterVersion: from.rosterVersion + 1,
    epoch: from.epoch + d.epochBumped,
    prevRosterHash,
    sharingMode: d.newSharingMode ?? from.sharingMode,
    checksPointer: d.newChecksPointer ?? from.checksPointer,
    entries: [
      ...from.entries
        .filter(e => !d.removed.some(id => sameId(id, e.id)))
        .map(e => ({ ...e, role: d.roles.find(r => sameId(r.id, e.id))?.role ?? e.role })),
      ...d.added,
    ],
    former: [...from.former, ...created].filter(e => !d.droppedFormer.some(id => sameId(id, e.deviceId))),
  };
}
export function walkTransition(
  from: Roster,
  t: Transition,
  revoked: readonly Buffer[],
  development?: Roster,
) {
  invariant(
    t.fromVersion === from.rosterVersion &&
      sameId(t.fromHash, framedHash(rosterBytes(from))) &&
      t.toVersion === t.fromVersion + 1,
    'SECRETS_FORK',
    'Roster transition does not chain from the trusted version.',
  );
  const signer = findEntry(from, t.signerId);
  refuse(
    signer &&
      signer.entryKind !== 2 &&
      !revoked.some(id => sameId(id, signer.id)) &&
      verifyBytes(transitionBytes(from, t), t.signature, signer.signPub),
    'Roster transition signer is not authorized.',
  );
  const d = t.delta;
  // GB-08 d3: a roster step never removes or lowers its own signer.
  refuse(
    !d.removed.some(id => sameId(id, signer!.id)) &&
      !d.roles.some(r => sameId(r.id, signer!.id) && r.role !== signer!.role),
    'A transition cannot remove or lower its own signer.',
  );
  refuse(
    unique(d.added.map(e => e.id)) &&
      unique(d.removed) &&
      unique(d.roles.map(e => e.id)) &&
      unique(d.droppedFormer),
    'Duplicate delta operation.',
  );
  refuse(
    !d.added.some(e => d.removed.some(id => sameId(id, e.id)) || d.roles.some(role => sameId(role.id, e.id))),
    'Ambiguous recipient delta.',
  );
  for (const entry of d.added) checkAdded(from, entry, signer!, t);
  for (const id of d.removed) {
    const entry = findEntry(from, id);
    refuse(entry, 'Removed recipient is absent.');
    const own = sameId(entry!.accountId, signer!.accountId);
    // Gate B2 M1: only an owner device removes another account's entry, marker or not. A marker is cleared by the
    // step that acts on it, so a later reader could not check a member's marker-based removal; no step depends on one.
    refuse(
      ownerDevice(signer) ||
        (from.setKind === 1 &&
          !ownerDevice(entry) &&
          own &&
          ((signer!.entryKind === 1 && signer!.role === 2) ||
            (signer!.entryKind === 3 && entry!.entryKind === 1 && entry!.role === 2))),
      'Removal exceeds signer authority.',
    );
  }
  for (const role of d.roles)
    refuse(
      ownerDevice(signer) &&
        findEntry(from, role.id)?.entryKind === 1 &&
        [1, 2].includes(role.role) &&
        !d.removed.some(id => sameId(id, role.id)),
      'Role changes require an owner and a device target.',
    );
  refuse(
    [0, 1].includes(d.epochBumped) && (!d.removed.length || d.epochBumped === 1),
    'Removal must raise the epoch.',
  );
  if (d.epochBumped && !d.removed.length)
    refuse(writeDevice(signer, from.setKind), 'Re-key requires write authority.');
  if (d.newSharingMode !== null)
    refuse(
      ownerDevice(signer) && (d.newSharingMode === 2 || (d.newSharingMode === 1 && from.setKind === 1)),
      'Sharing change requires owner authority.',
    );
  if (d.newChecksPointer)
    refuse(from.setKind === 1 && ownerDevice(signer), 'Checks pointer requires a Development owner device.');
  for (const id of d.droppedFormer)
    refuse(
      from.former.some(e => sameId(e.deviceId, id)) ||
        from.entries.some(e => e.entryKind === 1 && sameId(e.id, id) && d.removed.some(r => sameId(r, id))),
      'Dropped former signer is absent.',
    );
  const next = rosterAfterDelta(from, d, t.fromHash);
  // The cross-set rule is the caller's: readers pass Development for the final roster only (GB-08 d2).
  checkRoster(next, development);
  invariant(
    sameId(framedHash(rosterBytes(next)), t.toHash),
    'SECRETS_FORK',
    'Rebuilt roster hash does not match the transition.',
  );
  return next;
}

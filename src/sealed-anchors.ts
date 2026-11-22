// SPDX-License-Identifier: Apache-2.0
import { ForgeError, invariant } from './errors.js';
import { decodePersonCheckpoint } from './sealed-decode.js';
import { checkpointBytes, type PersonCheckpoint } from './sealed-future-records.js';
import { equalBytes, framedHash } from './sealed-format.js';
import { recipientId, verifyBytes } from './sealed-keys.js';
import { headBytes, rosterBytes, type Roster } from './sealed-records.js';
import { checkRoster, findEntry, sameId } from './sealed-roster.js';
import type { SealedReply, SecretPin } from './sealed-verify.js';

export type PersonCheckpointAnchor = {
  checkpoint: PersonCheckpoint;
  // These public keys come from the locally opened seed, never from the server's roster.
  person: { id: Buffer; accountId: Buffer; signPub: Buffer; encPub: Buffer };
};
export type DeviceHeadAnchor = { id: Buffer; signPub: Buffer };
/** The roster view R a requester fixed before its nonce, confirmed by a matched two-word reply (4.13). */
export type CodeAnchor = {
  purpose: 1 | 2 | 3 | 4;
  roster: Roster;
  /** Purpose re-pin only: the holder's own verified head becomes this device's head floor. */
  headFloor: { version: number; hash: Buffer } | null;
};
export type JourneyAnchor =
  | { kind: 'own-genesis'; deviceId: Buffer }
  | { kind: 'checks-genesis' }
  | { kind: 'person-checkpoint'; value: PersonCheckpointAnchor }
  | { kind: 'device-head'; value: DeviceHeadAnchor }
  | { kind: 'code'; value: CodeAnchor };

/** GB-08 d4: how a pin's trust started, independent of signed data. `none` is a Checks view reached only by
 * the walk from genesis: display-only. `holder` is this device's own genesis, its own signed head, a passkey
 * checkpoint, or a wrap it opened on a confirmed base. `tofu` (Gate B1 M2, Lane 2160f061) is Development-only trust
 * on first use through this device's own Automatic join; a code upgrades it. */
export type PinConfirmation = 'code' | 'holder' | 'machine' | 'none' | 'tofu';
/** Pins written before the flag existed: a holder pin is a holder, anything else is display-only. */
export const pinConfirmation = (pin: Pick<SecretPin, 'confirmed' | 'holder'>): PinConfirmation =>
  pin.confirmed ?? (pin.holder ? 'holder' : 'none');
const route = {
  proposal: 'Ask a Checks owner for a proposer code (nforge secret share on their device) before proposing.',
  join: 'Ask a Checks owner for an add code (nforge secret share on their device) before joining.',
  approve:
    'Confirm this Checks view with an owner code (nforge secret share) before approving another device.',
  wrap: 'Confirm this Checks view with an owner code (nforge secret share) before a wrap is made or opened.',
} as const;
export const walkOnly = (use: keyof typeof route) =>
  `This Checks view was reached only by a walk from genesis and is display-only. ${route[use]}`;
/** GB-08 d4 gate, in code: a proposal, a join request and a wrap never rest on a walk-only Checks view. */
export function requireConfirmedBase(pin: SecretPin, use: keyof typeof route) {
  if (pin.roster.setKind === 1) return;
  const confirmed = pinConfirmation(pin);
  invariant(
    confirmed === 'code' || confirmed === 'holder' || (use === 'wrap' && confirmed === 'machine'),
    'SECRETS_CODE_NEEDED',
    walkOnly(use),
  );
}

// The confirmed roster hash travels beside the anchor, so a view mutated after its reply matched is refused.
const matchedReplies = new WeakMap<CodeAnchor, Buffer>();
/** Only the requester's code journey calls this, after its two-word reply matched (source-guarded). */
export function codeConfirmedAnchor(value: CodeAnchor): JourneyAnchor {
  matchedReplies.set(value, framedHash(rosterBytes(value.roster)));
  return { kind: 'code', value };
}
export function codeAnchor(reply: SealedReply, value: CodeAnchor): Roster {
  const r = value?.roster;
  invariant(
    matchedReplies.has(value) &&
      equalBytes(matchedReplies.get(value)!, framedHash(rosterBytes(r))) &&
      sameId(r.projectId, reply.roster.projectId) &&
      sameId(r.setId, reply.roster.setId) &&
      r.setKind === reply.roster.setKind,
    'SECRETS_ROSTER_REFUSED',
    'A code anchor must come from a matched reply for this set.',
  );
  checkRoster(r);
  return r;
}

export function checkpointAnchor(reply: SealedReply, anchor: PersonCheckpointAnchor): Roster {
  try {
    const c = decodePersonCheckpoint(anchor.checkpoint),
      p = anchor.person,
      roster = c.roster;
    invariant(
      roster.setKind === 1 &&
        reply.roster.setKind === 1 &&
        sameId(roster.projectId, reply.roster.projectId) &&
        sameId(roster.setId, reply.roster.setId) &&
        Number.isSafeInteger(c.at) &&
        c.at >= 0 &&
        sameId(p.id, recipientId(3, p.signPub, p.encPub)) &&
        sameId(framedHash(rosterBytes(roster)), c.rosterHash) &&
        verifyBytes(checkpointBytes(roster, c.rosterHash, c.at), c.signature, p.signPub),
      'SECRETS_PIN_TOO_OLD',
      'Person checkpoint is missing or invalid. Confirm with a holder.',
    );
    checkRoster(roster);
    const entry = findEntry(roster, p.id);
    invariant(
      entry?.entryKind === 3 &&
        sameId(entry.accountId, p.accountId) &&
        sameId(entry.signPub, p.signPub) &&
        sameId(entry.encPub, p.encPub),
      'SECRETS_PIN_TOO_OLD',
      'Person checkpoint does not contain the locally derived person key.',
    );
    return roster;
  } catch {
    throw new ForgeError(
      'SECRETS_PIN_TOO_OLD',
      'Person checkpoint is missing or invalid. Confirm with a holder.',
    );
  }
}

export function deviceHeadAnchor(reply: SealedReply, local: DeviceHeadAnchor): Roster {
  invariant(
    sameId(reply.head.signerId, local.id) &&
      verifyBytes(headBytes(reply.head), reply.head.signature, local.signPub),
    'SECRETS_PIN_LOST',
    'This device cannot rebuild trust from a head it did not sign.',
  );
  return reply.roster;
}

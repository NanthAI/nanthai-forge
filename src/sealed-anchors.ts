// SPDX-License-Identifier: Apache-2.0
import { ForgeError, invariant } from './errors.js';
import { decodePersonCheckpoint } from './sealed-decode.js';
import { checkpointBytes, type PersonCheckpoint } from './sealed-future-records.js';
import { framedHash } from './sealed-format.js';
import { recipientId, verifyBytes } from './sealed-keys.js';
import { headBytes, rosterBytes, type Roster } from './sealed-records.js';
import { checkRoster, findEntry, sameId } from './sealed-roster.js';
import type { SealedReply } from './sealed-verify.js';

export type PersonCheckpointAnchor = {
  checkpoint: PersonCheckpoint;
  // These public keys come from the locally opened seed, never from the server's roster.
  person: { id: Buffer; accountId: Buffer; signPub: Buffer; encPub: Buffer };
};
export type DeviceHeadAnchor = { id: Buffer; signPub: Buffer };
export type JourneyAnchor =
  | { kind: 'own-genesis'; deviceId: Buffer }
  | { kind: 'checks-genesis' }
  | { kind: 'person-checkpoint'; value: PersonCheckpointAnchor }
  | { kind: 'device-head'; value: DeviceHeadAnchor };

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

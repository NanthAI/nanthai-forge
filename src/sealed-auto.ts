// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Design 5.1 Automatic sharing, the client side. Pure: the joining device's request, the holder's choice of
// which requests to wrap under the nine guards, and the one signed write that adds them. No IO.
import { deserialize, serialize } from 'node:v8';
import { forgeSecretId, framedHash } from './sealed-format.js';
import { signBytes, wrapSetKey, type DeviceKeys } from './sealed-keys.js';
import {
  AUTOMATIC_SET_KIND,
  decodeJoinRequest,
  deviceFingerprint,
  encodeJoinRequest,
  unshareCommand,
} from './sealed-join.js';
import { headBytes, rosterBytes, type Entry, type Roster } from './sealed-records.js';
import { findEntry, markedEntries, sameId, writeDevice } from './sealed-roster.js';
import { createTransition } from './sealed-transition.js';
import { requireConfirmedBase } from './sealed-anchors.js';
import type { SealedReply, SecretPin } from './sealed-verify.js';

/** The joining device's own request: its keys and signed account binding, never a role or a how. */
export const joinRequestBytes = (project: string, account: string, keys: DeviceKeys) =>
  encodeJoinRequest({
    v: 1,
    projectId: forgeSecretId('project', project),
    setKind: AUTOMATIC_SET_KIND,
    accountId: forgeSecretId('account', account),
    id: keys.id,
    signPub: keys.signPub,
    encPub: keys.encPub,
    bindSig: keys.bindSig,
    displayName: 'new device',
  });

/** Which waiting requests this holder device wraps now. Each skipped request gets a value-free reason. */
export function planAutomaticShares(input: {
  roster: Roster;
  revoked: readonly Buffer[];
  requests: readonly Uint8Array[];
  self: Buffer;
  /** Guard 5: shares this device may still make today. */
  quota: number;
}) {
  const { roster } = input,
    signer = findEntry(roster, input.self),
    entries: Entry[] = [],
    skipped: string[] = [];
  // Guard 1 (constant kind), the signed Automatic mode, and guard 5: only a device entry with write authority
  // wraps; a machine or a person key never does. A pending removal re-keys first (5.5), never alongside; a
  // marker that names no entry asks for nothing.
  if (
    roster.setKind !== AUTOMATIC_SET_KIND ||
    roster.sharingMode !== 1 ||
    signer?.entryKind !== 1 ||
    !writeDevice(signer, AUTOMATIC_SET_KIND) ||
    markedEntries(roster, input.revoked, input.self).remove.length
  )
    return { entries, skipped };
  for (const bytes of input.requests) {
    let request;
    try {
      request = decodeJoinRequest(bytes);
    } catch {
      skipped.push('A waiting join request is malformed; not shared.');
      continue;
    }
    const fp = deviceFingerprint(request.id);
    const account = (e: { accountId: Uint8Array }) => sameId(e.accountId, request.accountId);
    if (request.setKind !== AUTOMATIC_SET_KIND || !sameId(request.projectId, roster.projectId))
      skipped.push(`Join request ${fp} is for another project or set; not shared.`);
    // Guard 2: only the first device of an account with no entry. Further devices come from that person's own
    // device (code) or passkey. A removed device never comes back automatically.
    else if (roster.entries.some(account) || entries.some(account))
      skipped.push(
        `Device ${fp} belongs to an account that already has a device in Development; add it from that device with a code.`,
      );
    else if (
      findEntry(roster, request.id) ||
      roster.former.some(e => sameId(e.deviceId, request.id)) ||
      input.revoked.some(id => sameId(id, request.id))
    )
      skipped.push(`Device ${fp} was removed before; it needs a code to come back.`);
    // The fingerprint is what people compare and what Undo names: a request whose 40-bit fingerprint equals any
    // device already listed, removed or planned (a ground collision) is never shared automatically.
    else if (
      roster.entries.some(e => deviceFingerprint(e.id) === fp) ||
      roster.former.some(e => deviceFingerprint(e.deviceId) === fp) ||
      entries.some(e => deviceFingerprint(e.id) === fp)
    )
      skipped.push(`Device ${fp} has the fingerprint of another device; not shared. Add it with a code.`);
    else if (entries.length >= input.quota)
      skipped.push(
        `Device ${fp} waits: this device already made 3 automatic shares today. Another holder, or this one tomorrow, shares it.`,
      );
    // Guard 6: always a device with role member, never owner, never a person entry, never another kind.
    else
      entries.push({
        entryKind: 1,
        id: Buffer.from(request.id),
        encPub: Buffer.from(request.encPub),
        signPub: Buffer.from(request.signPub),
        accountId: Buffer.from(request.accountId),
        accountHandle: '',
        displayName: request.displayName,
        role: 2,
        addedBy: input.self,
        how: 3,
        addedAtRosterVersion: roster.rosterVersion + 1,
        bindSig: Buffer.from(request.bindSig),
      });
  }
  return { entries, skipped };
}

/** Guard 3: the new entries go into the chained signed roster in the same write as their wraps and the next head.
 * The set key and epoch are unchanged, so existing wraps and values stay as they are. */
export function automaticShareReply(
  verified: SealedReply,
  key: Buffer,
  entries: readonly Entry[],
  signer: Pick<DeviceKeys, 'id' | 'sign'>,
  now: number,
  /** The holder's own verified pin for this set: GB-08 d4, a wrap never rests on a walk-only Checks view. */
  base: SecretPin,
): SealedReply {
  requireConfirmedBase(base, 'wrap');
  const reply = deserialize(serialize(verified)) as SealedReply;
  const { roster, transition } = createTransition(
    reply.roster,
    {
      added: [...entries],
      removed: [],
      roles: [],
      droppedFormer: [],
      newSharingMode: null,
      newChecksPointer: null,
      supersede: null,
      epochBumped: 0,
    },
    signer,
    { revoked: reply.revoked },
  );
  reply.roster = roster;
  reply.transitions = [...reply.transitions, transition].slice(-64);
  reply.wraps = [
    ...reply.wraps,
    ...entries.map(e => wrapSetKey(key, roster, { id: e.id, encPub: e.encPub, kind: 1 })),
  ];
  reply.head = {
    ...reply.head,
    headVersion: reply.head.headVersion + 1,
    prevHeadHash: framedHash(headBytes(verified.head)),
    rosterVersion: roster.rosterVersion,
    rosterHash: framedHash(rosterBytes(roster)),
    signerId: signer.id,
    signedAt: now,
    signature: Buffer.alloc(64),
  };
  reply.head.signature = signBytes(headBytes(reply.head), signer.sign);
  return reply;
}

/** Guard 9: this device's account devices from the signed roster, on first contact and whenever they change. */
export function ownDevicesNotice(previous: Roster | null, roster: Roster, self: Buffer) {
  const mine = roster.entries.find(e => sameId(e.id, self));
  if (!mine) return null;
  const own = (r: Roster) =>
    r.entries
      .filter(e => e.entryKind === 1 && sameId(e.accountId, mine.accountId))
      .map(e => e.id.toString('hex'));
  const before = previous ? own(previous).sort().join() : null,
    after = own(roster);
  if (before === [...after].sort().join()) return null;
  const others = roster.entries.filter(
    e => e.entryKind === 1 && sameId(e.accountId, mine.accountId) && !sameId(e.id, self),
  );
  const label = (e: Entry) =>
    `fp ${deviceFingerprint(e.id)} (${e.how === 3 ? 'auto' : e.role === 1 ? 'owner' : 'member'}, added at roster version ${e.addedAtRosterVersion})`;
  return `Your account's devices in Development: this one (fp ${deviceFingerprint(self)})${others.map(e => `; ${label(e)}`).join('')}.${others.length ? ` Not yours? ${others.map(e => unshareCommand(e.id)).join(' or ')}` : ''}`;
}

// SPDX-License-Identifier: Apache-2.0
// Guard 7: the Undo of an automatic share is "Remove and rotate" (design 5.5), because the key was handed over.
// One owner-device write removes the device named by its fingerprint and re-keys: a new set key, every value
// re-sealed, a wrap for each remaining recipient. The removed device cannot open anything written from then on;
// what it could already open is printed as the rotate list (names only).
import { randomUUID } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';
import { framedHash } from './sealed-format.js';
import { deviceFingerprint } from './sealed-join.js';
import { headBytes } from './sealed-records.js';
import { rekeySet } from './sealed-rekey.js';
import { findEntry, ownerDevice, sameId } from './sealed-roster.js';
import { createTransition } from './sealed-transition.js';
import { sealedRefusal, sealedWrite, sealedWriteArgs } from './sealed-transport.js';
import { verifySealedReply, type SealedReply } from './sealed-verify.js';
import type { SealedClient } from './sealed-client.js';

const discard = (result: ReturnType<typeof verifySealedReply> | null | undefined) => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
export async function unshareDevice(client: SealedClient, fingerprint: string) {
  invariant(
    !client.agent,
    'PERSON_REQUIRED',
    'A person removes a device: run nforge secret unshare on a terminal.',
  );
  // A fingerprint names automatic entries only (guard 7, which the planner keeps free of fingerprint collisions);
  // the full 32-hex device id names any entry.
  const arg = fingerprint.trim(),
    fullId = /^[0-9a-f]{32}$/i.test(arg) ? Buffer.from(arg, 'hex') : null,
    fp = fullId ? deviceFingerprint(fullId) : arg.toUpperCase();
  const names = (id: Buffer, automatic: boolean) =>
    fullId ? sameId(id, fullId) : automatic && deviceFingerprint(id) === fp;
  // Rotate list (design 5.5): every live name whose valueEpoch the removed device held.
  const rotateFor = (state: { reply: SealedReply }, lastEpoch: number) =>
    state.reply.head.names
      .filter(n => n.kind !== 3 && n.valueEpoch <= lastEpoch)
      .map(n => n.name)
      .sort();
  // A compare-and-swap loss rebuilds from the new head; three tries bound it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await client.read();
    invariant(state, 'SECRETS_NOT_SET_UP', 'Development is not set up.');
    try {
      const roster = state.pin.roster,
        matches = roster.entries.filter(e => names(e.id, e.entryKind === 1 && e.how === 3));
      if (!matches.length) {
        // A repeat after an unknown outcome: the device is already gone, and the rotate list still matters.
        const gone = roster.former.filter(e => names(e.deviceId, true));
        if (gone.length === 1)
          return { removed: fp, rotate: rotateFor(state, gone[0]!.lastEpoch), already: true };
      }
      invariant(
        matches.length === 1,
        'BAD_ARGUMENT',
        matches.length
          ? 'Two Development entries share this fingerprint; nothing was removed. Use the full device id.'
          : `No automatic device with fingerprint ${fp} holds Development; nothing was removed. For a device added another way, use its full device id.`,
      );
      const target = matches[0]!;
      invariant(
        ownerDevice(findEntry(roster, client.keys.id)),
        'SECRETS_NOT_ALLOWED',
        'Removing a device needs an owner device of Development in this slice.',
      );
      invariant(
        !sameId(target.id, client.keys.id),
        'SECRETS_ROSTER_REFUSED',
        'A device cannot remove itself. Remove it from another owner device.',
      );
      const { roster: next, transition } = createTransition(
        roster,
        {
          added: [],
          removed: [target.id],
          roles: [],
          droppedFormer: [],
          newSharingMode: null,
          newChecksPointer: null,
          supersede: null,
          epochBumped: 1,
        },
        client.keys,
        { revoked: state.reply.revoked },
      );
      const rekeyed = rekeySet({
        from: roster,
        head: state.pin.head,
        key: state.key!,
        ciphertexts: state.reply.ciphertexts,
        next,
        signer: client.keys,
        now: Date.now(),
      });
      const reply: SealedReply = {
        ...state.reply,
        roster: next,
        head: rekeyed.head,
        ciphertexts: rekeyed.ciphertexts,
        wraps: rekeyed.wraps,
        transitions: [...state.reply.transitions, transition].slice(-64),
        proposals: [],
      };
      discard(verifySealedReply(reply, state.pin, client.request()));
      const out = sealedWrite(reply, randomUUID(), {
        headHash: framedHash(headBytes(state.pin.head)),
        rosterVersion: roster.rosterVersion,
      });
      let receipt: { accepted: boolean };
      try {
        receipt = await client.transport.write({ ...sealedWriteArgs(out), kind: 1 });
      } catch (error) {
        throw (
          sealedRefusal(error) ??
          new ForgeError(
            'SECRETS_WRITE_UNKNOWN',
            `Removal outcome is unknown. Run nforge secret unshare ${fp} again: it says when the device is gone.`,
          )
        );
      }
      if (!receipt.accepted) continue;
      discard(await client.pins.verifyAndSave(reply, client.request(), Date.now()));
      return { removed: fp, rotate: rotateFor(state, roster.epoch), already: false };
    } finally {
      discard(state);
    }
  }
  throw new ForgeError(
    'SECRETS_WRITE_UNKNOWN',
    `Development kept changing while removing ${fp}; run the command again.`,
  );
}

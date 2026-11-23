// SPDX-License-Identifier: Apache-2.0
// Design 5.5 removal: "remove and rotate". One owner-device write removes entries and re-keys: a new set key,
// every value re-sealed, a wrap for each remaining recipient. A removed entry cannot open anything written from
// then on; what it could already open is the rotate list (names only). Three routes share this one write:
// guard 7's Undo of an automatic share (a fingerprint), any entry by its full device id, and the entries Forge
// marked when their person left the project or their device's sign-in ended (the next person write, or
// `unshare --marked`).
import { randomUUID } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';
import { framedHash } from './sealed-format.js';
import { deviceFingerprint } from './sealed-join.js';
import { headBytes, type Entry, type Head, type Roster } from './sealed-records.js';
import { rekeySet } from './sealed-rekey.js';
import { findEntry, markedEntries, ownerDevice, sameId } from './sealed-roster.js';
import { createTransition } from './sealed-transition.js';
import { sealedRefusal, sealedWrite, sealedWriteArgs } from './sealed-transport.js';
import { verifySealedReply, type SealedReply } from './sealed-verify.js';
import { safeSecretName } from './sealed-display.js';
import type { SealedClient } from './sealed-client.js';

/** What a removal prints: who went, and the names to rotate at their provider. */
export const removalLine = (removed: readonly string[], rotate: readonly string[]) =>
  `Removed ${removed.map(fp => `fp ${fp}`).join(', ')} from Development and re-keyed it. Rotate at their provider what ${removed.length === 1 ? 'it' : 'they'} could open: ${rotate.length ? rotate.map(safeSecretName).join(', ') : 'nothing'}.`;

type Verified = { reply: SealedReply } & ReturnType<typeof verifySealedReply>;
const discard = (result: ReturnType<typeof verifySealedReply> | null | undefined) => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
const liveNames = (head: Head, lastEpoch: number) =>
  head.names
    .filter(n => n.kind !== 3 && n.valueEpoch <= lastEpoch)
    .map(n => n.name)
    .sort();
/** The rotate list, derived from signed records only: each live name a removed device could open, because its
 * value has not changed since that device's last epoch, with the fingerprints of those devices. A new value
 * (sealed at a later epoch) takes the name off the list. Nothing is stored for it. */
export function rotateList(roster: Roster, head: Head) {
  return liveNames(head, roster.epoch)
    .map(name => {
      const epoch = head.names.find(n => n.name === name)!.valueEpoch;
      return {
        name,
        devices: roster.former.filter(f => epoch <= f.lastEpoch).map(f => deviceFingerprint(f.deviceId)),
      };
    })
    .filter(r => r.devices.length);
}
/** The holder notice for markers, shown on every verified read until a person removes the entries. */
export function markerNotice(roster: Roster, revoked: readonly Uint8Array[], self: Uint8Array) {
  // A marked reader never gets here: verification refuses a recipient that carries a marker.
  const { remove: marked, ignored } = markedEntries(roster, revoked, self),
    fps = (entries: Entry[]) => entries.map(e => `fp ${deviceFingerprint(e.id)}`).join(', '),
    lines: string[] = [];
  if (marked.length)
    lines.push(
      `Forge asks to remove ${marked.length} Development ${marked.length === 1 ? 'entry' : 'entries'} whose person left the project or whose device sign-in ended (${fps(marked)}). They cannot read from Forge now, but they keep what they already opened. ${
        ownerDevice(findEntry(roster, self))
          ? 'Remove and re-key now with nforge secret unshare --marked; your next nforge secret set or rm also does it.'
          : 'An owner device removes them and re-keys on its next nforge secret set or rm.'
      }`,
    );
  // Forge never marks a machine (it has no sign-in); such a marker is not acted on.
  if (ignored.length)
    lines.push(
      `Forge also marked ${fps(ignored)}, a machine, which it never should; nothing is done about it. Not used any more? Remove it by its full device id with nforge secret unshare DEVICE_ID.`,
    );
  return lines.length ? lines.join(' ') : null;
}

/** One removal write, rebuilt from a fresh read after a compare-and-swap loss (three tries). `choose` picks the
 * entries to remove from the verified state, or returns a finished result (nothing to remove). A caller that
 * has just read passes that state (`first`), which this zeroes like its own reads. */
async function removeAndRekey<T>(
  client: SealedClient,
  choose: (state: Verified) => { remove: Entry[]; done: (rotate: string[]) => T } | { result: T },
  retry: string,
  first?: Verified,
): Promise<T> {
  invariant(
    !client.agent,
    'PERSON_REQUIRED',
    'A person removes a device: run nforge secret unshare on a terminal.',
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = attempt === 0 && first ? first : await client.read();
    invariant(state, 'SECRETS_NOT_SET_UP', 'Development is not set up.');
    try {
      const chosen = choose(state);
      if ('result' in chosen) return chosen.result;
      const roster = state.pin.roster;
      invariant(
        ownerDevice(findEntry(roster, client.keys.id)),
        'SECRETS_NOT_ALLOWED',
        'Removing a device needs an owner device of Development in this slice.',
      );
      invariant(
        !chosen.remove.some(e => sameId(e.id, client.keys.id)),
        'SECRETS_ROSTER_REFUSED',
        'A device cannot remove itself. Remove it from another owner device.',
      );
      const { roster: next, transition } = createTransition(
        roster,
        {
          added: [],
          removed: chosen.remove.map(e => e.id),
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
          new ForgeError('SECRETS_WRITE_UNKNOWN', `Removal outcome is unknown. ${retry}`)
        );
      }
      if (!receipt.accepted) continue;
      discard(await client.pins.verifyAndSave(reply, client.request(), Date.now()));
      // Every live value was sealed under the key the removed entries held.
      return chosen.done(liveNames(state.pin.head, roster.epoch));
    } finally {
      discard(state);
    }
  }
  throw new ForgeError('SECRETS_WRITE_UNKNOWN', `Development kept changing during the removal. ${retry}`);
}

export function unshareDevice(client: SealedClient, fingerprint: string) {
  // A fingerprint names automatic entries only (guard 7, which the planner keeps free of fingerprint collisions);
  // the full 32-hex device id names any entry.
  const arg = fingerprint.trim(),
    fullId = /^[0-9a-f]{32}$/i.test(arg) ? Buffer.from(arg, 'hex') : null,
    fp = fullId ? deviceFingerprint(fullId) : arg.toUpperCase();
  const names = (id: Buffer, automatic: boolean) =>
    fullId ? sameId(id, fullId) : automatic && deviceFingerprint(id) === fp;
  return removeAndRekey(
    client,
    state => {
      const roster = state.pin.roster,
        matches = roster.entries.filter(e => names(e.id, e.entryKind === 1 && e.how === 3));
      if (!matches.length) {
        // A repeat after an unknown outcome: the device is already gone, and the rotate list still matters.
        const gone = roster.former.filter(e => names(e.deviceId, true));
        if (gone.length === 1)
          return {
            result: { removed: fp, rotate: liveNames(state.pin.head, gone[0]!.lastEpoch), already: true },
          };
      }
      invariant(
        matches.length === 1,
        'BAD_ARGUMENT',
        matches.length
          ? 'Two Development entries share this fingerprint; nothing was removed. Use the full device id.'
          : `No automatic device with fingerprint ${fp} holds Development; nothing was removed. For a device added another way, use its full device id.`,
      );
      return { remove: matches, done: rotate => ({ removed: fp, rotate, already: false }) };
    },
    `Run nforge secret unshare ${fp} again: it says when the device is gone.`,
  );
}

/** Removes every entry Forge marked, in one write. Nothing marked: nothing written, empty lists. */
export function removeMarked(
  client: SealedClient,
  first?: Verified,
  retry = 'Run nforge secret unshare --marked again: it says when nothing is left to remove.',
) {
  return removeAndRekey(
    client,
    state => {
      const marked = markedEntries(state.pin.roster, state.reply.revoked, client.keys.id).remove;
      if (!marked.length) return { result: { removed: [] as string[], rotate: [] as string[] } };
      return {
        remove: marked,
        done: rotate => ({ removed: marked.map(e => deviceFingerprint(e.id)), rotate }),
      };
    },
    retry,
    first,
  );
}

/** Before a write: with entries marked, zero the read state, remove them (a person, once per write) and say so.
 * True when the write must read again. An agent never removes anyone: it is refused with the next step. */
export async function removeMarkedFirst(client: SealedClient, state: Verified | null, already: boolean) {
  if (!state || !markedEntries(state.pin.roster, state.reply.revoked, client.keys.id).remove.length)
    return false;
  if (client.agent || already) {
    discard(state);
    throw new ForgeError(
      'SECRETS_REKEY_PENDING',
      'Forge marked Development entries for removal. A person runs nforge secret unshare --marked (it removes them and re-keys), then repeats this change.',
    );
  }
  const done = await removeMarked(
    client,
    state,
    'Your change was not written. Repeat it: it removes the marked entries first if they are still there.',
  );
  if (done.removed.length) client.notice(removalLine(done.removed, done.rotate));
  return true;
}

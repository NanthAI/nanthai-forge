// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The given names the server keeps beside a stored set (Item fcfc7e62), display-only and never signed:
// - `entryNames`: an active computer whose signed roster entry holds a placeholder ("this device") takes the name its
//   sign-in was approved with, from the sign-in of the very write it makes (no read: the sign-in is already in hand).
// - `formerHandles`: a removed computer or CI machine keeps its given name (a signed former entry holds only an id).
//   A former entry with no recorded name gets one lookup in the roster this write replaces and, when that misses, in
//   the history row the write already read (a name recovered once; an entry nobody can name is marked `name: ''` so
//   no later write decodes again).
// Both lists are bounded by the roster (its entries and its former list). No Convex read is added by either.
import { decodeSealedWire } from '../src/sealed-wire';
import { equalBytes, hex } from '../src/sealed-portable';
import { displayText, type Entry, type Roster, type Transition } from '../src/sealed-records';
import { isPlaceholderName } from '../src/sealed-overview';
import type { StoredSealedSet } from './sealedSecretGate';

const u8 = (bytes: ArrayBuffer) => new Uint8Array(bytes);
const given = (name: string) => {
  const text = displayText(name);
  return text && !isPlaceholderName(text) ? text : '';
};

/** The server-kept names of active computers still listed under a placeholder: earlier ones that stay valid plus the
 * writing computer's own, taken from its approved sign-in name. A name the roster has since signed drops out. */
export function nextEntryNames(
  set: Pick<StoredSealedSet, 'entryNames'> | null,
  roster: Pick<Roster, 'entries'>,
  writer: { id: Uint8Array; name: string },
) {
  const placeholder = (id: Uint8Array) =>
    roster.entries.some(e => e.entryKind === 1 && equalBytes(e.id, id) && !given(e.displayName));
  const names = (set?.entryNames ?? []).filter(n => placeholder(u8(n.id)));
  const name = given(writer.name);
  if (name && placeholder(writer.id)) {
    const at = names.findIndex(n => equalBytes(u8(n.id), writer.id));
    const entry = { id: Uint8Array.from(writer.id).buffer, name };
    if (at < 0) names.push(entry);
    else names[at] = entry;
  }
  return names;
}

type Found = { name: string; account?: ArrayBuffer };
const found = (entry: Entry): Found => ({
  name: given(entry.displayName),
  ...(entry.entryKind === 1 && entry.accountId.length
    ? { account: Uint8Array.from(entry.accountId).buffer }
    : {}),
});

/** The handle lists after a head write: markers still set keep their note; the handle of a removed entry moves to
 * `formerHandles` while the roster still lists that device as a former signer, and leaves with it. A removed computer
 * or CI machine keeps its given name there (and a computer its account, so the page shows a computer's name only to
 * its own account), read from the roster this write replaces and, when absent there, from the history row. Decoding
 * happens only for a former entry with no recorded name, once: a miss is recorded as an empty name. */
export function nextHandles(
  set: StoredSealedSet | null,
  revoked: readonly ArrayBuffer[],
  roster: Roster,
  history: { genesis: ArrayBuffer; transitions: ArrayBuffer[] } | null = null,
) {
  const notes = (set?.revokedNotes ?? []).filter(n => revoked.some(id => equalBytes(u8(id), u8(n.id))));
  const former: NonNullable<StoredSealedSet['formerHandles']> = [
    ...(set?.formerHandles ?? []),
    ...(set?.revokedNotes ?? []).flatMap(n => (n.handle ? [{ id: n.id, handle: n.handle }] : [])),
  ].filter(
    (h, i, all) =>
      roster.former.some(f => equalBytes(f.deviceId, u8(h.id))) &&
      all.findIndex(o => equalBytes(u8(o.id), u8(h.id))) === i,
  );
  // A name recorded earlier (even an empty one: no one could name it) is not looked for again.
  const missing = roster.former.filter(
    f => !former.some(h => h.name !== undefined && equalBytes(u8(h.id), f.deviceId)),
  );
  if (set && missing.length) {
    const lookup = new Map<string, Found>();
    const take = (entries: readonly Entry[]) => {
      for (const entry of entries) {
        const key = hex(entry.id);
        if (!lookup.has(key) || (!lookup.get(key)!.name && given(entry.displayName)))
          lookup.set(key, found(entry));
      }
    };
    take((decodeSealedWire(u8(set.payload)) as { roster: Roster }).roster.entries);
    const open = () => missing.filter(f => !lookup.get(hex(f.deviceId))?.name);
    if (open().length && history) {
      take((decodeSealedWire(u8(history.genesis)) as Roster).entries);
      for (const step of history.transitions) {
        if (!open().length) break;
        take((decodeSealedWire(u8(step)) as Transition).delta.added);
      }
    }
    for (const f of missing) {
      const record = lookup.get(hex(f.deviceId));
      const at = former.findIndex(h => equalBytes(u8(h.id), f.deviceId));
      const next = {
        id: Uint8Array.from(f.deviceId).buffer,
        ...(at >= 0 && former[at]!.handle ? { handle: former[at]!.handle } : {}),
        name: record?.name ?? '',
        ...(record?.name && record.account ? { account: record.account } : {}),
      };
      if (at >= 0) former[at] = next;
      else former.push(next);
    }
  }
  return { revokedNotes: notes, formerHandles: former };
}

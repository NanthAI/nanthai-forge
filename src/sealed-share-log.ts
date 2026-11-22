// SPDX-License-Identifier: Apache-2.0
// Design 5.1 local state, kept in the private device key store under the pin lock, never on a server:
// - this device's own Automatic join requests, the only local evidence the M2 anchor accepts;
// - automatic shares this device made: the daily limit (guard 5) and the notice that survives restarts and
//   clears only when shown to a person on a terminal, even when the share ran inside an agent's command (guard 4).
import { forgeSecretId } from './sealed-format.js';
import { AUTOMATIC_SHARES_PER_DAY, deviceFingerprint, unshareCommand } from './sealed-join.js';
import { wipeDeviceKeys, secretLocked, type StoredDeviceKeys } from './sealed-local.js';
import { lost } from './sealed-pin-store.js';
import { findEntry } from './sealed-roster.js';
import type { Roster } from './sealed-records.js';
import type { SecretPins } from './sealed-pins.js';

const DAY = 24 * 60 * 60 * 1000;
type Share = NonNullable<StoredDeviceKeys['shares']>[number];
const projectKey = (project: string) => forgeSecretId('project', project).toString('hex');
function update<T>(pins: SecretPins, change: (keys: StoredDeviceKeys) => T): Promise<T> {
  return secretLocked(pins.lock, () => {
    const keys = pins.store.load();
    lost(keys);
    try {
      const result = change(keys!);
      pins.store.save(keys!);
      return result;
    } finally {
      wipeDeviceKeys(keys);
    }
  });
}
function read<T>(pins: SecretPins, look: (keys: StoredDeviceKeys) => T): T {
  const keys = pins.store.load();
  lost(keys);
  try {
    return look(keys!);
  } finally {
    wipeDeviceKeys(keys);
  }
}
/** Bounded: a share shown to a person is kept one day for the limit; an unshown one is kept until shown (at most
 * 50 records, dropping shown ones first). The daily limit bounds how fast unshown records can grow. */
function prune(shares: Share[], now: number) {
  const kept = shares.filter(s => !s.shown || now - s.at < DAY);
  return kept.length <= 50 ? kept : kept.filter(s => !s.shown).slice(-50);
}
const today = (s: Share, now: number) => now - s.at < DAY && s.at <= now;

export const recordJoin = (pins: SecretPins, project: string, at: number) =>
  update(pins, keys => {
    keys.joins = { ...keys.joins, [projectKey(project)]: keys.joins?.[projectKey(project)] ?? at };
  });
export const ownJoin = (pins: SecretPins, project: string): number | undefined =>
  read(pins, keys => keys.joins?.[projectKey(project)]);
export const clearJoin = (pins: SecretPins, project: string) =>
  update(pins, keys => {
    if (keys.joins) delete keys.joins[projectKey(project)];
  });
/** Guard 5: how many more automatic shares this device may make now (a planning hint; reserveShares decides). */
export const sharesLeftToday = (pins: SecretPins, now: number) =>
  read(pins, keys => AUTOMATIC_SHARES_PER_DAY - (keys.shares ?? []).filter(s => today(s, now)).length);
/** Guard 5 under the pin lock, before any wrap is built: re-counts today's shares and grants at most what is left,
 * so concurrent runs on one device never exceed the limit. A device already recorded for this project reuses its
 * record (the same keys gain nothing from a second wrap). Recorded before the write, so a crash, a refusal or a
 * lost reply still leaves the notice. Returns the granted device ids, in request order. */
export const reserveShares = (pins: SecretPins, project: string, ids: Buffer[], now: number) =>
  update(pins, keys => {
    const p = projectKey(project),
      wanted = new Set(ids.map(id => id.toString('hex')));
    const shares = keys.shares ?? [];
    const mine = (s: Share) => s.project === p && wanted.has(s.deviceId) && s.state !== 'done';
    let left = AUTOMATIC_SHARES_PER_DAY - shares.filter(s => today(s, now) && !mine(s)).length;
    const granted = ids.filter(() => left-- > 0);
    const hex = new Set(granted.map(id => id.toString('hex')));
    keys.shares = prune(
      [
        ...shares.filter(s => !(mine(s) && hex.has(s.deviceId))),
        ...granted.map(id => ({
          at: now,
          project: p,
          forgeProject: project,
          deviceId: id.toString('hex'),
          state: 'sending' as const,
          shown: false,
        })),
      ],
      now,
    );
    return granted;
  });
/** After a verified read or write. A share whose device the signed roster lists is done. One it does not list stays
 * as `unconfirmed`: the wrap left this device, and a server that stored it can still hide it from this device, so
 * the record is never dropped here and keeps counting against the limit (guards 4 and 5). */
export const settleShares = async (pins: SecretPins, project: string, roster: Roster, now: number) => {
  const p = projectKey(project);
  const listed = (s: Share) => !!findEntry(roster, Buffer.from(s.deviceId, 'hex'));
  const changes = (s: Share) =>
    s.project === p && (s.state === 'sending' || (s.state === 'unconfirmed' && listed(s)));
  // No key-store write on an ordinary read: only a device with an unsettled share of its own takes the lock.
  if (!read(pins, keys => keys.shares?.some(changes))) return;
  await update(pins, keys => {
    keys.shares = prune(
      (keys.shares ?? []).map(s => {
        if (!changes(s)) return s;
        // Becoming done is news even after the unconfirmed line was shown.
        return listed(s)
          ? { ...s, state: 'done' as const, shown: false }
          : { ...s, state: 'unconfirmed' as const };
      }),
      now,
    );
  });
};
/** Guard 4: every automatic share not yet shown to a person, in any project, naming the project. `terminal` marks
 * them shown; otherwise they stay. */
export const shareNotices = (pins: SecretPins, terminal: boolean) => {
  const due = (s: Share) => s.state !== 'sending' && !s.shown;
  const lines = (keys: StoredDeviceKeys) =>
    (keys.shares ?? []).filter(due).map(s => {
      const id = Buffer.from(s.deviceId, 'hex'),
        fp = deviceFingerprint(id),
        at = new Date(s.at).toISOString();
      return s.state === 'done'
        ? `This device shared Development of project ${s.forgeProject} automatically with a new device (fp ${fp}) at ${at}. Not expected? Undo (remove and rotate), in that project: ${unshareCommand(id)}`
        : `This device signed an automatic share of Development of project ${s.forgeProject} for a new device (fp ${fp}) at ${at}, and Forge did not confirm storing it. The set key was in that request: if fp ${fp} is not expected, rotate Development's values; once it is listed, ${unshareCommand(id)} removes it.`;
    });
  const pending = read(pins, lines);
  if (!terminal || !pending.length) return Promise.resolve(pending);
  return update(pins, keys => {
    const shown = lines(keys);
    keys.shares = (keys.shares ?? []).map(s => (due(s) ? { ...s, shown: true } : s));
    return shown;
  });
};
const PAUSE = DAY;
/** Finding 8: a storage refusal pauses automatic sharing on this device for a day for that project. */
export const sharingPaused = (pins: SecretPins, project: string, now: number) =>
  read(pins, keys => {
    const r = keys.shareRefused?.[projectKey(project)];
    return r && now - r.at < PAUSE && r.at <= now ? r.code : undefined;
  });
export const pauseSharing = (pins: SecretPins, project: string, code: string, now: number) =>
  update(pins, keys => {
    keys.shareRefused = { ...keys.shareRefused, [projectKey(project)]: { code, at: now } };
  });

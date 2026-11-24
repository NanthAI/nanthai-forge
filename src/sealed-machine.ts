// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Slice 5 (design 4.15): a machine key is an agreement key only. It never signs, wraps or approves. Its bundle,
// FORGE_SECRETS_KEY, carries the roster it was added in (its pin) and the head floor; a machine has no other memory.
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { ForgeError, invariant } from './errors.js';
import { deriveKey, equalBytes, fixed, frame } from './sealed-format.js';
import { recipientId, type RandomBytes } from './sealed-keys.js';
import { machineBundleBytes } from './sealed-future-records.js';
import { displayText, rosterBytes, type Entry, type Roster } from './sealed-records.js';
import { machineReaderVerifier } from './sealed-portable.js';

const PREFIX = 'fsk1_';
const LABEL = 'forge/secrets/v1/';
export type MachineKeys = { id: Buffer; enc: Buffer; encPub: Buffer };
export type MachineBundle = {
  projectId: Buffer;
  setId: Buffer;
  setKind: 1 | 2 | 3;
  machineId: Buffer;
  enc: Buffer;
  roster: Roster;
  headFloor: number;
};
const keysFrom = (enc: Buffer): MachineKeys => {
  const encPub = Buffer.from(x25519.getPublicKey(enc));
  return { enc, encPub, id: recipientId(2, Buffer.alloc(0), encPub) };
};
export const machineKeys = (random: RandomBytes = randomBytes) =>
  keysFrom(fixed(Buffer.from(random(32)), 32));
/** The key `machine add` makes for one operation: derived one way from the owner device's own private key and the
 * operation id, so repeating that operation after an unknown outcome rebuilds the same key, and the retry journal
 * holds no key (review F5). Only that device can derive it; it never leaves the device except in the bundle. */
export const operationMachineKeys = (deviceEnc: Uint8Array, operationId: string) => {
  const id = Buffer.from(operationId);
  return keysFrom(deriveKey(deviceEnc, id, frame('machine-key', id)));
};
/** Owner-add (how 6): only a full owner device signs the step that adds it (src/sealed-roster.ts checkAdded). */
export const machineEntry = (keys: MachineKeys, label: string, addedBy: Buffer, version: number): Entry => ({
  entryKind: 2,
  id: keys.id,
  encPub: keys.encPub,
  signPub: Buffer.alloc(0),
  accountId: Buffer.alloc(0),
  accountHandle: '',
  displayName: displayText(label),
  role: 3,
  addedBy,
  how: 6,
  addedAtRosterVersion: version,
  bindSig: Buffer.alloc(0),
});
/** The bearer token a machine shows to read its set's ciphertext row (sealedMachines:read). It is derived
 * one way from the private key, so the server, which sees it, learns nothing that opens a wrap. */
export const machineReadToken = (b: Pick<MachineBundle, 'enc' | 'machineId'>) =>
  deriveKey(b.enc, b.machineId, frame('machine-read', fixed(b.machineId, 16)));
export const machineReader = (b: Pick<MachineBundle, 'enc' | 'machineId'>) => {
  const token = machineReadToken(b);
  try {
    return { machineId: b.machineId, verifier: Buffer.from(machineReaderVerifier(token)) };
  } finally {
    token.fill(0);
  }
};
export function encodeMachineBundle(b: MachineBundle) {
  const bytes = machineBundleBytes(
    b.roster,
    b.machineId,
    b.enc,
    b.headFloor,
    Buffer.from(rosterBytes(b.roster)),
  );
  try {
    return PREFIX + Buffer.from(bytes).toString('base64url');
  } finally {
    bytes.fill(0);
  }
}

const malformed = () =>
  new ForgeError('SECRETS_FORMAT_REFUSED', 'FORGE_SECRETS_KEY is not a machine key bundle.');
/** The fields of one frame of `purpose`, in order; every length must fit exactly. */
function fields(bytes: Buffer, purpose: string) {
  const label = Buffer.from(LABEL + purpose);
  invariant(
    bytes.length > label.length && bytes.subarray(0, label.length).equals(label) && bytes[label.length] === 0,
    'SECRETS_FORMAT_REFUSED',
    'FORGE_SECRETS_KEY is not a machine key bundle.',
  );
  const out: Buffer[] = [];
  let at = label.length + 1;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) throw malformed();
    const length = bytes.readUInt32BE(at);
    at += 4;
    if (length > bytes.length - at) throw malformed();
    out.push(bytes.subarray(at, at + length));
    at += length;
  }
  return out;
}
function items(bytes: Buffer) {
  if (bytes.length < 4) throw malformed();
  const count = bytes.readUInt32BE(0),
    out: Buffer[] = [];
  let at = 4;
  for (let i = 0; i < count; i++) {
    if (at + 4 > bytes.length) throw malformed();
    const length = bytes.readUInt32BE(at);
    at += 4;
    if (length > bytes.length - at) throw malformed();
    out.push(bytes.subarray(at, at + length));
    at += length;
  }
  if (at !== bytes.length) throw malformed();
  return out;
}
const u64 = (bytes: Buffer | undefined) => {
  if (bytes?.length !== 8) throw malformed();
  const value = bytes.readBigUInt64BE(0);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed();
  return Number(value);
};
const one = (bytes: Buffer | undefined) => {
  if (bytes?.length !== 1) throw malformed();
  return bytes[0]!;
};
const copy = (bytes: Buffer | undefined, length?: number) => {
  if (!bytes || (length !== undefined && bytes.length !== length)) throw malformed();
  return Buffer.from(bytes);
};
function entry(bytes: Buffer): Entry {
  const f = fields(bytes, 'roster-entry');
  if (f.length !== 12) throw malformed();
  return {
    entryKind: one(f[0]) as Entry['entryKind'],
    id: copy(f[1], 16),
    encPub: copy(f[2], 32),
    signPub: copy(f[3]),
    accountId: copy(f[4]),
    accountHandle: f[5]!.toString('utf8'),
    displayName: f[6]!.toString('utf8'),
    role: one(f[7]) as Entry['role'],
    addedBy: copy(f[8], 16),
    how: one(f[9]) as Entry['how'],
    addedAtRosterVersion: u64(f[10]),
    bindSig: copy(f[11]),
  };
}
function roster(bytes: Buffer): Roster {
  const f = fields(bytes, 'roster');
  if (f.length !== 10) throw malformed();
  const pointer = f[4]!.length ? fields(f[4]!, 'checks-pointer') : null;
  if (pointer && pointer.length !== 2) throw malformed();
  return {
    v: 1,
    projectId: copy(f[0], 16),
    setId: copy(f[1], 16),
    setKind: one(f[2]) as Roster['setKind'],
    sharingMode: one(f[3]) as Roster['sharingMode'],
    checksPointer: pointer
      ? { checksSetId: copy(pointer[0], 16), checksGenesisHash: copy(pointer[1], 32) }
      : null,
    rosterVersion: u64(f[5]),
    epoch: u64(f[6]),
    prevRosterHash: copy(f[7], 32),
    entries: items(f[8]!).map(entry),
    former: items(f[9]!).map(bytes => {
      const g = fields(bytes, 'former');
      if (g.length !== 3) throw malformed();
      return { deviceId: copy(g[0], 16), signPub: copy(g[1], 32), lastEpoch: u64(g[2]) };
    }),
  };
}
/** Strict: the decoded bundle must re-encode to exactly its own bytes, and its key must be the roster's machine. */
export function decodeMachineBundle(text: string): MachineBundle {
  invariant(
    text.startsWith(PREFIX) && /^[A-Za-z0-9_-]+$/.test(text.slice(PREFIX.length)),
    'SECRETS_FORMAT_REFUSED',
    'FORGE_SECRETS_KEY is not a machine key bundle.',
  );
  const bytes = Buffer.from(text.slice(PREFIX.length), 'base64url');
  try {
    const f = fields(bytes, 'machine-bundle');
    if (f.length !== 8) throw malformed();
    const r = roster(f[6]!);
    const b: MachineBundle = {
      projectId: copy(f[0], 16),
      setId: copy(f[1], 16),
      setKind: one(f[2]) as MachineBundle['setKind'],
      machineId: copy(f[3], 16),
      enc: copy(f[4], 32),
      roster: r,
      headFloor: u64(f[7]),
    };
    invariant(
      u64(f[5]) === r.rosterVersion &&
        equalBytes(rosterBytes(r), f[6]!) &&
        equalBytes(b.projectId, r.projectId) &&
        equalBytes(b.setId, r.setId) &&
        b.setKind === r.setKind,
      'SECRETS_FORMAT_REFUSED',
      'FORGE_SECRETS_KEY is not a machine key bundle.',
    );
    const own = r.entries.find(e => equalBytes(e.id, b.machineId));
    invariant(
      own?.entryKind === 2 && equalBytes(Buffer.from(x25519.getPublicKey(b.enc)), own.encPub),
      'SECRETS_FORMAT_REFUSED',
      'FORGE_SECRETS_KEY does not match the machine its roster names.',
    );
    return b;
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw malformed();
  } finally {
    bytes.fill(0);
  }
}

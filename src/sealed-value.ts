// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { randomBytes } from 'node:crypto';
import { invariant } from './errors.js';
import {
  ciphertextHash,
  deriveKey,
  equalBytes,
  fixed,
  frame,
  framedHash,
  octet,
  textBytes,
  uint,
} from './sealed-format.js';
import { decrypt, encrypt, type RandomBytes, type SetContext } from './sealed-keys.js';

export { ciphertextHash };

export type ValueContext = SetContext & {
  name: string;
  kind: 1 | 2;
  valueVersion: number;
  valueEpoch: number;
  sealEpoch: number;
};
export function bucketSize(valueLength: number) {
  invariant(
    Number.isSafeInteger(valueLength) && valueLength >= 0 && valueLength <= 65536,
    'SECRETS_FORMAT_REFUSED',
    'Secret value exceeds the format size.',
  );
  const length = valueLength + 36;
  let bucket = 256;
  while (bucket < length && bucket < 4096) bucket *= 2;
  return length > 4096 ? Math.ceil(length / 4096) * 4096 : bucket;
}
/** The one plaintext layout of a sealed value and of a proposal: length, hidden r, value, zero padding to the
 * value's bucket. The caller zeroes the result. */
export function packValue(value: Uint8Array, r: Uint8Array) {
  const plain = Buffer.alloc(bucketSize(value.length));
  plain.writeUInt32BE(value.length);
  plain.set(fixed(r, 32), 4);
  plain.set(value, 36);
  return plain;
}
/** The checked inverse of packValue: views into `plain` (the caller copies what it keeps, then zeroes it). */
export function unpackValue(plain: Buffer) {
  const length = plain.length >= 36 ? plain.readUInt32BE(0) : -1;
  invariant(
    length >= 0 &&
      length <= 65536 &&
      bucketSize(length) === plain.length &&
      plain.subarray(36 + length).every(byte => byte === 0),
    'SECRETS_VALUE_REFUSED',
    'Invalid value padding.',
  );
  return { r: plain.subarray(4, 36), value: plain.subarray(36, 36 + length) };
}
/** The queue-first rule (lead 2a827903): the next version of `name` is max(its current version, the floor) + 1,
 * always from the current verified head of the write, never from a cached or proposed base. */
export const nextValueVersion = (
  head: { names: readonly Pick<NameFields, 'name' | 'valueVersion'>[]; versionFloor: number },
  name: string,
) => Math.max(head.names.find(n => n.name === name)?.valueVersion ?? 0, head.versionFloor) + 1;
type NameFields = { name: string; kind: number; valueVersion: number; changedAt: number };
/** A new name in a head of 400 records first drops its oldest tombstone, raising the floor to cover it. Runs before
 * nextValueVersion, since it can raise the floor. Changes `head` in place. */
export function makeRoom<T extends NameFields>(head: { names: T[]; versionFloor: number }, name: string) {
  if (head.names.length < 400 || head.names.some(n => n.name === name)) return;
  const tombstone = head.names.filter(n => n.kind === 3).sort((a, b) => a.changedAt - b.changedAt)[0];
  invariant(tombstone, 'SECRETS_FORMAT_REFUSED', 'The set has no tombstone to compact.');
  head.names = head.names.filter(n => n !== tombstone);
  head.versionFloor = Math.max(head.versionFloor, tombstone.valueVersion);
}
export const valueAad = (c: ValueContext) =>
  frame(
    'value',
    fixed(c.projectId, 16),
    fixed(c.setId, 16),
    textBytes(c.name),
    octet(c.kind),
    uint(c.valueVersion),
    uint(c.valueEpoch),
    uint(c.sealEpoch),
  );
export const valueCommitment = (
  c: Pick<ValueContext, 'projectId' | 'setId' | 'name' | 'valueVersion'>,
  r: Uint8Array,
  value: Uint8Array,
) => {
  const bytes = frame(
    'value-commit',
    fixed(c.projectId, 16),
    fixed(c.setId, 16),
    textBytes(c.name),
    uint(c.valueVersion),
    fixed(r, 32),
    value,
  );
  try {
    return framedHash(bytes);
  } finally {
    bytes.fill(0);
  }
};
export function sealValue(
  key: Uint8Array,
  c: ValueContext,
  value: Uint8Array,
  options: { r?: Uint8Array; random?: RandomBytes } = {},
) {
  const random = options.random ?? randomBytes;
  const salt = fixed(random(32), 32),
    nonce = fixed(random(12), 12),
    r = Buffer.from(fixed(options.r ?? random(32), 32));
  let plain: Buffer | undefined, derived: Buffer | undefined;
  try {
    plain = packValue(value, r);
    const aad = valueAad(c);
    derived = deriveKey(key, salt, aad);
    const stored = Buffer.concat([salt, nonce, encrypt(derived, nonce, plain, aad)]);
    return { stored, ctHash: ciphertextHash(c.name, stored), valueCommit: valueCommitment(c, r, value) };
  } finally {
    plain?.fill(0);
    derived?.fill(0);
    r.fill(0);
  }
}
export function openValue(
  key: Uint8Array,
  c: ValueContext,
  stored: Uint8Array,
  expected: { ctHash: Uint8Array; valueCommit: Uint8Array },
) {
  invariant(
    c.sealEpoch === c.epoch &&
      stored.length >= 316 &&
      equalBytes(ciphertextHash(c.name, stored), expected.ctHash),
    'SECRETS_VALUE_REFUSED',
    'Ciphertext does not match the signed record.',
  );
  const aad = valueAad(c),
    derived = deriveKey(key, stored.subarray(0, 32), aad);
  let plain: Buffer | undefined;
  try {
    plain = decrypt(derived, stored.subarray(32, 44), stored.subarray(44), aad);
    const { r, value } = unpackValue(plain);
    invariant(
      equalBytes(valueCommitment(c, r, value), expected.valueCommit),
      'SECRETS_VALUE_REFUSED',
      'Value does not match its signed commitment.',
    );
    return { r: Buffer.from(r), value: Buffer.from(value) };
  } finally {
    plain?.fill(0);
    derived.fill(0);
  }
}

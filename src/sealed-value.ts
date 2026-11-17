// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { invariant } from './errors.js';
import { deriveKey, equalBytes, fixed, frame, framedHash, octet, textBytes, uint } from './sealed-format.js';
import { decrypt, encrypt, type RandomBytes, type SetContext } from './sealed-keys.js';

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
export const ciphertextHash = (name: string, stored: Uint8Array) =>
  framedHash(frame('ct-record', textBytes(name), stored));
export function sealValue(
  key: Uint8Array,
  c: ValueContext,
  value: Uint8Array,
  options: { r?: Uint8Array; random?: RandomBytes } = {},
) {
  const random = options.random ?? randomBytes;
  const plain = Buffer.alloc(bucketSize(value.length));
  const salt = fixed(random(32), 32),
    nonce = fixed(random(12), 12),
    r = Buffer.from(fixed(options.r ?? random(32), 32));
  const aad = valueAad(c),
    derived = deriveKey(key, salt, aad);
  try {
    plain.writeUInt32BE(value.length);
    r.copy(plain, 4);
    plain.set(value, 36);
    const stored = Buffer.concat([salt, nonce, encrypt(derived, nonce, plain, aad)]);
    return { stored, ctHash: ciphertextHash(c.name, stored), valueCommit: valueCommitment(c, r, value) };
  } finally {
    plain.fill(0);
    derived.fill(0);
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
    const length = plain.readUInt32BE(0);
    invariant(
      bucketSize(length) === plain.length && plain.subarray(36 + length).every(byte => byte === 0),
      'SECRETS_VALUE_REFUSED',
      'Invalid value padding.',
    );
    const r = plain.subarray(4, 36),
      value = plain.subarray(36, 36 + length);
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

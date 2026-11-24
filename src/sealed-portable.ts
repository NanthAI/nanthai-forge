// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The one implementation of sealed format framing, protocol hashing and public-key checks.
// Uint8Array only, no node: builtins and no Buffer, so the same functions run in the CLI and
// inside a Convex V8 mutation. Node-only work (AES, HKDF, scrypt, randomness) stays in sealed-format
// and sealed-keys, which re-export these.
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { ForgeError, invariant } from './errors.js';
import { hexBytes, sha256Bytes } from './state/hash.js';

const prefix = 'forge/secrets/v1/';
const purposes = [
  'project-id',
  'account-id',
  'device',
  'machine',
  'person',
  'device-bind',
  'person-enc',
  'person-sign',
  'commit',
  'inbox',
  'value',
  'value-commit',
  'change',
  'ct-record',
  'wrap',
  'wrap-aad',
  'roster-entry',
  'roster',
  'former',
  'checks-pointer',
  'role-change',
  'transition-delta',
  'transition',
  'supersede',
  'head-name',
  'head',
  'proposer',
  'proposal-seal',
  'proposal',
  'prf',
  'person-envelope',
  'envelope-return',
  'page-code',
  'person-checkpoint',
  'code',
  'reply',
  'repin',
  'pins',
  'pin-index',
  'machine-bundle',
  'machine-read',
  'machine-reader',
  'machine-key',
] as const;
export type Purpose = (typeof purposes)[number];
declare const framed: unique symbol;
export type Framed = Uint8Array & { readonly [framed]: true };
const frames = new WeakSet<Uint8Array>();
const utf8 = new TextEncoder();
const labels = new Map(purposes.map(purpose => [purpose, utf8.encode(prefix + purpose)]));
const readLength = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);

export const empty = new Uint8Array(0);
export const hex = hexBytes;
/** Constant-time for equal lengths; lengths are public in every caller. */
export function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
/** Byte order, as Buffer.compare. */
export function compareBytes(a: Uint8Array, b: Uint8Array) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
export function concatBytes(parts: readonly Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
export function requireFrame(bytes: Framed) {
  invariant(frames.has(bytes), 'SECRETS_FORMAT_REFUSED', 'Cryptographic input must use format framing.');
  const end = bytes.indexOf(0);
  invariant(
    end > 0 && end < 96 && [...labels.values()].some(label => equalBytes(bytes.subarray(0, end), label)),
    'SECRETS_FORMAT_REFUSED',
    'Cryptographic frame label is invalid.',
  );
  let offset = end + 1;
  while (offset < bytes.length) {
    invariant(offset + 4 <= bytes.length, 'SECRETS_FORMAT_REFUSED', 'Cryptographic frame length is invalid.');
    const length = readLength(bytes, offset);
    offset += 4;
    invariant(
      length <= bytes.length - offset,
      'SECRETS_FORMAT_REFUSED',
      'Cryptographic frame length is invalid.',
    );
    offset += length;
  }
}
export function uint(value: number | bigint): Uint8Array {
  invariant(
    typeof value === 'bigint'
      ? value >= 0n && value <= 0xffffffffffffffffn
      : Number.isSafeInteger(value) && value >= 0,
    'SECRETS_FORMAT_REFUSED',
    'Invalid unsigned integer.',
  );
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}
export function octet(value: number): Uint8Array {
  invariant(Number.isInteger(value) && value >= 0 && value <= 255, 'SECRETS_FORMAT_REFUSED', 'Invalid enum.');
  return Uint8Array.of(value);
}
export const textBytes = (text: string) => utf8.encode(text.normalize('NFC'));
export function fixed(bytes: Uint8Array, length: number): Uint8Array {
  invariant(bytes.length === length, 'SECRETS_FORMAT_REFUSED', 'Invalid fixed-width field.');
  return bytes;
}
function u32(value: number) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}
const length = (bytes: Uint8Array) => u32(bytes.length);
export function list(items: readonly Uint8Array[]): Uint8Array {
  return concatBytes([u32(items.length), ...items.flatMap(item => [length(item), item])]);
}
export function frame(purpose: Purpose, ...fields: readonly Uint8Array[]): Framed {
  const label = labels.get(purpose);
  invariant(label, 'SECRETS_FORMAT_REFUSED', 'Unknown format purpose.');
  const bytes = concatBytes([label, Uint8Array.of(0), ...fields.flatMap(f => [length(f), f])]) as Framed;
  frames.add(bytes);
  return bytes;
}
/** Protocol hashes accept framed input only. Raw values must never reach this boundary. */
export const framedHash = (bytes: Framed) => {
  requireFrame(bytes);
  return sha256Bytes(bytes);
};
export const forgeSecretId = (kind: 'project' | 'account', id: string) =>
  framedHash(frame(kind === 'project' ? 'project-id' : 'account-id', utf8.encode(id))).subarray(0, 16);

export function verifyBytes(bytes: Framed, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    requireFrame(bytes);
    return ed25519.verify(fixed(signature, 64), bytes, fixed(publicKey, 32), { zip215: false });
  } catch {
    return false;
  }
}
export const recipientId = (kind: 1 | 2 | 3, signPub: Uint8Array, encPub: Uint8Array) =>
  framedHash(
    kind === 2
      ? frame('machine', fixed(encPub, 32))
      : frame(kind === 1 ? 'device' : 'person', fixed(signPub, 32), fixed(encPub, 32)),
  ).subarray(0, 16);
/** A ciphertext's public record hash, which the signed name record carries; the server checks it before storing. */
export const ciphertextHash = (name: string, stored: Uint8Array) =>
  framedHash(frame('ct-record', textBytes(name), stored));
export const bindingBytes = (
  accountId: Uint8Array,
  id: Uint8Array,
  signPub: Uint8Array,
  encPub: Uint8Array,
) => frame('device-bind', fixed(accountId, 16), fixed(id, 16), fixed(signPub, 32), fixed(encPub, 32));
/** Fixed probe scalar. X25519 clamps every scalar to a multiple of the cofactor 8, so any clamped
 * scalar maps a low-order point to zero exactly as a random scalar does. Public, never a key. */
const probeScalar = new Uint8Array(32).fill(0x5c);
/** Refuses an agreement key no wrap could be opened for (low-order or malformed), deterministically. */
export function checkAgreementKey(encPub: Uint8Array) {
  let shared: Uint8Array | undefined;
  try {
    shared = x25519.getSharedSecret(probeScalar, fixed(encPub, 32));
  } catch {
    throw new ForgeError('SECRETS_WRAP_REFUSED', 'Invalid recipient agreement key.');
  }
  invariant(
    !equalBytes(shared, new Uint8Array(32)),
    'SECRETS_WRAP_REFUSED',
    'Invalid recipient agreement key.',
  );
}
/** Slice 5: what the server keeps to let one machine key read its set's ciphertext row. The read token derives from
 * the machine's private key (src/sealed-machine.ts), so it opens nothing; the server stores only this hash of it. */
export const machineReaderVerifier = (token: Uint8Array) =>
  framedHash(frame('machine-reader', fixed(token, 32)));

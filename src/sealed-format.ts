// SPDX-License-Identifier: Apache-2.0
import { createHash, hkdfSync, timingSafeEqual, scryptSync } from 'node:crypto';
import { invariant } from './errors.js';

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
] as const;
type Purpose = (typeof purposes)[number];
declare const framed: unique symbol;
export type Framed = Buffer & { readonly [framed]: true };
const frames = new WeakSet<Uint8Array>();
export function requireFrame(bytes: Framed) {
  invariant(frames.has(bytes), 'SECRETS_FORMAT_REFUSED', 'Cryptographic input must use format framing.');
  const end = bytes.indexOf(0);
  invariant(
    end > 0 &&
      end < 96 &&
      purposes.some(purpose => bytes.subarray(0, end).equals(Buffer.from(prefix + purpose))),
    'SECRETS_FORMAT_REFUSED',
    'Cryptographic frame label is invalid.',
  );
  let offset = end + 1;
  while (offset < bytes.length) {
    invariant(offset + 4 <= bytes.length, 'SECRETS_FORMAT_REFUSED', 'Cryptographic frame length is invalid.');
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    invariant(
      length <= bytes.length - offset,
      'SECRETS_FORMAT_REFUSED',
      'Cryptographic frame length is invalid.',
    );
    offset += length;
  }
}
export const empty = Buffer.alloc(0);
export function uint(value: number | bigint): Buffer {
  invariant(
    typeof value === 'bigint'
      ? value >= 0n && value <= 0xffffffffffffffffn
      : Number.isSafeInteger(value) && value >= 0,
    'SECRETS_FORMAT_REFUSED',
    'Invalid unsigned integer.',
  );
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}
export function octet(value: number): Buffer {
  invariant(Number.isInteger(value) && value >= 0 && value <= 255, 'SECRETS_FORMAT_REFUSED', 'Invalid enum.');
  return Buffer.from([value]);
}
export const textBytes = (text: string) => Buffer.from(text.normalize('NFC'), 'utf8');
export function fixed(bytes: Uint8Array, length: number): Buffer {
  invariant(bytes.length === length, 'SECRETS_FORMAT_REFUSED', 'Invalid fixed-width field.');
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function length(bytes: Uint8Array) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(bytes.length);
  return out;
}
export function list(items: readonly Uint8Array[]): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(items.length);
  return Buffer.concat([count, ...items.flatMap(item => [length(item), item])]);
}
export function frame(purpose: Purpose, ...fields: readonly Uint8Array[]): Framed {
  invariant(purposes.includes(purpose), 'SECRETS_FORMAT_REFUSED', 'Unknown format purpose.');
  const bytes = Buffer.concat([
    Buffer.from(prefix + purpose + '\0'),
    ...fields.flatMap(field => [length(field), field]),
  ]) as Framed;
  frames.add(bytes);
  return bytes;
}
/** Protocol hashes accept framed input only. Raw values must never reach this boundary. */
export const framedHash = (bytes: Framed) => {
  requireFrame(bytes);
  return createHash('sha256').update(bytes).digest();
};
export const deriveKey = (key: Uint8Array, salt: Uint8Array, info: Framed) => {
  requireFrame(info);
  return Buffer.from(hkdfSync('sha256', key, salt, info, 32));
};
export const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);
export const forgeSecretId = (kind: 'project' | 'account', id: string) =>
  framedHash(frame(kind === 'project' ? 'project-id' : 'account-id', Buffer.from(id, 'utf8'))).subarray(
    0,
    16,
  );
export function codeBytes(input: {
  purpose: 1 | 2 | 3 | 4;
  projectId: Uint8Array;
  setId: Uint8Array;
  rosterVersion: number;
  rosterHash: Uint8Array;
  accountId: Uint8Array;
  deviceId: Uint8Array;
  signPub: Uint8Array;
  encPub: Uint8Array;
  nonce: Uint8Array;
}) {
  return scryptSync(
    frame(
      'code',
      octet(input.purpose),
      fixed(input.projectId, 16),
      fixed(input.setId, 16),
      uint(input.rosterVersion),
      fixed(input.rosterHash, 32),
      fixed(input.accountId, 16),
      fixed(input.deviceId, 16),
      fixed(input.signPub, 32),
      fixed(input.encPub, 32),
    ),
    fixed(input.nonce, 16),
    8,
    { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
  );
}
export const replyBytes = (purpose: 1 | 2 | 3 | 4, bytes: Framed, signature: Uint8Array) =>
  framedHash(frame('reply', octet(purpose), bytes, fixed(signature, 64)));

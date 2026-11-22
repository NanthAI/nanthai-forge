// SPDX-License-Identifier: Apache-2.0
import { hkdfSync, timingSafeEqual, scryptSync } from 'node:crypto';
import * as portable from './sealed-portable.js';
import { frame, octet, uint } from './sealed-portable.js';

// Framing and protocol hashing have one implementation, shared with the Convex runtime.
export { empty, frame, list, octet, requireFrame, textBytes, uint, type Framed } from './sealed-portable.js';
const view = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
export const fixed = (bytes: Uint8Array, length: number): Buffer => view(portable.fixed(bytes, length));
export const framedHash = (bytes: portable.Framed) => view(portable.framedHash(bytes));
export const forgeSecretId = (kind: 'project' | 'account', id: string) =>
  view(portable.forgeSecretId(kind, id));
export const deriveKey = (key: Uint8Array, salt: Uint8Array, info: portable.Framed) => {
  portable.requireFrame(info);
  return Buffer.from(hkdfSync('sha256', key, salt, info, 32));
};
export const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);
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
export const replyBytes = (purpose: 1 | 2 | 3 | 4, bytes: portable.Framed, signature: Uint8Array) =>
  framedHash(frame('reply', octet(purpose), bytes, fixed(signature, 64)));

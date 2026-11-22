// SPDX-License-Identifier: Apache-2.0
// Design 5.1: the join request a new device of an account with no Development entry posts, and the device
// fingerprint people compare. Uint8Array only and no node: builtins, so the Convex mutation that stores a
// request runs the same checks as the holder device that later wraps for it. Neither side trusts the other:
// the server binds the request to the caller's account, and the holder re-checks every field it signs.
import { invariant } from './errors.js';
import {
  bindingBytes,
  checkAgreementKey,
  equalBytes,
  hex,
  recipientId,
  verifyBytes,
} from './sealed-portable.js';
import { displayText, type Entry } from './sealed-records.js';
import { bytes, number, record, type Check } from './sealed-schema.js';
import { decodeSealedWire, encodeSealedWire } from './sealed-wire.js';

/** Guard 1: Automatic sharing exists for kind development only, whatever a roster or a server says. */
export const AUTOMATIC_SET_KIND = 1 as const;
/** Guard 5: at most three automatic shares per wrapping device per day. */
export const AUTOMATIC_SHARES_PER_DAY = 3;
export const JOIN_REQUEST_BYTES = 1024;
export type JoinRequest = {
  v: 1;
  projectId: Uint8Array;
  setKind: typeof AUTOMATIC_SET_KIND;
  accountId: Uint8Array;
  id: Uint8Array;
  signPub: Uint8Array;
  encPub: Uint8Array;
  bindSig: Uint8Array;
  displayName: string;
};
function refuse(ok: unknown, message: string): asserts ok {
  invariant(ok, 'SECRETS_FORMAT_REFUSED', message);
}
const text: Check = v =>
  refuse(typeof v === 'string' && v === displayText(v), 'Join request text is invalid.');
const one: Check = v => {
  number(v);
  refuse(v === 1, 'Join request is not for Development.');
};
const shape = record({
  v: one,
  projectId: bytes(16),
  setKind: one,
  accountId: bytes(16),
  id: bytes(16),
  signPub: bytes(32),
  encPub: bytes(32),
  bindSig: bytes(64),
  displayName: text,
});

/** Exact schema plus the device's own proof: its id derives from its keys and it signed its account binding.
 * A request proves only that some holder of these keys asked; who may post one is the server's account check. */
export function decodeJoinRequest(input: Uint8Array): JoinRequest {
  refuse(input.byteLength <= JOIN_REQUEST_BYTES, 'Join request exceeds its size.');
  const value = decodeSealedWire(input);
  shape(value);
  const r = value as JoinRequest;
  checkAgreementKey(r.encPub);
  refuse(
    equalBytes(recipientId(1, r.signPub, r.encPub), r.id) &&
      verifyBytes(bindingBytes(r.accountId, r.id, r.signPub, r.encPub), r.bindSig, r.signPub),
    'Join request keys do not match their signed binding.',
  );
  return r;
}
export const encodeJoinRequest = (request: JoinRequest) => {
  const bytes = encodeSealedWire(request);
  decodeJoinRequest(bytes);
  return bytes;
};

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Short device fingerprint (guards 4 and 9, T85): 40 bits of the key-derived recipient id, as XXXX-XXXX.
 * The joining device prints it while waiting and on its first run; holders' notices print the same. */
export function deviceFingerprint(id: Uint8Array) {
  let bits = 0n;
  for (const byte of id.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let out = '';
  for (let i = 7; i >= 0; i--) out += alphabet[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** The command that undoes an automatic share (guard 7): remove the device and rotate, since the key was handed over. */
export const unshareCommand = (id: Uint8Array) => `nforge secret unshare ${deviceFingerprint(id)}`;
/** Guards 3 and 4: what every holder is told, built only from the signed entry and the step's signer. */
export const automaticShareNotice = (entry: Pick<Entry, 'id'>, signerId: Uint8Array) =>
  `Development was shared automatically with a new device (fp ${deviceFingerprint(entry.id)}) of an account that had no device in it; added by device ${hex(signerId).slice(0, 8)}. Not expected? Undo (remove and rotate): ${unshareCommand(entry.id)}`;

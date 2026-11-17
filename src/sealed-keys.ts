// SPDX-License-Identifier: Apache-2.0
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { ForgeError, invariant } from './errors.js';
import {
  deriveKey,
  empty,
  equalBytes,
  fixed,
  frame,
  framedHash,
  octet,
  uint,
  requireFrame,
  type Framed,
} from './sealed-format.js';

export type RandomBytes = (length: number) => Uint8Array;
export type DeviceKeys = {
  sign: Buffer;
  enc: Buffer;
  signPub: Buffer;
  encPub: Buffer;
  id: Buffer;
  bindSig: Buffer;
  pinKey: Buffer;
};
export function signBytes(bytes: Framed, key: Uint8Array): Buffer {
  requireFrame(bytes);
  return Buffer.from(ed25519.sign(bytes, fixed(key, 32)));
}
export function verifyBytes(bytes: Framed, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    requireFrame(bytes);
    return ed25519.verify(fixed(signature, 64), bytes, fixed(publicKey, 32), { zip215: false });
  } catch {
    return false;
  }
}
export function recipientId(kind: 1 | 2 | 3, signPub: Uint8Array, encPub: Uint8Array): Buffer {
  return framedHash(
    kind === 2
      ? frame('machine', fixed(encPub, 32))
      : frame(kind === 1 ? 'device' : 'person', fixed(signPub, 32), fixed(encPub, 32)),
  ).subarray(0, 16);
}
export const bindingBytes = (
  accountId: Uint8Array,
  id: Uint8Array,
  signPub: Uint8Array,
  encPub: Uint8Array,
) => frame('device-bind', fixed(accountId, 16), fixed(id, 16), fixed(signPub, 32), fixed(encPub, 32));
export function deviceKeys(accountId: Uint8Array, random: RandomBytes = randomBytes): DeviceKeys {
  const sign = fixed(random(32), 32),
    enc = fixed(random(32), 32),
    pinKey = fixed(random(32), 32);
  const signPub = Buffer.from(ed25519.getPublicKey(sign)),
    encPub = Buffer.from(x25519.getPublicKey(enc));
  const id = recipientId(1, signPub, encPub);
  return {
    sign,
    enc,
    signPub,
    encPub,
    id,
    pinKey,
    bindSig: signBytes(bindingBytes(accountId, id, signPub, encPub), sign),
  };
}
export function personKeys(seed: Uint8Array, accountId: Uint8Array) {
  const sign = deriveKey(seed, empty, frame('person-sign', fixed(accountId, 16)));
  const enc = deriveKey(seed, empty, frame('person-enc', fixed(accountId, 16)));
  const signPub = Buffer.from(ed25519.getPublicKey(sign)),
    encPub = Buffer.from(x25519.getPublicKey(enc));
  return { sign, enc, signPub, encPub, id: recipientId(3, signPub, encPub) };
}
export type SetContext = { projectId: Uint8Array; setId: Uint8Array; epoch: number };
export const keyCommit = (key: Uint8Array, c: SetContext) =>
  deriveKey(
    fixed(key, 32),
    empty,
    frame('commit', fixed(c.projectId, 16), fixed(c.setId, 16), uint(c.epoch)),
  );
export function inboxKeys(key: Uint8Array, c: SetContext) {
  const privateKey = deriveKey(
    fixed(key, 32),
    empty,
    frame('inbox', fixed(c.projectId, 16), fixed(c.setId, 16), uint(c.epoch)),
  );
  return { privateKey, publicKey: Buffer.from(x25519.getPublicKey(privateKey)) };
}
export function agree(privateKey: Uint8Array, publicKey: Uint8Array): Buffer {
  try {
    const shared = Buffer.from(x25519.getSharedSecret(fixed(privateKey, 32), fixed(publicKey, 32)));
    invariant(
      !equalBytes(shared, Buffer.alloc(32)),
      'SECRETS_WRAP_REFUSED',
      'Invalid recipient agreement key.',
    );
    return shared;
  } catch {
    throw new ForgeError('SECRETS_WRAP_REFUSED', 'Invalid recipient agreement key.');
  }
}
export function encrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Framed) {
  requireFrame(aad);
  const cipher = createCipheriv('aes-256-gcm', fixed(key, 32), fixed(nonce, 12));
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
export function decrypt(key: Uint8Array, nonce: Uint8Array, stored: Uint8Array, aad: Framed) {
  try {
    requireFrame(aad);
    invariant(stored.length >= 16, 'SECRETS_VALUE_REFUSED', 'Invalid sealed bytes.');
    const cipher = createDecipheriv('aes-256-gcm', fixed(key, 32), fixed(nonce, 12));
    cipher.setAAD(aad);
    cipher.setAuthTag(stored.subarray(-16));
    return Buffer.concat([cipher.update(stored.subarray(0, -16)), cipher.final()]);
  } catch {
    throw new ForgeError('SECRETS_VALUE_REFUSED', 'Sealed bytes could not be authenticated.');
  }
}
export type KeyWrap = { recipientId: Buffer; ephPub: Buffer; ciphertext: Buffer };
function wrapKey(
  shared: Uint8Array,
  ephPub: Uint8Array,
  recipientPub: Uint8Array,
  c: SetContext,
  id: Uint8Array,
  kind: 1 | 2 | 3,
) {
  return deriveKey(
    shared,
    Buffer.concat([ephPub, recipientPub]),
    frame('wrap', fixed(c.projectId, 16), fixed(c.setId, 16), uint(c.epoch), fixed(id, 16), octet(kind)),
  );
}
function wrapAad(c: SetContext, id: Uint8Array, kind: 1 | 2 | 3, commit: Uint8Array) {
  return frame(
    'wrap-aad',
    fixed(c.projectId, 16),
    fixed(c.setId, 16),
    uint(c.epoch),
    fixed(id, 16),
    octet(kind),
    fixed(commit, 32),
  );
}
export function wrapSetKey(
  key: Uint8Array,
  c: SetContext,
  recipient: { id: Uint8Array; encPub: Uint8Array; kind: 1 | 2 | 3 },
  random: RandomBytes = randomBytes,
): KeyWrap {
  const ephemeral = fixed(random(32), 32),
    ephPub = Buffer.from(x25519.getPublicKey(ephemeral));
  let shared: Buffer | undefined, kek: Buffer | undefined;
  try {
    shared = agree(ephemeral, recipient.encPub);
    kek = wrapKey(shared, ephPub, recipient.encPub, c, recipient.id, recipient.kind);
    return {
      recipientId: fixed(recipient.id, 16),
      ephPub,
      ciphertext: encrypt(
        kek,
        Buffer.alloc(12),
        fixed(key, 32),
        wrapAad(c, recipient.id, recipient.kind, keyCommit(key, c)),
      ),
    };
  } finally {
    ephemeral.fill(0);
    shared?.fill(0);
    kek?.fill(0);
  }
}
export function unwrapSetKey(
  wrap: KeyWrap,
  c: SetContext,
  recipient: { id: Uint8Array; enc: Uint8Array; kind: 1 | 2 | 3 },
  commit: Uint8Array,
): Buffer {
  invariant(
    equalBytes(wrap.recipientId, recipient.id),
    'SECRETS_WRAP_REFUSED',
    'Wrap recipient does not match this device.',
  );
  const pub = x25519.getPublicKey(recipient.enc),
    shared = agree(recipient.enc, wrap.ephPub);
  const kek = wrapKey(shared, wrap.ephPub, pub, c, recipient.id, recipient.kind);
  let key: Buffer | undefined;
  try {
    key = decrypt(kek, Buffer.alloc(12), wrap.ciphertext, wrapAad(c, recipient.id, recipient.kind, commit));
    invariant(
      equalBytes(keyCommit(key, c), commit),
      'SECRETS_WRAP_REFUSED',
      'Unwrapped key does not match the signed commitment.',
    );
    return key;
  } catch (error) {
    key?.fill(0);
    throw error;
  } finally {
    shared.fill(0);
    kek.fill(0);
  }
}

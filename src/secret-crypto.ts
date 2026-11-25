// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';

// Seals the server's own service credentials (today only the GitHub App user tokens, convex/githubUserTokenActions.ts)
// under a server keyring. It is never used for a value a person or team stores: those are sealed sets, encrypted on
// devices, and no key that opens one exists on the server (scripts/check-no-server-key.mjs).

export interface SecretBinding {
  owner: string;
  operationId: string;
  repository: string;
  ref: string;
  version: number;
}
export interface SealedSecret {
  keyId: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}
export interface SecretKeyring {
  active: string;
  keys: Record<string, string>;
}
export function secretKeyring(text: string | undefined): SecretKeyring {
  try {
    const ring = JSON.parse(text ?? '');
    invariant(
      ring &&
        typeof ring.active === 'string' &&
        ring.active &&
        ring.keys &&
        typeof ring.keys === 'object' &&
        !Array.isArray(ring.keys),
      'SECRET_SETUP_REQUIRED',
      'Service credential encryption is not configured.',
    );
    secretKey(ring, ring.active);
    return ring;
  } catch {
    throw new ForgeError('SECRET_SETUP_REQUIRED', 'Service credential encryption is not configured.');
  }
}
function secretKey(ring: SecretKeyring, id: string): Buffer {
  const value = Object.hasOwn(ring.keys, id) ? ring.keys[id] : undefined;
  invariant(
    typeof value === 'string' &&
      /^[A-Za-z0-9+/]{43}=$/.test(value) &&
      Buffer.from(value, 'base64').length === 32,
    'SECRET_SETUP_REQUIRED',
    'The retained service credential key is unavailable.',
  );
  return Buffer.from(value, 'base64');
}
function bindingBytes(binding: SecretBinding): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: 1,
      owner: binding.owner,
      operationId: binding.operationId,
      repository: binding.repository,
      ref: binding.ref,
      version: binding.version,
    }),
  );
}
export function sealSecret(ring: SecretKeyring, binding: SecretBinding, value: string): SealedSecret {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', secretKey(ring, ring.active), nonce);
  cipher.setAAD(bindingBytes(binding));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    keyId: ring.active,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
export function openSecret(ring: SecretKeyring, binding: SecretBinding, sealed: SealedSecret): string {
  const key = secretKey(ring, sealed.keyId);
  try {
    const nonce = Buffer.from(sealed.nonce, 'base64'),
      tag = Buffer.from(sealed.tag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(bindingBytes(binding));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(Buffer.from(sealed.ciphertext, 'base64')), cipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new ForgeError('SECRET_INVALID', 'The stored service credential could not be verified.');
  }
}

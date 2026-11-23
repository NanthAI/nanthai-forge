// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { invariant } from './errors.js';
export { CLI_TOKEN_LIFETIME } from './device-lifetime.js';
import { CLI_TOKEN_LIFETIME } from './device-lifetime.js';
export const deviceHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function equalHash(a: string, b: string) {
  const left = Buffer.from(a, 'hex'),
    right = Buffer.from(b, 'hex');
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}
/** A client nonce reconciles start retries; the server controls the bearer secret. */
export function deviceSecret(key: string, operationId: string, clientNonce: string) {
  return createHmac('sha256', key).update(`forge-device-code:${operationId}:${clientNonce}`).digest('hex');
}
export function userCode(key: string, operationId: string, deviceCode: string) {
  const bytes = createHmac('sha256', key).update(`${operationId}:${deviceCode}`).digest();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = [...bytes.subarray(0, 10)].map(b => alphabet[b % alphabet.length]).join('');
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}
export function normalizedCode(value: string) {
  return value.toUpperCase().replace(/[\s-]/g, '');
}
let cachedKeys: { pem: string; keys: ReturnType<typeof deriveTokenKeys> } | undefined;
export function tokenKeys(pem: string) {
  if (cachedKeys?.pem === pem) return cachedKeys.keys;
  const keys = deriveTokenKeys(pem);
  cachedKeys = { pem, keys };
  return keys;
}
function deriveTokenKeys(pem: string) {
  const privateKey = createPrivateKey(pem),
    publicKey = createPublicKey(privateKey);
  invariant(publicKey.asymmetricKeyType === 'rsa', 'AUTH_CONFIGURATION', 'Configure an RSA CLI signing key.');
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = deviceHash(JSON.stringify(jwk));
  return { privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, kid };
}
export function issueDeviceToken(
  pem: string,
  issuer: string,
  input: { owner: string; credentialId: string; issuedAt: number; expiresAt?: number; signInId?: string },
) {
  const keys = tokenKeys(pem);
  const payload = {
    iss: issuer,
    aud: 'forge-cli',
    sub: input.owner,
    iat: input.issuedAt / 1000,
    exp: Math.min(input.issuedAt + CLI_TOKEN_LIFETIME, input.expiresAt ?? Infinity) / 1000,
    forgeCredential: input.credentialId,
    ...(input.signInId ? { forgeSignIn: input.signInId } : {}),
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const message = `${encode({ alg: 'RS256', typ: 'JWT', kid: keys.kid })}.${encode(payload)}`;
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), keys.privateKey).toString('base64url')}`;
}

/** A self-signed key identifies a proposed device; the approving account supplies its authority. */
export function verifyDeviceProof(
  origin: string,
  purpose: 'start' | 'renew',
  operationId: string,
  device: { id: string; key: string; at: number; proof: string },
  extra: unknown = null,
) {
  try {
    if (
      !/^[0-9a-f-]{36}$/i.test(operationId) ||
      !Number.isFinite(device.at) ||
      !/^[0-9a-f-]{36}$/i.test(device.id) ||
      device.key.length > 128 ||
      !/^[A-Za-z0-9_-]{86}$/.test(device.proof)
    )
      return false;
    const key = createPublicKey({ key: Buffer.from(device.key, 'base64url'), type: 'spki', format: 'der' });
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      key.export({ type: 'spki', format: 'der' }).toString('base64url') !== device.key
    )
      return false;
    const claim = { id: device.id, key: device.key, at: device.at };
    return verify(
      null,
      Buffer.from(JSON.stringify(['forge-device-v1', purpose, origin, operationId, claim, extra])),
      key,
      Buffer.from(device.proof, 'base64url'),
    );
  } catch {
    return false;
  }
}
export const stableDeviceCode = (key: string) => `dv-${deviceHash(key).slice(0, 10)}`;

// SPDX-License-Identifier: Apache-2.0
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { invariant } from './errors.js';
export const CLI_TOKEN_LIFETIME = 30 * 24 * 60 * 60 * 1000;
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
  input: { owner: string; credentialId: string; issuedAt: number },
) {
  const keys = tokenKeys(pem);
  const payload = {
    iss: issuer,
    aud: 'forge-cli',
    sub: input.owner,
    iat: input.issuedAt / 1000,
    exp: (input.issuedAt + CLI_TOKEN_LIFETIME) / 1000,
    forgeCredential: input.credentialId,
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const message = `${encode({ alg: 'RS256', typ: 'JWT', kid: keys.kid })}.${encode(payload)}`;
  return `${message}.${sign('RSA-SHA256', Buffer.from(message), keys.privateKey).toString('base64url')}`;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  deploymentUrl,
  httpOrigin,
  readAuth,
  writeAuth,
  authState,
  type SavedDevice,
  type SavedCredential,
} from './auth-store.js';
import { devicePost, deviceRefusal } from './device-endpoint.js';
import { ForgeError, invariant } from './errors.js';
/** The private half remains in the existing owner-only local auth store. Never print this object. */
export function localDevice(deployment: string, replace = false): SavedDevice {
  const origin = deploymentUrl(deployment),
    store = readAuth();
  if (!replace && store.devices?.[origin]) return store.devices[origin];
  const key = generateKeyPairSync('ed25519');
  const device = {
    id: randomUUID(),
    publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  const prior = store.devices?.[origin];
  if (prior)
    Object.assign(device, {
      previousKeys: [
        ...(prior.previousKeys ?? []),
        { id: prior.id, publicKey: prior.publicKey, privateKey: prior.privateKey },
      ],
    });
  store.devices ??= {};
  store.devices[origin] = device;
  writeAuth(store);
  return device;
}
export { stableDeviceCode as deviceCode } from './device-token.js';
export function signedDevice(
  device: SavedDevice,
  origin: string,
  purpose: 'start' | 'renew',
  operationId: string,
  extra: unknown = null,
) {
  const claim = { id: device.id, key: device.publicKey, at: Date.now() };
  const text = JSON.stringify(['forge-device-v1', purpose, origin, operationId, claim, extra]);
  return { ...claim, proof: sign(null, Buffer.from(text), device.privateKey).toString('base64url') };
}
const renewing = new Map<string, Promise<SavedCredential>>();
/** Called only for an expired saved stable-device sign-in. Valid commands do not make another RPC. */
export async function renewDevice(deployment: string): Promise<SavedCredential> {
  const origin = deploymentUrl(deployment),
    active = renewing.get(origin);
  if (active) return active;
  const work = (async () => {
    const store = readAuth(),
      saved = store.deployments[origin],
      device = store.devices?.[origin];
    invariant(
      saved?.deviceId && device && saved.deviceId === device.id,
      'AUTH_EXPIRED',
      'Run nforge login to sign in again.',
    );
    if (saved.expiresAt > Date.now()) return saved;
    const endpoint = httpOrigin(origin);
    let pending =
      device.pendingRenewal ??
      (() => {
        const operationId = randomUUID(),
          proof = signedDevice(device, endpoint, 'renew', operationId);
        device.pendingRenewal = { operationId, at: proof.at, proof: proof.proof };
        writeAuth(store);
        return device.pendingRenewal;
      })();
    let operationId = pending.operationId;
    let input = {
      operationId,
      device: { id: device.id, key: device.publicKey, at: pending.at, proof: pending.proof },
    };
    const send = async () => {
      const response = await devicePost(endpoint, 'renew', JSON.stringify(input));
      const result = (await response.json()) as Record<string, unknown>;
      if (response.status === 429)
        throw new ForgeError(
          'AUTH_SLOW_DOWN',
          deviceRefusal(result) ??
            'Device logins and renewals share this deployment’s request budget. Try the original command in a minute.',
        );
      if (!response.ok)
        throw new ForgeError(
          'AUTH_REQUEST_FAILED',
          deviceRefusal(result) ?? 'Forge could not renew this sign-in. Retry the original command.',
        );
      return result;
    };
    let result: Record<string, unknown>;
    try {
      result = await send();
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      result = await send();
    }
    if (
      result.status === 'proof-expired' ||
      (result.status === 'approved' && typeof result.expiresAt === 'number' && result.expiresAt <= Date.now())
    ) {
      operationId = randomUUID();
      const proof = signedDevice(device, endpoint, 'renew', operationId);
      device.pendingRenewal = pending = { operationId, at: proof.at, proof: proof.proof };
      writeAuth(store);
      input = {
        operationId,
        device: { id: device.id, key: device.publicKey, at: pending.at, proof: pending.proof },
      };
      result = await send();
    }
    invariant(
      result.status === 'approved',
      'AUTH_REVOKED',
      result.status === 'unapproved' || result.status === 'superseded'
        ? 'This device approval is unavailable. Run nforge login to approve it again.'
        : result.status === 'approval-expired'
          ? 'This device approval ended. Run nforge login to approve it again; its name and settings are kept.'
          : result.status === 'removed'
            ? 'This device was removed. Run nforge login to approve a new device.'
            : 'This device is signed out. Run nforge login; its name and settings are kept.',
    );
    invariant(
      typeof result.token === 'string' && typeof result.expiresAt === 'number',
      'AUTH_RESPONSE_INVALID',
      'Forge returned an invalid renewed sign-in.',
    );
    const credential = {
      ...saved,
      token: result.token,
      expiresAt: result.expiresAt,
      ...(typeof result.signInId === 'string' ? { signInId: result.signInId } : {}),
    };
    const latest = readAuth();
    invariant(
      latest.deployments[origin]?.credentialId === saved.credentialId,
      'AUTH_OPERATION_CHANGED',
      'The local sign-in changed during renewal. Retry your command.',
    );
    latest.deployments[origin] = credential;
    if (latest.devices?.[origin]?.pendingRenewal?.operationId === operationId)
      delete latest.devices[origin].pendingRenewal;
    writeAuth(latest);
    authState(origin);
    process.stderr.write(`Sign-in renewed on ${saved.deviceCode ?? 'this approved device'}.\n`);
    return credential;
  })();
  renewing.set(origin, work);
  try {
    return await work;
  } finally {
    renewing.delete(origin);
  }
}

// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { randomUUID } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';
import { ownerOnly } from './file-mode.js';
import { processAliveCached, processIdentityIfKnown } from './local-process.js';
import { refuseRealUserState } from './test-isolation.js';
import { syncDirectory } from './state/durability.js';
import { deviceKeys, type DeviceKeys } from './sealed-keys.js';

export function privateDirectory(path: string) {
  refuseRealUserState(path, 'sealed secret state');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  invariant(
    lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
    'SECRETS_PIN_LOST',
    'Local secret state directory is invalid.',
  );
  chmodSync(path, 0o700);
}
export function readPrivate(path: string): Buffer {
  const stat = lstatSync(path);
  invariant(
    stat.isFile() &&
      ownerOnly(stat.mode) &&
      (process.platform === 'win32' || stat.uid === process.getuid?.()),
    'SECRETS_PIN_LOST',
    'Local secret state must be a private regular file.',
  );
  return readFileSync(path);
}
export function atomicPrivate(path: string, bytes: Uint8Array) {
  privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}`,
    fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
type Lock = { pid: number; startTime?: string; token: string };
const readLock = (path: string): Lock | undefined => {
  try {
    const lock = deserialize(readPrivate(path)) as Lock;
    if (
      Number.isSafeInteger(lock.pid) &&
      lock.pid > 0 &&
      typeof lock.token === 'string' &&
      /^[0-9a-f-]{36}$/i.test(lock.token) &&
      (lock.startTime === undefined || typeof lock.startTime === 'string')
    )
      return lock;
  } catch {
    /* An interrupted legacy publication is reclaimed only after its grace period. */
  }
  return undefined;
};
const staleLock = (path: string) => {
  const lock = readLock(path);
  try {
    const stat = lstatSync(path);
    return { lock, stat, stale: lock ? !processAliveCached(lock) : Date.now() - stat.mtimeMs > 30_000 };
  } catch {
    return undefined;
  }
};
function removeStale(path: string, expectedToken?: string) {
  const before = staleLock(path);
  if (!before?.stale || (expectedToken !== undefined && before.lock?.token !== expectedToken)) return false;
  const now = staleLock(path);
  if (
    !now?.stale ||
    now.stat.ino !== before.stat.ino ||
    now.stat.dev !== before.stat.dev ||
    now.lock?.token !== before.lock?.token
  )
    return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Stream the directory; a complete candidate's token and dead process must both match. */
function sweepCandidates(path: string) {
  const directory = opendirSync(dirname(path)),
    prefix = `${basename(path)}.`;
  try {
    for (let entry; (entry = directory.readSync());) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.candidate')) continue;
      const token = entry.name.slice(prefix.length, -'.candidate'.length);
      if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(token))
        removeStale(join(dirname(path), entry.name), token);
    }
  } finally {
    directory.closeSync();
  }
}
/** Publish complete, fsynced lock contents with an exclusive hard link. No empty lock window. */
export async function secretLocked<T>(path: string, run: () => T, waitMs = 10_000): Promise<T> {
  privateDirectory(dirname(path));
  sweepCandidates(path);
  const own = { ...processIdentityIfKnown(), token: randomUUID() },
    began = Date.now();
  const temporary = `${path}.${own.token}.candidate`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, serialize(own));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let delay = 5,
    acquired = false;
  try {
    for (;;) {
      try {
        linkSync(temporary, path);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stale = staleLock(path);
      if (stale?.stale) {
        const gate = `${path}.${stale.lock?.token ?? 'unreadable'}.reclaim`;
        let gateHeld = false;
        try {
          try {
            linkSync(temporary, gate);
            gateHeld = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            removeStale(gate);
          }
          if (gateHeld) removeStale(path);
        } finally {
          if (gateHeld && readLock(gate)?.token === own.token) unlinkSync(gate);
        }
        if (!existsSync(path)) continue;
      }
      invariant(
        Date.now() - began < waitMs,
        'SECRETS_PIN_BUSY',
        'Another command holds the secret pin lock. Retry; incomplete legacy locks become reclaimable after 30 seconds.',
      );
      await new Promise(resolve =>
        setTimeout(resolve, Math.min(delay, Math.max(1, waitMs - (Date.now() - began)))),
      );
      delay = Math.min(100, delay * 2);
    }
    return run();
  } finally {
    if (acquired && readLock(path)?.token === own.token) unlinkSync(path);
    unlinkSync(temporary);
  }
}
export type StoredDeviceKeys = DeviceKeys & { pinCounter: number; pinned?: Record<string, number[]> };
export interface KeyStore {
  load(): StoredDeviceKeys | null;
  save(keys: StoredDeviceKeys): void;
}
export function wipeDeviceKeys(keys: DeviceKeys | null | undefined) {
  keys?.sign?.fill?.(0);
  keys?.enc?.fill?.(0);
  keys?.pinKey?.fill?.(0);
}
/** Slice 1 uses a private file on every platform. Keychain backends fit this interface later. */
export class FileKeyStore implements KeyStore {
  constructor(readonly path: string) {}
  load(): StoredDeviceKeys | null {
    if (!existsSync(this.path)) return null;
    let bytes: Buffer | undefined, keys: StoredDeviceKeys | undefined;
    try {
      bytes = readPrivate(this.path);
      keys = deserialize(bytes) as StoredDeviceKeys;
      const loaded = keys;
      invariant(
        ['sign', 'enc', 'signPub', 'encPub', 'pinKey'].every(
          name =>
            Buffer.isBuffer(loaded[name as keyof DeviceKeys]) &&
            (loaded[name as keyof DeviceKeys] as Buffer).length === 32,
        ) &&
          keys.id.length === 16 &&
          keys.bindSig.length === 64 &&
          Number.isSafeInteger(keys.pinCounter) &&
          keys.pinCounter >= 0,
        'SECRETS_PIN_LOST',
        'Local device key store is invalid.',
      );
      return {
        ...keys,
        sign: Buffer.from(keys.sign),
        enc: Buffer.from(keys.enc),
        pinKey: Buffer.from(keys.pinKey),
        signPub: Buffer.from(keys.signPub),
        encPub: Buffer.from(keys.encPub),
        id: Buffer.from(keys.id),
        bindSig: Buffer.from(keys.bindSig),
      };
    } catch {
      throw new ForgeError('SECRETS_PIN_LOST', 'Local device key store is invalid.');
    } finally {
      wipeDeviceKeys(keys);
      bytes?.fill(0);
    }
  }
  save(keys: StoredDeviceKeys) {
    const bytes = serialize(keys);
    try {
      atomicPrivate(this.path, bytes);
    } finally {
      bytes.fill(0);
    }
  }
}
export async function ensureSecretDevice(directory: string, accountId: Buffer): Promise<StoredDeviceKeys> {
  return secretLocked(join(directory, 'pins.lock'), () => {
    const store = new FileKeyStore(join(directory, 'device.bin'));
    const existing = store.load();
    if (existing) return existing;
    const keys = { ...deviceKeys(accountId), pinCounter: 0 };
    try {
      store.save(keys);
      return keys;
    } catch (error) {
      wipeDeviceKeys(keys);
      throw error;
    }
  });
}

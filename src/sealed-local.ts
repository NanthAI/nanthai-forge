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
import { randomBytes, randomUUID } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';
import { ownerOnly } from './file-mode.js';
import { processAliveCached, processIdentityIfKnown } from './local-process.js';
import { refuseRealUserState } from './test-isolation.js';
import { syncDirectory } from './state/durability.js';
import { deviceKeys, type DeviceKeys } from './sealed-keys.js';
import { KeychainKeyStore, platformKeychain, type Keychain } from './sealed-keychain.js';

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
export type StoredDeviceKeys = DeviceKeys & {
  pinCounter: number;
  pinned?: Record<string, number[]>;
  /** Design 5.1 local state (sealed-share-log): own Automatic join requests and automatic shares made. */
  joins?: Record<string, number>;
  /** `unconfirmed`: signed and sent, but no verified roster lists it yet (refused, lost or hidden by the server). */
  shares?: {
    at: number;
    project: string;
    forgeProject: string;
    deviceId: string;
    state: 'sending' | 'done' | 'unconfirmed';
    shown: boolean;
  }[];
  /** A storage refusal of this device's automatic share: sharing pauses a day per project (no retry each run). */
  shareRefused?: Record<string, { code: string; at: number }>;
};
export interface KeyStore {
  load(): StoredDeviceKeys | null;
  save(keys: StoredDeviceKeys): void;
}
export function wipeDeviceKeys(keys: DeviceKeys | null | undefined) {
  keys?.sign?.fill?.(0);
  keys?.enc?.fill?.(0);
  keys?.pinKey?.fill?.(0);
}
/** Validates a serialized device key record and returns fresh copies; the decoded buffers are wiped. */
export function decodeDeviceKeys(bytes: Buffer): StoredDeviceKeys {
  let keys: StoredDeviceKeys | undefined;
  try {
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
  }
}
/** The private file store: the fallback where no OS keychain can be used without a prompt. */
export class FileKeyStore implements KeyStore {
  constructor(readonly path: string) {}
  load(): StoredDeviceKeys | null {
    if (!existsSync(this.path)) return null;
    let bytes: Buffer | undefined;
    try {
      bytes = readPrivate(this.path);
    } catch {
      throw new ForgeError('SECRETS_PIN_LOST', 'Local device key store is invalid.');
    }
    try {
      return decodeDeviceKeys(bytes);
    } finally {
      bytes.fill(0);
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
function sweepDeviceKeyTemps(directory: string) {
  const entries = opendirSync(directory);
  let removed = false;
  try {
    for (let entry; (entry = entries.readSync());) {
      if (
        !entry.isFile() ||
        !/^(?:device\.(?:bin|kc)|keychain-retry\.bin)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          entry.name,
        )
      )
        continue;
      unlinkSync(join(directory, entry.name));
      removed = true;
    }
  } finally {
    entries.closeSync();
  }
  if (removed) syncDirectory(directory);
}
const sameKeys = (a: StoredDeviceKeys, b: StoredDeviceKeys) => {
  const left = serialize(a),
    right = serialize(b);
  try {
    return left.equals(right);
  } finally {
    left.fill(0);
    right.fill(0);
  }
};
const RETRY_MS = 24 * 60 * 60 * 1000;
const retryPath = (directory: string) => join(directory, 'keychain-retry.bin');
function keychainDeferred(directory: string) {
  try {
    const after = (deserialize(readPrivate(retryPath(directory))) as { after?: unknown }).after;
    return typeof after === 'number' && Date.now() < after;
  } catch {
    return false;
  }
}
/** Moves the record into the keychain store: the private file goes only after a verified round trip. */
function intoKeychain(directory: string, keychain: Keychain, keys: StoredDeviceKeys): KeyStore | null {
  const path = join(directory, 'device.kc');
  if (keychainDeferred(directory)) return null;
  const store = new KeychainKeyStore(path, keychain, randomBytes(16).toString('hex'));
  let created = false;
  try {
    store.create(keys);
    created = true;
    const back = store.load();
    try {
      invariant(back && sameKeys(back, keys), 'SECRETS_KEYCHAIN_UNAVAILABLE', 'Keychain round trip failed.');
    } finally {
      wipeDeviceKeys(back);
    }
    if (existsSync(retryPath(directory))) unlinkSync(retryPath(directory));
    return store;
  } catch {
    // Any failure keeps (or writes) the private file; the next attempt waits a day so headless runs
    // pay at most one bounded timeout per day.
    if (existsSync(path)) unlinkSync(path);
    if (created) store.forget();
    atomicPrivate(retryPath(directory), serialize({ after: Date.now() + RETRY_MS }));
    return null;
  }
}
/** Moves keys back to the private file (the opt-out, or a newer private record), then drops the
 * keychain copy and its item. The keychain file goes only after the private file reads back equal. */
function toFile(file: FileKeyStore, sealed: KeychainKeyStore, keys: StoredDeviceKeys, directory: string) {
  if (!existsSync(file.path)) {
    file.save(keys);
    const back = file.load();
    try {
      invariant(back && sameKeys(back, keys), 'SECRETS_PIN_LOST', 'Local device key store is invalid.');
    } finally {
      wipeDeviceKeys(back);
    }
  }
  unlinkSync(sealed.path);
  syncDirectory(directory);
  sealed.forget();
  return { keys, store: file as KeyStore };
}
/** Both files: an unfinished move, a restored or synced copy, or the opt-out. Never lose the newer
 * record of this device, and never swap one device identity for another. */
function reconcile(
  directory: string,
  file: FileKeyStore,
  keychain: Keychain | null,
  useKeychain: boolean,
): { keys: StoredDeviceKeys; store: KeyStore } {
  const plain = file.load()!;
  let sealed: KeychainKeyStore | undefined,
    kept: StoredDeviceKeys | null = null;
  try {
    const header = KeychainKeyStore.header(join(directory, 'device.kc'));
    if (keychain?.name === header.keychain) {
      sealed = new KeychainKeyStore(join(directory, 'device.kc'), keychain, header.account);
      kept = sealed.load();
    }
  } catch {
    kept = null;
  }
  // The keychain cannot be read now: keep both files and use the private one.
  if (!sealed || !kept) return { keys: plain, store: file };
  if (!plain.id.equals(kept.id)) {
    wipeDeviceKeys(plain);
    wipeDeviceKeys(kept);
    throw new ForgeError(
      'SECRETS_KEYCHAIN_UNAVAILABLE',
      `Two different device key stores are in ${directory}. Both were kept; move the device.bin that does not belong to this computer out of that folder.`,
    );
  }
  if (plain.pinCounter >= kept.pinCounter) {
    // Identical: the move finished except for removing the private file.
    if (useKeychain && sameKeys(plain, kept)) {
      wipeDeviceKeys(plain);
      unlinkSync(file.path);
      syncDirectory(directory);
      return { keys: kept, store: sealed };
    }
    // The private record is as new or newer (an unfinished move, or the opt-out): it wins.
    wipeDeviceKeys(kept);
    return toFile(file, sealed, plain, directory);
  }
  // An older private copy came back (backup or sync): the keychain record is newer.
  wipeDeviceKeys(plain);
  unlinkSync(file.path);
  syncDirectory(directory);
  return useKeychain ? { keys: kept, store: sealed } : toFile(file, sealed, kept, directory);
}
/** Opens this device's key store, creating keys on first use. FORGE_SECRET_KEYCHAIN=off keeps (or
 * moves keys back to) the private file, for sessions that cannot reach the keychain. */
export async function openSecretDevice(
  directory: string,
  accountId: Buffer,
  keychain: Keychain | null = platformKeychain(),
  useKeychain = process.env.FORGE_SECRET_KEYCHAIN !== 'off',
): Promise<{ keys: StoredDeviceKeys; store: KeyStore }> {
  // Up to two bounded keychain calls run under the lock; wait past them.
  return secretLocked(
    join(directory, 'pins.lock'),
    () => {
      // All production device-key writes share this lock, so these copies have no live writer.
      sweepDeviceKeyTemps(directory);
      const file = new FileKeyStore(join(directory, 'device.bin')),
        sealedPath = join(directory, 'device.kc');
      if (existsSync(sealedPath)) {
        if (existsSync(file.path)) return reconcile(directory, file, keychain, useKeychain);
        // Keys live only behind the keychain: never fall back to new keys or a stale copy.
        const header = KeychainKeyStore.header(sealedPath);
        invariant(
          keychain?.name === header.keychain,
          'SECRETS_KEYCHAIN_UNAVAILABLE',
          'This device key is in an OS keychain that this session cannot use. Run once from the signed-in desktop session, with FORGE_SECRET_KEYCHAIN=off to move it back to a private file.',
        );
        const sealed = new KeychainKeyStore(sealedPath, keychain, header.account);
        const keys = sealed.load()!;
        return useKeychain ? { keys, store: sealed } : toFile(file, sealed, keys, directory);
      }
      const existing = file.load();
      const keys = existing ?? { ...deviceKeys(accountId), pinCounter: 0 };
      try {
        const sealed = keychain && useKeychain ? intoKeychain(directory, keychain, keys) : null;
        if (sealed) {
          if (existing) {
            unlinkSync(file.path);
            syncDirectory(directory);
          }
          return { keys, store: sealed };
        }
        if (!existing) file.save(keys);
        return { keys, store: file };
      } catch (error) {
        if (!existing) wipeDeviceKeys(keys);
        throw error;
      }
    },
    30_000,
  );
}
export async function ensureSecretDevice(directory: string, accountId: Buffer, keychain?: Keychain | null) {
  return (await openSecretDevice(directory, accountId, keychain)).keys;
}

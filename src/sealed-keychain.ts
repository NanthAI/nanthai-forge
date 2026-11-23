// SPDX-License-Identifier: Apache-2.0
// OS keychain backends for the device key store (Item a9f9b608). The keychain holds one random
// 32-byte wrapping key per device; it encrypts the device key file. Key material reaches the
// keychain tools through stdin only, never argv, and every tool call is bounded by a timeout so a
// headless run cannot hang on an unlock or access prompt.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { ForgeError, invariant } from './errors.js';
import { inTestProcess } from './test-isolation.js';
import {
  atomicPrivate,
  decodeDeviceKeys,
  readPrivate,
  type KeyStore,
  type StoredDeviceKeys,
} from './sealed-local.js';

export type KeychainName = 'macos-security' | 'linux-secret-tool';
export type ToolRun = (
  command: string,
  args: string[],
  input: string | undefined,
  timeoutMs: number,
) => { status: number | null; stdout: string; stderr: string; failed: boolean };
/** One keychain: `read` returns null only when the tool says the item does not exist. */
export interface Keychain {
  readonly name: KeychainName;
  read(account: string): Buffer | null;
  write(account: string, key: Buffer): void;
  /** Best effort: deletes an item this store no longer uses. Never throws. */
  remove(account: string): void;
}

const SERVICE = 'dev.nforge.sealed-device';
const LABEL = 'nforge-sealed-device-key';
export const KEYCHAIN_TIMEOUT_MS = 5_000;
const TOKEN = /^nforge-kek-v1:([A-Za-z0-9_-]{43})$/;
const ACCOUNT = /^[0-9a-f]{32}$/;

const unavailable = (message: string) => new ForgeError('SECRETS_KEYCHAIN_UNAVAILABLE', message);
const remove = (run: ToolRun, tool: string, args: string[]) => {
  try {
    run(tool, args, undefined, KEYCHAIN_TIMEOUT_MS);
  } catch {
    /* Best effort: an orphaned item holds only an unused random key. */
  }
};
// The token travels as a JS string (stdin text, tool stdout), which cannot be wiped; Buffers are.
const encodeToken = (key: Buffer) => `nforge-kek-v1:${key.toString('base64url')}`;
function decodeToken(text: string) {
  const match = TOKEN.exec(text.replace(/\r?\n$/, ''));
  invariant(match, 'SECRETS_KEYCHAIN_UNAVAILABLE', 'The OS keychain returned an unreadable device key.');
  const key = Buffer.from(match[1]!, 'base64url');
  invariant(
    key.length === 32,
    'SECRETS_KEYCHAIN_UNAVAILABLE',
    'The OS keychain returned an unreadable device key.',
  );
  return key;
}

/** spawnSync with no shell, piped stdin only when needed, a hard kill at the timeout and its own
 * session (no controlling terminal), so no tool can read a prompt answer from the terminal. */
export const runTool: ToolRun = (command, args, input, timeoutMs) => {
  const result = spawnSync(command, args, {
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    detached: true,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  } as Parameters<typeof spawnSync>[2] & { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    failed: Boolean(result.error) || result.signal !== null,
  };
};

/** macOS `security`. Writes use interactive mode so the key is a stdin line, not an argument. */
export function macosKeychain(run: ToolRun = runTool, tool = '/usr/bin/security'): Keychain {
  return {
    name: 'macos-security',
    read(account) {
      invariant(ACCOUNT.test(account), 'SECRETS_KEYCHAIN_UNAVAILABLE', 'Invalid keychain account.');
      const result = run(
        tool,
        ['find-generic-password', '-a', account, '-s', SERVICE, '-w'],
        undefined,
        KEYCHAIN_TIMEOUT_MS,
      );
      // errSecItemNotFound: the tool exits 44.
      if (!result.failed && result.status === 44) return null;
      if (result.failed || result.status !== 0)
        throw unavailable('The OS keychain could not be read without a prompt. Unlock it and retry.');
      return decodeToken(result.stdout);
    },
    write(account, key) {
      invariant(ACCOUNT.test(account), 'SECRETS_KEYCHAIN_UNAVAILABLE', 'Invalid keychain account.');
      const result = run(
        tool,
        ['-i'],
        `add-generic-password -U -a ${account} -s ${SERVICE} -l ${LABEL} -w ${encodeToken(key)}\n`,
        KEYCHAIN_TIMEOUT_MS,
      );
      // `security -i` can exit 0 when its inner command failed: callers verify by reading back.
      if (result.failed || result.status !== 0)
        throw unavailable('The OS keychain could not be written without a prompt.');
    },
    remove(account) {
      if (ACCOUNT.test(account)) remove(run, tool, ['delete-generic-password', '-a', account, '-s', SERVICE]);
    },
  };
}

/** Linux libsecret `secret-tool`: `store` reads the secret from stdin; `lookup` prints it. Only an
 * absolute path is used, so no PATH entry (such as a Lane's node_modules/.bin) receives the key. */
export function linuxKeychain(run: ToolRun = runTool, tool = '/usr/bin/secret-tool'): Keychain {
  const attributes = (account: string) => ['service', SERVICE, 'account', account];
  return {
    name: 'linux-secret-tool',
    read(account) {
      invariant(ACCOUNT.test(account), 'SECRETS_KEYCHAIN_UNAVAILABLE', 'Invalid keychain account.');
      const result = run(tool, ['lookup', ...attributes(account)], undefined, KEYCHAIN_TIMEOUT_MS);
      // A missing item exits 1 with no output; any message on stderr is an error.
      if (!result.failed && result.status === 1 && !result.stdout && !result.stderr.trim()) return null;
      if (result.failed || result.status !== 0)
        throw unavailable('The OS keychain could not be read without a prompt. Unlock it and retry.');
      return decodeToken(result.stdout);
    },
    write(account, key) {
      invariant(ACCOUNT.test(account), 'SECRETS_KEYCHAIN_UNAVAILABLE', 'Invalid keychain account.');
      const result = run(
        tool,
        ['store', `--label=${LABEL}`, ...attributes(account)],
        encodeToken(key),
        KEYCHAIN_TIMEOUT_MS,
      );
      if (result.failed || result.status !== 0)
        throw unavailable('The OS keychain could not be written without a prompt.');
    },
    remove(account) {
      if (ACCOUNT.test(account)) remove(run, tool, ['clear', ...attributes(account)]);
    },
  };
}

/** The platform keychain, or null for the private-file fallback. Tests never reach a real one. */
export function platformKeychain(): Keychain | null {
  if (inTestProcess()) return null;
  if (process.platform === 'darwin' && existsSync('/usr/bin/security')) return macosKeychain();
  // Without a session bus there is no Secret Service to ask, and autolaunch could block.
  if (
    process.platform === 'linux' &&
    process.env.DBUS_SESSION_BUS_ADDRESS &&
    existsSync('/usr/bin/secret-tool')
  )
    return linuxKeychain();
  return null;
}

// One keychain read per wrapping key per few minutes; the key never changes after creation. Gate B2 L9: a cached key
// is zeroed after CACHE_MS, so a long-lived process (nforge mcp) does not hold it for ever. Callers use the key only
// inside one synchronous load or save, so a timer never wipes a key in use.
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, Buffer>();
const timers = new Map<string, NodeJS.Timeout>();
function remember(id: string, key: Buffer) {
  clearTimeout(timers.get(id));
  cache.get(id)?.fill(0);
  cache.set(id, key);
  const timer = setTimeout(() => {
    cache.get(id)?.fill(0);
    cache.delete(id);
    timers.delete(id);
  }, CACHE_MS);
  timer.unref();
  timers.set(id, timer);
}
export const forgetKeychainCache = () => {
  for (const key of cache.values()) key.fill(0);
  cache.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
};

type Envelope = { v: 1; keychain: KeychainName; account: string; nonce: Buffer; data: Buffer; tag: Buffer };
const aad = (keychain: string, account: string) =>
  Buffer.from(`forge-local-device-keystore-v1\0${keychain}\0${account}`, 'utf8');

/** The device key record, AES-256-GCM encrypted under a key held only in the OS keychain. */
export class KeychainKeyStore implements KeyStore {
  constructor(
    readonly path: string,
    readonly keychain: Keychain,
    readonly account: string,
  ) {
    invariant(ACCOUNT.test(account), 'SECRETS_KEYCHAIN_UNAVAILABLE', 'Invalid keychain account.');
  }
  /** Reads the envelope header (no secret) to learn which keychain item opens it. */
  static header(path: string): { keychain: KeychainName; account: string } {
    try {
      const envelope = deserialize(readPrivate(path)) as Envelope;
      invariant(
        envelope.v === 1 &&
          (envelope.keychain === 'macos-security' || envelope.keychain === 'linux-secret-tool') &&
          ACCOUNT.test(envelope.account),
        'SECRETS_PIN_LOST',
        'Local device key store is invalid.',
      );
      return { keychain: envelope.keychain, account: envelope.account };
    } catch {
      throw new ForgeError('SECRETS_PIN_LOST', 'Local device key store is invalid.');
    }
  }
  private key(): Buffer {
    const id = `${this.keychain.name}:${this.account}`,
      cached = cache.get(id);
    if (cached) return cached;
    const key = this.keychain.read(this.account);
    // A locked or unreachable keychain can also answer "not found": never advise a new identity first.
    if (!key)
      throw unavailable(
        'The OS keychain returned no key for this device. Unlock the keychain or run from the signed-in desktop session; enrol this device again only if its keychain item was deleted.',
      );
    remember(id, key);
    return key;
  }
  /** Creates the wrapping key, proves the keychain returns it, then encrypts the record. A failure
   * after the write removes the item again, so failed attempts leave no orphaned keys. */
  create(keys: StoredDeviceKeys) {
    const key = randomBytes(32);
    let written = false;
    try {
      this.keychain.write(this.account, key);
      written = true;
      const back = this.keychain.read(this.account);
      try {
        invariant(
          back?.equals(key),
          'SECRETS_KEYCHAIN_UNAVAILABLE',
          'The OS keychain did not return the stored device key.',
        );
      } finally {
        back?.fill(0);
      }
      remember(`${this.keychain.name}:${this.account}`, Buffer.from(key));
      this.save(keys);
    } catch (error) {
      if (written) this.forget();
      throw error;
    } finally {
      key.fill(0);
    }
  }
  /** Drops the cached key and deletes the keychain item (after a failed move or a move back). */
  forget() {
    const id = `${this.keychain.name}:${this.account}`;
    cache.get(id)?.fill(0);
    cache.delete(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
    this.keychain.remove(this.account);
  }
  load(): StoredDeviceKeys | null {
    if (!existsSync(this.path)) return null;
    let envelope: Envelope;
    try {
      envelope = deserialize(readPrivate(this.path)) as Envelope;
      invariant(
        envelope.v === 1 &&
          envelope.keychain === this.keychain.name &&
          envelope.account === this.account &&
          envelope.nonce.length === 12 &&
          envelope.tag.length === 16,
        'SECRETS_PIN_LOST',
        'Local device key store is invalid.',
      );
    } catch {
      throw new ForgeError('SECRETS_PIN_LOST', 'Local device key store is invalid.');
    }
    const key = this.key();
    let plain: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce);
      decipher.setAAD(aad(this.keychain.name, this.account));
      decipher.setAuthTag(envelope.tag);
      plain = Buffer.concat([decipher.update(envelope.data), decipher.final()]);
    } catch {
      throw new ForgeError('SECRETS_PIN_LOST', 'Local device key store is invalid.');
    }
    try {
      return decodeDeviceKeys(plain);
    } finally {
      plain.fill(0);
    }
  }
  save(keys: StoredDeviceKeys) {
    const key = this.key(),
      nonce = randomBytes(12),
      plain = serialize(keys);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad(this.keychain.name, this.account));
      const data = Buffer.concat([cipher.update(plain), cipher.final()]);
      const envelope: Envelope = {
        v: 1,
        keychain: this.keychain.name,
        account: this.account,
        nonce,
        data,
        tag: cipher.getAuthTag(),
      };
      atomicPrivate(this.path, serialize(envelope));
    } finally {
      plain.fill(0);
    }
  }
}

// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { isDeepStrictEqual } from 'node:util';
import { ForgeError, invariant } from './errors.js';
import { equalBytes, forgeSecretId } from './sealed-format.js';
import { headBytes } from './sealed-records.js';
import { verifyBytes } from './sealed-keys.js';
import { atomicPrivate, secretLocked, wipeDeviceKeys, type KeyStore } from './sealed-local.js';
import { verifySealedReply, type SealedReply, type VerifyRequest } from './sealed-verify.js';
import { knownKinds, lost, packed, unpack, type Index, type PinFile } from './sealed-pin-store.js';

function discard(result: ReturnType<typeof verifySealedReply> | undefined) {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
}
export class SecretPins {
  readonly lock: string;
  readonly indexPath: string;
  constructor(
    readonly directory: string,
    readonly store: KeyStore,
  ) {
    this.lock = join(directory, 'pins.lock');
    this.indexPath = join(directory, 'index.bin');
  }
  private snapshot(project: string, kind: 1 | 2 | 3) {
    const keys = this.store.load();
    lost(keys);
    try {
      const id = forgeSecretId('project', project),
        name = id.toString('hex'),
        path = join(this.directory, `${name}.bin`);
      let index: Index = { counter: 0, files: {} };
      if (existsSync(this.indexPath)) index = unpack<Index>(this.indexPath, 'pin-index', keys!);
      else lost(keys!.pinCounter === 0);
      lost(index.counter === keys!.pinCounter || index.counter === keys!.pinCounter + 1);
      const entry = index.files[name];
      let file: PinFile = { counter: 0, kinds: {} };
      if (entry) {
        lost(existsSync(path));
        file = unpack<PinFile>(path, 'pins', keys!, id);
        lost(file.counter === entry.counter || file.counter === entry.counter + 1);
        lost(entry.kinds.every(k => file.lostKinds?.includes(k) || Object.hasOwn(file.kinds, k)));
      } else if (existsSync(path)) {
        // Interrupted first file publication, before its index write.
        file = unpack<PinFile>(path, 'pins', keys!, id);
        lost(file.counter === 1);
      }
      lost(!file.lostKinds?.includes(kind));
      return { keys: keys!, index, file, id, name, path, current: file.kinds[kind] ?? null };
    } catch (error) {
      wipeDeviceKeys(keys);
      throw error;
    }
  }
  async load(project: string, kind: 1 | 2 | 3) {
    const read = () => {
      const snapshot = this.snapshot(project, kind);
      try {
        return snapshot.current;
      } finally {
        wipeDeviceKeys(snapshot.keys);
      }
    };
    try {
      return read();
    } catch {
      return secretLocked(this.lock, () => {
        try {
          return read();
        } catch {
          throw new ForgeError(
            'SECRETS_PIN_LOST',
            'Secret trust is missing or invalid. Run nforge secret repin.',
          );
        }
      });
    }
  }
  async verifyAndSave(reply: SealedReply, request: VerifyRequest, fetchedAt: number) {
    // Fetching occurred before this lock. Re-read and verify against the latest pin here.
    return secretLocked(this.lock, () => {
      const s = this.snapshot(request.forgeProjectId, request.setKind);
      let result: ReturnType<typeof verifySealedReply> | undefined;
      try {
        result = verifySealedReply(reply, s.current?.pin ?? null, {
          ...request,
          firstContact: !s.current,
        });
        const next = { pin: result.pin, cache: reply, fetchedAt };
        if (s.current && isDeepStrictEqual(s.current.pin, result.pin)) return result;
        // Repair a permitted +1 crash state before beginning another publication.
        if (
          s.file.counter !== (s.index.files[s.name]?.counter ?? 0) ||
          s.index.counter !== s.keys.pinCounter
        ) {
          s.index.files[s.name] = { counter: s.file.counter, kinds: knownKinds(s.file) };
          s.index.counter = Math.max(s.index.counter, s.keys.pinCounter) + 1;
          atomicPrivate(this.indexPath, packed('pin-index', s.keys, s.index.counter, serialize(s.index)));
          s.keys.pinCounter = s.index.counter;
          this.store.save(s.keys);
        }
        const file: PinFile = {
          ...s.file,
          counter: s.file.counter + 1,
          kinds: { ...s.file.kinds, [request.setKind]: next },
        };
        const index: Index = {
          counter: Math.max(s.index.counter, s.keys.pinCounter) + 1,
          files: {
            ...s.index.files,
            [s.name]: { counter: file.counter, kinds: knownKinds(file) },
          },
        };
        atomicPrivate(s.path, packed('pins', s.keys, file.counter, serialize(file), s.id));
        atomicPrivate(this.indexPath, packed('pin-index', s.keys, index.counter, serialize(index)));
        this.store.save({
          ...s.keys,
          pinCounter: index.counter,
          pinned: { ...s.keys.pinned, [s.name]: knownKinds(file) },
        });
        return result;
      } catch (error) {
        discard(result);
        throw error;
      } finally {
        wipeDeviceKeys(s.keys);
      }
    });
  }
  private requireLost(project: string, kind: 1 | 2 | 3) {
    let snapshot: ReturnType<SecretPins['snapshot']>;
    try {
      snapshot = this.snapshot(project, kind);
    } catch (error) {
      // Match load's locked error classification, without acquiring a second lock.
      const classified =
        error instanceof ForgeError
          ? error
          : new ForgeError('SECRETS_PIN_LOST', 'Local secret trust is invalid.');
      if (classified.code === 'SECRETS_PIN_LOST') return;
      throw classified;
    }
    wipeDeviceKeys(snapshot.keys);
    throw new ForgeError(
      'SECRETS_NOT_ALLOWED',
      'Re-pin only restores lost trust; this project/kind has no lost pin.',
    );
  }
  async rebuild(
    reply: SealedReply,
    request: VerifyRequest,
    person: boolean,
    confirm: (summary: string) => Promise<boolean>,
  ) {
    lost(person);
    await secretLocked(this.lock, () => this.requireLost(request.forgeProjectId, request.setKind));
    const keys = this.store.load();
    lost(keys);
    try {
      lost(
        equalBytes(reply.head.signerId, keys!.id) &&
          verifyBytes(headBytes(reply.head), reply.head.signature, keys!.signPub),
      );
      let verified: ReturnType<typeof verifySealedReply>;
      try {
        verified = verifySealedReply(reply, null, { ...request, firstContact: true });
      } catch {
        throw new ForgeError(
          'SECRETS_PIN_LOST',
          'This device cannot rebuild trust from this head. Confirm with a holder.',
        );
      }
      verified.key?.fill(0);
      for (const secret of verified.secrets) secret.value.fill(0);
    } finally {
      wipeDeviceKeys(keys);
    }
    const devices = reply.roster.entries
      .filter(e => e.entryKind === 1)
      .map(e => `${e.displayName} (${e.id.toString('hex')})`)
      .join(', ');
    const summary = `${request.setKind === 1 ? 'Development' : 'Checks'} as of ${new Date(reply.head.signedAt).toISOString()}. Devices: ${devices}. This set may be older than what this device last saw. Correct?`;
    invariant(await confirm(summary), 'CANCELLED', 'Secret trust was not changed.');
    return secretLocked(this.lock, () => {
      this.requireLost(request.forgeProjectId, request.setKind);
      const currentKeys = this.store.load();
      let result: ReturnType<typeof verifySealedReply> | undefined;
      try {
        lost(currentKeys && equalBytes(currentKeys.id, keys!.id));
        result = verifySealedReply(reply, null, { ...request, firstContact: true });
        let index: Index,
          recoveredIndex = false;
        try {
          index = unpack<Index>(this.indexPath, 'pin-index', currentKeys!);
          lost(index.counter === currentKeys!.pinCounter || index.counter === currentKeys!.pinCounter + 1);
        } catch {
          recoveredIndex = true;
          index = {
            counter: currentKeys!.pinCounter,
            files: Object.fromEntries(
              Object.entries(currentKeys!.pinned ?? {}).map(([project, kinds]) => [
                project,
                { counter: -1, kinds },
              ]),
            ),
          };
        }
        const id = forgeSecretId('project', request.forgeProjectId),
          name = id.toString('hex'),
          path = join(this.directory, `${name}.bin`);
        let previous: PinFile = { counter: 0, kinds: {} };
        try {
          previous = unpack<PinFile>(path, 'pins', currentKeys!, id);
        } catch {
          /* Explicitly confirmed rebuild replaces only this project/kind. */
        }
        const entry = index.files[name],
          lostSiblings =
            recoveredIndex ||
            index.counter !== currentKeys!.pinCounter ||
            previous.counter !== (entry?.counter ?? 0),
          remembered = [
            ...knownKinds(previous),
            ...(entry?.kinds ?? []),
            ...(currentKeys!.pinned?.[name] ?? []),
          ],
          counter = Math.max(previous.counter, index.counter, currentKeys!.pinCounter) + 1;
        const file: PinFile = {
          counter,
          lostKinds: [
            ...new Set([...(previous.lostKinds ?? []), ...(lostSiblings ? remembered : [])]),
          ].filter(kind => kind !== request.setKind),
          kinds: {
            ...previous.kinds,
            [request.setKind]: { pin: result.pin, cache: reply, fetchedAt: Date.now() },
          },
        };
        index.counter = counter;
        index.files[name] = { counter: file.counter, kinds: knownKinds(file) };
        atomicPrivate(path, packed('pins', currentKeys!, file.counter, serialize(file), id));
        atomicPrivate(this.indexPath, packed('pin-index', currentKeys!, index.counter, serialize(index)));
        this.store.save({
          ...currentKeys!,
          pinCounter: index.counter,
          pinned: { ...currentKeys!.pinned, [name]: knownKinds(file) },
        });
        return result;
      } catch (error) {
        discard(result);
        throw error;
      } finally {
        wipeDeviceKeys(currentKeys);
      }
    });
  }
}

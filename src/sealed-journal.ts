// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { invariant } from './errors.js';
import { atomicPrivate, privateDirectory, readPrivate, secretLocked } from './sealed-local.js';
import { syncDirectory } from './state/durability.js';
import type { SealedWrite } from './sealed-transport.js';

type Identity = { project: string; name: string; removing: boolean; file: boolean };
/** A machine removal's target, fixed when the request is first sent: the full machine id (hex) and its label then.
 * Retries and reconciliation use this id only, never a label that another machine may take later. */
type Target = { id: string; label: string };
type Pending = Identity & { state: 'unknown'; wire: SealedWrite; target?: Target };
type Receipt = Identity & {
  state: 'accepted';
  operationId: string;
  headHash: Buffer;
  confirmedAt: number;
  target?: Target;
};
type Entry = Pending | Receipt;
// At most 48 MiB, including metadata: 64 private files of at most 768 KiB each.
const maxEntries = 64,
  maxBytes = 768 * 1024;
/** All mutation shares the pin lock. No network operation runs inside this class. */
export class SealedJournal {
  readonly directory: string;
  constructor(
    directory: string,
    readonly lock: string,
  ) {
    this.directory = join(directory, 'operations');
  }
  private path(id: string) {
    return join(this.directory, `${id}.bin`);
  }
  private load(id: string): Entry | null {
    if (!existsSync(this.path(id))) return null;
    const bytes = readPrivate(this.path(id));
    invariant(bytes.length <= maxBytes, 'SECRETS_FORMAT_REFUSED', 'Local secret journal is invalid.');
    return deserialize(bytes) as Entry;
  }
  async lookup(id: string, project: string) {
    invariant(/^[0-9a-f-]{36}$/i.test(id), 'BAD_ARGUMENT', 'Use a UUID operation id.');
    return secretLocked(this.lock, () => {
      const entry = this.load(id);
      invariant(
        entry && entry.project === project,
        'NOT_FOUND',
        'No secret operation was retained for this project.',
      );
      return entry;
    });
  }
  async read(id: string, identity: Identity) {
    return secretLocked(this.lock, () => {
      const entry = this.load(id);
      invariant(
        !entry ||
          (entry.project === identity.project &&
            entry.name === identity.name &&
            entry.removing === identity.removing &&
            entry.file === identity.file),
        'WORK_OPERATION_REUSED',
        'This operation already names another secret change.',
      );
      return entry;
    });
  }
  /** The project's retained unknown requests, for an import to settle (review L4). Local files only. */
  async unknown(project: string) {
    return secretLocked(this.lock, () => {
      if (!existsSync(this.directory)) return [];
      return readdirSync(this.directory)
        .filter(n => /^[0-9a-f-]{36}\.bin$/i.test(n))
        .flatMap(n => {
          const id = n.slice(0, -4),
            entry = this.load(id);
          return entry?.state === 'unknown' && entry.project === project ? [{ id, entry }] : [];
        });
    });
  }
  async retain(id: string, entry: Pending) {
    return secretLocked(this.lock, () => {
      const existing = this.load(id);
      if (existing) return existing;
      privateDirectory(this.directory);
      const files = readdirSync(this.directory).filter(n => /^[0-9a-f-]{36}\.bin$/i.test(n));
      const completed = files
        .map(n => ({ id: n.slice(0, -4), entry: this.load(n.slice(0, -4))! }))
        .filter((e): e is { id: string; entry: Receipt } => e.entry.state === 'accepted')
        .sort((a, b) => a.entry.confirmedAt - b.entry.confirmedAt);
      while (files.length >= maxEntries && completed.length) {
        unlinkSync(this.path(completed.shift()!.id));
        files.pop();
      }
      syncDirectory(this.directory);
      const pendingIds = files.map(n => n.slice(0, -4)).sort();
      invariant(
        files.length < maxEntries,
        'SECRETS_JOURNAL_FULL',
        `The secret journal holds 64 unresolved operations. Pending operation ids: ${pendingIds.join(', ')}. Run nforge secret resolve --operation-id UUID for each unknown request; unresolved requests are never discarded automatically.`,
      );
      const bytes = serialize(entry);
      invariant(
        bytes.length <= maxBytes,
        'SECRETS_FORMAT_REFUSED',
        'Sealed request exceeds the local journal bound.',
      );
      atomicPrivate(this.path(id), bytes);
      return null;
    });
  }
  async accept(id: string, entry: Pending) {
    return secretLocked(this.lock, () => {
      const { project, name, removing, file } = entry;
      const receipt: Receipt = {
        project,
        name,
        removing,
        file,
        state: 'accepted',
        operationId: id,
        headHash: Buffer.from(entry.wire.headHash),
        confirmedAt: Date.now(),
        ...(entry.target ? { target: entry.target } : {}),
      };
      atomicPrivate(this.path(id), serialize(receipt));
    });
  }
  async discardUnknown(id: string) {
    return secretLocked(this.lock, () => {
      if (this.load(id)?.state !== 'unknown') return false;
      unlinkSync(this.path(id));
      syncDirectory(this.directory);
      return true;
    });
  }
  async refuse(id: string) {
    return secretLocked(this.lock, () => {
      if (existsSync(this.path(id))) {
        unlinkSync(this.path(id));
        syncDirectory(this.directory);
      }
    });
  }
}

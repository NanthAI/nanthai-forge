// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { pendingRecordWriter } from './work-record-staging.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdirBelow } from './mkdir-below.js';
import { join } from 'node:path';
import { readSource } from './files.js';
import { digest } from './hash.js';
import { durableReplace } from './state/durability.js';
import { invariant } from './errors.js';
import { hydrateRun, actionResult, type WorkDetailPin } from './work-record-details.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun, WorkData } from './work-types.js';

type StoreAccess = Pick<WorkStore, 'directory'>;

export function detailWriter(directory: string, pending = false) {
  let release: ReturnType<typeof pendingRecordWriter> | undefined;
  const put = (value: Uint8Array): WorkDetailPin => {
    const bytes = Buffer.from(value),
      sha256 = digest(bytes),
      path = join(directory, 'objects', sha256);
    if (pending) {
      release ??= pendingRecordWriter(directory);
      release.pin({ sha256, size: bytes.length });
    }
    // Never recreate a deleted Work directory from a late writer.
    mkdirBelow(directory, join(directory, 'objects'));
    invariant(
      lstatSync(join(directory, 'objects')).isDirectory() &&
        !lstatSync(join(directory, 'objects')).isSymbolicLink() &&
        realpathSync(join(directory, 'objects')) === join(directory, 'objects'),
      'UNSAFE_PATH',
      'Work objects must use a real directory.',
    );
    if (!existsSync(path)) durableReplace(path, bytes);
    const pin = { sha256, size: bytes.length };
    detailReader(directory)(pin);
    return pin;
  };
  return Object.assign(put, {
    release() {
      release?.();
      release = undefined;
    },
  });
}
export function detailReader(directory: string) {
  return (pin: WorkDetailPin) => {
    const bytes = readSource(directory, `objects/${pin.sha256}`, pin.size + 1, pin.sha256);
    invariant(
      bytes && bytes.length === pin.size && digest(bytes) === pin.sha256,
      'INVALID_WORK_STORE',
      'Retained Work detail is missing or changed. Existing Work is preserved.',
    );
    return bytes;
  };
}
export const runDetails = (store: StoreAccess, run: CheckRun) =>
  hydrateRun(run, detailReader(store.directory));
export const automaticResult = (
  store: StoreAccess,
  action: NonNullable<WorkData['automaticActions']>[number] | undefined,
) => actionResult(action, detailReader(store.directory));

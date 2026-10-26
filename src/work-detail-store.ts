// SPDX-License-Identifier: Apache-2.0
import { pendingRecordWriter } from './work-record-staging.js';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readSource } from './files.js';
import { digest } from './hash.js';
import { durableReplace } from './native-durability.js';
import { invariant } from './errors.js';
import { hydrateRun, actionResult, type WorkDetailPin } from './work-record-details.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun, WorkData } from './work-types.js';

export function detailWriter(directory: string, pending = false) {
  let release: (() => void) | undefined;
  const put = (value: Uint8Array): WorkDetailPin => {
    if (pending) release ??= pendingRecordWriter(directory);
    const bytes = Buffer.from(value),
      sha256 = digest(bytes),
      path = join(directory, 'objects', sha256);
    mkdirSync(join(directory, 'objects'), { recursive: true, mode: 0o700 });
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
export const runDetails = (store: WorkStore, run: CheckRun) => hydrateRun(run, detailReader(store.directory));
export const automaticResult = (
  store: WorkStore,
  action: NonNullable<WorkData['automaticActions']>[number] | undefined,
) => actionResult(action, detailReader(store.directory));

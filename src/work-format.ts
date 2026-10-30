// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
export const latestWorkFormat = 24;
/** Reject before any selected-record reads or writer preparation. */
export function assertWorkFormat(value: unknown) {
  if (!value || typeof value !== 'object' || !('schema' in value)) return;
  const format = value.schema;
  if (typeof format !== 'number') return;
  invariant(
    format <= latestWorkFormat,
    'WORK_UPGRADE_REQUIRED',
    `Work format ${format} is newer than this CLI supports; upgrade nforge. Existing work is preserved.`,
  );
}

/** Ordinary owners use the current format; old bytes are read only by recovery. */
export function assertCurrentWorkFormat(value: unknown) {
  assertWorkFormat(value);
  if (!value || typeof value !== 'object' || !('schema' in value)) return;
  invariant(
    typeof value.schema === 'number' && Number.isInteger(value.schema),
    'INVALID_WORK_STORE',
    'Work format is invalid. Existing work is preserved.',
  );
  invariant(
    value.schema === latestWorkFormat,
    'WORK_UPGRADE_REQUIRED',
    `Work format ${value.schema} requires recovery with restore-native before use. Existing work is preserved.`,
  );
}

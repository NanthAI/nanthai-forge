// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
export const latestWorkFormat = 20;
/** Reject before any selected-record reads or writer preparation. */
export function assertWorkFormat(value: unknown) {
  if (!value || typeof value !== 'object' || !('schema' in value)) return;
  const format = value.schema;
  invariant(
    typeof format !== 'number' || format <= latestWorkFormat,
    'WORK_UPGRADE_REQUIRED',
    `Work format ${format} is newer than this CLI supports; upgrade nforge. Existing work is preserved.`,
  );
}

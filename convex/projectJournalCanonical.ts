// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Archive scheduling, lookup hints and replay markers are derived metadata. Logical
 * recovery rows retain their original identities and source fields without those hints. */
const transient = new Set([
  'journalReady',
  'journalReadyAt',
  'journalLaneId',
  'journalSegment',
  'journalDigest',
  'journalCommand',
  'journalLane',
]);
export function journalSourceRow(row: object) {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => !transient.has(key) || (key === 'journalCommand' && 'purged' in row),
    ),
  );
}

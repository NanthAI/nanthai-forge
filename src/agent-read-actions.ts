// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Agent actions that only read. They never write Work records, States, receipts
 * or presence. */
export const SNAPSHOT_READ_ACTIONS: ReadonlySet<string> = new Set([
  'status',
  'landing',
  'tests',
  'peers',
  'review',
  'diff',
  'show',
  'brief',
  'handoff-read',
  'improve',
  'metrics',
  'decisions',
  'records',
  'making-of',
  'view',
  'views',
  'provenance',
]);
/** Also reads, but not pinned to one Work snapshot: `observe` waits for later run
 * records and `log` pages live check output. */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  ...SNAPSHOT_READ_ACTIONS,
  'policy',
  'link',
  'log',
  'observe',
]);

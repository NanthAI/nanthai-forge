// SPDX-License-Identifier: Apache-2.0
/** Agent actions that only read. They never write Work records, States, receipts
 * or presence; tests/agent-reads-never-write.test.mjs hashes the owner around each. */
export const SNAPSHOT_READ_ACTIONS: ReadonlySet<string> = new Set([
  'status',
  'tests',
  'peers',
  'review',
  'diff',
  'show',
  'brief',
  'handoff-read',
  'improve',
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

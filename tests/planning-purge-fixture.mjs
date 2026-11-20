// SPDX-License-Identifier: Apache-2.0
// Purge test helpers (Item 4c9e961e): find an Item's journal rows, list them on a purge (planning-purge-v2) and turn
// them into the purged form the purge executor writes.
import {
  purgeableCommandSchema,
  purgedFactsDigest,
  purgedFactsText,
  redactPlanningWrite,
} from '../dist/work-intent-types.js';

const parsed = row => purgeableCommandSchema.safeParse(JSON.parse(row.command));

/** Rows of one Item: puts and comments naming any of its ids (the Item, an alias, its Intent), its intent row and
 * the notes on its Intent. */
export function itemRows(rows, ids) {
  const named = new Set(ids);
  return [...rows].filter(row => {
    const command = parsed(row);
    if (!command.success) return false;
    const { data } = command;
    if (data.action === 'intent') return named.has(row.operationId);
    return named.has(data.action === 'note' ? data.intentId : data.itemId);
  });
}

/** The purge's row list: each row with the digest of the redacted facts it will hold. */
export const purgeList = rows =>
  rows.map(row => [row.operationId, purgedFactsDigest(redactPlanningWrite(parsed(row).data))]);

/** What the purge executor writes per row: the redacted facts, marked with the purge. */
export function markPurged(rows, purgeOperationId) {
  for (const row of rows) {
    row.command = purgedFactsText(parsed(row).data);
    row.purged = purgeOperationId;
  }
}

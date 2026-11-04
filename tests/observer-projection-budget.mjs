// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
/** Keep the original controller budgets, and account for the added read model
 * explicitly. Totals in diagnostics remain actual DB I/O, including projections. */
export function observerProjectionBudget(count) {
  const projectionReads = count.readDocumentsByTable?.projectFinishReadRows ?? 0;
  const projectionWrites = count.written.filter(table => table === 'projectFinishReadRows').length;
  const projectionReadBytes = count.readBytesByTable?.projectFinishReadRows ?? 0;
  const projectionWriteBytes = count.writeBytesByTable?.projectFinishReadRows ?? 0;
  const sourceWrites = count.writes - projectionWrites;
  assert(
    projectionReads <= 2 * sourceWrites + 2,
    'at most two selected observer roles per source write, plus project lookup',
  );
  assert(projectionWrites <= 2 * sourceWrites, 'at most two observer roles per source write');
  assert(
    projectionWriteBytes <= 3 * (count.writeBytes - projectionWriteBytes) + 1024 * sourceWrites,
    'bounded selected metadata encoding per source write',
  );
  return {
    documents: count.documents - projectionReads,
    ranges: count.ranges - (count.readRangesByTable?.projectFinishReadRows ?? projectionReads),
    writes: sourceWrites,
    readBytes: count.readBytes - projectionReadBytes,
    writeBytes: count.writeBytes - projectionWriteBytes,
    projectionReads,
    projectionWrites,
    projectionReadBytes,
    projectionWriteBytes,
  };
}

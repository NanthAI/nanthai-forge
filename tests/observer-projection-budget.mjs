// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
/** Keep the original controller budgets, and account for the added read model
 * explicitly. Totals in diagnostics remain actual DB I/O, including projections. */
export function observerProjectionBudget(count) {
  const line = count.liveLine ?? {};
  const markReads = line.markReads ?? 0,
    markWrites = line.markWrites ?? 0;
  const lineMetaReads = line.metaReads ?? 0,
    lineMetaWrites = line.metaWrites ?? 0;
  const projectionReads = (count.readDocumentsByTable?.projectFinishReadRows ?? 0) + markReads;
  const projectionWrites =
    count.written.filter(table => table === 'projectFinishReadRows').length + markWrites;
  const projectionReadBytes =
    (count.readBytesByTable?.projectFinishReadRows ?? 0) + (line.markReadBytes ?? 0);
  const projectionWriteBytes =
    (count.writeBytesByTable?.projectFinishReadRows ?? 0) + (line.markWriteBytes ?? 0);
  // Expiry allocates delayed system work, not another controller step. Preserve the
  // original controller bounds; raw meters and landing-cost guards include this cost.
  const maintenanceWrites = count.maintenanceWrites ?? 0;
  const maintenanceWriteBytes = count.maintenanceWriteBytes ?? 0;
  // S3 separates cold fields from the same logical ticket. Keep the original logical
  // controller ceilings, and guard physical companion fanout separately. Byte meters
  // below and landing-cost-guard still include every cold read/write.
  const { reads: bodyReads, writes: bodyWrites, ranges: bodyRanges } = landingBodyCounts(count);
  const sourceWrites = count.writes - projectionWrites - maintenanceWrites - bodyWrites;
  assert(
    projectionReads - markReads - lineMetaReads <= 2 * sourceWrites + 2,
    'at most two selected observer roles per source write, plus project lookup',
  );
  assert(
    projectionWrites - markWrites - lineMetaWrites <= 2 * sourceWrites,
    'at most two observer roles per source write',
  );
  assert(
    (line.markReadBytes ?? 0) <= 1024 * markReads && (line.markWriteBytes ?? 0) <= 1024 * markWrites,
    'live marks contain only slim metadata',
  );
  assert(
    (line.metaReadBytes ?? 0) <= 16 * 1024 * lineMetaReads &&
      (line.metaWriteBytes ?? 0) <= 16 * 1024 * lineMetaWrites,
    'live ownership uses bounded 100-mark pages',
  );
  assert(
    projectionWriteBytes - (line.markWriteBytes ?? 0) - (line.metaWriteBytes ?? 0) <=
      3 * (count.writeBytes - projectionWriteBytes - maintenanceWriteBytes) + 1024 * sourceWrites,
    'bounded selected metadata encoding per source write',
  );
  return {
    documents: count.documents - projectionReads - bodyReads,
    ranges:
      count.ranges -
      bodyRanges -
      (count.readRangesByTable?.projectFinishReadRows ?? projectionReads) -
      (line.markRanges ?? 0),
    writes: sourceWrites,
    readBytes: count.readBytes - projectionReadBytes,
    writeBytes: count.writeBytes - projectionWriteBytes - maintenanceWriteBytes,
    maintenanceWrites,
    maintenanceWriteBytes,
    bodyReads,
    bodyWrites,
    projectionReads,
    projectionWrites,
    projectionReadBytes,
    projectionWriteBytes,
  };
}

/** Physical cold companions have their own bounded fanout; byte meters include them unchanged. */
export function landingBodyCounts(count) {
  const projectionReads =
    (count.readDocumentsByTable?.projectFinishReadRows ?? 0) - (count.liveLine?.metaReads ?? 0);
  const bodyReads = count.readDocumentsByTable?.projectHostedLandingBodies ?? 0;
  const bodyWrites = count.written.filter(table => table === 'projectHostedLandingBodies').length;
  const ticketReads = count.readDocumentsByTable?.projectHostedLandingRequests ?? 0;
  const ticketWrites = count.written.filter(table => table === 'projectHostedLandingRequests').length;
  assert(
    bodyReads <= 2 * ticketReads + projectionReads,
    'at most two cold bodies per ticket or one request per observer role',
  );
  assert(bodyWrites <= 2 * ticketWrites, 'at most two cold-body writes per ticket write');
  return {
    reads: bodyReads,
    writes: bodyWrites,
    ranges: count.readRangesByTable?.projectHostedLandingBodies ?? bodyReads,
  };
}

/** New line projection only; physical meters remain the billing source. */
export function liveLineProjectionCounts(count) {
  const line = count.liveLine ?? {};
  const reads = (line.markReads ?? 0) + (line.metaReads ?? 0);
  const writes = (line.markWrites ?? 0) + (line.metaWrites ?? 0);
  assert((line.markReadBytes ?? 0) <= 1024 * (line.markReads ?? 0));
  assert((line.markWriteBytes ?? 0) <= 1024 * (line.markWrites ?? 0));
  assert((line.metaReadBytes ?? 0) <= 16384 * (line.metaReads ?? 0));
  assert((line.metaWriteBytes ?? 0) <= 16384 * (line.metaWrites ?? 0));
  return { reads, writes };
}

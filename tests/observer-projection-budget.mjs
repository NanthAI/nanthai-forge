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
  const feed = feedProjectionCounts(count);
  // Expiry allocates delayed system work, not another controller step. Preserve the
  // original controller bounds; raw meters and landing-cost guards include this cost.
  const maintenanceWrites = count.maintenanceWrites ?? 0;
  const maintenanceWriteBytes = count.maintenanceWriteBytes ?? 0;
  // S3 separates cold fields from the same logical ticket. Keep the original logical
  // controller ceilings, and guard physical companion fanout separately. Byte meters
  // below and landing-cost-guard still include every cold read/write.
  const { reads: bodyReads, writes: bodyWrites, ranges: bodyRanges } = landingBodyCounts(count);
  const aliases = metricAliasProjectionCounts(count);
  const sourceWrites =
    count.writes - projectionWrites - maintenanceWrites - bodyWrites - feed.writes - aliases.writes;
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
    documents: count.documents - projectionReads - bodyReads - feed.reads,
    ranges:
      count.ranges -
      bodyRanges -
      (count.readRangesByTable?.projectFinishReadRows ?? projectionReads) -
      (line.markRanges ?? 0) -
      feed.ranges,
    writes: sourceWrites,
    readBytes: count.readBytes - projectionReadBytes - feed.readBytes,
    writeBytes:
      count.writeBytes - projectionWriteBytes - maintenanceWriteBytes - feed.writeBytes - aliases.writeBytes,
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

/** Item 0de95ef2 protects the controller's original ceilings while the
 * landing-cost guard separately budgets every physical alias write. */
export function metricAliasProjectionCounts(count) {
  const writes = count.metricAliasWrites ?? 0;
  const writeBytes = count.metricAliasWriteBytes ?? 0;
  if (writes) {
    assert.equal(count.writeRounds, count.canonicalWriteRounds, 'aliases share the canonical write round');
    assert.equal(count.readRangesByTable?.projectMetricFacts ?? 0, 0, 'the controller does not read aliases');
    assert(writeBytes <= writes * 512, 'aliases contain compact lookup keys');
  }
  return { writes, writeBytes };
}

/** Feed I/O is charged in the physical totals and its own fixture budget. */
export function feedProjectionCounts(count) {
  const reads = count.readDocumentsByTable?.projectFeedEvents ?? 0;
  const writes = count.written.filter(table => table === 'projectFeedEvents').length;
  if (!count.query) assert(reads <= writes, 'expiry probes and reads accompany event writes or deletes');
  return {
    reads,
    writes,
    ranges: count.readRangesByTable?.projectFeedEvents ?? 0,
    readBytes: count.readBytesByTable?.projectFeedEvents ?? 0,
    writeBytes: count.writeBytesByTable?.projectFeedEvents ?? 0,
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

/** Dispatch-bounded measurement work is separate from the controller's existing
 * limits. Physical meters and landing-cost-guard still include every byte. No
 * cancellation means no allowance, so pass-path ceilings remain unchanged.
 * 436bd3e0: up to seven selected reads and two writes per attributed owner, plus
 * the run fence; the no-target path adds only its one run-row read. Byte bounds
 * retain the existing metadata scale, including both selected observer roles.
 */
export function cancelledUsageAllowance(count) {
  return (count.cancelledRuns ?? []).reduce(
    (sum, run) => ({
      documents: sum.documents + 1 + 7 * run.members,
      writes: sum.writes + (run.attributed ? 1 + 2 * run.members : 0),
      bytes: sum.bytes + (run.attributed ? 8192 + 16384 * run.members : 8192),
    }),
    { documents: 0, writes: 0, bytes: 0 },
  );
}

export function controllerMetadataFits(count, readLimit, writeLimit) {
  const accounting = cancelledUsageAllowance(count);
  return count.readBytes < readLimit + accounting.bytes && count.writeBytes < writeLimit + accounting.bytes;
}

// SPDX-License-Identifier: Apache-2.0
import type { MetricReceiptRow } from './self-metric-receipts.js';
import type { MetricPeriod, MetricRecords } from './self-metrics-types.js';

const HOUR = 60 * 60_000;
/** Join durable caller/owner receipts into the shared calculator's receipt model.
 * Collection starts come from the server; a submission whose caller has not
 * reported keeps 5.2/5.3 partial instead of being counted as complete. */
export function hostedCallerReceipts(
  records: MetricRecords,
  rows: MetricReceiptRow[],
  coverage: Record<string, string | null> | undefined,
  period: MetricPeriod,
) {
  const outcomes = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'mutation') {
      records.receipts.push({
        schema: 1,
        kind: 'mutation',
        origin: 'command',
        action: row.action,
        operationId: row.operationId,
        actor: { kind: 'person', name: row.actor },
        at: row.at,
      });
      continue;
    }
    const actor = { kind: 'agent' as const, name: row.actor };
    if (row.kind === 'outcome') {
      outcomes.add(row.operationId);
      records.receipts.push({
        schema: 1,
        kind: 'lifecycle',
        origin: 'command',
        action: row.action,
        operationId: row.operationId,
        actor,
        at: row.at,
        ...(row.errorCodes[0] ? { errorCode: row.errorCodes[0] } : {}),
        ...(row.errorCodes.length > 1 ? { errorCodes: row.errorCodes } : {}),
        ...(row.noOwner ? { noOwner: true } : {}),
      });
    } else
      records.receipts.push({
        schema: 1,
        kind: 'lifecycle',
        origin: 'command',
        // Not a finish: a delivery only proves the caller received this terminal state.
        action: 'delivery',
        operationId: `delivery:${row.entryId}:${row.state}`,
        actor,
        at: row.at,
        deliveries: [{ entryId: row.entryId, state: row.state }],
        ...(row.noOwner ? { noOwner: true } : {}),
      });
  }
  records.coverage = {
    ...records.coverage,
    ...(coverage?.lifecycle ? { lifecycle: coverage.lifecycle } : {}),
    ...(coverage?.deliveries ? { deliveries: coverage.deliveries } : {}),
    ...(coverage?.mutations ? { mutations: coverage.mutations } : {}),
  };
  const since = coverage?.lifecycle ? Date.parse(coverage.lifecycle) : null;
  if (since === null) return;
  const asOf = Date.parse(period.asOf ?? period.to);
  // Finish submissions older than the 60-minute progress window must have a caller receipt.
  const unreported = records.submissions.filter(
    s =>
      !(s as { compensating?: boolean }).compensating &&
      s.operationId &&
      Date.parse(s.at) >= since &&
      Date.parse(s.at) >= Date.parse(period.from) &&
      Date.parse(s.at) < Date.parse(period.to) &&
      asOf - Date.parse(s.at) >= HOUR &&
      !outcomes.has(s.operationId),
  ).length;
  if (!unreported) return;
  const gap = `${unreported} finish submissions after caller-receipt collection began have no caller outcome receipt (a client without receipt support, or receipts not yet carried by a later mutation).`;
  (records.lifecycleCoverageGaps ??= []).push(gap);
  (records.deliveryCoverageGaps ??= []).push(gap);
}

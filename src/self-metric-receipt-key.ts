// SPDX-License-Identifier: Apache-2.0
import type { CallerReceipt } from './self-metric-receipts.js';

/** Idempotency identity: replays of the same visible outcome collapse to one row. */
export function callerReceiptKey(receipt: CallerReceipt, actor: string) {
  return receipt.kind === 'outcome'
    ? `outcome:${actor}:${receipt.operationId}:${receipt.action}:${[...receipt.errorCodes].sort().join(',')}`
    : `delivery:${actor}:${receipt.entryId}:${receipt.state}`;
}

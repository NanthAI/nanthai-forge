// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { localCost, unknownCost } from './check-cost.js';
import { checkRunSchema } from './work-types.js';
// Completion files contain outcome fields, not the run's process/source identity.
export const receiptSchema = z
  .object(checkRunSchema.shape)
  .pick({
    reuseKey: true,
    status: true,
    cancellation: true,
    backend: true,
    failureSummary: true,
    checkSelection: true,
    endedAt: true,
    exitCode: true,
    signal: true,
    details: true,
    artifacts: true,
    resourceUsage: true,
    warnings: true,
    error: true,
  })
  .extend({
    environment: checkRunSchema.shape.environment.optional(),
    status: checkRunSchema.shape.status.exclude(['queued', 'preparing', 'running']),
    endedAt: checkRunSchema.shape.endedAt.unwrap(),
  });
/** New receipts gain a cost record; reading old receipts never backfills retained Work. */
export function createRunReceipt(input: unknown) {
  const receipt = receiptSchema.parse(input);
  return {
    ...receipt,
    backend: receipt.backend
      ? {
          ...receipt.backend,
          cost:
            receipt.backend.cost ??
            (receipt.backend.actual === 'local'
              ? { ...localCost('local-receipt'), items: [] }
              : unknownCost(receipt.backend.actual)),
        }
      : receipt.backend,
  };
}

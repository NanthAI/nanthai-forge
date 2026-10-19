// SPDX-License-Identifier: Apache-2.0
import { checkRunSchema } from './work-types.js';
export const receiptSchema = checkRunSchema
  .pick({
    status: true,
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
    status: checkRunSchema.shape.status.exclude(['queued', 'preparing', 'running']),
    endedAt: checkRunSchema.shape.endedAt.unwrap(),
  });

// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Exact predicted publication; a same-head replacement receipt is a new generation. */
export const predecessorPinSchema = z
  .object({
    submissionId: z.uuid(),
    head: z.string().regex(/^[0-9a-f]{64}$/),
    receiptId: z.uuid(),
  })
  .strict();
export const earlyResolutionSchema = z
  .object({
    predecessor: predecessorPinSchema,
    laneId: z.uuid(),
    originalHead: z.string().regex(/^[0-9a-f]{64}$/),
    startedAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().optional(),
  })
  .strict();

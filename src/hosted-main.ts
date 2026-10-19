// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
const head = z.string().regex(/^[0-9a-f]{64}$/);
/** Selected hosted source, not the uploaded owner's native main or an index row ID. */
export const hostedMainSchema = z
  .object({
    schema: z.literal(1),
    projectId: z.string().min(1),
    generationId: z.string().min(1),
    backupId: z.string().min(1),
    channel: z.literal('main'),
    head,
    receipt: z
      .object({
        id: z.string().min(1),
        kind: z.enum(['hosted', 'native']),
        previousHead: head.nullable(),
        previousReceiptId: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type HostedMain = z.infer<typeof hostedMainSchema>;
export const mainExpectationSchema = z
  .object({
    head,
    receiptId: z.string().min(1),
  })
  .strict();
export type MainExpectation = z.infer<typeof mainExpectationSchema>;

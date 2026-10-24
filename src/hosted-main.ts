// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
const head = z.string().regex(/^[0-9a-f]{64}$/);
const receipt = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['hosted', 'native']),
    previousHead: head.nullable(),
    previousReceiptId: z.string().nullable(),
  })
  .strict();
/** Selected hosted source, not the uploaded owner's native main or an index row ID. */
export const hostedMainV1Schema = z
  .object({
    schema: z.literal(1),
    projectId: z.string().min(1),
    generationId: z.string().min(1),
    backupId: z.string().min(1),
    channel: z.literal('main'),
    head,
    receipt,
  })
  .strict();
/** Server States need not belong to the historical seed backup or a display generation. */
export const hostedMainV2Schema = z
  .object({
    schema: z.literal(2),
    projectId: z.string().min(1),
    snapshotId: z.string().min(1),
    sourceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    authority: sourceAuthoritySchema,
    channel: z.literal('main'),
    head,
    receipt: receipt.extend({ kind: z.enum(['hosted', 'native', 'server']) }),
    seed: z
      .object({ backupId: z.string().min(1), generationId: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export const hostedMainSchema = z.discriminatedUnion('schema', [hostedMainV1Schema, hostedMainV2Schema]);
export type HostedMain = z.infer<typeof hostedMainSchema>;
export type HostedMainV1 = z.infer<typeof hostedMainV1Schema>;
export type HostedMainV2 = z.infer<typeof hostedMainV2Schema>;
export const mainExpectationSchema = z
  .object({
    head,
    receiptId: z.string().min(1),
  })
  .strict();
export type MainExpectation = z.infer<typeof mainExpectationSchema>;

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
export type HostedMainV2 = z.infer<typeof hostedMainV2Schema>;
export const mainExpectationSchema = z
  .object({
    head,
    receiptId: z.string().min(1),
  })
  .strict();
export type MainExpectation = z.infer<typeof mainExpectationSchema>;
/** The line feed's rolling day as a bare status reads it (Item 32e8de50): its hour rows and [hour, first tries,
 * landings judged] rows (src/flow-day.ts `FlowDay`), at most a day of each. The CLI works out today's figure with src/flow-day.ts `mainToday`. */
export const mainDaySchema = z
  .object({
    hours: z.array(z.array(z.number())).max(48),
    first: z.array(z.array(z.number())).max(48),
  })
  .strict();
export type MainDay = z.infer<typeof mainDaySchema>;

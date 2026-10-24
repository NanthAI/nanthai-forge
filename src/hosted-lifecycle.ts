// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { saveExpectedSchema } from './hosted-save.js';
const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const hostedLifecycleRequestSchema = z
  .object({
    operationId: z.uuid(),
    authorityEpoch: number,
    action: z.enum(['abandon', 'reopen']),
    reason: z.string().trim().max(4000).default(''),
    target: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('lane'),
          laneId: z.uuid(),
          expected: saveExpectedSchema,
          dirty: z.boolean().default(false),
          saveOperationId: z.uuid().nullable().default(null),
        })
        .strict(),
      z
        .object({
          kind: z.literal('intent'),
          intentId: z.uuid(),
          version: number,
          cascade: z.boolean().default(false),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.action === 'abandon' && !r.reason)
      ctx.addIssue({ code: 'custom', message: 'Give a reason for abandoning.' });
    if (r.action === 'reopen' && r.target.kind === 'intent' && r.target.cascade)
      ctx.addIssue({ code: 'custom', message: 'Intent reopen retains independent child lifecycle states.' });
  });
export type HostedLifecycleRequest = z.infer<typeof hostedLifecycleRequestSchema>;
export const hostedLifecycleResultSchema = z
  .object({
    schema: z.literal(1),
    operationId: z.uuid(),
    receiptId: z.uuid(),
    action: z.enum(['abandon', 'reopen']),
    target: z.enum(['lane', 'intent']),
    id: z.uuid(),
    status: z.enum(['pending', 'applied', 'stale', 'failed']),
    at: z.iso.datetime(),
    children: number,
    saveOperationId: z.uuid().nullable(),
    cancellation: z.literal('not-requested'),
    lane: saveExpectedSchema.extend({ state: z.enum(['active', 'abandoned']) }).nullable(),
  })
  .strict();
export type HostedLifecycleResult = z.infer<typeof hostedLifecycleResultSchema>;

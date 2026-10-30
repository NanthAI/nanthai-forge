// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Successful owner commands counted by metric 5.5. Start/checkpoint/finish are not interventions. */
export const metricMutationActions = [
  'cancel',
  'prioritize',
  'revert',
  'abandon',
  'reopen',
  'set-policy',
  'accept',
] as const;
export type MetricMutationAction = (typeof metricMutationActions)[number];
/** Each metric's collection starts at the earliest durable receipt of its kind. */
export const metricReceiptCoverage = {
  lifecycle: 'outcome',
  deliveries: 'delivery',
  mutations: 'mutation',
} as const;

const stamp = z.iso.datetime();
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const cause = z.string().min(1).max(200);
/** What a caller actually received. The server binds project and requester from auth. */
export const callerReceiptSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('outcome'),
      actor: z.string().min(1).max(200).nullable(),
      at: stamp,
      action: z.enum(['start', 'checkpoint', 'sync', 'finish']),
      operationId: z.uuid(),
      errorCodes: z.array(code).max(8),
      noOwner: z.boolean(),
      noOwnerCause: cause.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('delivery'),
      actor: z.string().min(1).max(200).nullable(),
      at: stamp,
      action: z.string().regex(/^[a-z-]{1,32}$/),
      operationId: z.uuid().nullable(),
      entryId: z.uuid(),
      state: z.enum(['landed', 'terminal-failed']),
      noOwner: z.boolean(),
      noOwnerCause: cause.nullable(),
    })
    .strict(),
]);
export type CallerReceipt = z.infer<typeof callerReceiptSchema>;
/** Idempotency identity: replays of the same visible outcome collapse to one row. */
export function callerReceiptKey(receipt: CallerReceipt, actor: string) {
  return receipt.kind === 'outcome'
    ? `outcome:${actor}:${receipt.operationId}:${receipt.action}:${[...receipt.errorCodes].sort().join(',')}`
    : `delivery:${actor}:${receipt.entryId}:${receipt.state}`;
}
export const mutationReceiptKey = (actor: string, operationId: string, action: MetricMutationAction) =>
  `mutation:${actor}:${operationId}:${action}`;
/** At most this many receipts ride on one existing mutation. */
export const CALLER_RECEIPT_BATCH = 20;
/** Compact page row for the self-metrics reader. */
export const metricReceiptRowSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('outcome'),
    actor: z.string(),
    at: stamp,
    action: z.string(),
    operationId: z.string(),
    errorCodes: z.array(z.string()),
    noOwner: z.boolean(),
    noOwnerCause: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('delivery'),
    actor: z.string(),
    at: stamp,
    action: z.string(),
    operationId: z.string().nullable(),
    entryId: z.string(),
    state: z.enum(['landed', 'terminal-failed']),
    noOwner: z.boolean(),
    noOwnerCause: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('mutation'),
    actor: z.string(),
    at: stamp,
    action: z.enum(metricMutationActions),
    operationId: z.string(),
  }),
]);
export type MetricReceiptRow = z.infer<typeof metricReceiptRowSchema>;

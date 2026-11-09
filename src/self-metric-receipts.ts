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
  firstWrites: 'first-write',
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
  /** Metric 5.4 first-write delivery on a hosted Lane: the edit hook returned overlap notices before
   * this write. `writeId` is an opaque hash of session, Lane and path; never transcript content. */
  z
    .object({
      kind: z.literal('first-write'),
      actor: z.string().min(1).max(200).nullable(),
      at: stamp,
      laneId: z.uuid(),
      writeId: z.string().regex(/^[0-9a-f]{64}$/),
      count: z.number().int().min(1).max(10_000),
      paths: z.array(z.string().min(1).max(1024)).min(1).max(5),
    })
    .strict(),
]);
export type CallerReceipt = z.infer<typeof callerReceiptSchema>;
export { callerReceiptKey } from './self-metric-receipt-key.js';
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
    /** From the signed-in identity (device credentials are agents); absent on older receipts. */
    actorKind: z.enum(['agent', 'person']).optional(),
  }),
  z.object({
    kind: z.literal('first-write'),
    actor: z.string(),
    at: stamp,
    laneId: z.string(),
    writeId: z.string(),
    count: z.number(),
    paths: z.array(z.string()),
  }),
]);
export type MetricReceiptRow = z.infer<typeof metricReceiptRowSchema>;

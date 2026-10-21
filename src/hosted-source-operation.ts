// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './portable-hash.js';
import { invariant } from './errors.js';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Exact resource observations; a new observation belongs to a named child attempt. */
export const hostedExpectedPinsSchema = z
  .object({
    authorityEpoch: version,
    head: hash.optional(),
    receiptId: z.string().min(1).nullable().optional(),
    resourceId: z.string().min(1).optional(),
    resourceVersion: version.optional(),
    sourceRevision: version.optional(),
  })
  .strict();
export const hostedAttemptSchema = z
  .object({
    projectId: z.string().min(1),
    operationId: z.uuid(),
    id: z.uuid(),
    parentAttemptId: z.uuid().nullable(),
    at: z.iso.datetime(),
    expected: hostedExpectedPinsSchema,
    ids: z.record(z.string().min(1), z.uuid()),
  })
  .strict();
export const hostedOperationRequestSchema = z
  .object({
    schema: z.literal(1),
    projectId: z.string().min(1),
    actor: z.string().min(1),
    operationId: z.uuid(),
    payloadHash: hash,
    expected: hostedExpectedPinsSchema,
  })
  .strict();
export const hostedTerminalReceiptSchema = z
  .object({
    attemptId: z.uuid(),
    at: z.iso.datetime(),
    outcome: z.discriminatedUnion('status', [
      z.object({ status: z.literal('completed'), result: z.json() }).strict(),
      z
        .object({
          status: z.literal('failed'),
          error: z.object({ code: z.string().min(1), message: z.string() }).strict(),
        })
        .strict(),
    ]),
  })
  .strict();
export const hostedOperationSchema = hostedOperationRequestSchema
  .extend({ firstAttempt: hostedAttemptSchema, terminal: hostedTerminalReceiptSchema.nullable() })
  .superRefine((value, ctx) => {
    if (
      value.firstAttempt.parentAttemptId !== null ||
      value.firstAttempt.projectId !== value.projectId ||
      value.firstAttempt.operationId !== value.operationId ||
      canonicalPayload(value.expected) !== canonicalPayload(value.firstAttempt.expected)
    )
      ctx.addIssue({ code: 'custom', message: 'First attempt must retain original operation pins.' });
  });
export type HostedExpectedPins = z.infer<typeof hostedExpectedPinsSchema>;
export type HostedAttempt = z.infer<typeof hostedAttemptSchema>;
export type HostedOperation = z.infer<typeof hostedOperationSchema>;
export type HostedTerminalReceipt = z.infer<typeof hostedTerminalReceiptSchema>;

/** JSON values only: recursively sorted object keys, preserved array order and exact strings. */
export function canonicalPayload(value: unknown): string {
  const parsed = z.json().parse(value);
  function encode(item: z.infer<ReturnType<typeof z.json>>): string {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (item && typeof item === 'object')
      return `{${Object.keys(item)
        .sort()
        .map(key => `${JSON.stringify(key)}:${encode(item[key]!)}`)
        .join(',')}}`;
    return JSON.stringify(item);
  }
  return encode(parsed);
}
export function hostedPayloadHash(payload: unknown, expected: HostedExpectedPins): string {
  return digest(canonicalPayload({ payload, expected: hostedExpectedPinsSchema.parse(expected) }));
}

/**
 * Reconcile before external effects. Callers persist a fresh record transactionally
 * before scheduling work, and must supply a current-access check even for completed retries.
 * The candidate first-attempt IDs/time are ignored on retry in favor of the saved originals.
 */
export async function prepareHostedOperation(
  input: unknown,
  payload: unknown,
  firstAttempt: unknown,
  saved: unknown | undefined,
  authorize: () => Promise<void>,
): Promise<{ operation: HostedOperation; replayed: boolean }> {
  await authorize();
  const request = hostedOperationRequestSchema.parse(input);
  invariant(
    request.payloadHash === hostedPayloadHash(payload, request.expected),
    'WORK_OPERATION_CHANGED',
    'Operation payload differs from its canonical hash.',
  );
  if (saved !== undefined) {
    const operation = hostedOperationSchema.parse(saved);
    invariant(
      canonicalPayload(request) ===
        canonicalPayload(
          hostedOperationRequestSchema.parse({
            schema: operation.schema,
            projectId: operation.projectId,
            actor: operation.actor,
            operationId: operation.operationId,
            payloadHash: operation.payloadHash,
            expected: operation.expected,
          }),
        ),
      'WORK_OPERATION_CHANGED',
      'Retry the original project, actor, payload and resource pins.',
    );
    return { operation, replayed: true };
  }
  return {
    operation: hostedOperationSchema.parse({ ...request, firstAttempt, terminal: null }),
    replayed: false,
  };
}

/** A terminal receipt is immutable; retries never substitute a later result or rerun effects. */
export function completeHostedOperation(
  input: HostedOperation,
  receipt: HostedTerminalReceipt,
): HostedOperation {
  const operation = hostedOperationSchema.parse(input);
  return operation.terminal ? operation : hostedOperationSchema.parse({ ...operation, terminal: receipt });
}

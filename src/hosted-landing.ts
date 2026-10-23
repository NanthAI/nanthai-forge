// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { mainExpectationSchema } from './hosted-main.js';
import { hostedCheckRequestSchema, checkNumber } from './hosted-check.js';
import { autonomyPolicySchema } from './autonomy-policy.js';
import { submissionOutcome } from './landing-submission-state.js';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const object = z.object({ sha256: hash, size: checkNumber }).strict();
export const landingCheckSelectionSchema = z.union([
  z.object({ kind: z.literal('run'), runId: z.uuid() }).strict(),
  hostedCheckRequestSchema
    .omit({ operationId: true, authorityEpoch: true, candidateId: true, expectedHead: true })
    .extend({ kind: z.literal('request') })
    .strict(),
]);
export const hostedLandingRequestSchema = z
  .object({
    operationId: z.uuid(),
    authorityEpoch: checkNumber,
    channel: z.literal('main'),
    expectedMain: mainExpectationSchema,
    candidateId: z.uuid(),
    expectedHead: hash.nullable(),
    agent: z.boolean().default(false),
    check: landingCheckSelectionSchema.nullable(),
    finish: z
      .object({ composeOperationId: z.uuid(), after: z.uuid().nullable().default(null) })
      .strict()
      .optional(),
  })
  .strict();
export const hostedLandingAttemptSchema = z
  .object({
    schema: z.literal(1),
    projectId: z.string().min(1),
    submissionId: z.uuid(),
    operationId: z.uuid(),
    id: z.uuid(),
    parentAttemptId: z.uuid().nullable(),
    number: checkNumber,
    at: z.iso.datetime(),
    authorityEpoch: checkNumber,
    actor: z.object({ id: z.string().min(1), kind: z.enum(['agent', 'person']) }).strict(),
    main: mainExpectationSchema,
    candidate: z
      .object({
        id: z.uuid(),
        digest: hash,
        head: hash.nullable(),
        inputs: object,
        dependencies: object,
        algorithm: z.string().min(1),
      })
      .strict(),
    check: z
      .object({
        runId: z.uuid(),
        checkId: z.uuid(),
        definition: hash,
        configuration: hash,
        environment: hash,
      })
      .strict()
      .nullable(),
    policy: autonomyPolicySchema,
    policyDigest: hash,
    operations: z.object({ check: z.uuid(), accept: z.uuid() }).strict(),
  })
  .strict();
export const landingObservationSchema = z
  .object({
    state: z.enum(['pending', 'terminal-failed', 'landed', 'superseded']),
    pendingReason: z
      .enum(['queued', 'checking', 'waiting-for-review', 'waiting-for-dependency', 'pending-infra'])
      .nullable(),
    cause: z.enum(['conflict', 'check-failed', 'infra', 'stale-head', 'rejected']).nullable(),
  })
  .strict();
export const hostedLandingStateSchema = z
  .object({
    schema: z.literal(1),
    projectId: z.string().min(1),
    id: z.uuid(),
    operationId: z.uuid(),
    actor: z.string().min(1),
    at: z.iso.datetime(),
    request: hostedLandingRequestSchema,
    sequence: checkNumber,
    version: checkNumber,
    firstAttemptId: z.uuid(),
    attemptId: z.uuid(),
    phase: z.enum(['queued', 'checking', 'ready', 'terminal-failed', 'landed']),
    observation: landingObservationSchema,
    acceptance: z.object({ receiptId: z.uuid(), head: hash }).strict().optional(),
    error: z
      .object({ code: z.string().min(1), message: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type HostedLandingRequest = z.infer<typeof hostedLandingRequestSchema>;
export type HostedLandingAttempt = z.infer<typeof hostedLandingAttemptSchema>;
export type HostedLandingState = z.infer<typeof hostedLandingStateSchema>;
/** Exactly the S01 observation vocabulary; ready is still pending until H14's receipt. */
export const landingObservation = (status: string, code?: string) =>
  submissionOutcome({ status, ...(code ? { code } : {}) });
export const HOSTED_LANDING_LEASE_MS = 30_000;
export const HOSTED_LANDING_PAGE_ROWS = 100;

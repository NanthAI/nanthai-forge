// SPDX-License-Identifier: Apache-2.0
import { batchDiagnosticSchema } from './hosted-batch-diagnosis.js';
import { checkFileSummarySchema } from './check-file-summary.js';
import { semanticConflictsSchema, semanticPlanSchema } from './intent-semantic-conflict.js';
import { z } from 'zod';
import { proofSummarySchema } from './landing-proof.js';
import { landingMessageSchema } from './landing-message.js';
import { landingStallSchema } from './landing-stall-schema.js';
import { mainExpectationSchema } from './hosted-main.js';
import { hostedCheckRequestSchema, checkNumber } from './hosted-check.js';
import { autonomyPolicySchema } from './autonomy-policy.js';
import { composeRequestSchema } from './hosted-compose.js';
import { submissionOutcome } from './landing-submission-state.js';
import { crossHeadProofSchema } from './hosted-cross-head-proof.js';
import { scopedRecheckBasisSchema } from './scoped-recheck-policy.js';
import { docsResolutionSchema } from './docs-resolution.js';
import { landingAcceptedBySchema } from './landing-accepted-by.js';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const finishRetryReasonSchema = z.enum(['flake', 'main-moved', 'infra', 'other']);
const object = z.object({ sha256: hash, size: checkNumber }).strict();
export const landingCheckSelectionSchema = z.union([
  z.object({ kind: z.literal('run'), runId: z.uuid() }).strict(),
  hostedCheckRequestSchema
    .omit({ operationId: true, authorityEpoch: true, candidateId: true, expectedHead: true, origin: true })
    .extend({ kind: z.literal('request') })
    .strict(),
]);
export const hostedLandingRequestSchema = z
  .object({
    operationId: z.uuid(),
    governanceVersion: z.literal(1).optional(),
    authorityEpoch: checkNumber,
    channel: z.literal('main'),
    expectedMain: mainExpectationSchema,
    candidateId: z.uuid(),
    expectedHead: hash.nullable(),
    agent: z.boolean().default(false),
    keepOpen: z.boolean().optional(),
    /** false: the landing only references its Lanes' Intents (GitHub `Refs #N`); absent or true declares them (`Closes #N`). */
    closes: z.boolean().optional(),
    message: landingMessageSchema.nullable().optional(),
    priority: z.enum(['urgent', 'normal']).optional(),
    revertOf: z.uuid().optional(),
    retryReason: finishRetryReasonSchema.optional(),
    check: landingCheckSelectionSchema.nullable(),
    finish: z
      .object({
        composeOperationId: z.uuid().optional(),
        reviewedSource: composeRequestSchema.optional(),
        after: z.uuid().nullable().default(null),
      })
      .strict()
      .refine(
        value => Boolean(value.composeOperationId) !== Boolean(value.reviewedSource),
        'Select one original composition or reviewed source.',
      )
      .optional(),
  })
  .strict();
/** A landing request is cancelled separately from its Lane or shared check run. */
export const hostedLandingCancelSchema = z
  .object({ operationId: z.uuid(), authorityEpoch: checkNumber, submissionId: z.uuid() })
  .strict();
/** Agent withdraw (78a97771): cancel the live landing of one Lane, named by the Lane. */
export const hostedLandingWithdrawSchema = z
  .object({
    operationId: z.uuid(),
    authorityEpoch: checkNumber,
    laneId: z.uuid(),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();
export const hostedLandingAttemptSchema = z
  .object({
    crossHeadProof: crossHeadProofSchema.optional(),
    /** Main-race retry basis: its check may run the scoped recheck selection. */
    recheck: scopedRecheckBasisSchema.optional(),
    /** Why this main-race attempt rechecked instead of carrying its parent's check across
     * heads, and why that recheck could not be scoped (src/fallback-reasons.ts, 7c2e69e1). */
    recheckReason: z.string().min(1).max(64).optional(),
    scopedFallback: z.string().min(1).max(64).optional(),
    semanticPlan: semanticPlanSchema.optional(),
    deferredCheck: z.literal(true).optional(),
    /** Infrastructure retries retain the exact Candidate and parent run in the attempt chain. */
    platformRetries: checkNumber.optional(),
    memberCandidate: z
      .object({
        id: z.uuid(),
        digest: hash,
        head: hash.nullable(),
        inputs: object,
        dependencies: object,
        algorithm: z.string().min(1),
      })
      .strict()
      .optional(),
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
    stall: landingStallSchema.optional(),
    state: z.enum(['pending', 'terminal-failed', 'landed', 'superseded']),
    pendingReason: z
      .enum(['queued', 'checking', 'waiting-for-review', 'waiting-for-dependency', 'pending-infra'])
      .nullable(),
    cause: z.enum(['conflict', 'check-failed', 'infra', 'stale-head', 'rejected']).nullable(),
  })
  .strict();
export const hostedLandingStateSchema = z
  .object({
    message: landingMessageSchema.nullable().optional(),
    schema: z.literal(1),
    projectId: z.string().min(1),
    id: z.uuid(),
    operationId: z.uuid(),
    actor: z.string().min(1),
    at: z.iso.datetime(),
    request: hostedLandingRequestSchema,
    sequence: checkNumber,
    priority: z.enum(['urgent', 'normal']).optional(),
    priorityReason: z.string().optional(),
    priorityVersion: checkNumber.optional(),
    version: checkNumber,
    firstAttemptId: z.uuid(),
    attemptId: z.uuid(),
    phase: z.enum(['composing', 'queued', 'checking', 'ready', 'terminal-failed', 'landed']),
    preparing: z.literal(true).optional(),
    supersedes: z.uuid().optional(),
    retryReason: finishRetryReasonSchema.optional(),
    batchId: z.uuid().optional(),
    batchOriginId: z.uuid().optional(),
    batchNeedsSoloCompose: z.literal(true).optional(),
    batchSolo: z.literal(true).optional(),
    batchDiagnostic: batchDiagnosticSchema.optional(),
    semanticConflicts: semanticConflictsSchema.optional(),
    checkProgress: hash.optional(),
    testFiles: checkFileSummarySchema.optional(),
    /** The attempt's check ran the whole command: its run's fallback reason (Issue 7cb61db1). */
    ranInFull: z.string().min(1).max(300).optional(),
    timing: z
      .object({
        submittedAt: z.iso.datetime(),
        selectedAt: z.iso.datetime().optional(),
        composeStartedAt: z.iso.datetime().optional(),
        composedAt: z.iso.datetime().optional(),
        checkReservedAt: z.iso.datetime().optional(),
        ciObservedAt: z.iso.datetime().optional(),
        ciProgressAt: z.iso.datetime().optional(),
        ciEndedAt: z.iso.datetime().optional(),
        settlementStartedAt: z.iso.datetime().optional(),
        commitObservedAt: z.iso.datetime().optional(),
        committedAt: z.iso.datetime().optional(),
        settledAt: z.iso.datetime().optional(),
      })
      .strict()
      .optional(),
    /** Cost counts the landing carries (Issue 3e3f9fe6), stamped by writes it makes anyway: the R2 requests
     * its composes signed (class A, class B, bytes put, over all attempts), and the shard execution seconds
     * of its latest check run and of the runs its earlier attempts discarded. Not timestamps. */
    counts: z
      .object({
        r2: z.tuple([checkNumber, checkNumber, checkNumber]).optional(),
        runnerSeconds: z.number().min(0).optional(),
        discardedRunnerSeconds: z.number().min(0).optional(),
      })
      .strict()
      .optional(),
    observation: landingObservationSchema,
    acceptance: z
      .object({
        receiptId: z.uuid(),
        head: hash,
        proofRunId: z.uuid().optional(),
        proof: proofSummarySchema.optional(),
        docsResolution: docsResolutionSchema.optional(),
        /** Who accepted it: a person, or policy with no person (fe5bea80). Absent on older landings. */
        acceptedBy: landingAcceptedBySchema.optional(),
      })
      .strict()
      .optional(),
    error: z
      .object({ code: z.string().min(1), message: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export const hostedLandingProgressSchema = hostedLandingStateSchema
  .pick({
    semanticConflicts: true,
    batchDiagnostic: true,
    observation: true,
    phase: true,
    error: true,
    version: true,
    timing: true,
  })
  .extend({
    acceptance: hostedLandingStateSchema.shape.acceptance.unwrap().nullable(),
    settled: z.boolean(),
  })
  .strict();
export type HostedLandingRequest = z.infer<typeof hostedLandingRequestSchema>;
export type HostedLandingAttempt = z.infer<typeof hostedLandingAttemptSchema>;
export type HostedLandingState = z.infer<typeof hostedLandingStateSchema>;
/** Exactly the S01 observation vocabulary; ready is still pending until H14's receipt. */
export const landingObservation = (status: string, code?: string) => {
  const outcome = submissionOutcome({ status, ...(code ? { code } : {}) });
  // The wire vocabulary has no `unknown`, and the server passes only its own literal statuses, so
  // it never reaches here; the CLI-side reader of other builds' statuses is where `unknown` lives.
  return outcome.state === 'unknown'
    ? { ...outcome, state: 'terminal-failed' as const, cause: 'rejected' as const }
    : { ...outcome, state: outcome.state };
};
export const HOSTED_LANDING_LEASE_MS = 30_000;

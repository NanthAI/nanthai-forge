// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { landingMessageSchema, cohortMessagesSchema } from './landing-message.js';
import { hostedMacEvidenceSchema } from './hosted-check.js';
import { hostedLandingAttemptSchema } from './hosted-landing.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './portable-hash.js';
import { crossHeadProofSchema } from './hosted-cross-head-proof.js';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
/** Immutable publication evidence. Input roots retain the exact ordered Lane
 * heads and included dependencies; no expanding fan-in lives in this document. */
export const hostedAcceptanceSchema = z
  .object({
    schema: z.literal(1),
    id: z.uuid(),
    projectId: z.string().min(1),
    channel: z.literal('main'),
    submissionId: z.uuid(),
    operationId: z.uuid(),
    attemptId: z.uuid(),
    at: z.iso.datetime(),
    authorityEpoch: count,
    previous: hostedLandingAttemptSchema.shape.main,
    candidate: hostedLandingAttemptSchema.shape.candidate.extend({ head: hash }),
    message: landingMessageSchema.optional(),
    cohortMessages: cohortMessagesSchema.optional(),
    memberCandidate: hostedLandingAttemptSchema.shape.candidate.optional(),
    batchId: z.uuid().optional(),
    crossHeadProof: crossHeadProofSchema.optional(),
    /** Pre-queue admitted landings: whether the landing took its first (admission)
     * check as acceptance evidence, or rechecked and why (Issue 7fe54c7c). */
    firstCheck: z
      .discriminatedUnion('landedOn', [
        z
          .object({
            landedOn: z.literal('admission-run'),
            mainMoved: z.boolean(),
            /** The first-check rule that carried a moved main (crossHeadProof.algorithm). */
            rule: z.string().min(1).max(64).optional(),
          })
          .strict(),
        z.object({ landedOn: z.literal('recheck'), reason: z.string().min(1).max(64) }).strict(),
      ])
      .optional(),
    actor: hostedLandingAttemptSchema.shape.actor,
    policyDigest: hash,
    check: z
      .object({
        runId: z.uuid(),
        checkId: z.uuid(),
        definition: hash,
        configuration: hash,
        environment: hash,
        terminalDigest: hash,
        planDigest: hash,
        executionId: z.string().min(1),
        macEvidence: hostedMacEvidenceSchema.optional(),
      })
      .strict()
      .nullable(),
    snapshot: z.object({ id: z.uuid(), previousId: z.string().min(1), revision: count }).strict(),
    completion: z
      .object({
        root: hash,
        pages: count,
        lanes: count,
        enabled: z.boolean(),
        /** The landing completes its Lanes' Intents (closeOnLand declared and not refs-only). Absent on older receipts: the Intent follows `enabled` only. */
        closeIntents: z.boolean().optional(),
      })
      .strict(),
    automatic: z.boolean(),
    undo: z.object({ kind: z.literal('revert'), receiptId: z.uuid() }).strict(),
  })
  .strict();
export type HostedAcceptance = z.infer<typeof hostedAcceptanceSchema>;
export const EMPTY_COMPLETION_ROOT = digest('forge-hosted-landed-heads-v1');
export const completionPageRoot = (previous: string, kind: string, index: number, page: unknown) =>
  digest(canonicalPayload({ domain: 'forge-hosted-landed-heads-v1', previous, kind, index, page }));

/** Receipt `firstCheck` from the server-only admission fields of the landing row. */
export function firstCheckReceipt(
  admission: { runId: string; status: string; full?: true; recheck?: string } | undefined,
  input: { runId: string | undefined; reused: boolean; batch: boolean; rule?: string },
): HostedAcceptance['firstCheck'] {
  if (!admission?.full || admission.status !== 'passed') return undefined;
  if (!input.batch && input.runId === admission.runId)
    return {
      landedOn: 'admission-run',
      mainMoved: input.reused,
      ...(input.rule ? { rule: input.rule } : {}),
    };
  return { landedOn: 'recheck', reason: admission.recheck ?? (input.batch ? 'cohort' : 'not-tried') };
}
export const firstCheckField = (value: HostedAcceptance['firstCheck']) =>
  value ? { firstCheck: value } : {};

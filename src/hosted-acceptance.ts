// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { landingMessageSchema, cohortMessagesSchema } from './landing-message.js';
import { candidateIsolationModeSchema, checkSkippedSchema, hostedMacEvidenceSchema } from './hosted-check.js';
import { hostedLandingAttemptSchema } from './hosted-landing.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './portable-hash.js';
import { crossHeadProofSchema } from './hosted-cross-head-proof.js';
import { secretAllowMarkSchema } from './secret-allow.js';
import { docsResolutionSchema } from './docs-resolution.js';
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
        /** Rechecked on the tests that can see both changes (Issue fc215574): `reason` is why the
         * first check did not carry, `selection` the planner's reason for the shared-impact set. */
        z
          .object({
            landedOn: z.literal('scoped-intersection'),
            reason: z.string().min(1).max(64),
            selection: z.string().min(1).max(300),
            tests: count,
          })
          .strict(),
      ])
      .optional(),
    /** Each older submission this landing waited for after its check passed, why (`held`) and whether
     * the two changes' footprints overlapped (Issue c6b81429). Under graph-sealed order a `disjoint`
     * wait has a named cause: urgent, a Ready entry about to land, or one whose pass cannot carry. */
    orderWaits: z
      .array(
        z
          .object({
            submissionId: z.string().min(1).max(64),
            held: z.string().min(1).max(32),
            footprints: z.enum(['overlap', 'disjoint', 'unknown']),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .optional(),
    actor: hostedLandingAttemptSchema.shape.actor,
    /** The agent run that submitted the landing (session slug, d730121f); shown as `handle/slug`.
     * Absent on older receipts, on person landings and from CLIs that predate it. */
    agentRun: z.string().min(1).max(64).optional(),
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
        /** Test shards the change's paths did not reach: skipped, never pending (Issue 9e71abcc). */
        skipped: checkSkippedSchema.optional(),
        /** Hosted Actions checks: `user` when project code ran as its own Candidate user, `shared`
         * when the owner's runner configuration let it run as the runner user (Issue 3b67363d). */
        isolation: candidateIsolationModeSchema.optional(),
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
    /** The landing added or edited a secret-scan allow entry; project owners were alerted (Issue 93e14bb0). */
    secretAllowAdded: secretAllowMarkSchema.optional(),
    undo: z.object({ kind: z.literal('revert'), receiptId: z.uuid() }).strict(),
    /** Markdown-only conflicts merged automatically with the docs rule, and how to undo that. */
    docsResolution: docsResolutionSchema.optional(),
  })
  .strict();
export type HostedAcceptance = z.infer<typeof hostedAcceptanceSchema>;
/** What a landing's completion tick does. A refs-only landing (`closes:false`, GitHub `Refs #N`) names the work without finishing it,
 * so like `keepOpen` it leaves the Lanes open for the follow-up edit that usually comes next (87c80c4b); closeOnLand "off" is
 * project-wide and still completes Lanes only per `completeOnAccept`. */
export function landingCompletion(
  lifecycle: { completeOnAccept: boolean; closeOnLand?: 'declared' | 'off' | undefined },
  request: { keepOpen?: boolean | undefined; closes?: boolean | undefined },
) {
  return {
    enabled: lifecycle.completeOnAccept && !request.keepOpen && request.closes !== false,
    closeIntents: lifecycle.closeOnLand !== 'off' && request.closes !== false,
  };
}
export const EMPTY_COMPLETION_ROOT = digest('forge-hosted-landed-heads-v1');
export const completionPageRoot = (previous: string, kind: string, index: number, page: unknown) =>
  digest(canonicalPayload({ domain: 'forge-hosted-landed-heads-v1', previous, kind, index, page }));

/** Receipt `firstCheck` from the server-only admission fields of the landing row. */
export function firstCheckReceipt(
  admission: { runId: string; status: string; full?: true; recheck?: string } | undefined,
  input: {
    runId: string | undefined;
    reused: boolean;
    batch: boolean;
    rule?: string;
    /** The accepted run's scoped-recheck plan record, when it ran the shared-impact selection. */
    scoped?: { reason: string; tests: number } | undefined;
  },
): HostedAcceptance['firstCheck'] {
  if (!admission?.full || admission.status !== 'passed') return undefined;
  if (!input.batch && input.runId === admission.runId)
    return {
      landedOn: 'admission-run',
      mainMoved: input.reused,
      ...(input.rule ? { rule: input.rule } : {}),
    };
  const reason = admission.recheck ?? (input.batch ? 'cohort' : 'not-tried');
  // A cohort's scoped recheck records it on every member's receipt (Issue 28f08555).
  return input.scoped
    ? { landedOn: 'scoped-intersection', reason, selection: input.scoped.reason, tests: input.scoped.tests }
    : { landedOn: 'recheck', reason };
}
export const firstCheckField = (value: HostedAcceptance['firstCheck']) =>
  value ? { firstCheck: value } : {};
/** Receipt `orderWaits` from the landing row's server-only list (no read). */
export const orderWaitsField = (waits: HostedAcceptance['orderWaits'] | undefined) =>
  waits?.length ? { orderWaits: waits.slice(0, 8) } : {};

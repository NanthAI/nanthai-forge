// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedLandingAttemptSchema } from './hosted-landing.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './portable-hash.js';
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
      })
      .strict()
      .nullable(),
    snapshot: z.object({ id: z.uuid(), previousId: z.string().min(1), revision: count }).strict(),
    completion: z.object({ root: hash, pages: count, lanes: count, enabled: z.boolean() }).strict(),
    automatic: z.boolean(),
    undo: z.object({ kind: z.literal('revert'), receiptId: z.uuid() }).strict(),
  })
  .strict();
export type HostedAcceptance = z.infer<typeof hostedAcceptanceSchema>;
export const EMPTY_COMPLETION_ROOT = digest('forge-hosted-landed-heads-v1');
export const completionPageRoot = (previous: string, kind: string, index: number, page: unknown) =>
  digest(canonicalPayload({ domain: 'forge-hosted-landed-heads-v1', previous, kind, index, page }));

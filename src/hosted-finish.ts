// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { composeInputSchema } from './hosted-compose.js';
import { composeRequestSchema } from './hosted-compose.js';
import { hostedLandingAttemptSchema, landingCheckSelectionSchema } from './hosted-landing.js';
/** Finish owns orchestration only. Source/check/publication authority remains in
 * H08/H10/H14; the original selection and check settings never follow later saves. */
export const hostedFinishSchema = z
  .object({
    source: composeRequestSchema,
    singleSelectionHead: hostedLandingAttemptSchema.shape.main.shape.head.optional(),
    recoveryRunId: z.uuid().optional(),
    restoreBases: composeInputSchema.shape.restoreBases,
    check: landingCheckSelectionSchema.nullable(),
    precomposed: z
      .object({
        operationId: z.uuid(),
        parentAttemptId: z.uuid(),
        main: hostedLandingAttemptSchema.shape.main,
      })
      .strict()
      .optional(),
    pending: z
      .object({
        precompose: z
          .object({
            peerLanes: z.array(z.uuid()),
            paths: z.array(z.string()),
            runnable: z.boolean(),
            next: z
              .object({ main: hostedLandingAttemptSchema.shape.main, peerLanes: z.array(z.uuid()) })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        id: z.uuid(),
        parentAttemptId: z.uuid(),
        number: z.number().int().positive().safe(),
        at: z.iso.datetime(),
        main: hostedLandingAttemptSchema.shape.main,
        operations: z.object({ compose: z.uuid(), check: z.uuid(), accept: z.uuid() }).strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type HostedFinish = z.infer<typeof hostedFinishSchema>;
/** Contended CAS creates one named attempt, then yields. No retry ceiling or
 * synchronous loop: every further race gets its own retained source/check work. */
export const hostedFinishBackoff = (number: number) => Math.min(30_000, 250 * 2 ** Math.min(number - 1, 7));
/** A submitted source job resumes a failed or killed step action only on an
 * explicit trigger. Its finish owner retains one deadline for at most 15 ticks. */
export const HOSTED_FINISH_COMPOSE_WATCHDOG_MS = 120_000;
export const HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS = 30 * 60_000;
export type FinishCommand =
  | { kind: 'reuse'; pendingId: string }
  | {
      kind: 'review';
      pendingId: string;
      approvedAttemptId: string;
      candidateDigest: string;
      before: { sha256: string; size: number };
      after: { sha256: string; size: number };
      /** Item fe2b0a86: compare only the protected entries; absent compares every changed file. */
      protect?: import('./protected-review.js').ReviewProtect;
    }
  | {
      /** Item fe2b0a86 part B: whether a held attempt's protected entries equal those of an earlier
       * owner-approved submission of the same Intent (`before`); only then is that reason lifted. */
      kind: 'protected';
      attemptId: string;
      candidateDigest: string;
      before: { sha256: string; size: number };
      after: { sha256: string; size: number };
      protect: import('./protected-review.js').ReviewProtect;
      /** The protected paths compared; recorded as carried only when they are equal. */
      paths: string[];
    }
  | {
      kind: 'page';
      url: string;
      range?: import('./object-pack-range.js').PackRange;
      pin: { sha256: string; size: number };
      selection: { attemptId: string; kind: 'inputs' | 'dependencies'; index: number };
    }
  | {
      kind: 'plan';
      value: string;
      pin: { sha256: string; size: number };
      batchId?: string;
      batchComposeOperationId?: string;
      /** Missing pins from the same retained batch window. A drive confirms the entire set. */
      batchUpload?: { from: number; rest: { pin: { sha256: string; size: number }; value: string }[] };
      /** A solo plan's compose, which rebuilds `value` in the action (Item 9a04d916). */
      source?: { actor: string; operationId: string; at: string };
    };

/** Private probe scheduling is not a released pending-attempt protocol field. */
export function finishPendingForReader(value: HostedFinish['pending']) {
  if (!value) return null;
  const { precompose, ...pending } = value;
  void precompose;
  return pending;
}

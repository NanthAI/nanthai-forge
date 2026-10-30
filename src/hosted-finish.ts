// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { composeInputSchema } from './hosted-compose.js';
import { composeRequestSchema } from './hosted-compose.js';
import { hostedLandingAttemptSchema, landingCheckSelectionSchema } from './hosted-landing.js';
/** Finish owns orchestration only. Source/check/publication authority remains in
 * H08/H10/H14; the original selection and check settings never follow later saves. */
export const hostedFinishSchema = z
  .object({
    source: composeRequestSchema,
    recoveryRunId: z.uuid().optional(),
    restoreBases: composeInputSchema.shape.restoreBases,
    check: landingCheckSelectionSchema.nullable(),
    pending: z
      .object({
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
      kind: 'page';
      url: string;
      pin: { sha256: string; size: number };
      selection: { attemptId: string; kind: 'inputs' | 'dependencies'; index: number };
    }
  | { kind: 'plan'; value: string; pin: { sha256: string; size: number }; batchId?: string };

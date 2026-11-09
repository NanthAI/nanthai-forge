// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/**
 * The stable outcome fields of a landing observation page (Issue 71ef0a66): what a wait needs to
 * follow a submission and report its outcome. Servers keep these names, types and the
 * observation-state values unchanged across deploys (docs/operations/cli-update.md "Server
 * replies"); everything else passes through as sent. Read only when the full contract fails.
 */
const stableSubmission = z
  .object({
    projectId: z.string(),
    id: z.uuid(),
    operationId: z.uuid(),
    attemptId: z.uuid(),
    version: z.number().int().nonnegative(),
    phase: z.string(),
    observation: z
      .object({ state: z.enum(['pending', 'terminal-failed', 'landed', 'superseded']) })
      .passthrough(),
    request: z.object({}).passthrough(),
    acceptance: z.object({ receiptId: z.uuid(), head: z.string() }).passthrough().optional(),
    error: z.object({ code: z.string() }).passthrough().nullable().optional(),
  })
  .passthrough();
export const stableSubmissionPageSchema = z
  .object({
    projectId: z.string(),
    operationId: z.uuid(),
    canonicalOperationId: z.uuid().optional(),
    authority: z.unknown(),
    submission: stableSubmission,
    events: z.array(z.object({ submission: stableSubmission }).passthrough()),
    nextVersion: z.number().int().nonnegative(),
    isDone: z.boolean(),
    resnapshot: z.boolean(),
  })
  .passthrough();

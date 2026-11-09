// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { pullJobSchema } from './github-pull-check.js';

/** Portable (V8-safe) two-way sync job shape and message; the GitHub diff lives in github-inbound.ts. */
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const pin = z.object({ sha256: hash, size: z.number().int().nonnegative() }).strict();
/** Two-way sync job progress, kept on its mirror queue row: `pending` reads GitHub, `compose`
 * uploads the small compose metadata, `landing` waits for the normal landing to settle. A pull
 * request job (`pull`) checks a PR head instead: after `compose` it releases the queue and its
 * `checking` phase waits for the composition and then the check-only run, never a landing. */
export const inboundJobSchema = z
  .object({
    phase: z.enum(['pending', 'compose', 'landing', 'checking']),
    pull: pullJobSchema.optional(),
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    tree: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    message: z.string().max(4000).optional(),
    /** The State whose files equal GitHub's tree at `commit`. */
    equivalent: hash.optional(),
    base: z
      .object({ head: hash, receiptId: z.string().min(1) })
      .strict()
      .optional(),
    intentId: z.uuid().optional(),
    laneId: z.uuid().optional(),
    composeOperationId: z.uuid().optional(),
    landingOperationId: z.uuid().optional(),
    submissionId: z.uuid().optional(),
    changes: z.number().int().nonnegative().optional(),
    paths: z.array(z.string()).max(20).optional(),
    uploads: z
      .array(z.object({ value: z.string(), pin }).strict())
      .max(8)
      .optional(),
  })
  .strict();
export type InboundJob = z.infer<typeof inboundJobSchema>;
/** The inbound landing's message: the GitHub commit it brings in, by public fields only. */
export function inboundMessage(input: { commit: string; message: string; repository: string }) {
  const subject = input.message.split('\n', 1)[0]!.trim().slice(0, 200) || 'GitHub change';
  return `${subject}\n\nBrought in from GitHub ${input.repository} main at ${input.commit}.\nGitHub-Commit: ${input.commit}`;
}

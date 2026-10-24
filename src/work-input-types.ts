// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { safeRelative } from './safe-relative.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const declaredInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), path: z.string().refine(safeRelative) }),
  z.object({ kind: z.literal('tool'), executable: z.string().trim().min(1) }),
  z.object({ kind: z.literal('environment'), name: z.string().trim().min(1) }),
  z.object({ kind: z.literal('external'), name: z.string().trim().min(1), claimSha256: sha256.optional() }),
]);
export const inputObservationSchema = z.object({
  input: declaredInputSchema,
  status: z.enum(['observed', 'unknown', 'claimed']),
  sha256: sha256.optional(),
  size: z.number().safe().nonnegative().optional(),
  locator: z.string().optional(),
  mode: z.string().optional(),
  producer: z.string(),
  details: z.string(),
});
export const inputAssessmentCommandSchema = z.object({
  action: z.literal('assess-check-inputs'),
  runId: z.uuid(),
  viewId: z.uuid(),
  expectedHead: z.string().regex(/^[0-9a-f]{40,64}$/),
});
export type DeclaredInput = z.infer<typeof declaredInputSchema>;
export type InputObservation = z.infer<typeof inputObservationSchema>;
export type InputAssessmentCommand = z.infer<typeof inputAssessmentCommandSchema>;

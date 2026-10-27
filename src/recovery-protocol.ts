// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedMainV2Schema } from './hosted-main.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const recoverySelectionSchema = z
  .object({
    projectId: z.string().min(1),
    ownerId: z.uuid(),
    backupId: z.string().min(1),
    checkpointSha256: sha256,
    checkpointSize: z.number().safe().nonnegative(),
    manifestSha256: sha256,
    revision: z.number().safe().nonnegative(),
    authority: sourceAuthoritySchema,
    transport: z.enum(['objects', 'archive']),
    hostedMain: hostedMainV2Schema.optional(),
    completeHistory: z.enum(['complete', 'incomplete', 'unknown']),
  })
  .strict();
export type RecoverySelection = z.infer<typeof recoverySelectionSchema>;
/** History coverage is advisory; improvements do not change source/Work CAS pins. */
export function sameRecoveryPins(left: RecoverySelection, right: RecoverySelection) {
  const leftPins = { ...left, completeHistory: null };
  const rightPins = { ...right, completeHistory: null };
  return JSON.stringify(leftPins) === JSON.stringify(rightPins);
}
export const recoveryBindingSchema = z.object({
  projectId: z.string(),
  operationId: z.uuid(),
  projectUrl: z.url(),
  name: z.string(),
  visibility: z.enum(['private', 'public']),
  backupId: z.string(),
});
export const recoveryConnectionSchema = z.object({
  operationId: z.uuid(),
  requestHash: sha256,
  role: z.enum(['owner', 'client']),
  selection: recoverySelectionSchema,
  binding: recoveryBindingSchema,
});
export type RecoveryConnection = z.infer<typeof recoveryConnectionSchema>;
export const recoveryPreparationSchema = z.object({
  authority: sourceAuthoritySchema.optional(),
  selection: recoverySelectionSchema.nullable(),
  receipt: recoveryConnectionSchema.nullable(),
});
export const recoveryRequestSchema = z
  .object({
    operationId: z.uuid(),
    url: z.url(),
    projectId: z.string().min(1),
    archivePath: z.string().min(1).optional(),
    cacheRoot: z.string().min(1).optional(),
  })
  .strict();
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;

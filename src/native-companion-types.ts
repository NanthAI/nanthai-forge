// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{64}$/);
export const companionCommandSchema = z.object({
  manifestSha256: sha.optional(),
  transport: z.literal('objects').optional(),
  preserveLocalSource: z.boolean().optional(),
  action: z.literal('reconcile-hosted-work'),
  operationId: z.uuid(),
  projectKey: z.uuid(),
  archivePath: z.string().min(1),
  archiveSha256: sha,
  journalPath: z.string().min(1),
  journalSha256: sha,
});
export type CompanionCommand = z.infer<typeof companionCommandSchema>;
export const companionReceiptSchema = z.object({
  id: z.uuid(),
  request: sha,
  projectKey: z.uuid(),
  at: z.string(),
  archiveSha256: sha,
  journalSha256: sha,
  baseWorkSha256: sha,
  hostedWorkSha256: sha,
  previousRevision: z.number().safe().nonnegative(),
  previousWorkSha256: sha,
  revision: z.number().safe().nonnegative(),
  hostedRevision: z.number().safe().nonnegative(),
  eventIds: z.array(z.uuid()),
});
export type CompanionReceipt = z.infer<typeof companionReceiptSchema>;
export type CompanionConflict = {
  collection: string;
  id?: string;
  field: string;
  base?: unknown;
  local?: unknown;
  hosted?: unknown;
};

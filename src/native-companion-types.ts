// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{64}$/);
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

// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const releaseStages = ['export', 'build', 'backend', 'web', 'package', 'install', 'select'] as const;
export const releaseStageSchema = z.enum(releaseStages);
export type ReleaseStage = z.infer<typeof releaseStageSchema>;
export const releaseRequestSchema = z
  .object({
    operationId: z.uuid(),
    runtimeDirectory: z.string().min(1),
    configurationDirectory: z.string().min(1),
    cliPath: z.string().min(1),
    npmCli: z.string().min(1),
    reuseExport: z.string().min(1).optional(),
  })
  .strict();
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;
export const releaseReceiptSchema = z.object({
  attemptId: z.uuid(),
  status: z.enum(['succeeded', 'failed', 'unknown']),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  result: z.record(z.string(), z.string()).default({}),
  code: z.string().optional(),
});
export type ReleaseReceipt = z.infer<typeof releaseReceiptSchema>;
export const releaseJournalSchema = z.object({
  schema: z.literal(1),
  request: releaseRequestSchema,
  owner: z.string(),
  head: z.string(),
  acceptanceId: z.string(),
  directory: z.string(),
  node: z.string(),
  createdAt: z.string(),
  previousCli: z.object({
    exists: z.boolean(),
    kind: z.enum(['absent', 'file', 'symlink']),
    mode: z.number().int(),
    sha256: z.string(),
  }),
  stages: z.array(
    z.object({
      name: releaseStageSchema,
      id: z.uuid(),
      attempts: z.array(
        z.object({
          id: z.uuid(),
          directory: z.string(),
          receipt: releaseReceiptSchema.optional(),
          reconciliation: z
            .object({ outcome: z.enum(['succeeded', 'failed']), evidence: z.string().min(1) })
            .optional(),
        }),
      ),
    }),
  ),
});
export type ReleaseJournal = z.infer<typeof releaseJournalSchema>;
export const releaseReconciliationSchema = z
  .object({
    stage: releaseStageSchema,
    attemptId: z.uuid(),
    outcome: z.enum(['succeeded', 'failed']),
    evidence: z.string().min(1),
  })
  .strict();

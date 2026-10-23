// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
const oid = z.string().regex(/^[0-9a-f]{64}$/);
const claimSchema = z
  .object({ actor: z.string().min(1), projectKey: z.uuid(), proposalId: z.string().min(1), viewId: z.uuid() })
  .strict();
export const nativeContributionCommandSchema = z
  .object({
    action: z.literal('import-native-contribution'),
    operationId: z.uuid(),
    intentId: z.uuid(),
    expectedBase: oid,
    expectedHead: oid,
    archivePath: z.string().min(1),
    archiveSha256: oid,
    name: z.string().trim().min(1).max(120),
    claim: claimSchema.optional(),
  })
  .strict();
const receipt = {
  id: z.uuid(),
  request: oid,
  intentId: z.uuid(),
  base: oid,
  head: oid,
  size: z.number().safe().nonnegative(),
  at: z.string(),
};
export const nativeArchiveContributionReceiptSchema = z
  .object({
    ...receipt,
    archiveSha256: oid,
    size: z.number().safe().nonnegative(),
    at: z.string(),
    provenance: z.literal('unverified-native-archive'),
    claim: claimSchema.optional(),
  })
  .strict();
const gitId = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
export const nativeGitContributionReceiptSchema = z
  .object({
    ...receipt,
    provenance: z.literal('unverified-git-bundle'),
    inputSha256: oid,
    bundleSha256: oid,
    wireRef: z.literal('refs/heads/contribution').optional(),
    selectedRef: z.string().min(1),
    retainedRef: z.string().regex(/^refs\/forge\/contributions\/[0-9a-f-]{36}\/head$/),
    gitBase: gitId,
    gitHead: gitId,
    projection: z
      .object({ state: oid, head: gitId, format: z.enum(['sha1', 'sha256']), bundle: oid, mapping: oid })
      .strict(),
  })
  .strict();
export const nativeContributionReceiptSchema = z.discriminatedUnion('provenance', [
  nativeArchiveContributionReceiptSchema,
  nativeGitContributionReceiptSchema,
]);
export type NativeContributionReceipt = z.infer<typeof nativeContributionReceiptSchema>;
export type NativeContributionCommand = z.infer<typeof nativeContributionCommandSchema>;

// SPDX-License-Identifier: Apache-2.0
import { v, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { r2Key } from './r2';

export const fallbackWindow = 14 * 86400_000;
export const abandonedWindow = 86400_000;
export const maintenancePageSize = 100;
/** The completed R6 local receipt. Only deployment-admin internal functions consume it. */
export const verifiedPass = v.object({
  operationId: v.string(),
  project: v.string(),
  mode: v.literal('verify'),
  complete: v.literal(true),
  verificationRevision: v.number(),
  verifiedAt: v.string(),
  safeToPurgeAfter: v.string(),
  fullDigest: v.optional(v.boolean()),
  count: v.optional(v.number()),
  digestChecks: v.optional(v.number()),
  kind: v.optional(v.number()),
  failureCount: v.optional(v.number()),
  early: v.optional(
    v.object({
      ownerApproval: v.string(),
      backup: v.object({
        complete: v.literal(true),
        includeFileStorage: v.literal(true),
        operationId: v.string(),
        deployment: v.string(),
        time: v.string(),
        manifestKey: v.string(),
        size: v.number(),
        sha256: v.string(),
      }),
    }),
  ),
});
export type VerifiedPass = Infer<typeof verifiedPass>;
export function checkPass(project: Doc<'hostedProjects'> | null, pass: VerifiedPass, now = Date.now()) {
  invariant(project && !project.removal, 'PROJECT_UNAVAILABLE', 'Select an active project.');
  const at = Date.parse(pass.verifiedAt),
    after = Date.parse(pass.safeToPurgeAfter);
  invariant(
    pass.operationId.trim() &&
      pass.project === project._id &&
      pass.mode === 'verify' &&
      pass.complete &&
      Number.isSafeInteger(pass.verificationRevision) &&
      pass.verificationRevision >= 0 &&
      Number.isFinite(at) &&
      Number.isFinite(after) &&
      at <= now &&
      after >= at + fallbackWindow,
    'R2_VERIFIED_PASS_REQUIRED',
    'Use the completed full R6 verification receipt for this project.',
  );
  invariant(
    (project.r2BackfillRevision ?? 0) === pass.verificationRevision,
    'R2_VERIFICATION_STALE',
    'Backfill changed; complete a new full verification pass.',
  );
  if (now < after || now - at < fallbackWindow) {
    const early = pass.early,
      backupAt = Date.parse(early?.backup?.time ?? '');
    invariant(
      pass.fullDigest === true &&
        pass.kind === 4 &&
        pass.failureCount === 0 &&
        Number.isSafeInteger(pass.count) &&
        pass.count! >= 0 &&
        pass.digestChecks === pass.count &&
        now - at <= abandonedWindow &&
        early?.ownerApproval.trim() &&
        early.backup?.complete &&
        early.backup.includeFileStorage &&
        early.backup.operationId.trim() &&
        early.backup.deployment.trim() &&
        early.backup.manifestKey.endsWith('/manifest.json') &&
        Number.isSafeInteger(early.backup.size) &&
        early.backup.size > 0 &&
        /^[a-f0-9]{64}$/.test(early.backup.sha256) &&
        Number.isFinite(backupAt) &&
        backupAt <= now &&
        now - backupAt <= 7 * abandonedWindow,
      'R2_FALLBACK_WINDOW',
      'Early purge requires a full digest pass within 24 hours, a completed file-inclusive backup within seven days, and explicit owner approval.',
    );
    return;
  }
  invariant(
    now >= after && now - at >= fallbackWindow,
    'R2_FALLBACK_WINDOW',
    'Keep the Convex copies until 14 days after the full verified pass.',
  );
}
export function purgeable(
  source: {
    location?: string;
    r2Key?: string;
    r2Committed?: boolean;
    r2BackfilledAt?: number;
    r2ConvexPurged?: boolean;
    digest: string;
    storageId?: unknown;
  },
  projectId: string,
  pass: VerifiedPass,
  createdAt?: number,
) {
  return (
    (!pass.early || (createdAt !== undefined && createdAt <= Date.parse(pass.verifiedAt))) &&
    source.location === 'r2' &&
    source.r2Committed &&
    source.r2Key === r2Key(projectId, source.digest) &&
    source.storageId &&
    !source.r2ConvexPurged &&
    source.r2BackfilledAt !== undefined &&
    source.r2BackfilledAt <= Date.parse(pass.verifiedAt)
  );
}
export function maintenanceEnabled() {
  invariant(
    process.env.FORGE_R2_MAINTENANCE === '1',
    'R2_MAINTENANCE_DISABLED',
    'The lead has not enabled R2 storage maintenance.',
  );
}

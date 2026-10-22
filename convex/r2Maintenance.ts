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
) {
  return (
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

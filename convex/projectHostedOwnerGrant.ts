// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { readHostedRecord } from './projectHostedRecords';
import type { HostedLandingAttempt } from '../src/hosted-landing';
import type { LandingRow } from './projectHostedLandingStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { AcceptanceActor } from '../src/autonomy-policy';
import { invariant } from '../src/errors';

/** Approval stays bound to the selected Candidate and can carry only after its exact file
 * changes have been verified against the new composition. */
type OwnerGrant = NonNullable<Doc<'projectHostedLandingRequests'>['ownerGrant']>;

export async function ownerReviewFiles(
  ctx: QueryCtx | MutationCtx,
  landing: LandingRow,
  candidateId: string,
) {
  const grant = landing.ownerGrant;
  if (!grant) return null;
  const approved = await loadLandingAttempt(ctx, {
    projectId: landing.projectId,
    attemptId: grant.attemptId,
  });
  const read = (key: string) =>
    readHostedRecord(ctx, {
      projectId: landing.projectId,
      actor: landing.actor,
      kind: 'candidate',
      key,
    });
  const [before, after] = await Promise.all([read(approved.candidate.id), read(candidateId)]);
  if (before?.digest !== approved.candidate.digest || !before.candidateFiles || !after?.candidateFiles)
    return null;
  return { before: before.candidateFiles, after: after.candidateFiles, digest: after.digest };
}

export async function grantOwnerApproval(
  ctx: MutationCtx,
  row: Doc<'projectHostedLandingRequests'>,
  actor: AcceptanceActor,
  attempt: HostedLandingAttempt,
) {
  invariant(
    actor.kind === 'person',
    'PROJECT_UNAVAILABLE',
    'Owner approval requires explicit person acceptance.',
  );
  if (row.ownerGrant?.attemptId === attempt.id && row.ownerGrant.actor === actor.id) return;
  const grant: OwnerGrant = {
    actor: actor.id,
    attemptId: attempt.id,
    inputs: canonicalPayload(attempt.candidate.inputs),
    dependencies: canonicalPayload(attempt.candidate.dependencies),
    policyDigest: attempt.policyDigest,
    paths: null, // Retained field in pre-existing grant rows.
    ...(JSON.parse(row.value).observation.pendingReason === 'waiting-for-review'
      ? { held: true as const }
      : {}),
    candidateDigest: attempt.candidate.digest,
    at: Date.now(),
    ...(attempt.candidate.head ? { head: attempt.candidate.head } : {}),
  };
  await ctx.db.patch(row._id, { ownerGrant: grant });
}
/** The owner person a retained grant names for this exact attempt, or undefined. */
export function grantedApproval(
  grant: OwnerGrant | undefined,
  attempt: HostedLandingAttempt,
  owner: string,
): AcceptanceActor | undefined {
  if (
    !grant ||
    grant.actor !== owner ||
    grant.inputs !== canonicalPayload(attempt.candidate.inputs) ||
    grant.dependencies !== canonicalPayload(attempt.candidate.dependencies) ||
    grant.policyDigest !== attempt.policyDigest
  )
    return undefined;
  if (
    grant.attemptId !== attempt.id &&
    (!attempt.check ||
      (grant.candidateDigest !== attempt.candidate.digest &&
        grant.verifiedDigest !== attempt.candidate.digest))
  )
    return undefined;
  return { kind: 'person', id: grant.actor };
}

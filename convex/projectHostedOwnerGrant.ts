// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { readHostedRecord } from './projectHostedRecords';
import type { HostedLandingAttempt } from '../src/hosted-landing';
import type { LandingRow } from './projectHostedLandingStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { hostedRecordSchema } from '../src/hosted-records';
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
  return reviewedCandidateFiles(ctx, {
    projectId: landing.projectId,
    approved: { attemptId: grant.attemptId, actor: landing.actor },
    actor: landing.actor,
    candidateId,
  });
}

/** The approved attempt's and the current Candidate's pinned changed-file listings and changed paths
 * (null when a record is gone or changed). Each record is read as its own submitter. Item fe2b0a86
 * part B: the approved attempt may belong to an earlier submission of the same Intent. */
export async function reviewedCandidateFiles(
  ctx: QueryCtx | MutationCtx,
  input: {
    projectId: LandingRow['projectId'];
    approved: { attemptId: string; actor: string };
    actor: string;
    candidateId: string;
  },
) {
  const approved = await loadLandingAttempt(ctx, {
    projectId: input.projectId,
    attemptId: input.approved.attemptId,
  });
  const read = (actor: string, key: string) =>
    readHostedRecord(ctx, { projectId: input.projectId, actor, kind: 'candidate', key });
  const [before, after] = await Promise.all([
    read(input.approved.actor, approved.candidate.id),
    read(input.actor, input.candidateId),
  ]);
  if (before?.digest !== approved.candidate.digest || !before.candidateFiles || !after?.candidateFiles)
    return null;
  // Item fe2b0a86: each Candidate's changed paths, from the records already read (null when unknown).
  const paths = (value: string) => {
    try {
      const record = hostedRecordSchema.safeParse(JSON.parse(value));
      return record.success && record.data.kind === 'candidate'
        ? (record.data.governance?.paths ?? null)
        : null;
    } catch {
      return null;
    }
  };
  return {
    before: before.candidateFiles,
    after: after.candidateFiles,
    digest: after.digest,
    paths: [paths(before.value), paths(after.value)],
  };
}

export async function grantOwnerApproval(
  ctx: MutationCtx,
  row: Doc<'projectHostedLandingRequests'>,
  actor: AcceptanceActor,
  attempt: HostedLandingAttempt,
  reason?: string,
) {
  invariant(
    actor.kind === 'person',
    'PROJECT_UNAVAILABLE',
    'Owner approval requires explicit person acceptance.',
  );
  if (row.ownerGrant?.attemptId === attempt.id && row.ownerGrant.actor === actor.id)
    return row.ownerGrant.reason;
  const why = reason?.trim().slice(0, 500) || undefined;
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
    ...(why ? { reason: why } : {}),
    ...(attempt.candidate.head ? { head: attempt.candidate.head } : {}),
  };
  await ctx.db.patch(row._id, { ownerGrant: grant });
  return why;
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

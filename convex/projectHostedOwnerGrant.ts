// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { readHostedRecord } from './projectHostedRecords';
import type { HostedLandingAttempt } from '../src/hosted-landing';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { AcceptanceActor } from '../src/autonomy-policy';
import { invariant } from '../src/errors';

/** Issue fe5bea80: the owner's explicit approval of one exact held attempt, kept on its landing row
 * (server-only; never on the client-visible state). A fresh attempt of the same submission, made
 * because main moved, lands with it only when its inputs, dependencies and policy are byte-identical,
 * its own check ran, and it changes no path the approved Candidate did not. */
export type OwnerGrant = NonNullable<Doc<'projectHostedLandingRequests'>['ownerGrant']>;

async function approvedPaths(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  attempt: HostedLandingAttempt,
) {
  const row = await readHostedRecord(ctx, {
    projectId,
    actor: attempt.actor.id,
    kind: 'candidate',
    key: attempt.candidate.id,
  });
  if (!row) return null;
  const candidate = hostedRecordSchema.parse(JSON.parse(row.value));
  return candidate.kind === 'candidate' ? (candidate.governance?.paths ?? null) : null;
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
    paths: await approvedPaths(ctx, row.projectId, attempt),
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
  paths: string[] | null,
): AcceptanceActor | undefined {
  if (
    !grant ||
    grant.actor !== owner ||
    grant.inputs !== canonicalPayload(attempt.candidate.inputs) ||
    grant.dependencies !== canonicalPayload(attempt.candidate.dependencies) ||
    grant.policyDigest !== attempt.policyDigest
  )
    return undefined;
  if (grant.attemptId !== attempt.id) {
    if (!attempt.check || paths === null || grant.paths === null) return undefined;
    const approved = new Set(grant.paths);
    if (!paths.every(path => approved.has(path))) return undefined;
  }
  return { kind: 'person', id: grant.actor };
}

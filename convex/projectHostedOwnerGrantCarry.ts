// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item fe2b0a86 part B: the owner's approval of one submission's protected paths stands for a later
// held submission of the same Intent (a resubmission after a failed check, or a resolution Lane's)
// when its protected entries, before and after content included, are the same. Only that reason is
// lifted: the submitter stays the acceptor, so supervised review, folder grants and every other check
// still apply to the rest.
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { LandingRow } from './projectHostedLandingStore';
import type { HostedLandingAttempt } from '../src/hosted-landing';
import { effectivePolicy, type AutonomyPolicy } from '../src/autonomy-policy';
import { carryScope, protectedPaths } from '../src/protected-review';
import { reviewedCandidateFiles } from './projectHostedOwnerGrant';

export type ProtectedCarry = NonNullable<LandingRow['protectedCarry']>;
/** Recent held submissions of one Intent read for an approval (newest first; bounded). */
const PRIOR_HELD = 4;

/** The approval a held row offers later submissions: its own grant, or one it verifiably carried. Null
 * ends the search: a landed row (its protected change is on main) or one the owner declined. */
function approvalSource(
  row: LandingRow,
): Omit<ProtectedCarry, 'verified' | 'refused' | 'paths' | 'settled'> | null | undefined {
  if (row.phase === 'landed') return null;
  if ((JSON.parse(row.value) as { error?: { code?: string } | null }).error?.code === 'REVIEW_DECLINED')
    return null;
  if (row.ownerGrant)
    return {
      submissionId: row.submissionId,
      attemptId: row.ownerGrant.attemptId,
      requester: row.actor,
      actor: row.ownerGrant.actor,
      policyDigest: row.ownerGrant.policyDigest,
      at: row.ownerGrant.at,
    };
  if (!row.protectedCarry?.verified) return undefined;
  const { verified, refused, paths, settled, ...source } = row.protectedCarry;
  void verified;
  void refused;
  void paths;
  void settled;
  return source;
}

/** One indexed read, held submissions only: the newest owner approval among the Intent's recent held
 * submissions, when the same owner gave it under the same policy. */
export async function priorProtectedApproval(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    intentId: string;
    owner: string;
    policyDigest: string;
    /** The asking row itself, when it already exists (the comparison's re-check). */
    self?: Id<'projectHostedLandingRequests'>;
  },
): Promise<ProtectedCarry | undefined> {
  const rows = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_intent_and_held_intent', q =>
      q.eq('projectId', input.projectId).eq('intentId', undefined).eq('heldIntent', input.intentId),
    )
    .order('desc')
    .take(PRIOR_HELD + (input.self ? 1 : 0));
  for (const row of rows) {
    if (row._id === input.self) continue;
    const source = approvalSource(row);
    if (source === null) return undefined;
    if (source)
      return source.actor === input.owner && source.policyDigest === input.policyDigest ? source : undefined;
  }
  return undefined;
}

/** The listing pair a held attempt compares with its earlier approval, or undefined after recording
 * a refusal for this Candidate: another owner or policy, no exact check, an approval no longer the
 * Intent's newest (a decline or landing since ends it), a gone or changed record or attempt, a
 * submitter without access, unknown changed paths or check entries, or no protected path. Each
 * Candidate is compared once. */
export async function protectedCarryReview(
  ctx: MutationCtx,
  landing: LandingRow,
  attempt: HostedLandingAttempt,
  project: { owner: string; checkEntries?: string[]; autonomyPolicy?: AutonomyPolicy },
) {
  const carry = landing.protectedCarry;
  const digest = attempt.candidate.digest;
  if (!carry || carry.verified === digest || carry.refused === digest) return undefined;
  const current =
    carry.actor === project.owner &&
    carry.policyDigest === attempt.policyDigest &&
    attempt.check &&
    landing.heldIntent
      ? await priorProtectedApproval(ctx, {
          projectId: landing.projectId,
          intentId: landing.heldIntent,
          owner: project.owner,
          policyDigest: attempt.policyDigest,
          self: landing._id,
        })
      : undefined;
  let files: Awaited<ReturnType<typeof reviewedCandidateFiles>> = null;
  if (current?.submissionId === carry.submissionId && current.attemptId === carry.attemptId)
    try {
      files = await reviewedCandidateFiles(ctx, {
        projectId: landing.projectId,
        approved: { attemptId: carry.attemptId, actor: carry.requester },
        actor: landing.actor,
        candidateId: attempt.candidate.id,
      });
    } catch {
      files = null; // A gone attempt or a requester without access: unprovable, ask the owner.
    }
  const protect =
    files?.digest === digest
      ? carryScope(effectivePolicy(project), files.paths, project.checkEntries)
      : undefined;
  if (!files || !protect) {
    await settleProtectedCarry(ctx, landing, attempt.id, digest, undefined);
    return undefined;
  }
  // The exact protected paths compared; publication lifts only these (never a recomputed set).
  return {
    before: files.before,
    after: files.after,
    protect,
    paths: protectedPaths(protect, files.paths[1]!),
  };
}

/** Record the comparison for one attempt's Candidate digest: the verified protected paths, or a
 * refusal. `settled` lets later finish steps of the same attempt skip the attempt read. */
export async function settleProtectedCarry(
  ctx: MutationCtx,
  landing: LandingRow,
  attemptId: string,
  digest: string,
  paths: string[] | undefined,
) {
  const carry = landing.protectedCarry;
  if (!carry) return;
  const { verified, refused, paths: earlier, settled, ...source } = carry;
  void verified;
  void refused;
  void earlier;
  void settled;
  await ctx.db.patch(landing._id, {
    protectedCarry: {
      ...source,
      settled: attemptId,
      ...(paths ? { verified: digest, paths } : { refused: digest }),
    },
  });
}

/** The protected paths an earlier approval stands for on this exact attempt, or undefined: exactly
 * the set the comparison verified for this Candidate, under the same owner and policy, on an attempt
 * with its own exact check. */
export function carriedProtectedPaths(
  carry: ProtectedCarry | undefined,
  attempt: HostedLandingAttempt,
  owner: string,
): string[] | undefined {
  if (
    !carry?.paths ||
    !attempt.check ||
    carry.verified !== attempt.candidate.digest ||
    carry.actor !== owner ||
    carry.policyDigest !== attempt.policyDigest
  )
    return undefined;
  return carry.paths;
}

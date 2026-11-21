// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import type { AutonomyPolicy } from '../src/autonomy-policy';
import { hostedLandingAttemptSchema, type HostedLandingAttempt } from '../src/hosted-landing';
import { hostedRecordSchema } from '../src/hosted-records';
import { landingPolicyImpact, landingPolicyMayChange } from '../src/policy-digest';
import { ForgeError } from '../src/errors';
import { landingAttemptRow } from './projectHostedLandingAttemptRead';
import { hostedRecordBody, recordHead } from './projectHostedRecords';

/** The policy caller already authorized the project. Read only the exact Candidate pin. */
async function candidatePaths(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  attempt: HostedLandingAttempt,
) {
  const pin = attempt.memberCandidate ?? attempt.candidate;
  const head = await recordHead(ctx, projectId, 'candidate', pin.id);
  const row = head && (await ctx.db.get(head.recordId));
  if (!row || row.digest !== pin.digest) return null;
  try {
    const candidate = hostedRecordSchema.options[3].parse(JSON.parse(await hostedRecordBody(ctx, row)));
    return candidate.governance?.paths ?? null;
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'SOURCE_UNAVAILABLE') return null;
    throw error;
  }
}

const MiB = 1024 * 1024;
async function impactPageSize(ctx: MutationCtx) {
  const left = await ctx.meta?.getTransactionMetrics?.();
  if (!left) return 2;
  // At most five 1 MiB documents per submission. Leave room for the enclosing policy write.
  return Math.min(
    2,
    Math.floor((left.bytesRead.remaining - 3 * MiB) / (5 * MiB)),
    Math.floor((left.databaseQueries.remaining - 64) / 6),
  );
}

/** Newly stale, currently pinned submissions. Read indexed in-flight pages on a policy edit only.
 * Review holds keep their original attempt until a person decides. No queue rows are changed. */
export async function policyImpactReceipt(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  previous: AutonomyPolicy,
  policy: AutonomyPolicy,
) {
  const invalidated: { id: string; sequence: number }[] = [];
  if (landingPolicyMayChange(previous, policy))
    for (const phase of ['queued', 'checking', 'ready'] as const) {
      let sequence = -1;
      for (;;) {
        const size = await impactPageSize(ctx);
        if (size < 1) return { impactComplete: false as const };
        const page = await ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
            q.eq('projectId', projectId).eq('channel', 'main').eq('phase', phase).gt('sequence', sequence),
          )
          .take(size);
        const assessed = await Promise.all(
          page.map(async row => {
            if (JSON.parse(row.value).observation.pendingReason === 'waiting-for-review') return true;
            const stored = await landingAttemptRow(ctx, { projectId, attemptId: row.attemptId });
            if (!stored || stored.submissionId !== row.submissionId) return false;
            const attempt = hostedLandingAttemptSchema.parse(JSON.parse(stored.value));
            const exact = row.ownerGrant?.policyDigest === attempt.policyDigest;
            const before = landingPolicyImpact(previous, attempt, exact);
            const after = landingPolicyImpact(policy, attempt, exact);
            if (before === 'all' || after === 'none') return true;
            const paths =
              typeof before === 'function' || typeof after === 'function'
                ? await candidatePaths(ctx, projectId, attempt)
                : null;
            if ((before === 'none' || !before(paths)) && (after === 'all' || after(paths)))
              invalidated.push({ id: row.submissionId, sequence: row.sequence });
            return true;
          }),
        );
        if (assessed.includes(false)) return { impactComplete: false as const };
        if (page.length < size) break;
        sequence = page.at(-1)!.sequence;
      }
    }
  return {
    invalidatedLandings: invalidated.length,
    invalidatedSubmissionIds: invalidated.sort((a, b) => a.sequence - b.sequence).map(row => row.id),
  };
}

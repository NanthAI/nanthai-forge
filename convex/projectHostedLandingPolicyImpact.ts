// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import type { AutonomyPolicy } from '../src/autonomy-policy';
import { hostedLandingAttemptSchema } from '../src/hosted-landing';
import { hostedRecordSchema } from '../src/hosted-records';
import type { QueueStatusKey } from '../src/hosted-queue-status';
import { landingPolicyImpact, landingPolicyMayChange } from '../src/policy-digest';
import { digest } from '../src/state/hash';
import { landingAttemptRow } from './projectHostedLandingAttemptRead';
import { landingQueue } from './projectHostedLandingEvents';
import { recordHead } from './projectHostedRecords';

const phases = ['ready', 'checking', 'queued'] as const;
const MiB = 1024 * 1024;
const pageSize = 8;
type Request = Doc<'projectHostedLandingRequests'>;
type Match = Pick<Request, 'submissionId' | 'sequence'>;

/** Respect the platform's 1 MiB document ceiling when a row's size is still unknown.
 * Then re-use actual headroom for the next stage. Keep room for the compact
 * directory if the scan stops, and leave 3 MiB and 64 reads for the policy write. */
async function readBudget(ctx: MutationCtx, bytes = MiB, directory = false) {
  const left = await ctx.meta.getTransactionMetrics();
  return Math.max(
    0,
    Math.min(
      pageSize,
      Math.floor((left.bytesRead.remaining - (directory ? 3 : 4) * MiB) / bytes),
      left.databaseQueries.remaining - (directory ? 64 : 80),
      left.documentsRead.remaining - (directory ? 64 : 80),
    ),
  );
}

async function readStage<T, R>(ctx: MutationCtx, items: readonly T[], read: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let start = 0; start < items.length;) {
    const size = await readBudget(ctx);
    if (!size) break;
    results.push(...(await Promise.all(items.slice(start, start + size).map(read))));
    start += size;
  }
  return results;
}

function decode(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The policy caller already authorized the project. Read only the live body of
 * the exact Candidate pin, with its size from the immutable header. A relocated
 * or damaged body leaves the submission unexamined. */
async function candidatePaths(ctx: MutationCtx, row: Doc<'projectHostedRecords'>) {
  if (row.purged !== undefined || !(row.bytes > 0 && row.bytes <= MiB)) return undefined;
  // The header's UTF-8 size covers value; 1 KiB covers the live body's envelope.
  if (row.inline === undefined && !(await readBudget(ctx, Math.min(MiB, row.bytes + 1024)))) return undefined;
  const body = row.inline === undefined ? await ctx.db.get(row.bodyId) : null;
  const value = row.inline ?? (body?.projectId === row.projectId ? body.value : undefined);
  if (
    value === undefined ||
    new TextEncoder().encode(value).length !== row.bytes ||
    digest(value) !== row.digest
  )
    return undefined;
  const candidate = hostedRecordSchema.options[3].safeParse(decode(value));
  if (candidate.success && candidate.data.id === row.key) return candidate.data.governance?.paths ?? null;
  return undefined;
}

/** Read the compact directory only if even the request rows do not fit. The
 * directory covers pending ready, checking and queued rows, including holds. */
async function remainingLandings(ctx: MutationCtx, projectId: Id<'hostedProjects'>, seen: number) {
  const queue = await landingQueue(ctx, { projectId, channel: 'main' });
  const status = queue?.status;
  if (!status) {
    // Legacy queues have issued one sequence per admission. Their high-water
    // mark is a conservative bound when the request rows alone fill the scan.
    return Math.max(0, (queue?.sequence ?? 0) - seen);
  }
  return Math.max(0, status.total + (status.held ?? 0) - seen);
}

/** Read review holds from the directory if a partial scan could not reach them. */
async function reviewHolds(ctx: MutationCtx, projectId: Id<'hostedProjects'>, known: number) {
  let count = 0;
  let cursor = -1;
  for (;;) {
    const size = await readBudget(ctx, MiB, true);
    if (!size) return known;
    const page = await ctx.db
      .query('projectHostedLandingQueueStatus')
      .withIndex('by_project_and_page', q => q.eq('projectId', projectId).gt('page', cursor))
      .take(size);
    for (const row of page) {
      const keys = decode(row.value) as QueueStatusKey[] | undefined;
      if (!keys) return known;
      count += keys.filter(key => key.held === 'review').length;
    }
    if (page.length < size) return Math.max(known, count);
    cursor = page.at(-1)!.page;
  }
}

/** Newly stale pins, judged in the same transaction as the policy write.
 * Review holds keep their original attempt until a person decides. */
export async function policyImpactReceipt(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  previous: AutonomyPolicy,
  policy: AutonomyPolicy,
) {
  const matches: Match[] = [];
  const classes = new Map<
    string,
    [ReturnType<typeof landingPolicyImpact>, ReturnType<typeof landingPolicyImpact>]
  >();
  const invalidatedByPhase = { ready: 0, checking: 0, queued: 0 };
  let heldForReview = 0;
  let impactUnexamined = 0;
  let seen = 0;
  if (landingPolicyMayChange(previous, policy))
    scan: for (const phase of phases) {
      let sequence = -1;
      for (;;) {
        const size = await readBudget(ctx);
        if (!size) {
          const remaining = await remainingLandings(ctx, projectId, seen);
          const held = remaining ? await reviewHolds(ctx, projectId, heldForReview) : heldForReview;
          impactUnexamined += Math.max(0, remaining - (held - heldForReview));
          heldForReview = held;
          break scan;
        }
        const page = await ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
            q.eq('projectId', projectId).eq('channel', 'main').eq('phase', phase).gt('sequence', sequence),
          )
          .take(size);
        seen += page.length;
        const pending = page.filter(row => {
          if (decode(row.value)?.observation?.pendingReason !== 'waiting-for-review') return true;
          heldForReview++;
          return false;
        });
        const attempts = await readStage(ctx, pending, async row => {
          const stored = await landingAttemptRow(ctx, { projectId, attemptId: row.attemptId });
          if (!stored || stored.submissionId !== row.submissionId) return;
          const parsed = hostedLandingAttemptSchema.safeParse(decode(stored.value));
          if (!parsed.success) return;
          const attempt = parsed.data;
          if (
            attempt.projectId === projectId &&
            attempt.id === row.attemptId &&
            attempt.submissionId === row.submissionId &&
            attempt.number === stored.number
          )
            return attempt;
        });
        const needsPaths = [];
        const mark = (row: Request) => {
          matches.push({ submissionId: row.submissionId, sequence: row.sequence });
          invalidatedByPhase[phase]++;
        };
        for (const [i, row] of pending.entries()) {
          const attempt = attempts[i];
          if (!attempt) {
            impactUnexamined++;
            continue;
          }
          const exact = row.ownerGrant?.policyDigest === attempt.policyDigest;
          const key = `${attempt.policyDigest}:${exact}`;
          let impacts = classes.get(key);
          if (!impacts) {
            impacts = [
              landingPolicyImpact(previous, attempt, exact),
              landingPolicyImpact(policy, attempt, exact),
            ];
            classes.set(key, impacts);
          }
          const [before, after] = impacts;
          if (before === 'all' || after === 'none') continue;
          // Current or already-stale pins hit the scalar cases on gate edits.
          // Older pins still valid after a path edit need their original paths.
          if (before === 'none' && after === 'all') mark(row);
          else needsPaths.push({ row, pin: attempt.memberCandidate ?? attempt.candidate, before, after });
        }
        const heads = await readStage(ctx, needsPaths, ({ pin }) =>
          recordHead(ctx, projectId, 'candidate', pin.id),
        );
        const records = await readStage(ctx, heads, head =>
          head ? ctx.db.get(head.recordId) : Promise.resolve(null),
        );
        for (const [i, { row, pin, before, after }] of needsPaths.entries()) {
          const record = records[i];
          const paths =
            record?.projectId === projectId &&
            record.kind === 'candidate' &&
            record.key === pin.id &&
            record.digest === pin.digest
              ? await candidatePaths(ctx, record)
              : undefined;
          if (paths === undefined) impactUnexamined++;
          else if ((before === 'none' || !before(paths)) && (after === 'all' || after(paths))) mark(row);
        }
        if (page.length < size) break;
        sequence = page.at(-1)!.sequence;
      }
    }
  return {
    invalidatedLandings: matches.length,
    invalidatedSubmissionIds: matches
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, 1000)
      .map(row => row.submissionId),
    invalidatedByPhase,
    heldForReview,
    ...(impactUnexamined ? { impactComplete: false as const, impactUnexamined } : {}),
    ...(matches.length > 1000 ? { idsTruncated: true as const } : {}),
  };
}

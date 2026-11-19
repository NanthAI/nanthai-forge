// SPDX-License-Identifier: Apache-2.0
// Fix D of Item 687d1eda: park, don't fail. A landing whose admission check fails only on the tests
// main itself fails is not at fault. It waits under the existing main-red hold and joins the queue
// again when main passes (releaseMainHolds), where its ordinary check runs on green main.
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedCheckRun } from '../src/hosted-check';
import type { HostedLandingAttempt, HostedLandingState } from '../src/hosted-landing';
import { hostedRecordSchema } from '../src/hosted-records';
import { memberExplainsFailure } from '../src/hosted-landing-suspect';
import { ForgeError } from '../src/errors';
import { isStandardForgeCheck } from '../src/standard-check';
import type { SemanticPlan } from '../src/intent-semantic-conflict';
import { readHostedRecord } from './projectHostedRecords';
import { auditRow, redTests } from './projectHostedMainAuditState';
import { finishRow } from './projectHostedFinishWake';
import { cancelPendingTask } from './schedulerCancel';
import { writeLanding, type LandingRow } from './projectHostedLandingStore';
export { parkOnMainRed } from './projectHostedMainAuditState';

/** A finished run whose only failure is one test job: every job reported, none cancelled or
 * interrupted, nothing left in the shard pool, and exactly one job failed. Only Forge's standard
 * check guarantees its static checks run in a job of their own, with no test (a project command
 * may run build or lint next to tests, and a static job may also run contract tests), so a
 * static failure always makes a second failed job and never parks. Free: run fields only (the
 * check wake reads no shard rows). A crash of this Lane's own test in the same job as a red test
 * is not separable here; the re-check on green catches it, so nothing lands unchecked. */
const onlyTestsFailed = (run: HostedCheckRun) =>
  isStandardForgeCheck(run.check) &&
  run.status === 'failed' &&
  !run.poolPending?.length &&
  Boolean(run.plan && run.plan.shardCount >= 2) &&
  run.counts.completed === run.plan!.shardCount &&
  run.counts.passed + run.counts.failed === run.plan!.shardCount &&
  run.counts.failed === 1;

/** The first error a failing file reported: on the run (inline) or in its compact file summary
 * (R2-backed runs keep no contractReports on the run row). */
const firstError = (run: HostedCheckRun, file: string) =>
  run.contractReports?.[file]?.firstError ??
  run.testFiles?.failed.find(item => item.file === file)?.report?.firstError;

/** The failing files, when every one is a file main's red audit fails too, the run failed on test
 * files alone, and none is explained by this landing's own paths or contract tests; otherwise null.
 * Red path only (a failed admission check while the switch is on): one audit-row read, then one
 * Candidate read when the files match. Both lists must be complete: a clipped list (moreTests) never
 * parks, since an unlisted file could be this Lane's. Anything it cannot read or verify fails
 * closed: the landing fails as it would with the switch off. */
export async function redOnlyFailure(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  attempt: HostedLandingAttempt,
  run: HostedCheckRun,
) {
  const own = redTests(run);
  if (!own.tests.length || own.moreTests || !onlyTestsFailed(run)) return null;
  const red = (await auditRow(ctx, projectId))?.red;
  if (!red?.tests?.length || red.moreTests || !own.tests.every(file => red.tests!.includes(file)))
    return null;
  let record;
  try {
    record = await readHostedRecord(ctx, {
      projectId,
      actor: attempt.actor.id,
      kind: 'candidate',
      key: attempt.candidate.id,
    });
  } catch (error) {
    // A submitter who lost access: no verdict here, the ordinary failure settles it.
    if (error instanceof ForgeError) return null;
    throw error;
  }
  if (!record || record.digest !== attempt.candidate.digest) return null;
  const candidate = hostedRecordSchema.options[3].parse(JSON.parse(record.value));
  const paths = candidate.governance?.paths;
  // Unknown paths cannot clear this landing of its own failure.
  if (!paths) return null;
  const member = { paths, tests: declaredTests(candidate.intentId, run, attempt, candidate) };
  if (own.tests.some(file => memberExplainsFailure(member, file, firstError(run, file)))) return null;
  return own.tests;
}

/** This Intent's own contract tests, from every copy already in hand (0 reads). A first Lane
 * submission's Candidate plan holds only main's accepted peers: its own tests join the run at
 * enqueue (`gate.tests`, `semanticPlan`). */
function declaredTests(
  intentId: string,
  run: HostedCheckRun,
  attempt: HostedLandingAttempt,
  candidate: { semanticPlan?: SemanticPlan },
) {
  const tests = new Set(run.gate?.tests ?? []);
  for (const plan of [run.semanticPlan, attempt.semanticPlan, candidate.semanticPlan])
    for (const member of plan?.members ?? [])
      if (member.intentId === intentId) for (const test of member.tests) tests.add(test.path);
  return [...tests];
}

export const parkedMessage = (files: readonly string[]) =>
  `Not this change: its check failed only on tests main fails too (${files.slice(0, 3).join(', ')}${
    files.length > 3 ? ` +${files.length - 3} more` : ''
  }). It waits and joins the queue again when main passes; no action needed.`;

/** Parks a settled admission in one landing write (one observation at `next.version`). Like a
 * publication hold it is an event wait: its finish wake stops and releaseMainHolds resumes it. */
export async function parkLanding(ctx: MutationCtx, row: LandingRow, next: HostedLandingState) {
  const finish = await finishRow(ctx, { projectId: row.projectId, submissionId: row.submissionId });
  if (finish?.wake) {
    await cancelPendingTask(ctx, finish.wake.taskId);
    await ctx.db.patch(finish._id, { wake: null });
  }
  await writeLanding(ctx, row, next, false, true, undefined, 'main-red');
}

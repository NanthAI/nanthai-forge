// SPDX-License-Identifier: Apache-2.0
// Item 687d1eda, "main red is not the Lane's failure" past the admission check (fix D parks only
// admission runs). Switch FORGE_QUEUE_PARK_EXACT_ON_MAIN_RED, off by default (queue-regression
// guard). A queue check that fails only on the tests main itself fails is not the change's failure:
// a cohort's shared run no longer splits into solo re-checks on red main (each one a full run that
// fails the same way, then fails the landing for good), and one entry's own exact check no longer
// ends its landing. Each pending entry parks under the main-red hold with a fresh deferred attempt
// for its own Candidate; releaseMainHolds puts it back in the queue on green, where it composes
// onto the repaired main and checks again. Nothing lands unchecked.
import type { MutationCtx } from './_generated/server';
import type { HostedCheckRun } from '../src/hosted-check';
import {
  landingObservation,
  type HostedLandingAttempt,
  type HostedLandingState,
} from '../src/hosted-landing';
import {
  forkLandingAttempt,
  insertLandingAttempt,
  landingQueue,
  type LandingRow,
} from './projectHostedLandingStore';
import { deferredOrigin, loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { forkRaceReason } from '../src/fallback-reasons';
import type { Id } from './_generated/dataModel';
import { parkLanding, parkedMessage, redOnlyFailure } from './projectHostedLandingPark';
import {
  loadBatch,
  writeBatch,
  type BatchIdentity,
  type LandingBatch,
} from './projectHostedLandingBatchStore';
import { advanceBatchFallback } from './projectHostedLandingBatchFallback';
import { settleBatchConflicts } from './projectHostedLandingCohortConflicts';
import type { BatchFailure } from '../src/hosted-batch-diagnosis';

export { parkExactOnMainRed } from './projectHostedMainAuditState';

type Entry = { row: LandingRow; state: HostedLandingState };

/** Parks one pending entry with a fresh fork of `own`, its own deferred attempt (a cohort
 * member's original, whose Candidate is its own, not the shared one), as the stale-check re-queue
 * does: no check, a deferred one. Only an attempt that was already deferred is re-deferred, so a
 * parked entry gets nothing its submission was not already given (owner inputs, batch policy, no
 * recovery gate, no revert, a requested check). */
async function parkEntry(
  ctx: MutationCtx,
  entry: Entry,
  files: readonly string[],
  run: HostedCheckRun,
  own: HostedLandingAttempt,
) {
  const {
    crossHeadProof: _proof,
    check: _check,
    recheckReason: _reason,
    forkReason: _fork,
    scopedFallback: _scoped,
    recheck: _recheck,
    memberCandidate: _member,
    platformRetries: _retries,
    ...pins
  } = own;
  void [_proof, _check, _reason, _fork, _scoped, _recheck, _member, _retries];
  const attempt = {
    ...pins,
    // A cohort-installed attempt checks the shared tree; the entry's own Candidate is its member one.
    ...(own.memberCandidate ? { candidate: own.memberCandidate } : {}),
    ...(await forkLandingAttempt(ctx, entry.state)),
    check: null,
    deferredCheck: true as const,
    operations: { check: crypto.randomUUID(), accept: crypto.randomUUID() },
    // Back on its own original main, the parked row names main red (c3c69c57); the parent pin is cached.
    ...forkRaceReason(
      await loadLandingAttempt(ctx, { projectId: entry.row.projectId, attemptId: entry.state.attemptId }),
      pins,
      'main-red',
    ),
  };
  await insertLandingAttempt(ctx, attempt);
  // A red-only failure is no evidence against the entry: no stale diagnostic follows it into
  // its next cohort's repeat-offender check.
  const {
    batchId: _batch,
    batchSolo: _solo,
    batchOriginId: _origin,
    batchNeedsSoloCompose: _needs,
    batchDiagnostic: _diagnostic,
    ...state
  } = entry.state;
  void [_batch, _solo, _origin, _needs, _diagnostic];
  await parkLanding(ctx, entry.row, {
    ...state,
    attemptId: attempt.id,
    version: state.version + 1,
    phase: 'queued',
    ...(run.testFiles ? { testFiles: run.testFiles } : {}),
    observation: landingObservation('queued'),
    error: { code: 'MAIN_RED', message: parkedMessage(files) },
  });
}

/** Drops parked entries from the speculative train: nothing stacks on them while they wait. One
 * queue read and at most one patch, red path only. */
async function leaveTrain(ctx: MutationCtx, entries: readonly Entry[]) {
  const queue = await landingQueue(ctx, { projectId: entries[0]!.row.projectId, channel: 'main' });
  const ids = new Set(entries.map(entry => entry.state.id));
  if (queue?.train?.some(id => ids.has(id)))
    await ctx.db.patch(queue._id, { train: queue.train.filter(id => !ids.has(id)) });
}

/** A failed unstacked cohort whose shared run failed only on main's red tests, with no member
 * named by the diagnosis (paths, contract tests or repeat failures): the cohort ends and every
 * pending member parks. The caller has already shown `files` are red-only (failsOnlyMainRed). */
export async function parkFailedBatch(
  ctx: MutationCtx,
  key: BatchIdentity,
  batch: LandingBatch,
  failure: BatchFailure,
  run: HostedCheckRun,
  pending: readonly (Entry & { original: HostedLandingAttempt })[],
  files: readonly string[],
) {
  const transition = {
    code: 'MAIN_RED',
    message: `Shared run ${failure.runId} failed only on tests main fails too; its members wait and join the queue again when main passes.`,
  };
  await writeBatch(ctx, key, { ...batch, phase: 'failed', failure, transition });
  if (batch.included) await settleBatchConflicts(ctx, key, { ...batch, phase: 'failed' });
  for (const member of pending) await parkEntry(ctx, member, files, run, member.original);
  if (pending.length) await leaveTrain(ctx, pending);
}

/** One entry's own exact check failed only on main's red tests and on nothing its own paths or
 * contract tests explain: it parks instead of failing, and true. Only an entry whose check came
 * from a deferred attempt parks (its cohort original when it came from a cohort in any phase, or
 * the deferred parent of a solo cohort check, past its platform retries); any other exact check
 * fails as before. A fallback member leaves
 * the line, which moves on to its next member at once. Red path only: the batch row or parent
 * attempt chain (at most three reads), then the audit-row and Candidate reads of redOnlyFailure. */
export async function parkRedOnlyEntry(
  ctx: MutationCtx,
  claim: { projectId: Id<'hostedProjects'> },
  entry: Entry & { attempt: HostedLandingAttempt },
  run: HostedCheckRun,
) {
  const { request } = entry.state;
  // Free: the request fields that keep a submission from ever being deferred.
  if (!request.finish || request.finish.after || request.revertOf || request.check?.kind !== 'request')
    return false;
  const origin = entry.state.batchOriginId;
  let line: { key: BatchIdentity; batch: LandingBatch } | undefined;
  let own: HostedLandingAttempt | undefined;
  if (origin) {
    const key = { projectId: claim.projectId, batchId: origin };
    const { batch } = await loadBatch(ctx, key);
    // The cohort's member entry is the deferred original whatever the cohort's phase: a split's
    // lone single, a member released from a landed cohort or re-composed after a conflict.
    if (batch.phase === 'fallback') line = { key, batch };
    own = batch.members.find(member => member.submissionId === entry.state.id);
  } else {
    own = (await deferredOrigin(ctx, claim.projectId, entry.attempt)) ?? undefined;
  }
  if (!own?.deferredCheck || own.check) return false;
  const files = await redOnlyFailure(ctx, claim.projectId, entry.attempt, run);
  if (!files) return false;
  await parkEntry(ctx, entry, files, run, own);
  await leaveTrain(ctx, [entry]);
  if (line) await advanceBatchFallback(ctx, line.key, line.batch);
  return true;
}

// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { changeLineMark, lineExit } from './projectLiveLineStore';
import { lineOwner, detachLineOwner, type LineBinding, type LineOwnerValue } from './projectLiveLineOwners';
import type { FlowStep } from '../src/flow-day';

type LineState = Pick<HostedLandingState, 'id' | 'projectId' | 'phase'> &
  Partial<
    Pick<HostedLandingState, 'observation' | 'error' | 'batchId' | 'timing' | 'counts' | 'at' | 'supersedes'>
  > & {
    held?: boolean;
    hold?: string | null;
  };
const pageKind = 'projectLiveLineSubmissionPage';
function selection(state: LineState) {
  const stage = (
    state.phase === 'checking'
      ? 'checking'
      : state.phase === 'ready'
        ? 'ready'
        : state.phase === 'queued' || state.phase === 'composing'
          ? 'queued'
          : 'saved'
  ) as 'checking' | 'ready' | 'queued' | 'saved';
  // A landing held for a person's approval or review: the only hold that waits on someone (Issue f5c4d136). The
  // parked holds (`main-red`, `ci-down`) and a failed end ask nobody.
  const person = state.observation?.pendingReason === 'waiting-for-review';
  // A landing withdrawn by its agent (or a person) waits on nobody: its Lane is back at Saved (Item 0cb9b064).
  const held =
    state.held === true ||
    person ||
    (state.phase === 'terminal-failed' && state.error?.code !== 'LANDING_CANCELLED') ||
    state.observation?.pendingReason === 'waiting-for-dependency';
  return {
    stage,
    held,
    // Held on the Lane's own next step: nobody is asked (a failed check, a conflict, a dependency, main red).
    fix: held && !person ? (true as const) : undefined,
    // Lanes checked together (one batch, or one submission of several Lanes) share a key while checked.
    check: stage === 'checking' ? (state.batchId ?? state.id)?.slice(0, 8) : undefined,
    // Parked by the gate while main is red (projectHostedGate.ts holdMainRed): held, but no person is asked.
    mainRed: state.hold === 'main-red' ? (true as const) : undefined,
  };
}
const seconds = (n: number | undefined) => (n && Number.isFinite(n) && n > 0 ? n : 0);
/** What one submission's write adds to the Flow view's day (src/flow-day.ts), or nothing. A landing or a failed end
 * counts only on its first arrival, so a replayed write of the same phase never counts twice. CI seconds count each
 * check at most once (review 85f456c1): a submission's latest check (`runnerSeconds`, a batch member's share) when it
 * lands or its check fails, and a check it discards on the way (a failed shared batch check, a cancelled run, a
 * recheck after main moved) when that write moves the seconds into its own `discardedRunnerSeconds`. A
 * resubmission's carried seconds arrive with its insert, which is no transition, so they never count again. Any
 * other failed end (superseded, cancelled, stalled, declined) counts no seconds: its check may have passed and its
 * resubmission may reuse it, which counts it then. A write that both binds a reused check and discards another sees
 * only the net change, so it can undercount, never overcount: CI minutes are a lower bound. Reverts and fixes on
 * top count once per red episode, when main turns green (projectLiveLineStore). */
function flowStep(before: LineState, state: LineState): FlowStep | null {
  const discarded =
    seconds(state.counts?.discardedRunnerSeconds) - seconds(before.counts?.discardedRunnerSeconds);
  const dropped = discarded > 0 ? { ciSeconds: discarded, lostSeconds: discarded } : null;
  if (before.phase === state.phase) return dropped;
  const lost = dropped?.lostSeconds ?? 0;
  if (state.phase === 'landed') {
    const runner = seconds(state.counts?.runnerSeconds);
    const submitted = Date.parse(state.timing?.submittedAt ?? state.at ?? '');
    return {
      ciSeconds: runner + lost,
      lostSeconds: lost,
      ...(Number.isFinite(submitted) ? { took: Math.max(0, (Date.now() - submitted) / 1000) } : {}),
    };
  }
  if (state.phase !== 'terminal-failed') return dropped;
  const fix = state.observation?.cause === 'check-failed' || state.error?.code === 'CHECK_FAILED' ? 1 : 0;
  const runner = fix ? seconds(state.counts?.runnerSeconds) : 0;
  // A failed end that counts nothing writes nothing.
  return fix || runner + lost ? { fix, ciSeconds: runner + lost, lostSeconds: runner + lost } : null;
}
/** The normal input-staging transaction already authenticated these exact pins. */
export async function bindLineInputs(
  ctx: MutationCtx,
  state: HostedLandingState,
  inputs: readonly { laneId: string; head?: string }[],
  position: number,
) {
  const projectId = state.projectId as Id<'hostedProjects'>;
  const bindings: Array<LineBinding & { head: string }> = [];
  for (const entry of inputs) {
    const mark = await ctx.db
      .query('projectLiveLineLanes')
      .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', entry.laneId))
      .unique();
    if (!mark) continue;
    const owner = await lineOwner(ctx.db, mark.laneId);
    const metadata: LineOwnerValue | null = owner ? JSON.parse(owner.value) : null;
    if (
      !owner ||
      !metadata ||
      !entry.head ||
      metadata.head !== entry.head ||
      (owner.submissionId === state.id && metadata.pageId)
    )
      continue;
    await detachLineOwner(ctx.db, owner);
    await changeLineMark(ctx.db, mark, selection(state));
    bindings.push({
      laneId: mark.laneId,
      markId: mark._id,
      ownerId: owner._id,
      head: metadata.head,
      ...(mark.retried ? { retried: true as const } : {}),
    });
  }
  if (bindings.length) {
    const pageId = await ctx.db.insert('projectFinishReadRows', {
      kind: pageKind,
      sourceId: `${state.id}:${position}`,
      projectId,
      submissionId: state.id,
      value: JSON.stringify(bindings.map(({ head: _head, ...entry }) => entry)),
    });
    for (const entry of bindings)
      await ctx.db.patch(entry.ownerId, {
        submissionId: state.id,
        value: JSON.stringify({ markId: entry.markId, head: entry.head, pageId }),
      });
  }
}
/** Bind the existing authenticated selection in pages of 100. Head changes detach
 * their binding, so transitions need no per-Lane ownership or source reads. */
export async function bindLineSubmission(
  ctx: MutationCtx,
  state: HostedLandingState,
  compose: { actor: string; operationId: string },
) {
  const projectId = state.projectId as Id<'hostedProjects'>;
  let cursor: string | null = null;
  let position = 0;
  do {
    const page = await ctx.db
      .query('projectHostedComposeSelections')
      .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
        q
          .eq('projectId', projectId)
          .eq('actor', compose.actor)
          .eq('operationId', compose.operationId)
          .eq('kind', 'inputs'),
      )
      .paginate({ cursor, numItems: 100 });
    await bindLineInputs(
      ctx,
      state,
      page.page.map(entry => ({ laneId: entry.key, ...(entry.head ? { head: entry.head } : {}) })),
      position,
    );
    position++;
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor);
}
/** Transition control reads O(pages), not one row per Lane. Mapping pages are
 * transactionally detached by saves/closes, so these exact ids can be patched
 * without a lookup. No heartbeat, holder, attempt or run identity participates. */
export async function transitionLineSubmission(
  ctx: Pick<MutationCtx, 'db'>,
  before: LineState,
  state: LineState,
) {
  const prior = selection(before),
    next = selection(state);
  // An end without landing marks its Lanes retried (Item 32e8de50), in the patch that end makes anyway; only an end
  // that moves nothing else (a withdrawal before any check, a decline while held) writes for it alone.
  const retried = state.phase === 'terminal-failed' && before.phase !== 'terminal-failed';
  const moved =
    retried ||
    prior.stage !== next.stage ||
    prior.held !== next.held ||
    prior.fix !== next.fix ||
    prior.check !== next.check ||
    prior.mainRed !== next.mainRed;
  const step = flowStep(before, state);
  const projectId = state.projectId as Id<'hostedProjects'>;
  if (before.phase === state.phase && !moved) {
    // A check discarded without a stage change: the step alone (one summary write per discarded check).
    if (step) await lineExit(ctx.db, projectId, null, step);
    return;
  }
  let cursor: string | null = null;
  let removed = 0;
  let last: string | undefined;
  let boundRetried = false;
  do {
    const page = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_project_and_submission', q =>
        q.eq('kind', pageKind).eq('projectId', projectId).eq('submissionId', state.id),
      )
      .paginate({ cursor, numItems: 1 });
    for (const row of page.page) {
      const bindings = JSON.parse(row.value) as LineBinding[];
      for (const entry of bindings) {
        if (state.phase === 'landed') {
          await ctx.db.delete(entry.markId);
          await ctx.db.delete(entry.ownerId);
          removed++;
          last = entry.laneId;
          if (entry.retried) boundRetried = true;
        } else if (moved) {
          await ctx.db.patch(entry.markId, {
            ...next,
            ...(prior.stage !== next.stage ? { changedAt: Date.now() } : {}),
            ...(retried ? { retried: true as const } : {}),
          });
        }
      }
      if (state.phase === 'landed') await ctx.db.delete(row._id);
    }
    // Terminal pages are deleted; consuming from the start also works for
    // offset-based test cursors. Other transitions retain the exact page cursor.
    if (page.isDone) break;
    cursor = state.phase === 'landed' ? null : page.continueCursor;
  } while (true);
  // First try (docs/concepts.md#first-try, the rule of src/stats-estimate.ts#firstTry, live and per Lane): none of the
  // landing's Lanes had a submission end without landing since they last landed, it replaced no earlier attempt, and
  // no check of it was thrown away. Judged on the landing's own write: no read is added.
  if (step && state.phase === 'landed' && before.phase !== 'landed')
    step.first =
      !boundRetried &&
      !state.supersedes &&
      !(seconds(state.counts?.discardedRunnerSeconds) > 0) &&
      !state.counts?.discardedRunnerUnknown;
  // One summary write: the exit a landing already writes, carrying duration, check time and first try.
  // Publication counts the receipts separately in its existing main snapshot write.
  if (removed || step)
    await lineExit(
      ctx.db,
      projectId,
      removed ? { laneId: last!, kind: 'landed', at: Date.now() } : null,
      step ?? undefined,
    );
}

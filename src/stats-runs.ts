// SPDX-License-Identifier: Apache-2.0
/** Stats method, every check run (Item a61d3c91, analyst comment 438310e0, review 1240fe03; docs/run-evidence.md#stats).
 * Forge's side counts every check run started on a day, not only the minutes attached to landings, and names why each
 * run that did not land was discarded. The GitHub side is priced from this project's own solo full checks. Pure: no
 * clock, no I/O. */
import { checkUnsuccessful } from './check-run-state.js';

/** One check run as its metrics row holds it (src/self-metrics-run.ts#metricRunRow). Times are epoch ms. */
export type StatsRun = {
  id: string;
  at: number;
  endedAt: number | null;
  status: string;
  runnerSeconds: number | null;
  /** The run ran the project's whole check command: false only for a scoped or contract gate that did not fall back
   * to full; null when the project sets no gate (its command is the whole check). */
  fullSuite: boolean | null;
  scopedRecheck: boolean;
  /** A main audit (gate mode audit): not a change's check, so left out of both sides. */
  audit: boolean;
};
/** One landing attempt: which run checked it and whether Forge recomposed it (a child attempt). */
export type StatsAttempt = {
  id: string;
  submissionId: string;
  parentAttemptId: string | null;
  runId: string | null;
  /** The attempt checked as a member of a batch. */
  member: boolean;
  /** Forge recomposed it because main moved and rechecked it (the attempt's recorded `recheckReason`), rather than
   * forking it to join a batch, to fall back from one, or to restart a stopped check on the same work. */
  mainRace: boolean;
};

export const DISCARD_CAUSES = ['mainMoved', 'failed', 'cancelled', 'superseded'] as const;
export type DiscardCause = (typeof DISCARD_CAUSES)[number];
export type RunTally = { runs: number; seconds: number; unknown: number };
export const runTally = (): RunTally => ({ runs: 0, seconds: 0, unknown: 0 });
const add = (t: RunTally, seconds: number | null) => {
  t.runs++;
  if (seconds === null) t.unknown++;
  else t.seconds += seconds;
};
/** A failed recheck after main moved, as a GitHub merge queue meets it: the change passed on its own, then failed on
 * top of the changes ahead of it. Its build is ejected from the queue (src/stats-runs.ts#mergeQueueReplay). */
export type QueueFailure = { at: number; seconds: number | null };

/** Where a run's tally goes, so a late correction (convex/projectCancelledRunDay.ts) adds to the same one. */
export type RunBucket = 'accepted' | 'pending' | 'unlinked' | DiscardCause;

/** Every run of a day, by what became of it:
 * - accepted: it checked an attempt that landed.
 * - mainMoved: main moved and Forge rechecked the same save (the attempt has a child attempt), whether the thrown
 *   away check had passed or was stopped for the recheck.
 * - failed: the check failed. cancelled: it ended any other way short of passing (stopped, or no runner).
 * - superseded: it passed, and its work was replaced or withdrawn before it landed.
 * - pending: still running, or passed and waiting to land when the day closed (counted, not yet discarded).
 * - unlinked: no landing attempt the close read names it (a check run by hand, or a pre-queue check its landing did not
 *   reuse), or its landing was past the close's lookup cap. Counted on Forge's side, never discarded.
 * Audits are kept apart. Solo full runs (one change, whole command, passed, minutes known) price the GitHub side. */
export function classifyRuns(input: {
  runs: readonly StatsRun[];
  attempts: readonly StatsAttempt[];
  landedAttemptIds: ReadonlySet<string>;
  pendingSubmissionIds: ReadonlySet<string>;
  /** Passed runs whose landing the close did not read (past its lookup cap): unlinked, never guessed. */
  unreadSubmissionIds?: ReadonlySet<string>;
  /** The close read fewer runs or attempts than the day held. */
  partial?: boolean;
}) {
  const byRun = new Map<string, StatsAttempt[]>();
  for (const a of input.attempts) if (a.runId) byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a]);
  const parents = new Set(input.attempts.flatMap(a => (a.parentAttemptId ? [a.parentAttemptId] : [])));
  const unread = input.unreadSubmissionIds ?? new Set<string>();
  const all = runTally(),
    accepted = runTally(),
    pending = runTally(),
    unlinked = runTally(),
    audits = runTally();
  const discarded = Object.fromEntries(DISCARD_CAUSES.map(c => [c, runTally()])) as Record<
    DiscardCause,
    RunTally
  >;
  /** Of the failed runs: rechecks after main moved, which fail inside a GitHub merge queue (ejected). The rest fail a
   * change's own check, which on GitHub is its pull-request run, before it ever joins the queue. */
  const failedInQueue = runTally();
  const queueFailures: QueueFailure[] = [];
  /** Each submission's first passed run of the day: on GitHub, its pull-request check passed and it joined the queue. */
  const passedAt = new Map<string, number>();
  for (const run of input.runs)
    if (!run.audit && run.status === 'passed')
      for (const a of byRun.get(run.id) ?? [])
        passedAt.set(a.submissionId, Math.min(run.at, passedAt.get(a.submissionId) ?? Infinity));
  const solo: { runnerSeconds: number[]; wallSeconds: number[] } = { runnerSeconds: [], wallSeconds: [] };
  /** Runs whose minutes are not known yet, by bucket: a late cancelled-run report adds to the same bucket. */
  const unknownRuns: Array<[string, RunBucket]> = [];
  const wall = (run: StatsRun) =>
    run.endedAt !== null && run.endedAt >= run.at ? Math.round((run.endedAt - run.at) / 1000) : null;
  for (const run of input.runs) {
    if (run.audit) {
      add(audits, run.runnerSeconds);
      continue;
    }
    add(all, run.runnerSeconds);
    const attempts = byRun.get(run.id) ?? [];
    const recomposed = attempts.some(a => parents.has(a.id));
    let bucket: RunBucket;
    if (!attempts.length) bucket = 'unlinked';
    else if (attempts.some(a => input.landedAttemptIds.has(a.id))) bucket = 'accepted';
    else if (run.status === 'failed') {
      bucket = 'failed';
      // A failed recheck after main moved of work that had passed: on GitHub it passed its pull-request check, joined
      // the queue and failed there. A child attempt alone is not enough: Forge forks one to join a batch, to fall
      // back from one, or to restart a stopped check, none of which had passed. Every change on the run must have
      // passed: a batch holding one that never passed fails that change's pull-request check on GitHub, and the
      // others merge (review d6b0f1aa finding 2). A pass on an earlier day is not read, so that recheck counts as a
      // pull-request failure (the GitHub side is not charged an ejection). A flaky failure ejects too, as on GitHub.
      if (attempts.every(a => a.mainRace && (passedAt.get(a.submissionId) ?? Infinity) < run.at)) {
        add(failedInQueue, run.runnerSeconds);
        queueFailures.push({ at: run.at, seconds: wall(run) });
      }
    } else if (checkUnsuccessful(run.status)) bucket = recomposed ? 'mainMoved' : 'cancelled';
    else if (run.status !== 'passed') bucket = 'pending';
    else if (recomposed) bucket = 'mainMoved';
    else if (attempts.some(a => input.pendingSubmissionIds.has(a.submissionId))) bucket = 'pending';
    else if (attempts.some(a => unread.has(a.submissionId))) bucket = 'unlinked';
    else bucket = 'superseded';
    const into =
      bucket === 'accepted'
        ? accepted
        : bucket === 'pending'
          ? pending
          : bucket === 'unlinked'
            ? unlinked
            : discarded[bucket];
    add(into, run.runnerSeconds);
    if (run.runnerSeconds === null && checkUnsuccessful(run.status) && run.status !== 'failed')
      unknownRuns.push([run.id, bucket]);
    // The whole command: an explicit full gate, a scoped gate that fell back to full, or a project with no gate.
    const soloRun =
      run.status === 'passed' &&
      run.fullSuite !== false &&
      !run.scopedRecheck &&
      run.runnerSeconds !== null &&
      attempts.length > 0 &&
      new Set(attempts.map(a => a.submissionId)).size === 1 &&
      attempts.every(a => !a.member);
    if (soloRun) {
      solo.runnerSeconds.push(Math.round(run.runnerSeconds!));
      const w = wall(run);
      if (w !== null) solo.wallSeconds.push(w);
    }
  }
  const sorted = (v: number[]) => [...v].sort((a, b) => a - b);
  return {
    all,
    accepted,
    pending,
    unlinked,
    audits,
    discarded,
    failedInQueue,
    solo: { runnerSeconds: sorted(solo.runnerSeconds), wallSeconds: sorted(solo.wallSeconds) },
    queueFailures: [...queueFailures].sort((a, b) => a.at - b.at),
    unknownRuns,
    partial: input.partial === true,
  };
}

/** One merge-queue entry. `at` is when it joins the queue; `from` is when its clock starts (default `at`): a change that
 * first runs its pull-request check joins the queue after that check. A failing entry's build takes `seconds` (its own
 * failed check), at most a full check. */
export type QueueEntry = { at: number; fails: boolean; from?: number; seconds?: number | null };

/** GitHub's merge queue over the same arrivals (oldest first), with "Build concurrency" `concurrency` and "Maximum
 * pull requests to merge" 1: up to `concurrency` entries build at once, each on top of the entries ahead of it, a
 * passing build taking `wallSeconds`. An entry merges when its build passed and every entry ahead merged. A failing
 * entry is ejected when its build ends, and the builds behind it restart.
 * - `tail`: merge times (epoch ms) of the previous day's last entries, at most `concurrency`: they hold the first
 *   slots until then, so a backlog carries across midnight slot by slot.
 * Returns each passing entry's seconds from `from` to merging, the builds run as full-build equivalents (a build
 * cut short by a restart, or a failing one, counts its share of a full check), and this day's tail. */
export function mergeQueueReplay(
  entries: readonly QueueEntry[],
  wallSeconds: number,
  concurrency: number,
  tail: readonly number[] = [],
) {
  const W = wallSeconds * 1000;
  const order = [...entries].sort((a, b) => a.at - b.at);
  if (!order.length || W <= 0) return { toMainSeconds: [] as number[], builds: 0, tail: [...tail] };
  type Entry = {
    at: number;
    from: number;
    fails: boolean;
    dur: number;
    start: number | null;
    end: number | null;
    carried: boolean;
  };
  const queue: Entry[] = [...tail]
    .sort((a, b) => a - b)
    .map(m => ({ at: m, from: m, fails: false, dur: 0, start: m, end: m, carried: true }));
  const toMain: number[] = [];
  const merged: number[] = [...tail].sort((a, b) => a - b);
  let next = 0,
    t = order[0]!.at,
    builds = 0;
  const startBuilds = () => {
    for (let k = 0; k < Math.min(concurrency, queue.length); k++)
      if (queue[k]!.end === null) {
        queue[k]!.start = t;
        queue[k]!.end = t + queue[k]!.dur;
      }
  };
  const done = (e: Entry) => {
    if (!e.carried) builds += (e.end! - e.start!) / W;
  };
  for (;;) {
    while (next < order.length && order[next]!.at <= t) {
      const e = order[next++]!;
      const own = e.fails && e.seconds !== null && e.seconds !== undefined ? e.seconds * 1000 : W;
      queue.push({
        at: e.at,
        from: e.from ?? e.at,
        fails: e.fails,
        dur: Math.min(own, W),
        start: null,
        end: null,
        carried: false,
      });
    }
    // Settle everything due at t: merges from the head, ejections anywhere in the building window. A build started
    // here may already be due (a failure that took no time), so builds start again before each pass.
    for (let changed = true; changed;) {
      changed = false;
      startBuilds();
      const head = queue[0];
      if (head && head.end !== null && head.end <= t && !head.fails) {
        // A build that finished behind a slower one merges with it, at t. A carried entry's merge is already in `tail`.
        if (!head.carried) {
          toMain.push((t - head.from) / 1000);
          merged.push(t);
        }
        done(head);
        queue.shift();
        changed = true;
        continue;
      }
      const k = queue.findIndex((e, i) => i < concurrency && e.fails && e.end !== null && e.end <= t);
      if (k >= 0) {
        done(queue[k]!);
        queue.splice(k, 1);
        // The builds behind it were built on top of it: each stops now, its time so far spent.
        for (let j = k; j < queue.length; j++) {
          const e = queue[j]!;
          if (e.end === null || e.carried) continue;
          builds += (t - e.start!) / W;
          e.start = null;
          e.end = null;
        }
        changed = true;
      }
    }
    const ends = queue.slice(0, concurrency).flatMap(e => (e.end !== null && e.end > t ? [e.end] : []));
    const candidates = [...ends, ...(next < order.length ? [order[next]!.at] : [])];
    if (!candidates.length) break;
    t = Math.min(...candidates);
  }
  return { toMainSeconds: toMain, builds, tail: merged.slice(-concurrency) };
}

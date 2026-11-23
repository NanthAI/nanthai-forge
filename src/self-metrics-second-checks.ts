// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { fallbackKind } from './fallback-reasons.js';
import { checkInfrastructure, checkTerminal } from './check-run-state.js';
import { during, ratio } from './self-metrics-joins.js';
import type { MetricPeriod, MetricRecords, MetricSubmission } from './self-metrics-types.js';

/** A check failure, as opposed to a conflict, a cancel or a hold. */
const CHECK_FAILURES = new Set(['CHECK_FAILED', 'CHECK_NOT_PASSED']);
export type SecondCheckVerdict = 'landed' | 'flaky' | 'real' | 'unknown' | 'other';
type Entry = {
  id: string;
  at: string;
  reason: string;
  status: string;
  errorCode: string | null;
  model: string | null;
  /** Lane → head of the last attempt, for the retry join. */
  heads: Map<string, string>;
  sharedBatch: MetricSubmission['sharedBatch'];
};

/** Second checks by reason class, with what became of each (Issue 81d12a32). One entry per
 * submission that did not land on its own first check: its reason is the receipt-stage
 * `firstCheckRecheck` (failed entries included) or its first main-race `recheckReason`.
 *
 * A failed check is joined to the next landing of the same Lane, from rows the metric pages
 * already return: the same head landed later means the failure was flaky (a later pass vouches);
 * a different head means it was real and was fixed; no later landing is `unknown`. Shared-batch
 * failures that every member then passed alone left no failed entry before: they are counted
 * here. No extra read. */
export function secondCheckMetric(records: MetricRecords, period: MetricPeriod) {
  const byEntry = new Map<string, MetricSubmission[]>();
  for (const row of records.submissions) {
    const rows = byEntry.get(row.entryId);
    if (rows) rows.push(row);
    else byEntry.set(row.entryId, [row]);
  }
  const entries: Entry[] = [];
  const landed: { at: string; heads: Map<string, string> }[] = [];
  for (const [id, unsorted] of byEntry) {
    const rows = [...unsorted].sort((a, b) => a.at.localeCompare(b.at));
    const first = rows[0]!,
      last = rows.at(-1)!;
    const status = first.entryStatus ?? first.status;
    const heads = new Map(last.inputs.map(input => [input.laneId, input.head]));
    const at = first.entryAt ?? first.at;
    if (status === 'landed') landed.push({ at: last.endedAt ?? last.at, heads });
    const reason =
      rows.find(row => row.firstCheckRecheck)?.firstCheckRecheck ??
      rows.find(row => row.recheck !== false && row.recheckReason)?.recheckReason;
    if (!reason || !during(at, period)) continue;
    entries.push({
      id,
      at,
      reason,
      status,
      errorCode: first.errorCode ?? null,
      model: first.agentClient ?? null,
      heads,
      sharedBatch: first.sharedBatch,
    });
  }
  const verdict = (entry: Entry): SecondCheckVerdict => {
    if (entry.status === 'landed') return 'landed';
    if (!CHECK_FAILURES.has(entry.errorCode ?? '')) return 'other';
    let found: SecondCheckVerdict = 'unknown';
    for (const later of landed) {
      if (later.at <= entry.at) continue;
      for (const [lane, head] of entry.heads) {
        const landedHead = later.heads.get(lane);
        if (landedHead === undefined) continue;
        // The same source passing later proves a flake; that outranks a later fixed head.
        if (landedHead === head) return 'flaky';
        found = 'real';
      }
    }
    return found;
  };
  const rows = new Map<string, Record<SecondCheckVerdict, number> & { reason: string }>();
  const models = new Map<string, { model: string; secondChecks: number; failed: number }>();
  for (const entry of entries) {
    const outcome = verdict(entry);
    const row = rows.get(entry.reason) ?? {
      reason: entry.reason,
      landed: 0,
      flaky: 0,
      real: 0,
      unknown: 0,
      other: 0,
    };
    row[outcome]++;
    rows.set(entry.reason, row);
    const model = entry.model ?? 'not recorded';
    const counted = models.get(model) ?? { model, secondChecks: 0, failed: 0 };
    counted.secondChecks++;
    if (outcome === 'flaky' || outcome === 'real' || outcome === 'unknown') counted.failed++;
    models.set(model, counted);
  }
  // Shared-batch failures: every member of a cohort whose shared check failed, whatever came after.
  const shared = [...byEntry.values()]
    .map(list => list[0]!)
    .filter(row => row.sharedBatch && during(row.entryAt ?? row.at, period));
  const gaps = records.secondChecksUnprojected
    ? [
        'Some hosted metric pages predate the second-check projection: deploy projectSelfMetrics; earlier failed second checks have no reason class.',
      ]
    : [];
  return {
    total: entries.length,
    byReason: [...rows.values()]
      .map(row => ({ ...row, kind: fallbackKind('first-check', row.reason) }))
      .sort(
        (a, b) =>
          b.real + b.unknown - (a.real + a.unknown) ||
          b.landed - a.landed ||
          a.reason.localeCompare(b.reason),
      ),
    /** Members of cohorts whose shared check failed; `passedAlone` then passed their own fallback check. */
    sharedBatch: {
      members: shared.length,
      runs: new Set(shared.map(row => row.sharedBatch!.runId)).size,
      passedAlone: shared.filter(row => row.sharedBatch!.individualPassed).length,
    },
    byModel: [...models.values()].sort(
      (a, b) => b.secondChecks - a.secondChecks || a.model.localeCompare(b.model),
    ),
    partial: gaps.length > 0,
    gaps,
  };
}

/** Recent-tail sizes reported beside the window (Item 9ce2ee79). */
export const FIRST_CHECK_TAILS = [50, 200] as const;
export type FirstCheckClass =
  | 'green'
  | 'red'
  | 'flaky'
  | 'cohort'
  | 'cancelled'
  | 'runner-unavailable'
  | 'pending'
  | 'no-check'
  | 'unresolved';

/** First-submission check red rate (Item 9ce2ee79): of the changes submitted for the first time in
 * the window, the share whose first check (the admission run when one ran, else the first attempt's
 * queue run) failed on the change itself.
 *
 * Decided = green + red. Reported apart, never in the rate: a first check that recovered flaky files in
 * the run or failed and later passed on the same head (`flaky`), a shared cohort check that failed
 * while this change passed alone (`cohort`), `cancelled`, `runner-unavailable` (runner unavailable,
 * budget exhausted or interrupted), still `pending`, no check at all (`no-check`) and a run row outside the read
 * (`unresolved`). A submission that retries another (`supersedes`), a revert, and a change whose Intent
 * an earlier submission already carried are not first submissions. Every input is a row the metrics
 * pages already return: no extra call, no write, nothing on the landing path. */
export function firstCheckMetric(records: MetricRecords, period: MetricPeriod) {
  const byEntry = new Map<string, MetricSubmission[]>();
  for (const row of records.submissions) {
    const rows = byEntry.get(row.entryId);
    if (rows) rows.push(row);
    else byEntry.set(row.entryId, [row]);
  }
  const runs = new Map(records.runs.map(run => [run.id, run]));
  type Entry = { id: string; at: string; rows: MetricSubmission[]; first: MetricSubmission };
  const entries: Entry[] = [...byEntry]
    .map(([id, unsorted]) => {
      const rows = [...unsorted].sort((a, b) => a.at.localeCompare(b.at));
      const first = rows[0]!;
      return { id, at: first.entryAt ?? first.at, rows, first };
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  // Same Lane head landing later proves a failed first check was flaky (the second-check join).
  const landed = entries
    .filter(entry => (entry.first.entryStatus ?? entry.first.status) === 'landed')
    .map(entry => ({
      at: entry.rows.at(-1)!.endedAt ?? entry.rows.at(-1)!.at,
      heads: new Set(entry.rows.flatMap(row => row.inputs.map(input => `${input.laneId}:${input.head}`))),
    }));
  const seenIntents = new Set<string>();
  const counts: Record<FirstCheckClass, number> = {
    green: 0,
    red: 0,
    flaky: 0,
    cohort: 0,
    cancelled: 0,
    'runner-unavailable': 0,
    pending: 0,
    'no-check': 0,
    unresolved: 0,
  };
  const decided: { at: string; red: boolean }[] = [];
  let noInputs = 0;
  for (const entry of entries) {
    const intents = new Set(entry.rows.flatMap(row => row.inputs.map(input => input.intentId)));
    const revert =
      entry.rows.some(row => row.compensating) ||
      entry.rows.some(row => row.inputs.some(input => input.compensating));
    const seen = [...intents].some(id => seenIntents.has(id));
    for (const id of intents) seenIntents.add(id);
    if (revert || entry.first.supersedes || seen || !during(entry.at, period)) continue;
    if (!intents.size) noInputs++;
    const submission = entry.first;
    const runId = submission.admissionRun?.runId ?? entry.rows.find(row => row.runIds[0])?.runIds[0];
    const run = runId ? runs.get(runId) : undefined;
    let outcome: FirstCheckClass;
    if (!runId)
      outcome = submission.admissionRun?.status === 'unavailable' ? 'runner-unavailable' : 'no-check';
    else if (!run) outcome = 'unresolved';
    else if (run.status === 'passed') outcome = run.flaky ? 'flaky' : 'green';
    else if (run.status === 'failed') {
      const heads = entry.rows[0]!.inputs.map(input => `${input.laneId}:${input.head}`);
      if (submission.sharedBatch?.runId === runId && submission.sharedBatch.individualPassed)
        outcome = 'cohort';
      else if (landed.some(later => later.at > entry.at && heads.some(head => later.heads.has(head))))
        outcome = 'flaky';
      else outcome = 'red';
    } else if (run.status === 'cancelled') outcome = 'cancelled';
    else if (checkInfrastructure(run.status)) outcome = 'runner-unavailable';
    else outcome = checkTerminal(run.status) ? 'unresolved' : 'pending';
    counts[outcome]++;
    if (outcome === 'green' || outcome === 'red') decided.push({ at: entry.at, red: outcome === 'red' });
  }
  const recent = decided.slice().sort((a, b) => b.at.localeCompare(a.at));
  const tail = (size: number) => {
    const rows = recent.slice(0, size);
    const red = rows.filter(row => row.red).length;
    return { size, decided: rows.length, red, rate: ratio(red, rows.length), complete: rows.length === size };
  };
  const gaps: string[] = [];
  if (records.admissionUnprojected)
    gaps.push(
      'Some hosted request pages predate the admission-run projection: deploy projectSelfMetrics; their first check is the first queue run.',
    );
  if (noInputs)
    gaps.push(
      `${noInputs} first submissions have no resolved input Lanes, so earlier submissions of their Intent could not be excluded.`,
    );
  const total = Object.values(counts).reduce((n, count) => n + count, 0);
  return {
    firstSubmissions: total,
    decided: decided.length,
    red: counts.red,
    rate: ratio(counts.red, decided.length),
    excluded: {
      flaky: counts.flaky,
      cohort: counts.cohort,
      cancelled: counts.cancelled,
      runnerUnavailable: counts['runner-unavailable'],
      pending: counts.pending,
      noCheck: counts['no-check'],
      unresolved: counts.unresolved,
    },
    recent: FIRST_CHECK_TAILS.map(tail),
    partial: gaps.length > 0,
    gaps,
  };
}

// SPDX-License-Identifier: Apache-2.0
import { fallbackKind } from './fallback-reasons.js';
import { during } from './self-metrics-joins.js';
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

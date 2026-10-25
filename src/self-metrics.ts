// SPDX-License-Identifier: Apache-2.0
import type { MetricInput, MetricPeriod, MetricRecords, SelfMetricsReader } from './self-metrics-types.js';
export type { SelfMetricsReader, MetricRecords, MetricPeriod } from './self-metrics-types.js';
const excluded = new Set(['start', 'checkpoint', 'finish', 'land']);
const instant = (at: string) => Date.parse(at);
const inPeriod = (at: string, period: MetricPeriod) =>
  instant(at) >= instant(period.from) && instant(at) < instant(period.to);
const unique = <T>(items: T[], key: (item: T) => string) => [
  ...new Map(items.map(item => [key(item), item])).values(),
];
const ratio = (n: number, d: number) => (d ? n / d : null);
const coverage = (
  records: MetricRecords,
  field: 'lifecycle' | 'mutations' | 'deliveries' | 'checkRequests',
  from: string,
) => !records.coverage?.[field] || instant(records.coverage[field]!) > instant(from);
function pathFor(records: MetricRecords, inputs: MetricInput[], at: string) {
  const paths = inputs.map(input => {
    const history = records.submissions
      .filter(s => instant(s.at) <= instant(at) && s.inputs.some(i => i.intentId === input.intentId))
      .sort((a, b) => instant(a.at) - instant(b.at));
    if (!history.length) return 'unknown';
    const same = (s: (typeof history)[number]) =>
      s.inputs.some(i => i.intentId === input.intentId && i.head === input.head);
    const failed = history.filter(
      s => s.status === 'failed' && s.endedAt && instant(s.endedAt) < instant(at),
    );
    if (input.savedAt && failed.some(s => instant(s.endedAt!) < instant(input.savedAt!)))
      return 'after-fixer';
    if (
      history.some(
        (s, index) =>
          same(s) &&
          ['failed', 'interrupted', 'superseded'].includes(s.status) &&
          s.endedAt &&
          history.slice(index + 1).some(next => same(next) && instant(next.at) >= instant(s.endedAt!)),
      )
    )
      return 'after-retry';
    const priorBadRun = records.runs.some(
      run =>
        run.endedAt &&
        instant(run.endedAt) < instant(at) &&
        ['failed', 'interrupted'].includes(run.status) &&
        run.inputs.some(i => i.intentId === input.intentId && i.head === input.head),
    );
    if (same(history[0]!) && !priorBadRun) return 'first-try';
    return 'unknown';
  });
  return paths.includes('after-fixer')
    ? 'after-fixer'
    : paths.includes('after-retry')
      ? 'after-retry'
      : paths.length && paths.every(p => p === 'first-try')
        ? 'first-try'
        : 'unknown';
}
/** Pure calculation. Period is [from,to); days are UTC; asOf fixes the 60-minute stall test. */
export function calculateSelfMetrics(records: MetricRecords, period: MetricPeriod) {
  const asOf = period.asOf ?? period.to;
  const incompleteReceiptRecords = records.incompleteReceiptRecords ?? 0;
  const receiptGaps = incompleteReceiptRecords
    ? [
        `${incompleteReceiptRecords} incomplete trailing metric receipt records were ignored; receipt coverage is partial.`,
      ]
    : [];
  const moves = unique(
    records.moves.filter(move => inPeriod(move.at, period)),
    move => move.id,
  );
  const landings = moves.filter(move => move.kind === 'landing');
  const rows = landings.map(move => ({
    id: move.id,
    day: new Date(move.at).toISOString().slice(0, 10),
    path: pathFor(records, move.inputs, move.at),
  }));
  const days = [...new Set(rows.map(row => row.day))].sort().map(day => ({
    day,
    landings: rows.filter(row => row.day === day).length,
    firstTry: rows.filter(row => row.day === day && row.path === 'first-try').length,
    afterRetry: rows.filter(row => row.day === day && row.path === 'after-retry').length,
    afterFixer: rows.filter(row => row.day === day && row.path === 'after-fixer').length,
    unknown: rows.filter(row => row.day === day && row.path === 'unknown').length,
  }));
  const first = <T extends { at: string }>(items: T[], key: (item: T) => string) =>
    unique(
      [...items].sort((a, b) => instant(b.at) - instant(a.at)),
      key,
    );
  const lifecycle = records.receipts.filter(r => r.kind === 'lifecycle');
  const finishes = first(
    lifecycle.filter(r => r.action === 'finish' || r.action === 'land'),
    r => r.operationId,
  ).filter(r => inPeriod(r.at, period)).length;
  const errors = first(
    lifecycle.flatMap(r =>
      (r.errorCodes ?? (r.errorCode ? [r.errorCode] : [])).map(errorCode => ({ ...r, errorCode })),
    ),
    r => `${r.operationId}:${r.errorCode}`,
  ).filter(r => inPeriod(r.at, period));
  const errorGaps = coverage(records, 'lifecycle', period.from)
    ? ['Caller-visible lifecycle receipts and operation IDs were not recorded for the whole period.']
    : [];
  errorGaps.push(...(records.lifecycleCoverageGaps ?? []), ...receiptGaps);
  const byCode = [...new Set(errors.map(r => r.errorCode!))].sort().map(code => ({
    code,
    count: errors.filter(r => r.errorCode === code).length,
    per100Finishes: finishes ? (errors.filter(r => r.errorCode === code).length * 100) / finishes : null,
    noOwner: errors.filter(r => r.errorCode === code && r.noOwner === true).length || null,
  }));
  const delivered = new Map<string, string>();
  for (const receipt of records.receipts.filter(r => instant(r.at) <= instant(asOf)))
    for (const item of receipt.deliveries ?? []) delivered.set(item.entryId, item.state);
  const dropped = records.submissions
    .filter(s => inPeriod(s.at, period) && instant(s.at) <= instant(asOf))
    .filter(s => {
      if (s.delivered || delivered.has(s.entryId)) return false;
      if (
        records.moves.some(
          m =>
            instant(m.at) <= instant(asOf) &&
            m.inputs.some(i => s.inputs.some(j => j.laneId === i.laneId && j.head === i.head)),
        )
      )
        return false;
      const progress = [
        s.at,
        ...(s.endedAt ? [s.endedAt] : []),
        ...s.progressAt,
        ...records.runs
          .filter(r => s.runIds.includes(r.id))
          .flatMap(r => [r.at, ...(r.endedAt ? [r.endedAt] : [])]),
      ]
        .filter(at => instant(at) <= instant(asOf))
        .sort((a, b) => instant(a) - instant(b))
        .at(-1)!;
      return Date.parse(asOf) - Date.parse(progress) >= 60 * 60_000;
    })
    .map(s => ({ id: s.id, entryId: s.entryId, noOwner: s.noOwner ?? null }));
  const mutations = first(
    records.receipts.filter(r => r.kind === 'mutation' && r.origin === 'command' && !excluded.has(r.action)),
    r => `${r.operationId}:${r.action}`,
  ).filter(r => inPeriod(r.at, period));
  const mutationGaps = coverage(records, 'mutations', period.from)
    ? [
        'Requester-attributed owner mutations (including cancel, retry, service restart and queue nudge) were not recorded for the whole period.',
      ]
    : [];
  mutationGaps.push(...(records.mutationCoverageGaps ?? []), ...receiptGaps);
  const actors = [...new Set(mutations.map(r => `${r.actor.kind}:${r.actor.name}`))].sort().map(actor => ({
    actor,
    count: mutations.filter(r => `${r.actor.kind}:${r.actor.name}` === actor).length,
    perLanding: ratio(
      mutations.filter(r => `${r.actor.kind}:${r.actor.name}` === actor).length,
      landings.length,
    ),
  }));
  const runs = unique(
    records.runs.filter(r => inPeriod(r.at, period)),
    r => r.id,
  );
  const seen = new Set<string>();
  let runnerMinutes = 0,
    wallMinutes = 0,
    unknownRunnerRuns = 0,
    unknownWallRuns = 0;
  for (const run of runs) {
    if (run.reusedFrom) continue;
    if (run.wallMinutes === undefined) unknownWallRuns++;
    else wallMinutes += run.wallMinutes;
    if (run.executions?.length) {
      for (const item of run.executions)
        if (!seen.has(item.id)) {
          seen.add(item.id);
          runnerMinutes += item.minutes;
        }
    } else if (run.runnerMinutes === undefined) unknownRunnerRuns++;
    else runnerMinutes += run.runnerMinutes;
  }
  const fullChecksStarted = runs.filter(r => !r.reusedFrom && r.started !== false).length;
  const retainedReuses = runs.filter(
    r =>
      r.reusedFrom &&
      r.reuseKey &&
      records.runs.some(
        original =>
          original.id === r.reusedFrom && original.status === 'passed' && original.reuseKey === r.reuseKey,
      ),
  ).length;
  const reusedRequests = first(
    (records.checkRequests ?? []).filter(
      r => r.reused && !records.runs.find(run => run.id === r.runId)?.reusedFrom,
    ),
    r => r.id,
  ).filter(r => inPeriod(r.at, period));
  const reused =
    retainedReuses +
    reusedRequests.filter(
      r =>
        r.reuseKey &&
        records.runs.some(
          run => run.id === r.runId && run.status === 'passed' && run.reuseKey === r.reuseKey,
        ),
    ).length;
  const unknownReuseHistory = coverage(records, 'checkRequests', period.from) || !!incompleteReceiptRecords;
  const unknownReuseKeys = runs.filter(r => !r.reuseKey).length;
  const runGaps = [
    ...receiptGaps,
    ...(unknownReuseHistory
      ? ['Check request/adoption receipts were not recorded for the whole period; reuse rate is unknown.']
      : []),
    ...(unknownRunnerRuns
      ? [
          `${unknownRunnerRuns} runs lack shard execution durations (local billed-zero cost is not execution time).`,
        ]
      : []),
    ...(unknownWallRuns ? [`${unknownWallRuns} runs lack a completed wall duration.`] : []),
    ...(unknownReuseKeys
      ? [
          `${unknownReuseKeys} runs lack the complete tree + definition + lockfile + Node major.minor + declared-input reuse key.`,
        ]
      : []),
  ];
  const deliveryGaps = coverage(records, 'deliveries', period.from)
    ? [
        'Terminal-outcome delivery and timestamped batch progress were not recorded for the whole period; dropped rows are candidates where delivery is unknown.',
      ]
    : [];
  deliveryGaps.push(...receiptGaps);
  return {
    period: { ...period, asOf },
    incompleteReceiptRecords,
    landings: landings.length,
    ...(records.source ? { source: records.source } : {}),
    metric1: {
      partial: rows.some(r => r.path === 'unknown') || records.landingKindsComplete === false,
      gaps: [
        ...(rows.some(r => r.path === 'unknown')
          ? ['Submission history or saved-head/failure ordering is unavailable for unclassified landings.']
          : []),
        ...(records.landingKindsComplete === false
          ? [
              'Records do not uniformly distinguish ordinary, revert and compensating main moves; the denominator includes unclassified accepting main moves.',
            ]
          : []),
      ],
      days,
      rows,
      reverts:
        records.landingKindsComplete === false && !moves.some(m => m.kind === 'revert')
          ? null
          : moves.filter(m => m.kind === 'revert').length,
      compensating:
        records.landingKindsComplete === false && !moves.some(m => m.kind === 'compensating')
          ? null
          : moves.filter(m => m.kind === 'compensating').length,
    },
    metric2: {
      partial: !!errorGaps.length,
      gaps: errorGaps,
      finishes: errorGaps.length && !finishes ? null : finishes,
      errors: errorGaps.length && !errors.length ? null : errors.length,
      byCode,
    },
    metric3: {
      partial: !!deliveryGaps.length,
      gaps: deliveryGaps,
      dropped: deliveryGaps.length && !dropped.length ? null : dropped.length,
      rows: dropped,
    },
    metric5: {
      partial: !!mutationGaps.length,
      gaps: mutationGaps,
      interventions: mutationGaps.length && !mutations.length ? null : mutations.length,
      perLanding: mutationGaps.length && !mutations.length ? null : ratio(mutations.length, landings.length),
      byActor: actors,
    },
    metric6: {
      partial: !!runGaps.length,
      gaps: runGaps,
      runs: runs.length,
      runnerMinutes:
        unknownRunnerRuns === runs.filter(r => !r.reusedFrom).length && unknownRunnerRuns
          ? null
          : runnerMinutes,
      wallMinutes: unknownWallRuns && !wallMinutes ? null : wallMinutes,
      runnerMinutesPerLanding:
        unknownRunnerRuns && !runnerMinutes ? null : ratio(runnerMinutes, landings.length),
      wallMinutesPerLanding: unknownWallRuns && !wallMinutes ? null : ratio(wallMinutes, landings.length),
      unknownRunnerRuns,
      unknownWallRuns,
      reused: unknownReuseHistory && !reused ? null : reused,
      fullChecksStarted,
      reuseRate: unknownReuseKeys || unknownReuseHistory ? null : ratio(reused, reused + fullChecksStarted),
    },
    gaps: [...records.gaps, ...receiptGaps],
  };
}
export async function readSelfMetrics(reader: SelfMetricsReader, period: MetricPeriod) {
  return calculateSelfMetrics(await reader.read(), period);
}

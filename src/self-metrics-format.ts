// SPDX-License-Identifier: Apache-2.0
import { metricNames, type MetricsSurface, type MetricTotals } from './self-metrics-surface.js';
const number = (value: number | null | undefined) =>
  value == null ? 'unknown' : Number(value.toFixed(3)).toString();
export function metricValues(t: MetricTotals): Record<keyof typeof metricNames, string> {
  return {
    '5.1': `${number(t['5.1'].landings)} (${t['5.1'].days.reduce((n, d) => n + d.firstTry, 0)} first-try, ${t['5.1'].days.reduce((n, d) => n + d.afterRetry, 0)} retry, ${t['5.1'].days.reduce((n, d) => n + d.afterRecompose, 0)} recompose after main moved, ${t['5.1'].days.reduce((n, d) => n + d.afterFixer, 0)} fixer, ${t['5.1'].days.reduce((n, d) => n + d.reusedAfterRace, 0)} reused after main moved, ${t['5.1'].days.reduce((n, d) => n + d.unknown, 0)} unknown, ${t['5.1'].unresolved} no inputs); first-attempt land rate ${number(t['5.1'].firstAttemptLandRate.rate)} (${t['5.1'].firstAttemptLandRate.accepted}/${t['5.1'].firstAttemptLandRate.lanes} Lanes); reverts ${number(t['5.1'].reverts)}, compensating ${number(t['5.1'].compensating)}`,
    '5.2': `${number(t['5.2'].errors)} / ${number(t['5.2'].finishes)} finishes; ${t['5.2'].byCode.map(c => `${c.code} ${number(c.per100Finishes)}/100`).join(', ') || 'rates unknown'}`,
    '5.3': number(t['5.3'].dropped),
    '5.4': `${number(t['5.4'].delivered)}/${number(t['5.4'].overlappingSaves)} delivered; acknowledgement ${number(t['5.4'].acknowledgementRate)}; median ${number(t['5.4'].medianDeliverySeconds)} s`,
    '5.5': `${number(t['5.5'].perLanding)} (${number(t['5.5'].interventions)} interventions)`,
    '5.6': `${number(t['5.6'].runnerMinutesPerLanding)} runner, ${number(t['5.6'].checkMinutesPerLanding)} check-minutes (${number(t['5.6'].runsPerLanding)} runs/landing, ${t['5.6'].discardedMainRaceRuns} discarded by a moved main); reuse ${number(t['5.6'].reuseRate)} (missed ${number(t['5.6'].missedReuse.runs)} runs); total ${number(t['5.6'].runnerMinutes)} runner / ${number(t['5.6'].checkMinutes)} check min`,
    '5.7': `${t['5.7'].totals.map(m => `${m.mode} ${m.revisions} revisions; p50/p95 ${number(m.secondsP50)}/${number(m.secondsP95)} s, ${number(m.revisionLagP50)}/${number(m.revisionLagP95)} revisions`).join('; ')}; contradictions ${number(t['5.7'].contradictionMinutes)} min`,
    '5.8':
      [
        ...t['5.8'].periods.map(
          p =>
            `${p.provider} ${p.from.slice(0, 10)}..${p.to.slice(0, 10)}: $${number(p.billedUsd)} billed, $${number(p.billedUsdPerLanding)}/landing; estimate $${number(p.estimateUsd)} (${p.estimateSource}), error ${number(p.estimatorError)}`,
        ),
        ...t['5.8'].months.map(
          m =>
            `${m.month}: $${number(m.billedUsdPerLanding)} billed / $${number(m.listUsdPerLanding)} list; estimator error ${number(m.estimatorError)}`,
        ),
      ].join('; ') || 'unknown',
    R: t.R.sources.map(s => `${s.source}: ${number(s.minutes)}`).join('; '),
    B: `${number(t.B.reuseAcceptances)} reuse acceptances; ${number(t.B.mainCheckFailures)} main-check failures (${number(t.B.failuresAfterReuse)} after reuse, ${number(t.B.flakeCleared)} flake, ${number(t.B.culprits)} culprits, ${number(t.B.reuseCulprits)} on reuse)`,
  };
}
const finishToMain = (current: MetricsSurface) => {
  const f = current.totals.finishToMain;
  return `p50 ${number(f.p50Minutes)} / p90 ${number(f.p90Minutes)} / mean ${number(f.meanMinutes)} min; ${f.admissionRunShare === null ? 'admission-run share unknown' : `${number(f.admissionRunShare * 100)}% landed on the admission check`}`;
};
const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
export function formatMetricReport(current: MetricsSurface, before?: MetricsSurface) {
  const values = metricValues(current.totals),
    previous = before && metricValues(before.totals);
  const columns = previous
    ? '| Metric | Before | After | Source records (before / after) | Coverage |'
    : '| Metric | Value | Source records | Coverage |';
  const rows = (Object.keys(metricNames) as (keyof typeof metricNames)[]).map(id => {
    const metric = current.totals[id],
      prior = before?.totals[id];
    const gaps = [...new Set([...(prior?.gaps ?? []), ...metric.gaps])];
    const coverage = metric.partial || prior?.partial ? `partial: ${gaps.join(' ')}` : 'complete';
    return `| ${id} ${metricNames[id]} | ${previous ? `${cell(previous[id])} | ` : ''}${cell(values[id])} | ${prior ? `${prior.sourceRecords} / ` : ''}${metric.sourceRecords} | ${cell(coverage)} |`;
  });
  return [
    `Metrics UTC [${current.period.from}, ${current.period.to})`,
    ...(before ? [`Before UTC [${before.period.from}, ${before.period.to})`] : []),
    '',
    columns,
    previous ? '| --- | --- | --- | --- | --- |' : '| --- | --- | --- | --- |',
    ...rows,
    '',
    '| Waste cause | Attempts | Lost elapsed minutes | Runner minutes | Discarded passed runner minutes | Unknown elapsed / runner |',
    '| --- | --- | --- | --- | --- | --- |',
    ...current.totals.waste.byCause.map(
      row =>
        `| ${row.cause} | ${row.attempts} | ${number(row.elapsedMinutes)} | ${number(row.runnerMinutes)} | ${number(row.discardedPassedRunnerMinutes)} | ${row.unknownElapsedAttempts} / ${row.unknownRunnerRuns} |`,
    ),
    `Main-race re-checks: ${current.totals.waste.mainRaceRecheckRuns} runs / ${number(current.totals.waste.mainRaceRecheckRunnerMinutes)} runner minutes; ${recheckShare(current)}. ${cell(current.totals.waste.gaps.join(' '))}`,
    '',
    ...formatFallbacks(current),
    ...formatSecondChecks(current),
    `Finish-to-main (trusted actors): ${finishToMain(current)}. ${cell(current.totals.finishToMain.gaps.join(' '))}`,
    '',
    ...formatFlakes(current).map(line => (line.startsWith('  ') ? `- ${line.trim()}` : line)),
    '',
  ].join('\n');
}
/** Scoped share, and recheck runner minutes per main-race attempt. */
function recheckShare(current: MetricsSurface) {
  const waste = current.totals.waste;
  const races = waste.byCause.find(row => row.cause === 'main-race')?.attempts ?? 0;
  return `${waste.mainRaceScopedRecheckRuns} scoped (${number(waste.mainRaceScopedRecheckRunnerMinutes)} runner min); ${races ? number(waste.mainRaceRecheckRunnerMinutes / races) : 'n/a'} recheck runner min per main-race attempt`;
}
/** Fast-path fallbacks by stage and reason; each limitation reason is flagged once (7c2e69e1). */
export function formatFallbacks(current: MetricsSurface) {
  const value = current.totals.fallbacks;
  if (!value.byReason.length)
    return [`Fast-path fallbacks: none in window${value.partial ? ' · partial' : ''}`];
  return [
    `Fast-path fallbacks: ${value.total} (${value.limitations} limitation)${value.partial ? ' · partial' : ''}`,
    ...value.byReason.map(
      row =>
        `  ${row.kind === 'limitation' ? '⚑ limitation' : 'genuine'} · ${row.stage} ${row.reason} ×${row.count}`,
    ),
    ...value.gaps.map(gap => `  ${gap}`),
  ];
}
/** Second checks by reason class with their outcome, shared-batch failures and agent clients (81d12a32). */
export function formatSecondChecks(current: MetricsSurface) {
  const value = current.totals.secondChecks;
  if (!value.total && !value.sharedBatch.members)
    return [`Second checks: none in window${value.partial ? ' · partial' : ''}`];
  return [
    `Second checks: ${value.total}${value.partial ? ' · partial' : ''}`,
    ...value.byReason.map(
      row =>
        `  ${row.reason}: ${row.landed} landed · failed ${row.real} real, ${row.flaky} flaky, ${row.unknown} not retried${row.other ? ` · ${row.other} ended otherwise` : ''}`,
    ),
    ...(value.sharedBatch.members
      ? [
          `  shared-batch failures: ${value.sharedBatch.runs} runs, ${value.sharedBatch.members} members, ${value.sharedBatch.passedAlone} passed alone`,
        ]
      : []),
    ...value.byModel.map(row => `  ${row.model}: ${row.secondChecks} second checks, ${row.failed} failed`),
    ...value.gaps.map(gap => `  ${gap}`),
  ];
}
const FLAKE_LINES = 10;
const ms = (value: number) => `${Number((value / 1000).toFixed(1))}s`;
/** One line per flaky file, with the same-day next step: comment on the Issue or file one. */
export function formatFlakes(current: MetricsSurface) {
  const flakes = current.totals.flakes;
  if (!flakes.files.length)
    return [`Flaky files (recovered on retry): none in window${flakes.partial ? ' · partial' : ''}`];
  const rest = flakes.filesTotal - Math.min(flakes.files.length, FLAKE_LINES);
  return [
    `Flaky files (recovered on retry, never a clean pass): ${flakes.filesTotal} files in ${flakes.flakyRuns} runs${flakes.partial ? ' · partial' : ''}`,
    ...flakes.files.slice(0, FLAKE_LINES).map(row => {
      const attempts = row.lastAttempts
        ?.map(a => `${a.failed ? 'failed' : 'passed'} ${ms(a.durationMs)}`)
        .join(' → ');
      const issue =
        row.issue === undefined
          ? `next: nforge agent ROOT planning '{"search":"${row.search}","status":"all"}' → comment run ids on a match, else file an Issue today`
          : row.issue === null
            ? 'no Issue found: file one today with the file, first error and run ids'
            : 'possible' in row.issue
              ? `check before filing: ${row.issue.possible.map(i => `${i.id.slice(0, 8)} ${i.title}`).join('; ')}`
              : `Issue ${row.issue.id.slice(0, 8)} (${row.issue.status}): comment these run ids`;
      return `  ${row.file} ×${row.runs} · last ${row.lastAt.slice(0, 16)}Z${attempts ? ` · ${attempts}` : ''} · runs ${row.runIds.map(id => id.slice(0, 8)).join(',')}${row.lastError ? ` · ${row.lastError.split('\n')[0]!.slice(0, 120)}` : ''}\n    ${issue}`;
    }),
    ...(rest > 0 ? [`  … ${rest} more (--json: totals.flakes)`] : []),
    ...(flakes.omittedPerRun
      ? [`  ${flakes.omittedPerRun} further flaky files were omitted by the per-run cap.`]
      : []),
    ...flakes.gaps.map(gap => `  ${gap}`),
  ];
}
export function formatMetrics(current: MetricsSurface) {
  const values = metricValues(current.totals);
  const rows = (Object.keys(metricNames) as (keyof typeof metricNames)[]).map(
    id =>
      `${id.padEnd(3)} ${values[id]} · ${current.totals[id].sourceRecords} records${current.totals[id].partial ? ' · partial' : ''}`,
  );
  return [
    `Metrics UTC [${current.period.from}, ${current.period.to})`,
    ...rows,
    `Finish-to-main (trusted actors): ${finishToMain(current)} · partial`,
    ...current.totals.waste.byCause
      .filter(row => row.attempts)
      .map(
        row =>
          `Waste ${row.cause}: ${number(row.elapsedMinutes)} elapsed / ${number(row.runnerMinutes)} runner min; discarded passed ${number(row.discardedPassedRunnerMinutes)} runner min`,
      ),
    `Main-race re-checks: ${current.totals.waste.mainRaceRecheckRuns} runs / ${number(current.totals.waste.mainRaceRecheckRunnerMinutes)} runner min; ${recheckShare(current)}`,
    ...formatFallbacks(current),
    ...formatSecondChecks(current),
    ...formatFlakes(current),
    'Daily values and named gaps: --json; report: --report FILE.md',
  ].join('\n');
}
export function metricsHeadline(t: MetricTotals) {
  return {
    landings: t['5.1'].landings,
    finishToMainP50Minutes: t.finishToMain.p50Minutes,
    firstTryShare: t['5.1'].firstTryShare,
    interventionsPerLanding: t['5.5'].perLanding,
    redMainMinutes: Object.fromEntries(t.R.sources.map(s => [s.source, s.minutes])),
    checkMinutesPerLanding: t['5.6'].runnerMinutesPerLanding,
    dollarsPerLanding: t['5.8'].months.map(m => ({
      month: m.month,
      billed: m.billedUsdPerLanding,
      list: m.listUsdPerLanding,
    })),
    partial: Object.values(t).some(m => m.partial),
    gaps: [...new Set(Object.values(t).flatMap(m => m.gaps))],
    diskWarning: t.disk.warning,
    placementWarning: t.placement.warning,
    /** One line naming each fast-path limitation reason in the window, or null (7c2e69e1). */
    fallbackWarning: t.fallbacks.warning,
  };
}
export type MetricsHeadline = ReturnType<typeof metricsHeadline>;
export function formatMetricsHeadline(value: MetricsHeadline) {
  return [
    `Metrics · last 7 days${value.partial ? ' · partial (metrics --json for gaps)' : ''}: ${number(value.landings)} landings · first-try ${value.firstTryShare === null ? 'unknown' : `${number(value.firstTryShare * 100)}%`} · interventions/landing ${number(value.interventionsPerLanding)}`,
    `Checks/landing ${number(value.checkMinutesPerLanding)} min · dollars/landing ${value.dollarsPerLanding.map(m => `${m.month} $${number(m.billed)}`).join(', ') || 'unknown'} · red-main ${Object.entries(
      value.redMainMinutes,
    )
      .map(([source, min]) => `${source} ${number(min)} min`)
      .join(', ')}`,
    ...(value.diskWarning ? [value.diskWarning] : []),
    ...(value.placementWarning ? [value.placementWarning] : []),
    ...(value.fallbackWarning ? [value.fallbackWarning] : []),
  ];
}

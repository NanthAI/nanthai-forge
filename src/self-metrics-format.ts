// SPDX-License-Identifier: Apache-2.0
import { metricNames, type MetricsSurface, type MetricTotals } from './self-metrics-surface.js';
const number = (value: number | null | undefined) =>
  value == null ? 'unknown' : Number(value.toFixed(3)).toString();
export function metricValues(t: MetricTotals): Record<keyof typeof metricNames, string> {
  return {
    '5.1': `${t['5.1'].landings} (${t['5.1'].days.reduce((n, d) => n + d.firstTry, 0)} first-try, ${t['5.1'].days.reduce((n, d) => n + d.afterRetry, 0)} retry, ${t['5.1'].days.reduce((n, d) => n + d.afterFixer, 0)} fixer, ${t['5.1'].days.reduce((n, d) => n + d.unknown, 0)} unknown); reverts ${number(t['5.1'].reverts)}, compensating ${number(t['5.1'].compensating)}`,
    '5.2': `${number(t['5.2'].errors)} / ${number(t['5.2'].finishes)} finishes; ${t['5.2'].byCode.map(c => `${c.code} ${number(c.per100Finishes)}/100`).join(', ') || 'rates unknown'}`,
    '5.3': number(t['5.3'].dropped),
    '5.4': `${number(t['5.4'].delivered)}/${number(t['5.4'].overlappingSaves)} delivered; acknowledgement ${number(t['5.4'].acknowledgementRate)}; median ${number(t['5.4'].medianDeliverySeconds)} s`,
    '5.5': `${number(t['5.5'].perLanding)} (${number(t['5.5'].interventions)} interventions)`,
    '5.6': `${number(t['5.6'].runnerMinutesPerLanding)} runner, ${number(t['5.6'].wallMinutesPerLanding)} wall; reuse ${number(t['5.6'].reuseRate)}; total ${number(t['5.6'].runnerMinutes)} runner / ${number(t['5.6'].wallMinutes)} wall min`,
    '5.7': `${t['5.7'].totals.map(m => `${m.mode} ${m.revisions} revisions; p50/p95 ${number(m.secondsP50)}/${number(m.secondsP95)} s, ${number(m.revisionLagP50)}/${number(m.revisionLagP95)} revisions`).join('; ')}; contradictions ${number(t['5.7'].contradictionMinutes)} min`,
    '5.8':
      t['5.8'].months
        .map(
          m =>
            `${m.month}: $${number(m.billedUsdPerLanding)} billed / $${number(m.listUsdPerLanding)} list; estimator error ${number(m.estimatorError)}`,
        )
        .join('; ') || 'unknown',
    R: t.R.sources.map(s => `${s.source}: ${number(s.minutes)}`).join('; '),
  };
}
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
  ].join('\n');
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
    'Daily values and named gaps: --json; report: --report FILE.md',
  ].join('\n');
}
export function metricsHeadline(t: MetricTotals) {
  return {
    landings: t['5.1'].landings,
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
  };
}
export type MetricsHeadline = ReturnType<typeof metricsHeadline>;
export function formatMetricsHeadline(value: MetricsHeadline) {
  return [
    `Metrics · last 7 days${value.partial ? ' · partial (metrics --json for gaps)' : ''}: ${value.landings} landings · first-try ${value.firstTryShare === null ? 'unknown' : `${number(value.firstTryShare * 100)}%`} · interventions/landing ${number(value.interventionsPerLanding)}`,
    `Checks/landing ${number(value.checkMinutesPerLanding)} min · dollars/landing ${value.dollarsPerLanding.map(m => `${m.month} $${number(m.billed)}`).join(', ') || 'unknown'} · red-main ${Object.entries(
      value.redMainMinutes,
    )
      .map(([source, min]) => `${source} ${number(min)} min`)
      .join(', ')}`,
    ...(value.diskWarning ? [value.diskWarning] : []),
  ];
}

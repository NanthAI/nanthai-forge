// SPDX-License-Identifier: Apache-2.0
import { metrics } from './stats-math.mjs';
import { fmt, table } from './stats-format.mjs';
import { headlineRows, wallContext, replaySummary } from './stats-overview.mjs';

const title = group => `${group.kind} N=${group.N} · ${group.arm}`;
const metricLabel = key => `${metrics[key][0]} (${metrics[key][1]})`;
const improvement = g => `${fmt(g.improvement)} (${fmt(g.percent)}%)`;

function statistics(series) {
  const out = [];
  for (const g of series.groups) {
    out.push(`### ${title(g)} (${g.cells} cells)\n`);
    for (const scope of ['perCell', 'perLanding']) {
      out.push(`#### ${scope === 'perCell' ? 'Per cell' : 'Per landing: cell value / landed count'}\n`);
      out.push(
        table(
          ['Metric', 'n', 'Min', 'Max', 'Mean', 'Median'],
          Object.keys(metrics)
            .filter(m => g[scope][m].n)
            .map(m => [
              metricLabel(m),
              ...['n', 'min', 'max', 'mean', 'median'].map(k => fmt(g[scope][m][k])),
            ]),
        ),
      );
    }
  }
  out.push('### Pooled task time to main\n');
  out.push(
    table(
      ['Cell kind / arm', 'View', 'Tasks', 'p50 s', 'p90 s', 'Max s'],
      series.groups.flatMap(g =>
        [
          ['Excluding task flags', g.pooledTimeToMain],
          ['All landed (observational)', g.observedPooledTimeToMain],
        ].map(([view, values]) => [
          title(g),
          view,
          values.n,
          ...['p50', 'p90', 'max'].map(k => fmt(values[k])),
        ]),
      ),
    ),
  );
  return out.join('\n');
}

function comparisons(items, heading) {
  const out = [];
  for (const item of items) {
    out.push(`### ${heading}: ${title(item)}\n`);
    out.push(
      table(
        ['Pooled timing view', 'Quantile', 'Reference s', 'Treatment s', 'Gain s (%)'],
        [
          ['Excluding task flags', item.pooledTimeToMainGains],
          ['All landed (observational)', item.observedPooledTimeToMainGains],
        ].flatMap(([view, values]) =>
          Object.entries(values)
            .filter(([, g]) => g.reference != null || g.treatment != null)
            .map(([q, g]) => [view, q, fmt(g.reference), fmt(g.treatment), improvement(g)]),
        ),
      ),
    );
    for (const scope of ['perCell', 'perLanding']) {
      out.push(`#### ${scope === 'perCell' ? 'Per cell gains' : 'Per landing gains'}\n`);
      out.push(
        table(
          [
            'Metric',
            'Reference median',
            'Treatment median',
            'Median gain',
            'Reference mean',
            'Treatment mean',
            'Mean gain',
            'Floor',
            'Ceiling',
          ],
          Object.keys(metrics)
            .filter(m => item[scope][m].median.reference != null || item[scope][m].median.treatment != null)
            .map(m => {
              const g = item[scope][m];
              return [
                metricLabel(m),
                fmt(g.median.reference),
                fmt(g.median.treatment),
                improvement(g.median),
                fmt(g.mean.reference),
                fmt(g.mean.treatment),
                improvement(g.mean),
                improvement(g.floor),
                improvement(g.ceiling),
              ];
            }),
        ),
      );
    }
  }
  return out.join('\n');
}

function attempts(series) {
  const out = ['### Voided attempts (excluded from all aggregates)\n'];
  out.push(
    series.voided.length
      ? table(
          ['Cell ID', 'Arm', 'Batch void', 'Dry', 'Reason'],
          series.voided.map(c => [
            c.cellId,
            c.arm,
            c.batchVoided == null ? 'unknown' : String(c.batchVoided),
            String(c.dry ?? false),
            c.reasons.join('; '),
          ]),
        )
      : 'None in supplied inputs.\n',
  );
  out.push('### Other excluded attempts\n');
  out.push(
    series.excluded.length
      ? table(
          ['Cell ID', 'Reason'],
          series.excluded.map(c => [c.cellId, c.reason]),
        )
      : 'None in supplied inputs.\n',
  );
  out.push('### Task-level exclusions retained from the harness\n');
  const flagged = series.cells.filter(c => c.taskVoids?.length);
  out.push(
    flagged.length
      ? table(
          ['Cell ID', 'Task voids', 'Quota/capacity flags', 'Contamination flags'],
          flagged.map(c => [
            c.cellId,
            c.taskVoids.join(', '),
            c.quotaTasks.join(', ') || 'none',
            c.contaminationVoids.join(', ') || 'none',
          ]),
        )
      : 'None in supplied inputs.\n',
  );
  out.push('### Every included cell\n');
  out.push(
    table(
      [
        'Cell ID',
        'Kind',
        'Arm',
        'Rep',
        'Landed',
        'Strict',
        'TTM median s',
        'TTM max s',
        'Wall s',
        'CI min',
        'Recovery turns',
      ],
      series.cells.map(c => [
        c.cellId,
        c.kind,
        c.arm,
        c.rep,
        ...[
          'landed',
          'strict',
          'timeToMainMedianSeconds',
          'timeToMainMaxSeconds',
          'wallSeconds',
          'ciBilledMinutes',
          'reworkTurns',
        ].map(m => fmt(c.perCell[m])),
      ]),
    ),
  );
  return out.join('\n');
}

export function render(report, { jsonName = 'p6-exit-bench-results.json' } = {}) {
  const primary = report.series.find(s => s.name === report.primary);
  const hasRerun = report.series.some(
    s => s.name === 'rerun' && s.cells.some(c => c.kind === 'scored' && c.N === 10),
  );
  const scored = primary.cells.filter(c => c.kind === 'scored');
  const out = [
    '# P6 exit bench: complete descriptive results\n',
    `Generated by [stats.mjs](../../scripts/bench-t3code/stats.mjs). Exact scalar observations, task timings, counts, coverage, gains and input digests are in [the JSON record](${jsonName}). The JSON preserves full numeric precision; tables round to three decimals.\n`,
    `The ${primary.name} series contains ${scored.length} scored cells and ${primary.cells.length - scored.length} coordination/diagnostic cells. It has ${primary.voided.length} voided attempts, kept separately. The table below gives medians of per-cell values across reps. It uses the primary series at each available N and the first supplied historical series for other N values; the Source column names each selection. No headline row pools different series. All observations, including unfavorable outcomes, remain in the record.\n`,
    table(
      [
        'N',
        'Arm',
        'Source',
        'Cells',
        'Observed TTM median s',
        'TTM excluding task flags s',
        'Wall s',
        'CI min',
        'Cached input',
        'Output tokens',
        'Recovery turns',
      ],
      headlineRows(
        primary,
        report.series.filter(s => s !== primary),
      ),
    ),
    '## How these were measured\n',
    'Methods and registered decisions: [P6 exit plan](p6-exit-bench-plan.md), [B1.5d plan](b15d-bench-plan.md), [harness and recovery recipe](../../evals/bench-t3code/README.md), [cell harness](../../scripts/bench-t3code/run-cell.mjs), [offline rework accounting](../../scripts/bench-t3code/rework.mjs). Ten upstream tasks are scheduled at scored N=1/3/5/10. Coordination workloads have their own task counts. Both arms use the registered agent and checks.\n',
    'Inputs are retained result.json, batch.json, forge-metrics.json and sessions. Discovery matches cellId, never folder names. Identical duplicate cell IDs count once; different bytes for one identity are an error. A cell or whole-batch void excludes that attempt in both arms. Dry/model-check/refused/incomplete/unbatched cells are not scored. Replay diagnostics, when supplied, get separate replay-kind groups and never enter scored tables. No benchmark or service is started.\n',
    'Time to main runs from task dispatch to acceptance. The main time-to-main metrics exclude task voids and harness errors. Separately labelled observed metrics retain all landed task times, including task flags, solely as descriptive observations; they cannot establish the registered pass/fail bar. Both pooled views and their sample counts are retained. Prep is outside time to main and inside wall; prep sum adds task prep (parallel work, not elapsed wall). Prep median is also retained. Cell totals include resources spent on tasks that did not land. Per-landing values divide each cell metric by that cell’s landed count before summarizing reps; dividing a cell median/max is a normalized cell value, not another per-task latency percentile. Missing values stay null, never zero. Each metric has its own observation count.\n',
    'Min, max, arithmetic mean and midpoint median describe cells, with equal weight per cell. Pooled p50/p90 use all valid landed task times with linear interpolation at (n−1)p; tasks within a run are correlated, not independent repeats. Output includes reasoning tokens; reasoning is retained separately as a subset and is not added twice. Recovery tokens sum cached input, uncached input, cache creation and output; components remain separate for cost interpretation. Causal recovery includes waiting inside a real recovery episode; it is not all waiting. Missing session coverage makes recovery unknown.\n',
    'Gain is positive when favorable to Forge (or the newer series in history). For lower-is-better metrics: absolute gain = reference − treatment and percent = 100 × gain / reference. Landed, strict, lenient and reuse counts use treatment − reference. Median and mean compare like statistics. Floor compares treatment worst to reference best; ceiling compares treatment best to reference worst. These are observed extrema, not uncertainty bounds or paired causal effects. Zero references have null percentages and an absolute gain. JSON retains both operands for every gain.\n',
    'Reproduce with `node scripts/bench-t3code/stats.mjs --series tuned=TUNED_DIRECTORY --series early-v1=V1_DIRECTORY --series rerun=V2_AND_REPLAY_DIRECTORY --series before=HISTORY_DIRECTORY --primary rerun --rework-module CORRECTED_REWORK_MODULE --classifier-state 0759c451bed7dbc64e47bb0b09f6b3f24646addbe7ce1d5ab74353357ccbdc34 --b15d-report docs/research/b15d-report.md`. Repeat `--series NAME=DIRECTORY` to combine retained input locations within a series, or give a new name to a later series. `--out PREFIX` selects JSON/Markdown outputs; defaults to this report. Inputs are never modified.\n',
    '## Caveats\n',
    '- Scored tuned cells have three reps per arm/N in the supplied baseline. Convoy N=4/8/16 and overlap N=8 have one valid rep per arm/setting; their extrema, mean and median coincide. Counts in the generated tables are authoritative if more cells are later supplied. There are too few repeats to claim population effects or stable floor/ceiling gains.\n',
    '- Retained taskVoids include quota/capacity and contamination flags, sometimes for every task despite recorded landings. The generator preserves them without adjudicating their cause. Timing tables show all-landed observations alongside the view excluding those flags, and counts expose missing coverage. The raw oracle strict/lenient counts are retained observations, not regraded clean-task correctness claims.\n',
    '- GitHub overlap landed 7 of 8 tasks. Its all-landed wall is missing, not zero. Per-landing cost divides by seven and retains work on the failed task; pooled timing excludes that unlanded task. Coordination oracle counts are not the scored ten-task oracle.\n',
    `- Original N=10 wall remains visible: paired arm differences change sign across the three reps. ${hasRerun ? 'The v2 N=10 rerun supplies the published N=10 headline; tuned and v1 observations remain history. GitHub ran slower in the v2 series, so the wall comparison below shows both its paired reference and earlier GitHub medians. Historical gains do not isolate a product effect.' : 'The pending N=10 rerun is tracked on Issue \`8c9b84fc\`; add it as a separate named series without replacing these observations.'} See the [exit plan](p6-exit-bench-plan.md). This descriptive report is not an exit-bar pass.\n`,
    `- Recovery is recomputed offline through rework.mjs with classifier State \`${report.classifier.state ?? 'unspecified (see digests)'}\`. The correction excludes speculative predecessor advice and help-only false positives while preserving real mixed-output failures. Retained result.json rework fields are unchanged; no actual token cost is saved by reclassification. Module digests are in JSON.\n`,
    '- Before-run cells use full pre-queue admission and have one valid rep per N/arm; tuned cells use queue-only cold-start admission. Historical differences are observations across runs, not an isolated causal estimate. The B1.5d fallback uses only published rounded per-cell numbers from the registered series; raw sessions, pooled times and unsupported metrics remain unknown. The owner-requested extra N=3 attempt is retained in its own deviation group and is not folded into the registered historical comparisons. The published every-cell table has ten registered cells per arm plus this extra, although its prose totals say eleven; no missing raw cell is invented.\n',
    '- Forge metrics retain their per-section partial flags. Submit-to-main is a separate interval from agent task time to main. Covered Convex cost uses retained harness coverage/rates and is not a complete invoice or whole-service cost. No new billing or byte-placement measurement was made. Service-only metrics have no GitHub counterpart.\n',
  ];
  out.push(wallContext(report), replaySummary(primary));
  for (const series of report.series) {
    out.push(
      `## Series: ${series.name}\n`,
      series.coverage ? `${series.coverage}\n` : '',
      statistics(series),
      attempts(series),
    );
    out.push(comparisons(series.gains, 'Forge versus GitHub'));
    const convoy = series.cells.filter(c => c.convoy);
    if (convoy.length)
      out.push(
        '### Convoy verdicts\n',
        table(
          ['Cell', 'Pass', 'Limit s', 'Late tasks', 'Independent waits', 'Unattributed waits'],
          convoy.map(c => [
            c.cellId,
            String(c.convoy.pass),
            fmt(c.convoy.limitSeconds),
            c.convoy.lateTasks.join(', ') || 'none',
            c.convoy.orderWaitsAgainstIndependent,
            c.convoy.orderWaitsUnattributed,
          ]),
        ),
      );
  }
  out.push('## History: primary series versus earlier series\n');
  for (const history of report.history) {
    out.push(comparisons(history.comparisons, `${report.primary} versus ${history.reference}`));
    out.push(`### Change in Forge lead over GitHub: ${history.reference} → ${report.primary}\n`);
    out.push(
      table(
        [
          'Kind',
          'N',
          'Arm',
          'Scope',
          'Metric',
          'Earlier median lead %',
          'Current median lead %',
          'Change pp',
          'Earlier mean lead %',
          'Current mean lead %',
          'Change pp',
        ],
        history.leadChanges.map(x => [
          x.kind,
          x.N,
          x.arm,
          x.scope,
          metricLabel(x.metric),
          ...['oldMedian', 'newMedian', 'medianPoints', 'oldMean', 'newMean', 'meanPoints'].map(k =>
            fmt(x[k]),
          ),
        ]),
      ),
    );
  }
  return out.join('\n').trimEnd() + '\n';
}

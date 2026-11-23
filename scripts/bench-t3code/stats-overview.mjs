// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { gains } from './stats-math.mjs';
import { fmt, table } from './stats-format.mjs';
const improvement = g => `${fmt(g.improvement)} (${fmt(g.percent)}%)`;

export function headlineRows(series, history = []) {
  const byN = new Map();
  for (const source of [series, ...history].filter(s => !s.validationOnly))
    for (const group of source.groups.filter(g => g.kind === 'scored'))
      if (!byN.has(group.N))
        byN.set(group.N, {
          source: source.name,
          groups: source.groups.filter(g => g.kind === 'scored' && g.N === group.N),
        });
  return [...byN.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, { source, groups }]) => groups.map(g => ({ ...g, source })))
    .map(g => [
      g.N,
      g.arm,
      g.source,
      g.cells,
      ...[
        'observedTimeToMainMedianSeconds',
        'timeToMainMedianSeconds',
        'wallSeconds',
        'ciBilledMinutes',
        'cachedInputTokens',
        'outputTokens',
        'reworkTurns',
      ].map(m => fmt(g.perCell[m].median)),
    ]);
}

export function wallContext(report) {
  const primary = report.series.find(s => s.name === report.primary);
  const out = [];
  const currentForge = primary.groups.find(g => g.kind === 'scored' && g.N === 10 && g.arm === 'forge');
  if (currentForge) {
    out.push('## N=10 wall context\n');
    out.push(
      table(
        [
          'GitHub reference series',
          'Comparison',
          'GitHub median wall s',
          'Published Forge median wall s',
          'Gain s (%)',
        ],
        [primary, ...report.series.filter(s => s !== primary && !s.validationOnly)].flatMap(series => {
          const reference = series.groups.find(g => g.kind === 'scored' && g.N === 10 && g.arm === 'github');
          return reference
            ? [
                [
                  series.name,
                  series === primary ? 'Paired series' : 'Historical reference',
                  fmt(reference.perCell.wallSeconds.median),
                  fmt(currentForge.perCell.wallSeconds.median),
                  improvement(
                    gains(reference.perCell.wallSeconds, currentForge.perCell.wallSeconds, 'wallSeconds')
                      .median,
                  ),
                ],
              ]
            : [];
        }),
      ),
    );
  }
  return out.join('\n');
}

export function replaySummary(series) {
  const cells = series.cells.filter(c => c.replay);
  const voided = series.voided.filter(c => c.kind.startsWith('replay-'));
  if (!cells.length && !voided.length) return '';
  const attempts = voided.length
    ? '\n### Voided replay attempts\n\n' +
      table(
        ['Cell', 'Arm', 'Scenario', 'Failure codes', 'Reason'],
        voided.map(c => [
          c.cellId,
          c.arm,
          c.kind,
          (c.failureCodes ?? []).join(', ') || 'unknown',
          c.reasons.join('; '),
        ]),
      )
    : '';
  return (
    '## Fixed N=10 replay diagnostics\n\n' +
    `Valid replay cells: ${cells.length}; voided replay attempts: ${voided.length}. A voided attempt supplies no valid conflict/clean comparison or late-task time to main. Earlier attempts remain visible below.\n\n` +
    'Synthetic no-model diagnostics are separate from scored agent results. Protocol wall starts after all ten workspaces are prepared; cell wall also includes preparation and grading. Late-task time to main starts at that task’s dispatch, after its registered release offset. Receipt gates deliberately control predecessor order, so conflict versus clean differences are descriptive, not natural queue-latency estimates.\n\n' +
    table(
      [
        'Cell',
        'Arm',
        'Scenario',
        'Release',
        'Prep s',
        'Protocol wall s',
        'Cell wall s',
        'Late task',
        'Late TTM s',
        'Late recoveries',
        'Model tokens',
      ],
      cells.flatMap(c => {
        const late = c.replay.lateTasks.length
          ? c.replay.lateTasks
          : [{ task: '—', timeToMainSeconds: null, recoveries: null }];
        return late.map(task => [
          c.cellId,
          c.arm,
          c.kind,
          c.replay.release ?? '—',
          fmt(c.replay.prepSeconds),
          fmt(c.replay.protocolSeconds),
          fmt(c.perCell.wallSeconds),
          task.task,
          fmt(task.timeToMainSeconds),
          fmt(task.recoveries),
          fmt(c.replay.modelTokens),
        ]);
      }),
    ) +
    attempts
  );
}

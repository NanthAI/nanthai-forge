// SPDX-License-Identifier: Apache-2.0
import type { MetricRecords, MetricPeriod } from './self-metrics-types.js';
import { observations, time } from './self-metrics-joins.js';
/** Sweep exact-State results against accepted main. Only a passing current head ends red. */
export function calculateRedMainMetrics(records: MetricRecords, period: MetricPeriod) {
  const events = observations(records).filter(e => time(e.at) <= time(period.asOf ?? period.to));
  const results = [
    ...events.filter(e => e.type === 'full-result'),
    ...records.runs.flatMap(run =>
      !run.reusedFrom && run.fullSuite && run.head && run.endedAt && ['failed', 'passed'].includes(run.status)
        ? [
            {
              type: 'full-result' as const,
              id: `run:${run.id}`,
              at: run.endedAt,
              head: run.head,
              source: 'forge' as const,
              status: run.status as 'failed' | 'passed',
            },
          ]
        : [],
    ),
  ];
  const moves = [...new Map(records.moves.map(move => [move.id, move])).values()].sort(
    (a, b) => time(a.at) - time(b.at),
  );
  const culpritIds = new Set(events.filter(e => e.type === 'culprit').map(e => e.landingId));
  const culpritHeads = moves.filter(move => culpritIds.has(move.id)).map(move => move.head);
  const from = time(period.from),
    to = Math.min(time(period.to), time(period.asOf ?? period.to));
  const bySource = (['forge', 'github-verify'] as const).map(source => {
    const selected = results.filter(result => result.source === source && time(result.at) <= to);
    const timeline = [
      ...moves.map(move => ({ at: time(move.at), move })),
      ...selected.map(result => ({ at: time(result.at), result })),
    ].sort((a, b) => a.at - b.at || ('move' in a ? -1 : 1));
    let head: string | undefined,
      red = false,
      last = timeline[0]?.at ?? from;
    const clearedCulprits = new Set<string>();
    const clearCulprits = (at: number) => {
      for (const move of moves)
        if (culpritIds.has(move.id) && time(move.at) <= at) clearedCulprits.add(move.head);
    };
    const known = new Map<string, 'failed' | 'passed'>(),
      days = new Map<string, number>();
    const add = (start: number, stop: number) => {
      for (let at = Math.max(start, from); at < Math.min(stop, to);) {
        const day = new Date(at).toISOString().slice(0, 10),
          end = Math.min(stop, to, time(`${day}T00:00:00Z`) + 86_400_000);
        days.set(day, (days.get(day) ?? 0) + (end - at) / 60_000);
        at = end;
      }
    };
    for (const event of timeline) {
      if (event.at > to) break;
      if (red) add(last, event.at);
      if ('move' in event) {
        head = event.move.head;
        if (known.get(head) === 'passed') {
          red = false;
          clearCulprits(event.at);
        } else if (
          known.get(head) === 'failed' ||
          (source === 'forge' &&
            culpritHeads.some(
              culprit =>
                !clearedCulprits.has(culprit) &&
                (culprit === head || event.move.ancestorHeads?.includes(culprit)),
            ))
        )
          red = true;
      } else {
        known.set(event.result.head, event.result.status);
        if (head === event.result.head) {
          red = event.result.status === 'failed';
          if (!red) clearCulprits(event.at);
        }
      }
      last = event.at;
    }
    if (red) add(last, to);
    const complete = records.coverage?.[source === 'forge' ? 'fullResults' : 'mirrorResults'];
    const unavailable = source === 'forge' && records.fullResultsUnavailable;
    return {
      source,
      partial: !!unavailable || !complete || time(complete) > from,
      minutes:
        !unavailable && (days.size || (complete && time(complete) <= from))
          ? [...days.values()].reduce((n, m) => n + m, 0)
          : null,
      days: unavailable
        ? []
        : [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, minutes]) => ({ day, minutes })),
      open: unavailable ? null : red,
    };
  });
  return {
    partial: bySource.some(row => row.partial),
    gaps: [
      ...(records.fullResultsUnavailable ? [records.fullResultsUnavailable] : []),
      'Forge full-suite results and public GitHub Verify are reported separately. Missing exact-State or mirror-to-State mappings remain partial; no result is inferred from a Candidate status. Culprit descendants count from their accepted main records.',
    ],
    sources: bySource,
  };
}

/** Revision-pinned hosted audit exports. Classification can move the start back
 * to a named culprit's landing; an unknown culprit never invents a landing time. */
export type HostedMainAuditEvent = {
  projectId: string;
  kind: 'red' | 'green' | 'flake' | 'stalled' | 'culprit';
  at: string;
  head: string;
  runId: string;
  sequence: number;
  culprit?: string;
};
export function calculateHostedRedMainMetrics(
  events: HostedMainAuditEvent[],
  period: MetricPeriod,
  moves: MetricRecords['moves'] = [],
  coverageFrom?: string,
) {
  const from = time(period.from),
    to = Math.min(time(period.to), time(period.asOf ?? period.to));
  const landings = new Map(moves.map(move => [move.id, time(move.at)]));
  const byProject = new Map<string, HostedMainAuditEvent[]>();
  for (const event of events) {
    if (time(event.at) > to) continue;
    const rows = byProject.get(event.projectId) ?? [];
    rows.push(event);
    byProject.set(event.projectId, rows);
  }
  let minutes = 0;
  const open: string[] = [];
  for (const [projectId, rows] of byProject) {
    rows.sort((a, b) => time(a.at) - time(b.at));
    let since: number | undefined;
    let greenSequence = -1;
    let redSequence = -1;
    for (const event of rows) {
      if (event.kind === 'red' && event.sequence > greenSequence) {
        since ??= time(event.at);
        redSequence = Math.max(redSequence, event.sequence);
      }
      if (event.kind === 'culprit' && since !== undefined && event.culprit && landings.has(event.culprit))
        since = Math.min(since, landings.get(event.culprit)!);
      if ((event.kind === 'green' || event.kind === 'flake') && event.sequence >= redSequence) {
        greenSequence = Math.max(greenSequence, event.sequence);
        if (since !== undefined)
          minutes += Math.max(0, Math.min(to, time(event.at)) - Math.max(from, since)) / 60_000;
        since = undefined;
      }
    }
    if (since !== undefined) {
      minutes += Math.max(0, to - Math.max(from, since)) / 60_000;
      open.push(projectId);
    }
  }
  return { minutes, open, partial: !coverageFrom || time(coverageFrom) > from };
}

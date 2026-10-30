// SPDX-License-Identifier: Apache-2.0
import type { MetricObservation } from './self-metrics-observation-schema.js';
import type { MetricPeriod, MetricRecords } from './self-metrics-types.js';
export const time = (at: string) => Date.parse(at);
export const during = (at: string, p: MetricPeriod) => time(at) >= time(p.from) && time(at) < time(p.to);
export const ratio = (n: number, d: number) => (d ? n / d : null);
export function observations(records: MetricRecords): MetricObservation[] {
  return [
    ...new Map(
      [
        ...(records.observations ?? []),
        ...records.receipts.flatMap(r => (r.observation ? [r.observation] : [])),
      ]
        .sort((a, b) => time(b.at) - time(a.at))
        .map(row => [row.id, row]),
    ).values(),
  ].sort((a, b) => time(a.at) - time(b.at));
}
export const percentile = (values: number[], p: number) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]! : null;
export function calculateOverlapMetrics(records: MetricRecords, period: MetricPeriod) {
  const events = observations(records),
    end = Math.min(time(period.to), time(period.asOf ?? period.to));
  const saves = events.filter(e => e.type === 'save');
  const deliveries = events.filter(e => e.type === 'overlap-delivery');
  type Answer = Extract<MetricObservation, { type: 'overlap-answer' }>;
  const answers = new Map<string, Answer[]>();
  for (const event of events) {
    if (event.type !== 'overlap-answer' || time(event.at) > end) continue;
    const keys = [
      event.deliveryId,
      ...(event.laneId && event.noticeId ? [`notice:${event.laneId}:${event.noticeId}`] : []),
    ];
    for (const key of keys) {
      const group = answers.get(key) ?? [];
      group.push(event);
      answers.set(key, group);
    }
  }
  const answerFor = (delivery: (typeof deliveries)[number]) =>
    [delivery.id, ...delivery.noticeIds.map(id => `notice:${delivery.laneId}:${id}`)]
      .flatMap(key => answers.get(key) ?? [])
      .filter(answer => time(answer.at) >= time(delivery.at))
      .sort((a, b) => time(a.at) - time(b.at))[0];

  const rows = saves
    .filter(save => during(save.at, period) && time(save.at) <= end && save.overlaps.length)
    .map(save => {
      const next = saves.find(other => other.laneId === save.laneId && time(other.at) > time(save.at));
      const paths = new Set(save.overlaps.flatMap(peer => peer.paths));
      const delivery = deliveries.find(
        d =>
          d.laneId === save.laneId &&
          ((d.via === 'hook' && d.head === save.parent && time(d.at) <= time(save.at)) ||
            (d.head === save.head && time(d.at) >= time(save.at))) &&
          time(d.at) <= end &&
          (!next || time(d.at) < time(next.at)) &&
          d.paths.some(path => paths.has(path)),
      );
      const answer = delivery && answerFor(delivery);
      return {
        saveId: save.id,
        laneId: save.laneId,
        head: save.head,
        deliveryId: delivery?.id ?? null,
        deliverySeconds: delivery ? Math.max(0, (time(delivery.at) - time(save.at)) / 1000) : null,
        disposition: answer?.type === 'overlap-answer' ? answer.disposition : null,
      };
    });
  const firstWrites = deliveries.filter(d => d.via === 'hook' && during(d.at, period) && time(d.at) <= end);
  const firstWriteAnswers = firstWrites.filter(delivery => answerFor(delivery));
  const answeredIds = new Set(firstWriteAnswers.map(delivery => delivery.id));
  // One first write can alert about several peers. Count the edit once, and
  // require answers to every delivered notice before calling that write acknowledged.
  const byWrite = new Map<string, typeof firstWrites>();
  for (const delivery of firstWrites) {
    const id = delivery.firstWriteId ?? delivery.id;
    const group = byWrite.get(id) ?? [];
    group.push(delivery);
    byWrite.set(id, group);
  }
  for (const [id, group] of byWrite) {
    const first = group[0]!;
    const complete = group.every(delivery => answeredIds.has(delivery.id));
    rows.push({
      saveId: id,
      laneId: first.laneId,
      head: first.head,
      deliveryId: id,
      deliverySeconds: 0,
      disposition: complete
        ? group.some(delivery => answerFor(delivery)?.disposition === 'routed-around')
          ? 'routed-around'
          : 'acknowledged'
        : null,
    });
  }
  const count = rows.filter(row => row.deliveryId).length;
  const gaps = [
    ...(!saves.length || !records.coverage?.overlaps || time(records.coverage.overlaps) > time(period.from)
      ? [
          'Overlapping-save collection is partial; historical saves and first-write events were not uniformly recorded.',
        ]
      : []),
    ...(!records.coverage?.overlapAnswers || time(records.coverage.overlapAnswers) > time(period.from)
      ? ['Acknowledgement and routed-around records do not cover the whole period.']
      : []),
    ...(saves.some(save => during(save.at, period) && !save.complete)
      ? ['Some save observations have incomplete active/unlanded peer coverage.']
      : []),
  ];
  return {
    partial: !!gaps.length,
    gaps,
    overlappingSaves: gaps.length && !rows.length ? null : rows.length,
    delivered: gaps.length && !rows.length ? null : count,
    deliveryRate: ratio(count, rows.length),
    medianDeliverySeconds: (() => {
      const values = rows
        .flatMap(row => (row.deliverySeconds === null ? [] : [row.deliverySeconds]))
        .sort((a, b) => a - b);
      return values.length
        ? (values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2
        : null;
    })(),
    firstWrites: byWrite.size,
    firstWriteAlerts: firstWrites.length,
    firstWriteAcknowledgedOrRouted: firstWriteAnswers.length,
    firstWriteAcknowledgementRate: ratio(firstWriteAnswers.length, firstWrites.length),
    acknowledgedOrRouted: rows.filter(row => row.disposition).length,
    acknowledgementRate:
      firstWrites.length ||
      (records.coverage?.overlapAnswers && time(records.coverage.overlapAnswers) <= time(period.from))
        ? ratio(rows.filter(row => row.disposition).length, count)
        : null,
    rows,
  };
}
function contradictionMinutes(events: MetricObservation[], period: MetricPeriod) {
  const samples = events.filter(e => e.type === 'surface');
  const keys = [...new Set(samples.map(e => `${e.surface}\0${e.entity}`))];
  const intervals: [number, number][] = [];
  const end = Math.min(time(period.to), time(period.asOf ?? period.to));
  for (const key of keys) {
    const rows = samples.filter(e => `${e.surface}\0${e.entity}` === key);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.authority === row.displayed) continue;
      const start = Math.max(time(row.at), time(period.from)),
        stop = Math.min(time(rows[i + 1]?.at ?? period.to), end);
      if (stop > start) intervals.push([start, stop]);
    }
  }
  // Any contradictory surface counts once, even when several pages disagree simultaneously.
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const interval of intervals) {
    const prior = merged.at(-1);
    if (prior && interval[0] <= prior[1]) prior[1] = Math.max(prior[1], interval[1]);
    else merged.push([...interval]);
  }
  const days = new Map<string, number>();
  for (const [start, end] of merged)
    for (let at = start; at < end;) {
      const day = new Date(at).toISOString().slice(0, 10),
        stop = Math.min(end, time(`${day}T00:00:00Z`) + 86_400_000);
      days.set(day, (days.get(day) ?? 0) + (stop - at) / 60_000);
      at = stop;
    }
  return {
    minutes: [...days.values()].reduce((a, b) => a + b, 0),
    days: [...days].map(([day, minutes]) => ({ day, minutes })),
  };
}
export function calculateAuthorityMetrics(records: MetricRecords, period: MetricPeriod) {
  const events = observations(records);
  const revisions = events.filter(e => e.type === 'revision');
  const modes = (['owner-hosted', 'hosted-cache'] as const).map(mode => {
    const rows = revisions
      .filter(
        r =>
          r.mode === mode &&
          r.side === 'authority' &&
          during(r.at, period) &&
          time(r.at) <= time(period.asOf ?? period.to),
      )
      .map(authority => {
        const peers = revisions.filter(
          r => r.mode === mode && r.stream === authority.stream && r.side === 'replica',
        );
        const before = peers.filter(r => time(r.at) <= time(authority.at)).at(-1);
        const caught = peers.find(
          r =>
            r.revision >= authority.revision &&
            time(r.at) >= time(authority.at) &&
            time(r.at) <= time(period.asOf ?? period.to),
        );
        return {
          id: authority.id,
          day: new Date(authority.at).toISOString().slice(0, 10),
          timeBasis: authority.timeBasis ?? 'commit',
          revisionLag: before ? Math.max(0, authority.revision - before.revision) : null,
          seconds:
            before && before.revision >= authority.revision
              ? 0
              : caught
                ? (time(caught.at) - time(authority.at)) / 1000
                : null,
        };
      });
    const days = [...new Set(rows.map(row => row.day))].sort().map(day => {
      const selected = rows.filter(row => row.day === day),
        lag = selected.flatMap(row => (row.revisionLag === null ? [] : [row.revisionLag])),
        seconds = selected.flatMap(row => (row.seconds === null ? [] : [row.seconds]));
      return {
        day,
        revisions: selected.length,
        pending: selected.filter(row => row.seconds === null).length,
        revisionLagP50: percentile(lag, 0.5),
        revisionLagP95: percentile(lag, 0.95),
        secondsP50: percentile(seconds, 0.5),
        secondsP95: percentile(seconds, 0.95),
      };
    });
    return {
      mode,
      partial:
        !rows.length ||
        rows.some(
          row => row.revisionLag === null || row.seconds === null || row.timeBasis === 'observation',
        ) ||
        !records.coverage?.authority ||
        time(records.coverage.authority) > time(period.from),
      days,
      rows,
    };
  });
  const surfaceCoverage =
    !!records.coverage?.surfaces && time(records.coverage.surfaces) <= time(period.from);
  const contradictions = contradictionMinutes(events, period);
  return {
    partial: modes.some(mode => mode.partial) || !surfaceCoverage,
    gaps: [
      ...(modes.some(mode => mode.partial)
        ? [
            'Revision observations are incomplete or pending; missing catch-up time is unknown, never zero. Revision streams are comparable only within an authority epoch. Cache authority timestamps observed on writes measure a lower bound from observation, not the unobserved hosted commit time.',
          ]
        : []),
      ...(!surfaceCoverage
        ? [
            'Surface observations do not cover all CLI, MCP and hosted pages for the period. Contradiction minutes are a measured lower bound.',
          ]
        : []),
    ],
    modes,
    contradictionMinutes: surfaceCoverage || contradictions.minutes ? contradictions.minutes : null,
    contradictionDays: contradictions.days,
  };
}

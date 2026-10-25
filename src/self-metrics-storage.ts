// SPDX-License-Identifier: Apache-2.0
import type { MetricRecords, MetricPeriod } from './self-metrics-types.js';
import { observations, time, ratio, during } from './self-metrics-joins.js';
/** Growth compares retained physical-byte observations, never forecasts missing scans as zero. */
export function calculateStorageMetrics(records: MetricRecords, period: MetricPeriod) {
  const end = Math.min(time(period.to), time(period.asOf ?? period.to));
  const moves = [...new Map(records.moves.map(move => [move.id, move])).values()];
  const samples = [...(records.diskSamples ?? records.receipts.flatMap(r => (r.disk ? [r.disk] : [])))]
    .filter(s => time(s.at) <= end)
    .sort((a, b) => time(a.at) - time(b.at));
  const first =
    samples.filter(s => time(s.at) <= time(period.from)).at(-1) ?? samples.find(s => during(s.at, period));
  const last = samples.at(-1),
    total = (s: NonNullable<typeof first>) => Object.values(s.localBytes).reduce((n, bytes) => n + bytes, 0);
  const days = first && last ? (time(last.at) - time(first.at)) / 86_400_000 : 0;
  const growth = first?.complete && last?.complete && days > 0 ? total(last) - total(first) : null;
  const landings = moves.filter(
    m => m.kind === 'landing' && first && last && time(m.at) > time(first.at) && time(m.at) <= time(last.at),
  ).length;
  const hosted = observations(records)
    .filter(e => e.type === 'storage')
    .filter(e => time(e.at) <= end);
  const remote = hosted.at(-1),
    remoteFirst =
      hosted.filter(s => time(s.at) <= time(period.from)).at(-1) ?? hosted.find(s => during(s.at, period));
  const remoteDays = remote && remoteFirst ? (time(remote.at) - time(remoteFirst.at)) / 86_400_000 : 0;
  const growthFor = (key: 'hostedBytes' | 'r2Bytes') => {
    const bytes =
      remoteDays > 0 && remote && remoteFirst && remote[key] !== null && remoteFirst[key] !== null
        ? remote![key]! - remoteFirst![key]!
        : null;
    const landed = moves.filter(
      m =>
        m.kind === 'landing' &&
        remote &&
        remoteFirst &&
        time(m.at) > time(remoteFirst.at) &&
        time(m.at) <= time(remote.at),
    ).length;
    return {
      bytes,
      bytesPerDay: bytes === null ? null : bytes / remoteDays,
      bytesPerLanding: bytes === null ? null : ratio(bytes, landed),
    };
  };
  return {
    partial:
      !last?.complete ||
      !first?.complete ||
      growth === null ||
      !remote ||
      remote.hostedBytes === null ||
      remote.r2Bytes === null,
    gaps: [
      'Local bytes are measured file lengths by disjoint kind; shared source objects belong to objects, snapshot metadata to snapshots. Bounded incomplete scans report lower bounds. Hosted/R2 bytes require retained write-side accounting observations, never a storage poll.',
    ],
    sample: last ?? null,
    hostedBytes: remote?.hostedBytes ?? null,
    r2Bytes: remote?.r2Bytes ?? null,
    hostedBasis: remote?.basis ?? null,
    growthBytes: growth,
    growthBytesPerDay: growth === null ? null : growth / days,
    growthBytesPerLanding: growth === null ? null : ratio(growth, landings),
    hostedGrowth: growthFor('hostedBytes'),
    r2Growth: growthFor('r2Bytes'),
    landings,
    warning: last?.warning ?? null,
  };
}

// SPDX-License-Identifier: Apache-2.0
import type { MetricRecords, MetricPeriod } from './self-metrics-types.js';
import { observations, during, time, ratio } from './self-metrics-joins.js';
/** Bills, including real zero bills, are authoritative. Never infer an invoice from an estimate. */
export function calculateBillingMetrics(records: MetricRecords, period: MetricPeriod) {
  const bills = observations(records)
    .filter(e => e.type === 'bill')
    .filter(e => time(e.at) <= time(period.asOf ?? period.to));
  const moves = [
    ...new Map(
      records.moves
        .filter(m => m.kind === 'landing' && time(m.at) <= time(period.asOf ?? period.to))
        .map(m => [m.id, m]),
    ).values(),
  ];
  const months = [
    ...new Set([
      ...bills.map(b => b.month),
      ...moves.filter(m => during(m.at, period)).map(m => new Date(m.at).toISOString().slice(0, 7)),
    ]),
  ]
    .filter(
      month =>
        time(`${month}-01T00:00:00Z`) < time(period.to) &&
        time(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1)).toISOString()) >
          time(period.from),
    )
    .sort()
    .map(month => {
      const selected = bills.filter(b => b.month === month),
        landings = moves.filter(m => new Date(m.at).toISOString().startsWith(month));
      const byLanding = landings.map(move => ({
        landingId: move.id,
        billedUsd: 0,
        listUsd: 0 as number | null,
        estimateUsd: 0 as number | null,
        billIds: [] as string[],
      }));
      let unallocatedUsd = 0;
      for (const bill of selected) {
        let targets = bill.landingIds
          ? byLanding.filter(row => bill.landingIds!.includes(row.landingId))
          : [];
        if (!bill.landingIds && bill.runIds?.length) {
          const inputs = records.runs.filter(run => bill.runIds!.includes(run.id)).flatMap(run => run.inputs);
          targets = byLanding.filter(row =>
            landings
              .find(move => move.id === row.landingId)!
              .inputs.some(input => inputs.some(i => i.laneId === input.laneId && i.head === input.head)),
          );
        }
        // Failed checks, continuous audit and shared hosting/storage are monthly landing overhead.
        if (!targets.length && !bill.landingIds) targets = byLanding;
        if (!targets.length) unallocatedUsd += bill.billedUsd;
        for (const row of targets) {
          row.billedUsd += bill.billedUsd / targets.length;
          row.listUsd =
            row.listUsd === null || bill.listUsd === null
              ? null
              : row.listUsd + bill.listUsd / targets.length;
          row.estimateUsd =
            row.estimateUsd === null || bill.estimateUsd === null
              ? null
              : row.estimateUsd + bill.estimateUsd / targets.length;
          row.billIds.push(bill.id);
        }
      }
      const billedUsd = selected.length ? selected.reduce((n, bill) => n + bill.billedUsd, 0) : null;
      const listUsd =
        !selected.length || selected.some(b => b.listUsd === null)
          ? null
          : selected.reduce((n, bill) => n + bill.listUsd!, 0);
      const estimateUsd =
        !selected.length || selected.some(b => b.estimateUsd === null)
          ? null
          : selected.reduce((n, bill) => n + bill.estimateUsd!, 0);
      const missingProviders = (
        ['modal', 'blacksmith', 'github-actions', 'convex', 'netlify', 'r2'] as const
      ).filter(provider => !selected.some(bill => bill.provider === provider));
      return {
        month,
        partial: !!missingProviders.length || listUsd === null || estimateUsd === null,
        missingProviders,
        landings: landings.length,
        billedUsd,
        listUsd,
        estimateUsd,
        billedUsdPerLanding: billedUsd === null ? null : ratio(billedUsd, landings.length),
        listUsdPerLanding: listUsd === null ? null : ratio(listUsd, landings.length),
        estimatorError:
          billedUsd === null || estimateUsd === null ? null : ratio(estimateUsd - billedUsd, billedUsd),
        estimatorErrorBasis:
          billedUsd === 0 ? 'Undefined: recorded bill is zero.' : '(estimate - bill) / bill',
        unallocatedUsd,
        bills: selected,
        rows: byLanding.map(row => ({
          ...row,
          billedUsd: row.billIds.length ? row.billedUsd : null,
          listUsd: row.billIds.length ? row.listUsd : null,
          estimateUsd: row.billIds.length ? row.estimateUsd : null,
        })),
      };
    });
  return {
    partial: !months.length || months.some(month => month.partial),
    gaps: [
      "Only entered project bills are included. Missing provider/month bills, list prices and estimates stay partial. Run-linked bills join exact saved inputs; unjoined runs and shared services are allocated evenly over the month's ordinary landings.",
    ],
    months,
  };
}

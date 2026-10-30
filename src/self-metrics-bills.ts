// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './portable-hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { metricObservationSchema, type MetricObservation } from './self-metrics-observation-schema.js';
import type { MetricPeriod, MetricRecords } from './self-metrics-types.js';
import { ratio, time } from './self-metrics-joins.js';

const amount = z.number().finite().nonnegative();
const unit = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const quantities = z.record(unit, amount).refine(value => Object.keys(value).length <= 16);
/** Providers with a current hosted price basis. Modal and Blacksmith are retired, retained for old bills. */
export const billProviders = ['convex', 'github-actions', 'r2', 'netlify', 'blacksmith', 'modal'] as const;
export const currentBillProviders = ['convex', 'github-actions', 'r2', 'netlify'] as const;
/** One owner-entered provider bill for a billing period. Billed dollars come only
 * from the provider invoice or dashboard; Forge never derives them. */
export const hostedBillSchema = z
  .object({
    operationId: z.string().regex(/^[a-f0-9]{64}$|^[0-9a-f-]{36}$/),
    provider: z.enum(billProviders),
    periodFrom: z.iso.datetime(),
    periodTo: z.iso.datetime(),
    billedUsd: amount,
    listUsd: amount.nullable(),
    // Provider dashboard usage and the configured price basis (USD per unit).
    usage: quantities,
    rates: quantities,
    basis: z.string().min(1).max(500),
  })
  .strict()
  .refine(bill => Date.parse(bill.periodFrom) < Date.parse(bill.periodTo), 'Use a billing period [from,to).');
export type HostedBill = z.infer<typeof hostedBillSchema>;
export type RecordedBill = HostedBill & { at: string; actor: string };
/** Identical owner input gives the same operation, so a repeated command reconciles. */
export function billOperationId(bill: Omit<HostedBill, 'operationId'>) {
  return digest(canonicalPayload(bill));
}
/** Forge's own counters for a provider. Only Actions has one today: retained shard minutes. */
export function forgeBillCounters(records: MetricRecords, bill: HostedBill) {
  if (bill.provider !== 'github-actions') return null;
  const runs = records.runs.filter(
    run =>
      !run.reusedFrom &&
      run.started !== false &&
      time(run.at) >= time(bill.periodFrom) &&
      time(run.at) < time(bill.periodTo),
  );
  const unknownRuns = runs.filter(run => run.runnerMinutes === undefined).length;
  return {
    'runner-minute': runs.reduce((n, run) => n + (run.runnerMinutes ?? 0), 0),
    unknownRuns,
  };
}
/** Corrections replace the earlier record for the same provider and period start. */
export function currentBills(bills: RecordedBill[]) {
  const latest = new Map<string, RecordedBill>();
  for (const bill of bills) {
    const key = `${bill.provider}:${bill.periodFrom}`;
    const old = latest.get(key);
    if (!old || old.at < bill.at || (old.at === bill.at && old.operationId < bill.operationId))
      latest.set(key, bill);
  }
  return [...latest.values()].sort(
    (a, b) => a.periodFrom.localeCompare(b.periodFrom) || a.provider.localeCompare(b.provider),
  );
}
/** Estimate = quantity x configured rate. A Forge counter replaces dashboard usage for its unit. */
export function billEstimate(bill: HostedBill, counters: ReturnType<typeof forgeBillCounters>) {
  const usage: Record<string, number> = { ...bill.usage };
  if (counters) usage['runner-minute'] = counters['runner-minute'];
  const priced = Object.keys(usage).filter(key => key in bill.rates);
  const unpriced = Object.keys(usage).filter(key => !(key in bill.rates));
  return {
    estimateUsd: priced.length ? priced.reduce((n, key) => n + usage[key]! * bill.rates[key]!, 0) : null,
    usage,
    unpriced,
    source: counters ? ('forge-counter' as const) : ('owner-usage' as const),
  };
}
export function billObservation(bill: RecordedBill, estimateUsd: number | null): MetricObservation {
  return metricObservationSchema.parse({
    type: 'bill',
    id: bill.operationId,
    at: bill.at,
    month: bill.periodFrom.slice(0, 7),
    provider: bill.provider,
    billedUsd: bill.billedUsd,
    listUsd: bill.listUsd,
    estimateUsd,
    basis: bill.basis,
  });
}
/** Per-bill-period $/landing and estimator error; the provider cycle, not the calendar month. */
export function calculateBillPeriods(records: MetricRecords, period: MetricPeriod) {
  const landings = [...new Map(records.moves.filter(m => m.kind === 'landing').map(m => [m.id, m])).values()];
  const bills = currentBills(records.bills ?? []).filter(
    bill => time(bill.periodFrom) < time(period.to) && time(bill.periodTo) > time(period.from),
  );
  return bills.map(bill => {
    const counters = forgeBillCounters(records, bill);
    const estimate = billEstimate(bill, counters);
    const count = landings.filter(
      m => time(m.at) >= time(bill.periodFrom) && time(m.at) < time(bill.periodTo),
    ).length;
    const gaps = [
      ...(records.billHistoryFrom && time(bill.periodFrom) < time(records.billHistoryFrom)
        ? [`Landings before ${records.billHistoryFrom} were not read; landing count is a lower bound.`]
        : []),
      ...(counters?.unknownRuns
        ? [`${counters.unknownRuns} runs lack shard execution durations; Forge minutes are a lower bound.`]
        : []),
      ...(estimate.unpriced.length ? [`No configured rate for: ${estimate.unpriced.join(', ')}.`] : []),
      ...(!counters ? ['Forge has no counter for this provider; estimate uses owner-entered usage.'] : []),
    ];
    return {
      id: bill.operationId,
      provider: bill.provider,
      from: bill.periodFrom,
      to: bill.periodTo,
      recordedAt: bill.at,
      billedUsd: bill.billedUsd,
      listUsd: bill.listUsd,
      landings: count,
      billedUsdPerLanding: ratio(bill.billedUsd, count),
      estimateUsd: estimate.estimateUsd,
      estimateSource: estimate.source,
      usage: estimate.usage,
      rates: bill.rates,
      // Zero bills are real; the relative error is undefined, never 0.
      estimatorError:
        estimate.estimateUsd === null || bill.billedUsd === 0
          ? null
          : (estimate.estimateUsd - bill.billedUsd) / bill.billedUsd,
      estimatorErrorBasis:
        bill.billedUsd === 0 ? 'Undefined: recorded bill is zero.' : '(estimate - bill) / bill',
      partial: gaps.length > 0,
      gaps,
    };
  });
}
const billPage = z.object({
  page: z.array(z.unknown()).max(100),
  isDone: z.boolean(),
  continueCursor: z.string(),
});
/** Full reports only. A missing module is a visible gap, never a zero bill. */
export async function readHostedBills(
  query: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  period: MetricPeriod,
  records: MetricRecords,
) {
  const bills: RecordedBill[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  try {
    do {
      const raw = await query('projectSelfMetricBills:page', { from: period.from, to: period.to, cursor });
      const page = billPage.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
      for (const row of page.page) {
        const { at, actor, ...bill } = row as { at: string; actor: string };
        bills.push({
          ...hostedBillSchema.parse(bill),
          at: z.iso.datetime().parse(at),
          actor: z.string().parse(actor),
        });
      }
      if (page.isDone || !page.continueCursor || seen.has(page.continueCursor)) break;
      seen.add(page.continueCursor);
      cursor = page.continueCursor;
    } while (cursor);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/(?:Could not find (?:public )?function|function[^\n]*not found|no function)[^\n]*projectSelfMetricBills/i.test(
        error.message,
      )
    )
      throw error;
    records.gaps.push('Hosted bills need the deployed projectSelfMetricBills module.');
    return;
  }
  records.bills = bills;
  const current = currentBills(bills);
  records.observations = [
    ...(records.observations ?? []),
    ...current.map(bill =>
      billObservation(bill, billEstimate(bill, forgeBillCounters(records, bill)).estimateUsd),
    ),
  ];
}

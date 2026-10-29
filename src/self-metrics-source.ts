// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readHostState } from './host-binding.js';
import { nativeOwner } from './native-source.js';
import { sourceAuthority } from './hosted-source-authority.js';
import { hostedAgentAddress } from './hosted-agent-cli.js';
import { ConvexExchange } from './exchange-client.js';
import { makeFunctionReference } from 'convex/server';
import { nativeSelfMetricsReader } from './self-metrics-native.js';
import { readHostedMetricPages, type MetricQuery } from './self-metrics-hosted-pages.js';
import type { WorkStore } from './work-store.js';
import type { MetricRecords, MetricPeriod } from './self-metrics-types.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { metricsHeadline } from './self-metrics-format.js';
import { metricPeriod, metricTotals } from './self-metrics-surface.js';

/** Inspect only retained addressing. Never construct a WorkStore or wake an owner. */
export function metricAddress(root: string): { owner: string; address: HostedAgentAddress | null } {
  const owner = nativeOwner(realpathSync(root)) ?? realpathSync(root);
  const binding = readHostState({ directory: join(owner, '.forge', 'work') } as WorkStore).binding;
  return {
    owner,
    address: binding
      ? sourceAuthority(binding).mode === 'server'
        ? { url: binding.deployment, projectId: binding.projectId }
        : null
      : hostedAgentAddress(root, {}),
  };
}
export function metricQuery(address: HostedAgentAddress): MetricQuery {
  const exchange = new ConvexExchange(address.url, process.env.FORGE_AUTH_TOKEN, address.projectId, '', null);
  return (name, args) =>
    exchange.client.query(makeFunctionReference<'query'>(name), { ...args, projectId: address.projectId });
}
/** Join by authority time, retaining context on each side but never counting a
 * stale post-cutover native move. The seam itself is always visible in coverage. */
export function joinMetricAuthority(
  native: MetricRecords,
  hosted: MetricRecords,
  cutover: string,
): MetricRecords {
  const before = (row: { at: string }) => Date.parse(row.at) < Date.parse(cutover);
  const after = (row: { at: string }) => !before(row);
  const merge = <T extends { at: string }>(left: T[], right: T[]) => [
    ...left.filter(before),
    ...right.filter(after),
  ];
  const seam = `Authority seam at ${cutover}: native before cutover, hosted at/after cutover; authority epochs and collection gaps remain separate.`;
  return {
    ...hosted,
    moves: merge(native.moves, hosted.moves),
    submissions: merge(native.submissions, hosted.submissions),
    runs: merge(native.runs, hosted.runs),
    receipts: merge(native.receipts, hosted.receipts),
    observations: merge(native.observations ?? [], hosted.observations ?? []),
    checkRequests: merge(native.checkRequests ?? [], hosted.checkRequests ?? []),
    finishTimings: merge(native.finishTimings ?? [], hosted.finishTimings ?? []),
    diskSamples: (native.diskSamples ?? []).filter(before),
    surfaceGaps: [...(native.surfaceGaps ?? []), ...(hosted.surfaceGaps ?? []), seam],
    gaps: [...native.gaps, ...hosted.gaps, seam],
    source: { ...hosted.source, kind: 'joined' },
  };
}
export async function readMetricRecords(
  root: string,
  period: MetricPeriod,
  options: {
    pointer?: Buffer | null | undefined;
    query?: MetricQuery;
    summary?: boolean;
    address?: HostedAgentAddress;
  } = {},
) {
  const selected = options.address ? { owner: root, address: options.address } : metricAddress(root);
  if (!selected.address)
    return nativeSelfMetricsReader(
      selected.owner,
      options.pointer ? { pointer: options.pointer } : {},
    ).read();
  const { records, cutover } = await readHostedMetricPages(
    options.query ?? metricQuery(selected.address),
    period,
    options.summary,
  );
  if (cutover && Date.parse(period.from) < Date.parse(cutover)) {
    // Hosted-only checkouts have no owner history. Do not manufacture native evidence.
    try {
      const native = await nativeSelfMetricsReader(
        selected.owner,
        options.pointer ? { pointer: options.pointer } : {},
      ).read();
      return joinMetricAuthority(native, records, cutover);
    } catch (error) {
      if (!(error instanceof Error) || !/Owner Work records are unavailable|ENOENT/.test(error.message))
        throw error;
      records.surfaceGaps!.push(
        `Authority seam at ${cutover}: pre-cutover native records are unavailable in this checkout.`,
      );
    }
  } else if (!cutover)
    records.surfaceGaps!.push(
      'Hosted cutover timestamp is unavailable; native history cannot be joined safely.',
    );
  return records;
}
/** Four page calls maximum; no full-history metric calculation on the status path. */
export async function hostedStatusMetrics(root: string, now = new Date().toISOString(), query?: MetricQuery) {
  const selected = metricAddress(root);
  if (!selected.address) return null;
  const period = metricPeriod(undefined, undefined, now);
  // Do not hydrate native history in the bounded status reader.
  const { records, cutover } = await readHostedMetricPages(
    query ?? metricQuery(selected.address),
    period,
    true,
  );
  if (!cutover || period.from < cutover)
    records.surfaceGaps!.push('Status omits pre-cutover native context; read metrics for the joined window.');
  return { period, ...metricsHeadline(metricTotals(records, period, { headline: true })) };
}

/** Async status surfaces replace the native-cache metric section after their
 * existing local status read. Native authority incurs no network calls. */
export async function withHostedStatusMetrics<T extends object>(root: string, status: T) {
  const metrics = await hostedStatusMetrics(root);
  return metrics ? { ...status, metrics } : status;
}

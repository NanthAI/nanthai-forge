// SPDX-License-Identifier: Apache-2.0
import { hostedAgentCommandSchemas, type HostedAgentAddress } from './hosted-agent-contract.js';
import { readMetricRecords } from './self-metrics-source.js';
import type { MetricQuery } from './self-metrics-hosted-pages.js';
import { metricPeriod, metricsSurface } from './self-metrics-surface.js';
import { pageMetrics } from './self-metrics-page.js';
import { networkDeadline, networkFailure } from './network-fetch.js';
import { withExchangeProgress } from './exchange-progress.js';
import { currentExchangeProgress } from './exchange-progress-hooks.js';
import { ForgeError } from './errors.js';

/** The whole metrics read, not only each page: it ends under an agent shell's
 * two-minute limit. Page reads grow with the window (about 70 s for 7 days at
 * 2026-11 dogfood size), so a larger window ends here with a typed next step. */
export const METRICS_DEADLINE_MS = 100_000;

export async function executeHostedMetrics(
  session: { root: string; address: HostedAgentAddress; query: MetricQuery },
  input: unknown,
  deadlineMs = METRICS_DEADLINE_MS,
) {
  const command = hostedAgentCommandSchemas.metrics.parse(input);
  const period = metricPeriod(command.from, command.to);
  return metricsDeadline(
    input,
    async () => {
      const [page, exactConflicts] = await Promise.all([
        pageMetrics(
          metricsSurface(
            await readMetricRecords(session.root, period, {
              address: session.address,
              query: session.query,
              contextDays: command.contextDays,
            }),
            period,
          ),
          period,
          command,
        ),
        exactConflictSummary(session.query, period),
      ]);
      return exactConflicts ? { ...page, exactConflicts } : page;
    },
    deadlineMs,
  );
}

/** Exact conflicts at save (flip 4): notices flagged in the window and the time from flag to the Lane's
 * first land. One read-only query; a server without it leaves the field out. */
async function exactConflictSummary(query: MetricQuery, period: { from: string; to: string }) {
  try {
    const value = await query('projectHostedConflicts:summary', {
      from: Date.parse(period.from),
      to: Date.parse(period.to),
    });
    const parsed = (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown> | null;
    return parsed && !('error' in parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** One budget for the whole action: callers that read capabilities first wrap
 * that call too, so discovery cannot add its own 120 s on top. Nested calls
 * share the outer signal; the earliest deadline wins. */
export async function metricsDeadline<T>(
  input: unknown,
  operation: () => Promise<T>,
  deadlineMs = METRICS_DEADLINE_MS,
): Promise<T> {
  try {
    // Cancellation reaches every in-flight page and object read through the exchange signal.
    return await networkDeadline(
      signal => withExchangeProgress({ signal }, operation),
      deadlineMs,
      currentExchangeProgress()?.signal,
      'metrics',
    );
  } catch (error) {
    if (
      !networkFailure(error) ||
      error.code !== 'EXCHANGE_REQUEST_TIMEOUT' ||
      !/^metrics /.test(error.message)
    )
      throw error;
    throw metricsTimeout(input, deadlineMs);
  }
}

function metricsTimeout(input: unknown, deadlineMs: number) {
  const parameters = { ...(input as Record<string, unknown> | undefined) };
  delete parameters.operationId;
  const command = hostedAgentCommandSchemas.metrics.safeParse(parameters);
  let period: { from: string; to: string } | undefined;
  try {
    if (command.success) period = metricPeriod(command.data.from, command.data.to);
  } catch {
    // An invalid window fails inside the action with its own BAD_ARGUMENT.
  }
  const to = period?.to ?? new Date().toISOString();
  // Never suggest a window larger than the one that failed: the later half, at least an hour.
  const span = period ? Date.parse(period.to) - Date.parse(period.from) : 86_400_000;
  const half = new Date(Date.parse(to) - Math.max(3_600_000, Math.floor(span / 2))).toISOString();
  const from = period && half < period.from ? period.from : half;
  return new ForgeError(
    'METRICS_TIMEOUT',
    `metrics did not finish within ${Math.round(deadlineMs / 1000)} s${period ? ` for [${period.from}, ${period.to})` : ''}; it reads the window plus a context horizon (contextDays, default 2) page by page. Nothing changed. Next: nforge agent ROOT metrics '${JSON.stringify({ from, to, contextDays: 1 })}' for the later part of the window with a one-day horizon.`,
  );
}

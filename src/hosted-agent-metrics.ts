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
    async () =>
      pageMetrics(
        metricsSurface(
          await readMetricRecords(session.root, period, {
            address: session.address,
            query: session.query,
          }),
          period,
        ),
        period,
        command,
      ),
    deadlineMs,
  );
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
  const day = new Date(Date.parse(to) - 86_400_000).toISOString();
  return new ForgeError(
    'METRICS_TIMEOUT',
    `metrics did not finish within ${Math.round(deadlineMs / 1000)} s${period ? ` for [${period.from}, ${period.to})` : ''}; it reads every landing record in the window page by page. Nothing changed. Next: nforge agent ROOT metrics '${JSON.stringify({ from: day, to })}' for a one-day window.`,
  );
}

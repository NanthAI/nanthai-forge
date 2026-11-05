// SPDX-License-Identifier: Apache-2.0
import { hostedAgentCommandSchemas, type HostedAgentAddress } from './hosted-agent-contract.js';
import { readMetricRecords } from './self-metrics-source.js';
import type { MetricQuery } from './self-metrics-hosted-pages.js';
import { metricPeriod, metricsSurface } from './self-metrics-surface.js';
import { networkDeadline, networkFailure } from './network-fetch.js';
import { withExchangeProgress } from './exchange-progress.js';
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
  try {
    // Cancellation reaches every in-flight page and object read through the exchange signal.
    return await networkDeadline(
      signal =>
        withExchangeProgress({ signal }, async () =>
          metricsSurface(
            await readMetricRecords(session.root, period, { address: session.address, query: session.query }),
            period,
          ),
        ),
      deadlineMs,
      undefined,
      'metrics',
    );
  } catch (error) {
    if (
      !networkFailure(error) ||
      error.code !== 'EXCHANGE_REQUEST_TIMEOUT' ||
      !/^metrics /.test(error.message)
    )
      throw error;
    const day = new Date(Date.parse(period.to) - 86_400_000).toISOString();
    throw new ForgeError(
      'METRICS_TIMEOUT',
      `metrics did not finish within ${Math.round(deadlineMs / 1000)} s for [${period.from}, ${period.to}); it reads every landing record in the window page by page. Nothing changed. Next: nforge agent ROOT metrics '${JSON.stringify({ from: day, to: period.to })}' for a one-day window.`,
    );
  }
}

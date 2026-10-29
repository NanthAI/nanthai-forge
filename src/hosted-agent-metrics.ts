// SPDX-License-Identifier: Apache-2.0
import { hostedAgentCommandSchemas, type HostedAgentAddress } from './hosted-agent-contract.js';
import { readMetricRecords } from './self-metrics-source.js';
import type { MetricQuery } from './self-metrics-hosted-pages.js';
import { metricPeriod, metricsSurface } from './self-metrics-surface.js';
export async function executeHostedMetrics(
  session: { root: string; address: HostedAgentAddress; query: MetricQuery },
  input: unknown,
) {
  const command = hostedAgentCommandSchemas.metrics.parse(input);
  const period = metricPeriod(command.from, command.to);
  return metricsSurface(
    await readMetricRecords(session.root, period, { address: session.address, query: session.query }),
    period,
  );
}

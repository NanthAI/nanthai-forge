// SPDX-License-Identifier: Apache-2.0
import { canonicalPayload } from '../src/hosted-source-operation';
import { metricRunRow } from '../src/self-metrics-run';
import type { HostedCheckRun } from '../src/hosted-check';

export const metricRunKind = 'projectMetricCheckRuns';
/** Unsupported legacy values stay on the canonical reader; never manufacture metric evidence. */
export function metricReadProjection(row: Record<string, unknown>) {
  let run: HostedCheckRun;
  try {
    run = JSON.parse(row.value as string);
  } catch {
    return null;
  }
  if (!run?.id || !run.at || !run.request?.expectedHead || !run.cost) return null;
  const sourceCreatedAt = row.sourceCreatedAt ?? row._creationTime;
  if (typeof sourceCreatedAt !== 'number') return null;
  return {
    kind: metricRunKind,
    sourceId: row._id as string,
    projectId: row.projectId as HostedCheckRun['projectId'],
    runId: row.runId as string,
    sourceCreatedAt,
    value: canonicalPayload(metricRunRow(run)),
  };
}

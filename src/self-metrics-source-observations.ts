// SPDX-License-Identifier: Apache-2.0
import type { HostedMain } from './hosted-main.js';
import { recordMetricObservation } from './self-metrics-observations.js';
/** A successful publication acknowledges the captured owner revision, not a hosted counter. */
export function recordMetricPublication(directory: string, revision: number, operationId: string) {
  recordMetricObservation(directory, {
    type: 'revision',
    id: `publication:${operationId}`,
    at: new Date().toISOString(),
    mode: 'owner-hosted',
    stream: 'owner',
    side: 'replica',
    revision,
  });
}
/** Reuse an authorized main selection on an existing cache write. Schema 1 has no comparable revision. */
export function recordMetricCache(
  directory: string,
  main: HostedMain,
  side: 'authority' | 'replica',
  operationId: string,
) {
  if (main.schema !== 2) return;
  recordMetricObservation(directory, {
    type: 'revision',
    id: `${operationId}:${side}`,
    at: new Date().toISOString(),
    mode: 'hosted-cache',
    timeBasis: 'observation',
    stream: `${main.projectId}:${main.authority.epoch}`,
    side,
    revision: main.sourceRevision,
  });
}

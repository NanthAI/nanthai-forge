// SPDX-License-Identifier: Apache-2.0
import { appendSelfMetric } from './self-metrics-journal.js';
import { metricObservationSchema, type MetricObservation } from './self-metrics-observation-schema.js';
export {
  metricObservationSchema,
  githubHostedZeroBill,
  type MetricObservation,
} from './self-metrics-observation-schema.js';
/** Explicit local records or existing write acknowledgements only; never starts a reader or timer. */
export function recordMetricObservation(directory: string, input: MetricObservation) {
  const observation = metricObservationSchema.parse(input);
  appendSelfMetric(directory, {
    schema: 1,
    kind: 'observation',
    action: observation.type,
    operationId: observation.id,
    actor: { kind: 'system', name: 'Forge self-metrics' },
    origin: 'system',
    at: observation.at,
    observation,
  });
}

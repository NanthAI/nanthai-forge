// SPDX-License-Identifier: Apache-2.0
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MetricObservation } from './self-metrics-observations.js';

/** A hook has no owner transaction/request handles to reuse. Keep this append
 * independent of metric collection and weekly reporting, which import full Work. */
export function recordEditDelivery(
  directory: string,
  observation: Extract<MetricObservation, { type: 'overlap-delivery' }>,
) {
  try {
    appendFileSync(
      join(directory, 'self-metrics.jsonl'),
      JSON.stringify({
        schema: 1,
        kind: 'observation',
        action: observation.type,
        operationId: observation.id,
        actor: { kind: 'system', name: 'Forge self-metrics' },
        origin: 'system',
        at: observation.at,
        observation,
      }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    process.emitWarning('Overlap delivery receipt could not be recorded.', {
      code: 'METRIC_RECEIPT_UNAVAILABLE',
    });
  }
}

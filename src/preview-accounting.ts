// SPDX-License-Identifier: Apache-2.0
import { CoordinationJournal } from './agent-coordination-journal.js';
import { z } from 'zod';
import { checkCostSchema } from './check-cost.js';
import type { WorkStore } from './work-store.js';

export const previewMeasurementSchema = z.object({
  executionId: z.uuid(),
  startedAt: z.string(),
  durationMs: z.number().nonnegative().finite(),
  inputs: z.array(z.object({ laneId: z.uuid(), head: z.string() })),
  cost: checkCostSchema,
});
/** Reuse the existing private advisory journal; no Work mutation or source changes. */
export function retainPreviewMeasurement(
  store: WorkStore,
  measurement: z.infer<typeof previewMeasurementSchema>,
) {
  new CoordinationJournal(store).recordPreview(previewMeasurementSchema.parse(measurement));
}

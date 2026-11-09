// SPDX-License-Identifier: Apache-2.0
import type { WorkData } from './work-types.js';

/** Completion is an explicit metadata observation, never source acceptance/deletion. */
export function intentLifecycle(
  data: WorkData,
  intent: WorkData['intents'][number],
  status: WorkData['intents'][number]['status'],
  at: string,
) {
  // Do not change historical replay bytes for pre-lifecycle status operations.
  if (status === 'completed' || intent.lifecycle) {
    data.schema = Math.max(data.schema, 8) as WorkData['schema'];
    if (intent.status !== status) (intent.lifecycle ??= []).push({ from: intent.status, to: status, at });
  }
  intent.status = status;
}

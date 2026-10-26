// SPDX-License-Identifier: Apache-2.0
import type { WorkData, Lane } from './work-types.js';

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
export function laneLifecycle(
  data: WorkData,
  lane: Lane,
  state: Exclude<Lane['state'], 'creating'>,
  at: string,
) {
  if (state === 'completed' || lane.lifecycle) {
    data.schema = Math.max(data.schema, 8) as WorkData['schema'];
    if (lane.state !== state) (lane.lifecycle ??= []).push({ from: lane.state, to: state, at });
  }
  lane.state = state;
}

// SPDX-License-Identifier: Apache-2.0
import { readPolicy } from './work-autonomy.js';
import type { CheckRun } from './work-types.js';
import type { WorkStore } from './work-store.js';

/** Only local-owner work can opt into executing a remote candidate on this machine.
 * Import provenance remains authoritative even after a local agent edits a Lane. */
export function localFallbackAllowed(store: WorkStore, run: CheckRun): boolean {
  if (readPolicy(store).checks?.fallback !== 'local') return false;
  const lanes = new Set<string>(),
    views = new Set<string>();
  const localLane = (id: string): boolean => {
    if (lanes.has(id)) return false;
    lanes.add(id);
    const lane = store.select('lanes', id);
    if (!lane || lane.nativeContributionId || lane.contribution) return false;
    if (store.select('intents', lane.intentId)?.external) return false;
    const result = !lane.parent || localLane(lane.parent.laneId);
    lanes.delete(id);
    return result;
  };
  const localView = (id: string): boolean => {
    if (views.has(id)) return false;
    views.add(id);
    const view = store.select('views', id);
    const result =
      !!view &&
      view.inputs.every(input => localLane(input.laneId)) &&
      (view.dependencies ?? []).every(
        dependency => dependency.kind === 'view' && localView(dependency.viewId),
      );
    views.delete(id);
    return result;
  };
  return (
    run.inputs.every(input => localLane(input.laneId)) &&
    run.dependencies.every(dependency => dependency.kind === 'view' && localView(dependency.viewId))
  );
}

export function runnerRetryMessage(status: 'runner-unavailable' | 'runner-budget-exhausted') {
  return `${status === 'runner-budget-exhausted' ? 'Modal runner budget is exhausted' : 'Modal runner is unavailable'}; no test outcome was recorded and no local command ran. Retry with a new run/finish operation, or switch the runner with set-policy {"checks":{"runner":"local"}}. Local fallback can be enabled for owner-originated work with set-policy {"checks":{"fallback":"local"}}.`;
}

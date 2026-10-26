// SPDX-License-Identifier: Apache-2.0
import { optimisticLanding, reviewReason } from './autonomy-policy.js';
import { acceptancePaths, readPolicy } from './work-autonomy.js';
import { changedPaths } from './agent-sync.js';
import { pathsOverlap } from './coordination-paths.js';
import { NativeSource } from './native-source.js';
import { contractDelta, dependentOn } from './contract-deps.js';
import type { WorkService } from './work.js';
import type { WorkView } from './work-types.js';
import type { FinishAction } from './agent-workflow-schema.js';

/** Overlapping in-flight changes retain the existing combined-check batch path. */
export function prepareOptimistic(work: WorkService, command: FinishAction, view: WorkView) {
  const policy = readPolicy(work.store);
  if (!work.store.native || !command.accept || command.accept.invariant || !optimisticLanding(policy))
    return false;
  const policyPaths = acceptancePaths(work.store, view, view.composedMain ?? view.base);
  if (reviewReason(policy, work.actor, policyPaths)) return false;
  const source = new NativeSource(work.store.root);
  const paths = changedPaths(
    source.state(view.composedMain ?? view.base).files,
    source.state(view.head!).files,
  );
  return work.store.locked(() => {
    const data = work.store.load(),
      source = new NativeSource(work.store.root);
    // Recheck policy in the same transaction as publishing the scoped selection.
    if (!optimisticLanding(readPolicy(work.store))) return false;
    const overlap = (others: string[]) => paths.some(a => others.some(b => pathsOverlap(a, b)));
    // A View that changes an export or schema another open Lane uses is gated, never optimistic.
    const delta = contractDelta(
      source,
      source.state(view.composedMain ?? view.base).files,
      source.state(view.head!).files,
    );
    for (const lane of data.lanes) {
      if (view.inputs.some(pin => pin.laneId === lane.id) || !['active', 'ready'].includes(lane.state))
        continue;
      if (source.contains(view.head!, lane.head)) continue;
      const theirs = source.state(lane.head).files,
        changed = changedPaths(source.state(lane.base).files, theirs);
      if (overlap(changed)) return false;
      if (
        delta.length &&
        dependentOn(
          source,
          theirs.filter(file => changed.includes(file.path)),
          theirs,
          delta,
        ).length
      )
        return false;
    }
    for (const entry of data.landingEntries ?? []) {
      if (!['queued', 'checking'].includes(entry.status) || entry.viewId === view.id) continue;
      const other = data.views.find(item => item.id === entry.viewId)!;
      if (
        overlap(
          changedPaths(source.state(other.composedMain ?? other.base).files, source.state(entry.head).files),
        )
      )
        return false;
    }
    const saved = data.views.find(item => item.id === view.id)!;
    if (!saved.optimistic) {
      saved.optimistic = true;
      saved.composedMain ??= saved.base;
      data.revision++;
      work.store.save(data);
    }
    return true;
  });
}

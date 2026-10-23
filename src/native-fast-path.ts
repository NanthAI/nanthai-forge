// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import { reviewPaths } from './native-source-review.js';
import { effectivePolicy, optimisticLanding, reviewReason, type AcceptanceActor } from './autonomy-policy.js';
import { checkEnvironment } from './check-environment.js';
import { runApplicability } from './work-evidence.js';
import type { WorkData, WorkView, ChannelMove } from './work-types.js';

/** Exact immutable manifests, never derived graph edges, establish independence. */
export function nativeFastPath(
  source: NativeSource,
  data: WorkData,
  view: WorkView,
  previous: string,
  actor: AcceptanceActor,
  reuseRunId?: string,
  rejected: (reason: string) => void = () => {},
): { head: string; evidence: NonNullable<ChannelMove['fastPath']> } | undefined {
  const reject = (reason: string) => {
    rejected(reason);
    return undefined;
  };
  const policy = effectivePolicy(data),
    main = view.composedMain;
  if (!policy.acceptance.disjointFastPath && !(view.optimistic && optimisticLanding(policy)))
    return reject('Disjoint fast path disabled');
  if (!main || !view.head || view.status !== 'clean') return reject('Missing clean composed-main provenance');
  if (!source.contains(previous, main) || !source.contains(view.head, main))
    return reject('Main ancestry changed');
  const changed = (before: string, after: string) =>
    reviewPaths(source.state(before).files, source.state(after).files)
      .filter(path => path.status !== 'unchanged')
      .map(path => path.path);
  const lanePaths = changed(main, view.head),
    mainPaths = changed(main, previous);
  // A file replacing a directory also conflicts with paths below that directory.
  if (lanePaths.some(a => mainPaths.some(b => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))))
    return reject('Changed paths overlap');
  // Fast-lane overtaking must also be disjoint from queued or checking candidates.
  for (const entry of data.landingEntries ?? []) {
    if (
      !['queued', 'checking'].includes(entry.status) ||
      entry.viewId === view.id ||
      source.contains(view.head, entry.head)
    )
      continue;
    const queued = data.views.find(candidate => candidate.id === entry.viewId);
    if (!queued?.head) return reject('Queued candidate source unavailable');
    const queuedPaths = changed(queued.composedMain ?? queued.base, queued.head);
    if (lanePaths.some(a => queuedPaths.some(b => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))))
      return reject('Changed paths overlap a queued candidate');
  }
  if (reviewReason(policy, actor, lanePaths)) return reject('Person review required');
  const visited = new Set<string>();
  const currentInputs = (candidate: WorkView): boolean => {
    if (visited.has(candidate.id)) return true;
    visited.add(candidate.id);
    if (candidate.inputs.some(pin => data.lanes.find(lane => lane.id === pin.laneId)?.head !== pin.head))
      return false;
    if (candidate.resolution) {
      const original = data.views.find(item => item.id === candidate.resolution!.viewId);
      if (!original || !currentInputs(original)) return false;
    }
    return (candidate.dependencies ?? []).every(
      pin =>
        pin.kind !== 'view' ||
        (() => {
          const dependency = data.views.find(item => item.id === pin.viewId && item.head === pin.head);
          return !!dependency && currentInputs(dependency);
        })(),
    );
  };
  if (!currentInputs(view)) return reject('Input Lane heads changed');
  const environment =
    data.landingBatches?.find(batch =>
      batch.prefixes.some(prefix => prefix.viewId === view.id && prefix.head === view.head),
    )?.environment ?? checkEnvironment();
  const run = [...data.runs]
    .reverse()
    .find(
      run =>
        (!reuseRunId || run.id === reuseRunId) &&
        run.viewId === view.id &&
        run.head === view.head &&
        run.status === 'passed' &&
        !!run.endedAt &&
        run.base === view.base &&
        JSON.stringify(run.inputs) === JSON.stringify(view.inputs) &&
        JSON.stringify(run.dependencies) === JSON.stringify(view.dependencies ?? []) &&
        runApplicability(data, run, environment).applicability === 'current',
    );
  if (!run) return reject('Passing evidence is no longer applicable');
  const merged = source.compose(
    previous,
    view.head,
    'Disjoint fast-path acceptance',
    new Date().toISOString(),
  );
  if (!merged.head) return reject('Composition conflicts');
  return {
    head: merged.head,
    evidence: {
      kind: 'disjoint-fast-path',
      policy,
      checkedViewId: view.id,
      checkedHead: view.head,
      runId: run.id,
      checkDefinition: run.check.definition,
      environmentFingerprint: run.environment.fingerprint,
      composedMain: main,
      previousMain: previous,
      lanePaths,
      mainPaths,
      cleanComposition: true,
      descendant: true,
      postAccept: { checkId: run.check.id, mode: 'full', required: true },
    },
  };
}

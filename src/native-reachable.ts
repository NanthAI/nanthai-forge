// SPDX-License-Identifier: Apache-2.0
import { validateNativeContributions } from './native-contribution-objects.js';
import { NativeSource, parseNativeState } from './native-source.js';
import { WorkStore } from './work-store.js';
import { workSourcePins } from './work-archive-metadata.js';
import { validateNativeProjection } from './native-git.js';
import { validateHistoricalObjects } from './native-work-history.js';
import { nativeDependencyHead, validateNativePr } from './native-pr-pins.js';
import { invariant, ForgeError } from './errors.js';

export function nativeReachable(
  store: WorkStore,
  data = store.load(),
  onObject?: (id: string, bytes: Buffer, state: boolean) => void,
  retained: Iterable<string> = [],
  retainedStates: Iterable<string> = [],
) {
  const source = new NativeSource(store.root);
  invariant(data.nativeHead, 'INVALID_NATIVE_SOURCE', 'Native bootstrap source is unavailable.');
  const roots = [
    ...new Set([
      ...workSourcePins(data),
      ...[...data.runs, ...data.playbookRuns].flatMap(run => [
        run.head,
        run.base,
        ...run.inputs.map(pin => pin.head),
        ...run.dependencies.map(pin => nativeDependencyHead(data, pin)),
      ]),
      ...[...data.publications, ...data.githubChecks, ...data.reviews].map(record => record.head),
      ...data.releases.flatMap(release => [
        release.acceptance.head,
        ...(release.buildRuns ?? []).map(run => run.head),
      ]),
      ...(data.hostedChannelMoves ?? []).map(move => move.head),
      ...(data.historicalWork ?? []).map(record => record.destination.head),
    ]),
  ];
  const ids = new Set<string>(retained),
    retainedStateIds = new Set(retainedStates);
  const states = new Set<string>(),
    pending = [...roots];
  while (pending.length) {
    const id = pending.pop()!;
    if (states.has(id) || retainedStateIds.has(id)) continue;
    const bytes = source.object(id);
    let state: ReturnType<typeof parseNativeState>;
    try {
      state = parseNativeState(bytes);
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      invariant(false, 'INVALID_NATIVE_SOURCE', 'A retained source pin is not a valid native State.');
    }
    onObject?.(id, bytes, true);
    states.add(id);
    ids.add(id);
    pending.push(...state.parents);
    for (const blob of [...(state.git ? [state.git.bundle] : []), ...state.files.map(file => file.blob)]) {
      if (ids.has(blob)) continue;
      const bytes = source.object(blob);
      onObject?.(blob, bytes, false);
      ids.add(blob);
    }
  }
  for (const record of [...data.publications, ...data.githubChecks])
    if (record.projection) {
      validateNativeProjection(store, record.head, record.projection);
      ids.add(record.projection.bundle);
      ids.add(record.projection.mapping);
    }
  for (const item of data.publications.flatMap(record => record.checks ?? []))
    if (item.bundle) {
      source.object(item.bundle);
      ids.add(item.bundle);
    }
  for (const intent of data.intents)
    for (const observation of intent.external?.observations ?? []) {
      const pins = validateNativePr(source, observation);
      validateNativeProjection(store, pins.projection.state, pins.projection);
      ids.add(pins.projection.bundle);
      ids.add(pins.projection.mapping);
      ids.add(observation.bundle!);
    }
  for (const id of validateHistoricalObjects(store, data.historicalWork ?? [])) ids.add(id);
  validateNativeContributions(source, data);
  for (const receipt of data.nativeContributionReceipts ?? [])
    if (receipt.provenance === 'unverified-git-bundle') {
      for (const id of [
        receipt.inputSha256,
        receipt.bundleSha256,
        receipt.projection.bundle,
        receipt.projection.mapping,
      ]) {
        source.object(id);
        ids.add(id);
      }
    }
  return [...ids].sort();
}

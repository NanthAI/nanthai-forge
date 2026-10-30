// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { NativeSource, nativeOwner } from './native-source.js';
import { parseWorkBytes, validateWorkSize } from './work-metadata.js';
import type { WorkStore } from './work-store.js';
import type { Lane, WorkData } from './work-types.js';
import type { NativeContributionReceipt } from './native-contribution-types.js';

export type ContributionPins = Pick<
  NativeContributionReceipt,
  'id' | 'request' | 'intentId' | 'base' | 'provenance'
>;
export function contributionSnapshot(store: WorkStore) {
  const bytes = store.snapshotBytes();
  invariant(bytes, 'INVALID_WORK_STORE', 'Original native Work metadata is unavailable.');
  return { data: parseWorkBytes(bytes), sha256: digest(bytes) };
}
export function retryNativeContribution(store: WorkStore, data: WorkData, pins: ContributionPins) {
  const old = data.nativeContributionReceipts?.find(item => item.id === pins.id);
  if (!old) return;
  invariant(
    old.request === pins.request &&
      old.provenance === pins.provenance &&
      old.intentId === pins.intentId &&
      old.base === pins.base,
    'WORK_OPERATION_CHANGED',
    'Reconcile the original contribution source, provenance and Lane name.',
  );
  const lane = data.lanes.find(item => item.id === old.id && item.nativeContributionId === old.id);
  invariant(lane, 'INVALID_WORK_STORE', 'Original contribution Lane is unavailable.');
  let warnings: string[] = [];
  if (lane.state === 'creating') {
    const source = new NativeSource(store.root),
      path = store.path(lane.id);
    if (existsSync(path))
      invariant(
        nativeOwner(path) === store.root &&
          source.tree(source.capture(path, false, lane.head)) === source.tree(source.state(lane.head).files),
        'LANE_UNAVAILABLE',
        'An interrupted workspace has incomplete or changed files; its files are preserved.',
      );
    else warnings = source.materialize(lane.head, path);
    lane.state = 'active';
    data.revision++;
    store.save(data);
  }
  return { revision: data.revision, result: { ...lane, ...(warnings.length ? { warnings } : {}) } };
}
function select(data: WorkData, pins: ContributionPins, revision: number) {
  invariant(
    data.revision === revision,
    'WORK_STALE',
    'Work changed before contribution import; current source and Work are preserved.',
  );
  invariant(
    data.intents.find(item => item.id === pins.intentId)?.base === pins.base,
    'CONTRIBUTION_CHANGED',
    'Select the existing Intent’s original native base.',
  );
  invariant(
    !data.lanes.some(item => item.id === pins.id),
    'WORK_OPERATION_CHANGED',
    'This operation already belongs to another Lane.',
  );
}
export function startNativeContribution(store: WorkStore, pins: ContributionPins, revision: number) {
  return store.locked(() => {
    const current = contributionSnapshot(store),
      original = retryNativeContribution(store, current.data, pins);
    if (original) return { original };
    select(current.data, pins, revision);
    new NativeSource(store.root).state(pins.base);
    return { current };
  });
}
export function registerNativeContribution(
  store: WorkStore,
  initial: { sha256: string },
  revision: number,
  receipt: NativeContributionReceipt,
  name: string,
  source: NativeSource,
  ids: Set<string>,
) {
  return store.locked(() => {
    const current = contributionSnapshot(store),
      repeated = retryNativeContribution(store, current.data, receipt);
    if (repeated) return repeated;
    invariant(
      current.sha256 === initial.sha256,
      'WORK_STALE',
      'Work bytes changed during contribution validation; refresh before importing.',
    );
    select(current.data, receipt, revision);
    invariant(
      source.contains(receipt.head, receipt.base),
      'CONTRIBUTION_CHANGED',
      'Native candidate ancestry differs from its original base.',
    );
    const target = new NativeSource(store.root),
      data = current.data;
    for (const id of ids)
      invariant(
        target.put(source.object(id)) === id,
        'INVALID_CONTRIBUTION',
        'An original source object changed.',
      );
    const lane: Lane = {
      id: receipt.id,
      startedAt: new Date().toISOString(),
      intentId: receipt.intentId,
      name,
      assignment: '',
      target: '',
      base: receipt.head,
      head: receipt.head,
      state: 'creating',
      checkpoints: [],
      nativeContributionId: receipt.id,
    };
    data.nativeContributionReceipts = [...(data.nativeContributionReceipts ?? []), receipt];
    data.lanes.push(lane);
    data.revision++;
    validateWorkSize(data);
    store.save(data);
    const warnings = target.materialize(lane.head, store.path(lane.id));
    lane.state = 'active';
    data.revision++;
    store.save(data);
    return { revision: data.revision, result: { ...lane, ...(warnings.length ? { warnings } : {}) } };
  });
}

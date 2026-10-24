// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { NativeSource, nativeOwner } from './native-source.js';
import type { WorkStore } from './work-store.js';
import { ForgeError, invariant } from './errors.js';

type CheckpointInput = {
  laneId: string;
  expectedHead: string;
  expectedTree?: string | undefined;
  message: string;
  operationId?: string;
};
/** Only immutable source is prepared here. Current Lane/operation checks and Work
 * publication remain under the existing owner lock. No metadata-only freshness
 * shortcut: capture reads every included file's actual bytes and current mode. */
export function nativeCheckpointCandidate(
  store: WorkStore,
  command: CheckpointInput,
  revision?: number,
  preparedSource?: NativeSource,
) {
  if (!store.native) return;
  try {
    let tx;
    for (;;) {
      try {
        tx = store.readRecords();
        break;
      } catch (error) {
        if (preparedSource && error instanceof ForgeError && error.code === 'SOURCE_CHANGED') continue;
        throw error;
      }
    }
    if (!tx || (revision !== undefined && tx.revision !== revision)) return;
    const lane = tx.fields('lanes', command.laneId)?.record;
    if (!lane || lane.head !== command.expectedHead) return;
    if (
      command.operationId &&
      (tx.fieldFind('lanes', lane.id, 'checkpoints', command.operationId, 'operation') ||
        tx.positions('intents', command.operationId, 'agentOperation').length ||
        tx.positions('lanes', command.operationId, 'agentOperation').length)
    )
      return;
    const path = store.path(lane.id);
    invariant(
      existsSync(path) &&
        !lstatSync(path).isSymbolicLink() &&
        realpathSync(path) === path &&
        nativeOwner(path) === store.root,
      'LANE_UNAVAILABLE',
      'Lane workspace is unavailable or unsafe.',
    );
    const source = preparedSource ?? new NativeSource(store.root),
      capture = source.captureReport(path, true, lane.head),
      tree = source.tree(capture.files),
      at = new Date().toISOString();
    if (command.expectedTree && command.expectedTree !== tree) return;
    return { parent: lane.head, path, capture, tree, at, lane };
  } catch (error) {
    // Agent preparation defers this error until its locked identity checks.
    // Existing local Work callers retain their original fallback/error ordering.
    if (preparedSource) throw error;
  }
}

/** Collection can remove unreferenced prepared objects before publication.
 * Recheck the complete candidate while collection is excluded by the owner lock;
 * a discarded candidate uses the original live capture path instead. */
export function retainedCheckpointCandidate(
  source: NativeSource,
  candidate: ReturnType<typeof nativeCheckpointCandidate>,
) {
  if (!candidate) return;
  try {
    if (
      !existsSync(candidate.path) ||
      lstatSync(candidate.path).isSymbolicLink() ||
      realpathSync(candidate.path) !== candidate.path ||
      nativeOwner(candidate.path) !== source.owner
    )
      return;
    source.state(candidate.parent);
    for (const file of candidate.capture.files) source.object(file.blob);
    return candidate;
  } catch {
    /* No unpublished candidate grants retained-source availability. */
  }
}

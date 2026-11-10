// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import type { NativeFile, NativeState } from './native-state-format.js';
import { digest } from './portable-hash.js';
import type { TreeFile } from './state-tree-format.js';
import { saveStateTree, verifyStateTreeSave } from './state-tree-save.js';
import type { SegmentStore, StateTreePointer } from './state-tree-store.js';
import { stateTreeRecordOf, treeFile } from './state-tree.js';

/** Dual-write: a worker that has just built a flat State also writes its tree form, and learns
 * whether that form may be recorded. The flat State is the authority throughout. This never
 * throws and never changes the flat result: any doubt keeps the State flat-only and says why. */
export type StateTreeDualInput = {
  store: SegmentStore;
  /** The first parent: its proven pointer, identity and flat file list. */
  base: { pointer: StateTreePointer | undefined; state: string; files: readonly NativeFile[] };
  /** The new State exactly as the flat writer serialized it. */
  next: { value: NativeState; manifest: Uint8Array };
  /** Paths that differ from the base, with the new file or null for a removal. */
  changes: readonly { path: string; after: Pick<NativeFile, 'blob' | 'mode'> | null }[];
  /** A changed file's Git id when the caller already derived it from verified bytes, otherwise
   * its exact bytes (the Git id is then derived here). */
  gitFile(file: Pick<NativeFile, 'blob' | 'mode'>): Promise<TreeFile | Uint8Array>;
};
export type StateTreeDualResult =
  | { status: 'written'; pointer: StateTreePointer; bytes: number; records: number }
  /** Nothing was attempted: the base has no tree form yet (a conversion job supplies it), or too
   * many changed files have no known Git id to read them back in one bounded batch. */
  | { status: 'skipped'; reason: 'BASE_HAS_NO_TREE' | 'GIT_IDS_UNKNOWN' }
  /** The tree form was refused and the State stays flat-only. This is the alarm case. */
  | { status: 'refused'; code: string; message: string };

export async function dualWriteStateTree(input: StateTreeDualInput): Promise<StateTreeDualResult> {
  const { store, base, next } = input;
  if (!base.pointer) return { status: 'skipped', reason: 'BASE_HAS_NO_TREE' };
  try {
    const changes = await Promise.all(
      input.changes.map(async change => {
        if (!change.after) return [change.path, null] as const;
        const known = await input.gitFile(change.after);
        return [change.path, known instanceof Uint8Array ? treeFile(change.after, known) : known] as const;
      }),
    );
    const record = stateTreeRecordOf(next.value as unknown as Record<string, unknown>, digest(next.manifest)),
      written = await saveStateTree(store, base.pointer, record, changes);
    // The gate: what the store holds must give back the flat manifest byte for byte.
    await verifyStateTreeSave(
      store,
      { pointer: base.pointer, state: base.state, files: base.files },
      { pointer: written.pointer, manifest: next.manifest },
    );
    return { status: 'written', ...written };
  } catch (error) {
    return {
      status: 'refused',
      code: error instanceof ForgeError ? error.code : 'unexpected',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

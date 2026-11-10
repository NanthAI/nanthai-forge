// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { NativeFile } from './native-state-format.js';
import type { TreeFile } from './state-tree-format.js';
import { TreeSession, type SegmentStore, type StateTreePointer } from './state-tree-store.js';
import {
  applyTreeEdits,
  readStateTree,
  reproducesManifest,
  stateTreeManifest,
  stateTreeRecord,
  treeChanges,
} from './state-tree.js';

/** Writing a State in tree form beside its flat manifest. A pointer returned here was proven
 * against the flat bytes from what the store actually holds; the flat manifest is never changed. */
export type StateTreeWrite =
  | { exact: true; pointer: StateTreePointer; bytes: number; records: number }
  | { exact: false; reason: 'NON_CANONICAL_MANIFEST' };
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const mismatch = (condition: unknown) =>
  invariant(condition, 'SOURCE_DIGEST_MISMATCH', 'The stored tree does not reproduce its State.');

/** First conversion of a State: writes every folder once (the only write that costs the whole
 * list), then rebuilds the manifest from the stored segment with a cold reader and compares it
 * byte for byte. `fileOf` supplies each file's Git id (from its bytes, or a trusted alias). */
export async function convertStateTree(
  store: SegmentStore,
  manifest: Uint8Array,
  fileOf: (file: NativeFile) => TreeFile | Promise<TreeFile>,
): Promise<StateTreeWrite> {
  const { record, files } = stateTreeRecord(manifest);
  if (!reproducesManifest(record, files, manifest)) return { exact: false, reason: 'NON_CANONICAL_MANIFEST' };
  const session = new TreeSession(store),
    entries = await Promise.all(files.map(async file => [file.path, await fileOf(file)] as const)),
    written = await session.finish(record, await applyTreeEdits(session, undefined, entries));
  mismatch(equal((await readStateTree(new TreeSession(store), written.pointer)).manifest, manifest));
  return { exact: true, pointer: written.pointer, bytes: written.bytes, records: written.records };
}

/** A save as edits on a base that already has a verified pointer: rewrites only the folders on
 * the changed paths. `verifyStateTreeSave` must pass before the pointer is recorded. */
export async function saveStateTree(
  store: SegmentStore,
  base: StateTreePointer,
  manifest: Uint8Array,
  changes: Iterable<readonly [string, TreeFile | null]>,
): Promise<StateTreeWrite> {
  const { record, files } = stateTreeRecord(manifest);
  if (!reproducesManifest(record, files, manifest)) return { exact: false, reason: 'NON_CANONICAL_MANIFEST' };
  const session = new TreeSession(store),
    written = await session.finish(
      record,
      await applyTreeEdits(session, (await session.open(base)).root, changes),
    );
  return { exact: true, pointer: written.pointer, bytes: written.bytes, records: written.records };
}

/** Prove a save's tree form against its flat manifest at the cost of what changed. A cold reader
 * finds the files that differ between the stored base tree and the stored new tree; those
 * differences applied to the base's flat list must give the new manifest byte for byte. The base
 * pointer was proven the same way (or by a full conversion), so unchanged folders are covered. */
export async function verifyStateTreeSave(
  store: SegmentStore,
  base: { pointer: StateTreePointer; manifest: Uint8Array },
  next: { pointer: StateTreePointer; manifest: Uint8Array },
): Promise<void> {
  const session = new TreeSession(store),
    [from, to] = await Promise.all([session.open(base.pointer), session.open(next.pointer)]),
    was = stateTreeRecord(base.manifest),
    files = new Map(was.files.map(file => [file.path, file]));
  mismatch(
    from.record.state === was.record.state && to.record.state === stateTreeRecord(next.manifest).record.state,
  );
  for (const change of await treeChanges(session, from.root, to.root)) {
    const old = files.get(change.path);
    mismatch(change.before ? old?.blob === change.before.blob && old.mode === change.before.mode : !old);
    if (change.after)
      files.set(change.path, { path: change.path, blob: change.after.blob, mode: change.after.mode });
    else files.delete(change.path);
  }
  mismatch(equal(stateTreeManifest(to.record, [...files.values()]), next.manifest));
}

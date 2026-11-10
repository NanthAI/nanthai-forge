// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { parseNativeState, type NativeFile } from './native-state-format.js';
import { digest } from './portable-hash.js';
import { dualWriteStateTree, type StateTreeDualResult } from './state-tree-dual.js';
import type { TreeFile } from './state-tree-format.js';
import { TreeSession, type SegmentStore, type StateTreePointer } from './state-tree-store.js';
import { treeFileAt } from './state-tree.js';

/** What a source step needs to dual-write the States it produces (projects with tree writes on).
 * The flat State stays the authority: `settled` only learns whether a pointer may be recorded. */
export type StateTreeIo = {
  store: SegmentStore;
  /** The proven pointer of a State this step knows (from its object row, or written here). */
  pointer(state: string): StateTreePointer | undefined;
  /** `ms` is the wall time the dual-write added to the step. */
  settled(state: string, result: StateTreeDualResult, ms: number): void;
  /** Exact bytes of a raw object this project stores under its own key, read without a
   * descriptor; undefined when it is not stored that way (a pack member, a recipe). */
  direct?(pin: { sha256: string; size: number }): Promise<Uint8Array | undefined>;
};
export type StateTreeSources = {
  /** A parent's flat file list when the step already holds it; never a new read. */
  files(state: string): readonly NativeFile[] | undefined;
  /** Git ids the step already derived from verified bytes, by blob id. */
  oids?: ReadonlyMap<string, string>;
  /** Exact bytes of changed files, for the Git ids nothing else supplies: one batch, in order. */
  bytes(files: readonly Pick<NativeFile, 'blob' | 'mode'>[]): Promise<Uint8Array[]>;
};
/** More changed files than this without a known Git id are not read back: the State stays flat. */
export const TREE_UNKNOWN_FILES = 100;
const key = (file: Pick<NativeFile, 'blob' | 'mode'>) =>
  `${file.mode === 'gitlink' ? 'link' : 'blob'}:${file.blob}`;
const same = (a: NativeFile | undefined, b: NativeFile | undefined) =>
  !!a && !!b && a.blob === b.blob && a.mode === b.mode;

/** Dual-write one State a step is about to publish, as edits on the first parent that has both a
 * proven pointer and a flat list in hand. A changed file's Git id comes from the step's own
 * hashes, else from a stored tree that already holds the same blob at a known path (another
 * parent, or the base before a rename), else from its bytes. Never throws; bytes that are not a
 * State are ignored. */
export async function writeOutputTree(
  io: StateTreeIo,
  manifest: Uint8Array,
  sources: StateTreeSources,
): Promise<StateTreeDualResult | null> {
  let value;
  try {
    value = parseNativeState(manifest);
  } catch {
    return null;
  }
  const state = digest(manifest),
    started = performance.now();
  if (io.pointer(state)) return null;
  const parent = value.parents.find(id => io.pointer(id) && sources.files(id));
  let result: StateTreeDualResult;
  if (!parent) result = { status: 'skipped', reason: 'BASE_HAS_NO_TREE' };
  else {
    const pointer = io.pointer(parent)!,
      files = sources.files(parent)!,
      before = new Map(files.map(file => [file.path, file])),
      after = new Map(value.files.map(file => [file.path, file])),
      changes: { path: string; after: NativeFile | null }[] = [];
    for (const file of value.files)
      if (!same(before.get(file.path), file)) changes.push({ path: file.path, after: file });
    for (const file of files) if (!after.has(file.path)) changes.push({ path: file.path, after: null });
    // Where a stored tree already holds a changed blob: its own path in another parent, or any
    // path of the base (a rename or copy).
    const session = new TreeSession(io.store),
      others = value.parents.filter(id => id !== parent && io.pointer(id)),
      wanted = new Map(
        changes.flatMap(change => (change.after ? [[change.after.blob, change.path] as const] : [])),
      ),
      inBase = new Map<string, string>();
    for (const file of files)
      if (wanted.has(file.blob) && !inBase.has(file.blob)) inBase.set(file.blob, file.path);
    const stored = async (file: Pick<NativeFile, 'blob' | 'mode'>): Promise<TreeFile | undefined> => {
      const places = [
        ...others.map(id => [id, wanted.get(file.blob)!] as const),
        ...(inBase.has(file.blob) ? [[parent, inBase.get(file.blob)!] as const] : []),
      ];
      for (const [id, path] of places) {
        const found = await treeFileAt(session, (await session.open(io.pointer(id)!)).root, path).catch(
          () => undefined,
        );
        // The Git id of a blob is the same under any file mode; a gitlink's is its commit.
        if (found?.blob === file.blob && (found.mode === 'gitlink') === (file.mode === 'gitlink'))
          return { mode: file.mode, blob: file.blob, oid: found.oid };
      }
      return undefined;
    };
    try {
      // Git ids first, so the files nothing answers are read in one batch.
      const added = [
          ...new Map(changes.flatMap(change => (change.after ? [[key(change.after), change.after]] : []))),
        ].map(([, file]) => file),
        known = new Map<string, TreeFile | Uint8Array>();
      await Promise.all(
        added.map(async file => {
          const oid = file.mode === 'gitlink' ? undefined : sources.oids?.get(file.blob),
            found = oid ? { mode: file.mode, blob: file.blob, oid } : await stored(file);
          if (found) known.set(key(file), found);
        }),
      );
      const unknown = added.filter(file => !known.has(key(file)));
      if (unknown.length > TREE_UNKNOWN_FILES) result = { status: 'skipped', reason: 'GIT_IDS_UNKNOWN' };
      else {
        const bytes = unknown.length ? await sources.bytes(unknown) : [];
        unknown.forEach((file, i) => known.set(key(file), bytes[i]!));
        result = await dualWriteStateTree({
          store: io.store,
          base: { pointer, state: parent, files },
          next: { value, manifest },
          changes,
          gitFile: async file => known.get(key(file))!,
        });
      }
    } catch (error) {
      result = {
        status: 'refused',
        code: error instanceof ForgeError ? error.code : 'unexpected',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  io.settled(state, result, Math.round(performance.now() - started));
  return result;
}

/** One line per dual-write outcome, on the source-step log channel: identifiers, counts and a
 * code only. A refusal is the alarm line (`console.error`); the flat State was recorded. */
export function logStateTree(
  identity: { jobId: string; step: number },
  state: string,
  result: StateTreeDualResult,
  /** The step's dual-write wall time and its segment traffic so far (R2 GETs and PUTs). */
  io: { ms: number; gets: number; getBytes: number; puts: number; putBytes: number },
) {
  const line = JSON.stringify({
    event: 'forge-state-tree',
    job: identity.jobId,
    step: identity.step,
    state,
    status: result.status,
    ...io,
    ...(result.status === 'written' ? { bytes: result.bytes, records: result.records } : {}),
    ...(result.status === 'skipped' ? { reason: result.reason } : {}),
    ...(result.status === 'refused' ? { code: result.code.slice(0, 64) } : {}),
  });
  if (result.status === 'refused') console.error(line);
  else console.warn(line);
}

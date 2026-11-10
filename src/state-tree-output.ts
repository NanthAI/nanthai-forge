// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { parseNativeState, type NativeFile, type NativeState } from './native-state-format.js';
import { digest } from './portable-hash.js';
import { dualWriteStateTree, type StateTreeDualResult } from './state-tree-dual.js';
import type { TreeFile } from './state-tree-format.js';
import { TreeSession, type SegmentStore, type StateTreePointer } from './state-tree-store.js';
import { stateTreeManifest, treeChanges, treeFileAt, treeFiles } from './state-tree.js';

/** What a source step needs to dual-write the States it produces (projects with tree writes on).
 * The flat State stays the authority: `settled` only learns whether a pointer may be recorded. */
export type StateTreeIo = {
  /** Dual-write is on (`stateTrees.write`). */
  write: boolean;
  /** The merge reader is switched to trees (`stateTrees.read` has `merge`). */
  read: boolean;
  store: SegmentStore;
  /** The proven pointer of a State this step knows (from its object row, or written here). */
  pointer(state: string): StateTreePointer | undefined;
  /** Self-heal: the nearest State with a proven pointer this step knows, searching the known
   * ancestry of these States (then any base the step was handed for this purpose). */
  nearest?(states: readonly string[]): string | undefined;
  /** Dual-write work the step's `settle` awaits before it attaches pointers, so the work (its
   * segment PUT above all) runs beside the uploads that overlap the rest of the step instead of
   * in front of it. Without it the caller awaits the work itself. */
  defer?(work: Promise<unknown>): void;
  /** `ms` is the wall time the dual-write added to the step. */
  settled(state: string, result: StateTreeDualResult, ms: number): void;
  /** Exact bytes of a raw object this project stores under its own key, read without a
   * descriptor; undefined when it is not stored that way (a pack member, a recipe). */
  direct?(pin: { sha256: string; size?: number }): Promise<Uint8Array | undefined>;
  /** A tree read finished: `ok` false means a pointer exists but its tree did not give the State
   * (the reader then took the flat manifest). */
  derived?(state: string, ok: boolean): void;
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

/** Dual-write one State a step is about to publish, as edits on a base that has a proven pointer:
 * the first parent with a flat list in hand, else (self-heal, so a flat State does not keep its
 * descendants flat) the nearest State with a pointer the step knows (`io.nearest`), whose file
 * list is then read from its own tree. Any base gives the same tree; the gate still compares with
 * the flat manifest byte for byte. A changed file's Git id comes from the step's own hashes, else
 * from a stored tree that already holds the same blob (the base, or another parent), else from its
 * bytes. Never throws; bytes that are not a State are ignored. `known` skips a second parse and hash
 * when the caller holds the State value and identity. */
export async function writeOutputTree(
  io: StateTreeIo,
  manifest: Uint8Array,
  sources: StateTreeSources,
  known?: { value: NativeState; state: string },
): Promise<StateTreeDualResult | null> {
  let value = known?.value;
  if (!value)
    try {
      value = parseNativeState(manifest);
    } catch {
      return null;
    }
  const state = known?.state ?? digest(manifest),
    started = performance.now();
  if (!io.write || io.pointer(state)) return null;
  const parent = value.parents.find(id => io.pointer(id) && sources.files(id)),
    healFrom = parent ? undefined : io.nearest?.(value.parents);
  let result: StateTreeDualResult;
  if (!parent && !healFrom) result = { status: 'skipped', reason: 'BASE_HAS_NO_TREE' };
  else
    try {
      result = await writeOnBase(io, value, manifest, state, sources, (parent ?? healFrom)!);
    } catch (error) {
      result = {
        status: 'refused',
        code: error instanceof ForgeError ? error.code : 'unexpected',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  io.settled(state, result, Math.round(performance.now() - started));
  return result;
}

async function writeOnBase(
  io: StateTreeIo,
  value: NativeState,
  manifest: Uint8Array,
  state: string,
  sources: StateTreeSources,
  base: string,
): Promise<StateTreeDualResult> {
  const pointer = io.pointer(base)!,
    began = performance.now(),
    session = new TreeSession(io.store),
    /** Git ids the base's own tree names, when its file list was read from that tree. */
    walked = new Map<string, TreeFile>();
  let files = sources.files(base);
  if (!files) {
    const { root } = await session.open(pointer),
      listed = await treeFiles(session, root);
    for (const file of listed) walked.set(key(file), { mode: file.mode, blob: file.blob, oid: file.oid });
    files = listed.map(({ path, blob, mode }) => ({ path, blob, mode }));
  }
  const baseMs = Math.round(performance.now() - began),
    before = new Map(files.map(file => [file.path, file])),
    after = new Map(value.files.map(file => [file.path, file])),
    changes: { path: string; after: NativeFile | null }[] = [];
  for (const file of value.files)
    if (!same(before.get(file.path), file)) changes.push({ path: file.path, after: file });
  for (const file of files) if (!after.has(file.path)) changes.push({ path: file.path, after: null });
  // Where a stored tree already holds a changed blob: its own path in another parent (for a
  // parent left flat, as by a late merge, in its nearest State with a tree), or any path of the
  // base (a rename or copy). Without the nearest, a flat Lane tip made every changed file's bytes
  // a read, and that read made the next segment late too.
  const others = [
      ...new Set(
        value.parents.flatMap(id => {
          const at = io.pointer(id) ? id : io.nearest?.([id]);
          return at && at !== base ? [at] : [];
        }),
      ),
    ],
    wanted = new Map(
      changes.flatMap(change => (change.after ? [[change.after.blob, change.path] as const] : [])),
    ),
    inBase = new Map<string, string>();
  for (const file of files)
    if (wanted.has(file.blob) && !inBase.has(file.blob)) inBase.set(file.blob, file.path);
  const stored = async (file: Pick<NativeFile, 'blob' | 'mode'>): Promise<TreeFile | undefined> => {
    const places = [
      ...others.map(id => [id, wanted.get(file.blob)!] as const),
      ...(inBase.has(file.blob) ? [[base, inBase.get(file.blob)!] as const] : []),
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
  // Git ids first, so the files nothing answers are read in one batch.
  const added = [
      ...new Map(changes.flatMap(change => (change.after ? [[key(change.after), change.after]] : []))),
    ].map(([, file]) => file),
    gitIds = new Map<string, TreeFile | Uint8Array>();
  await Promise.all(
    added.map(async file => {
      const oid = file.mode === 'gitlink' ? undefined : sources.oids?.get(file.blob),
        listed = walked.get(key(file)),
        found = oid
          ? { mode: file.mode, blob: file.blob, oid }
          : listed
            ? { ...listed, mode: file.mode }
            : await stored(file);
      if (found) gitIds.set(key(file), found);
    }),
  );
  const unknown = added.filter(file => !gitIds.has(key(file)));
  if (unknown.length > TREE_UNKNOWN_FILES) return { status: 'skipped', reason: 'GIT_IDS_UNKNOWN' };
  // Bytes this step cannot reach (a blob another step of the same job wrote and no row names
  // yet, as in a conflict draft) leave the State flat. That is not a refusal: nothing was
  // written and nothing disagrees.
  const bytes = unknown.length ? await sources.bytes(unknown).catch(() => null) : [];
  if (!bytes || bytes.some(value => !value)) return { status: 'skipped', reason: 'GIT_IDS_UNKNOWN' };
  unknown.forEach((file, i) => gitIds.set(key(file), bytes[i]!));
  const idsMs = Math.round(performance.now() - began) - baseMs,
    result = await dualWriteStateTree({
      store: io.store,
      base: { pointer, state: base, files },
      next: { value, manifest },
      state,
      changes,
      gitFile: async file => gitIds.get(key(file))!,
    });
  if (result.status !== 'written') return result;
  return {
    ...result,
    ...(value.parents.includes(base) ? {} : { healed: base }),
    phases: { baseMs, idsMs, ...result.phases! },
  };
}

const warmed = new WeakMap<SegmentStore, Set<string>>();
/** Fetch the segments a State's tree lives in, while the step still has other work to do (the
 * merge step, as soon as it knows a State it will read that has a pointer), so its dual-write
 * later costs CPU and one PUT instead of sequential GETs. Once per State and store. Best effort,
 * as `warmTreePaths`. */
export function warmTreeState(io: StateTreeIo, state: string) {
  // A flat State (a late merge) warms its nearest State with a tree: its Git ids come from there.
  const at = io.pointer(state) ? state : io.write ? io.nearest?.([state]) : undefined,
    pointer = at && io.pointer(at);
  if (!io.write || !at || !pointer) return;
  let done = warmed.get(io.store);
  if (!done) warmed.set(io.store, (done = new Set()));
  if (done.has(at)) return;
  done.add(at);
  new TreeSession(io.store).prefetch(pointer).catch(() => {});
}

/** Read, while a save's baseline manifest downloads, the folders on the paths it changes, so its
 * dual-write finds them in the store's cache. Best effort: a failure here is found again, and
 * reported, by the write itself. */
export function warmTreePaths(io: StateTreeIo, state: string, paths: readonly string[]) {
  const pointer = io.pointer(state);
  if (!io.write || !pointer || !paths.length || paths.length > TREE_UNKNOWN_FILES) return;
  const session = new TreeSession(io.store);
  session
    .open(pointer)
    .then(({ root }) => Promise.all(paths.map(path => treeFileAt(session, root, path))))
    .catch(() => {});
}

/** The merge reader: a State's exact flat manifest from its stored tree and the flat list of
 * another State already in hand, reading only the folders that differ between the two. The
 * result is returned only when it hashes to the State's own identity, so a tree answer and the
 * flat manifest cannot differ; null (no pointer, a failed read, any mismatch) means the caller
 * reads the flat manifest as before. */
export async function manifestFromTree(
  io: StateTreeIo,
  state: string,
  held: { state: string; files: readonly NativeFile[] },
): Promise<Uint8Array | null> {
  const pointer = io.pointer(state),
    base = io.pointer(held.state);
  if (!io.read || !pointer || !base || state === held.state) return null;
  let manifest: Uint8Array | null = null;
  try {
    const session = new TreeSession(io.store),
      [from, to] = await Promise.all([session.open(base), session.open(pointer)]),
      files = new Map(held.files.map(file => [file.path, file]));
    if (from.record.state === held.state && to.record.state === state) {
      for (const change of await treeChanges(session, from.root, to.root))
        if (change.after)
          files.set(change.path, { path: change.path, blob: change.after.blob, mode: change.after.mode });
        else files.delete(change.path);
      const rebuilt = stateTreeManifest(to.record, [...files.values()]);
      if (digest(rebuilt) === state) manifest = rebuilt;
    }
  } catch {
    manifest = null;
  }
  io.derived?.(state, !!manifest);
  return manifest;
}

/** How long a step that is otherwise ready to commit waits for its dual-write: a small share
 * of the step's run time so far, so a late tree costs the step at most that share; past it the
 * States commit flat (`late`). */
export const TREE_LATE_SHARE = 0.04;
/** `fixed` (the deployment's `FORGE_STATE_TREE_GRACE_MS`, when set to a whole number of ms)
 * replaces the share: tests that wait in full, or an operator who must. */
export const treeLateGraceMs = (runMs: number, fixed?: string) =>
  fixed && /^\d{1,7}$/.test(fixed) ? Number(fixed) : Math.max(0, Math.round(runMs * TREE_LATE_SHARE));

/** One line per dual-write outcome, on the source-step log channel: identifiers, counts and a
 * code only. A refusal is the alarm line (`console.error`); the flat State was recorded. `late`
 * (state null): the step committed after its grace with dual-write still running, so the States
 * it had not yet proven are flat. */
export function logStateTree(
  identity: { jobId: string; step: number },
  state: string | null,
  result: StateTreeDualResult | { status: 'read' } | { status: 'late' },
  /** The step's dual-write wall time and its segment traffic so far (R2 GETs and PUTs, and the
   * wall time with a GET in flight); `atMs`: the step's run time when the line was written;
   * `late`: written after a deadline settle, so no pointer was recorded. */
  io: {
    ms: number;
    gets: number;
    getBytes: number;
    getMs?: number;
    puts: number;
    putBytes: number;
    atMs?: number;
    late?: boolean;
  },
) {
  const line = JSON.stringify({
    event: 'forge-state-tree',
    job: identity.jobId,
    step: identity.step,
    state,
    status: result.status,
    ...io,
    ...(result.status === 'written'
      ? {
          bytes: result.bytes,
          records: result.records,
          ...(result.healed ? { healed: result.healed } : {}),
          ...result.phases,
        }
      : {}),
    ...(result.status === 'skipped' ? { reason: result.reason } : {}),
    ...(result.status === 'refused' ? { code: result.code.slice(0, 64) } : {}),
  });
  if (result.status === 'refused') console.error(line);
  else console.warn(line);
}

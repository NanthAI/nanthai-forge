import { gitlinkCommit } from './gitlink.js';
import { readEditContext } from './agent-edit-context.js';
import { conversationSchema } from './agent-edit-types.js';
// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ForgeError } from './errors.js';
import { digest } from './hash.js';
import { mkdirBelow } from './mkdir-below.js';
import { nativeFile } from './native-file.js';
import { snapshotBlob } from './native-snapshot-clone.js';
import { NativeSource, nativePaths, type NativeFile } from './native-source.js';
import { changedPaths } from './agent-sync.js';
import { writeRecoveryState } from './recovery-state.js';
import { readPolicy } from './work-autonomy.js';
import { workLocked } from './work-lock.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';

/** Defaults: snapshot a few seconds after the last edit, at most every 30 s, and
 * no later than a minute into continuous editing. Env overrides exist for tests. */
export const AUTO_SNAPSHOT = { debounceMs: 5_000, minIntervalMs: 30_000, maxWaitMs: 60_000 } as const;
const setting = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && process.env[name] !== '' ? value : fallback;
};
const settings = () => ({
  debounceMs: setting('FORGE_AUTO_SNAPSHOT_DEBOUNCE_MS', AUTO_SNAPSHOT.debounceMs),
  minIntervalMs: setting('FORGE_AUTO_SNAPSHOT_INTERVAL_MS', AUTO_SNAPSHOT.minIntervalMs),
  maxWaitMs: setting('FORGE_AUTO_SNAPSHOT_MAX_WAIT_MS', AUTO_SNAPSHOT.maxWaitMs),
});

const oid = z.string().regex(/^[0-9a-f]{64}$/);
const pointerSchema = z.object({
  schema: z.literal(1),
  kind: z.literal('forge-auto-snapshot'),
  conversation: conversationSchema.optional(),
  laneId: z.string().uuid(),
  state: oid,
  parent: z.string(),
  tree: z.string(),
  at: z.string().datetime(),
  changedPathCount: z.number().int().nonnegative(),
  paths: z.array(z.string()),
  storage: z
    .object({
      cloned: z.number().int().nonnegative(),
      copied: z.number().int().nonnegative(),
      reasons: z.array(z.string()),
    })
    .optional(),
});
export type AutoSnapshot = z.infer<typeof pointerSchema>;
type CacheEntry = { key: string; blob: string; mode: NativeFile['mode'] };
const cacheSchema = z.object({
  schema: z.literal(1),
  entries: z.array(
    z.tuple([z.string(), z.string(), oid, z.enum(['file', 'executable', 'symlink', 'gitlink'])]),
  ),
});

export const autoSnapshotDirectory = (store: WorkStore) => join(store.directory, 'auto-snapshots');
const pointerPath = (store: WorkStore, laneId: string) =>
  join(autoSnapshotDirectory(store), `${laneId}.json`);
const cachePath = (store: WorkStore, laneId: string) =>
  join(autoSnapshotDirectory(store), `${laneId}.cache.json`);
/** Short publication section shared only with native object collection. */
export function withAutoSnapshotLock<T>(store: WorkStore, run: () => T, waitMs = 2_000): T {
  mkdirBelow(store.directory, autoSnapshotDirectory(store));
  return workLocked(join(autoSnapshotDirectory(store), 'lock'), run, {
    waitMs,
    operation: 'auto-snapshot publication',
  });
}

export function readAutoSnapshot(store: WorkStore, laneId: string): AutoSnapshot | undefined {
  try {
    const value = pointerSchema.parse(JSON.parse(readFileSync(pointerPath(store, laneId), 'utf8')));
    return value.laneId === laneId ? value : undefined;
  } catch {
    return undefined;
  }
}
function readCache(store: WorkStore, laneId: string) {
  try {
    const parsed = cacheSchema.parse(JSON.parse(readFileSync(cachePath(store, laneId), 'utf8')));
    return new Map(parsed.entries.map(([path, key, blob, mode]) => [path, { key, blob, mode }]));
  } catch {
    return new Map<string, CacheEntry>();
  }
}
function writeCache(store: WorkStore, laneId: string, cache: Map<string, CacheEntry>) {
  const entries = [...cache].map(([path, entry]) => [path, entry.key, entry.blob, entry.mode]);
  mkdirBelow(store.directory, autoSnapshotDirectory(store));
  writeRecoveryState(cachePath(store, laneId), { schema: 1, entries });
}
function statKey(root: string, path: string) {
  const stat = lstatSync(join(root, path), { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(':');
}

/** Unsaved edits on top of the Lane's saved head, as an agent-facing notice. A
 * snapshot whose parent is no longer the head was superseded by a checkpoint. */
export function autoSnapshotNotice(store: WorkStore, lane: Pick<Lane, 'id' | 'head' | 'state'>) {
  const snapshot = readAutoSnapshot(store, lane.id);
  if (!snapshot || snapshot.parent !== lane.head || ['completed', 'abandoned'].includes(lane.state))
    return undefined;
  return {
    state: snapshot.state,
    at: snapshot.at,
    parent: snapshot.parent,
    changedPathCount: snapshot.changedPathCount,
    paths: snapshot.paths,
    notice: `Unsaved edits recovered from auto-snapshot at ${snapshot.at}: ${snapshot.changedPathCount} path(s) changed since the last checkpoint. They stay in the Lane folder unless it was removed; checkpoint saves them. Read them with diff {"from":"${snapshot.parent}","to":"${snapshot.state}"} or show {"state":"${snapshot.state}","path":"…"}.`,
  };
}
/** Start/status notices for every open Lane with unsaved auto-snapshot edits. */
export function autoSnapshotNotices(store: WorkStore, actor?: string) {
  let names: string[];
  try {
    names = readdirSync(autoSnapshotDirectory(store)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
  } catch {
    return [];
  }
  return names.flatMap(name => {
    const lane = store.select('lanes', name.slice(0, -5), 'id', true);
    if (!lane || (actor && lane.startedBy?.name !== actor)) return [];
    const notice = autoSnapshotNotice(store, lane);
    return notice ? [{ laneId: lane.id, path: store.path(lane.id), ...notice }] : [];
  });
}

export type AutoSnapshotResult =
  | { status: 'snapshot'; state: string; changedPathCount: number; reread: number; ms: number }
  | { status: 'unchanged' | 'clean'; reread: number; ms: number }
  | { status: 'skipped'; reason: string };
const busy = (error: unknown) => error instanceof ForgeError && error.code === 'WORK_BUSY';
const pending = (lane: Lane) => !!(lane.pendingMerge || lane.pendingSync || lane.pendingUndo || lane.pending);

/** Capture an open native Lane into a content-addressed State without touching
 * Work, sync, landing or hosted push. Only the Lane lock (never waited for) and the
 * short publication lock are taken; a running sync, merge or checkpoint wins. */
export function snapshotLane(store: WorkStore, laneId: string): AutoSnapshotResult {
  if (!store.native) return { status: 'skipped', reason: 'not-native' };
  if (readPolicy(store).autoSnapshot === false) return { status: 'skipped', reason: 'disabled' };
  const outer = store.select('lanes', laneId);
  if (!outer || ['completed', 'abandoned'].includes(outer.state))
    return { status: 'skipped', reason: 'inactive' };
  if (pending(outer)) return { status: 'skipped', reason: 'merge-pending' };
  if (!existsSync(store.path(laneId))) return { status: 'skipped', reason: 'missing' };
  try {
    return store.laneLocked(laneId, () => capture(store, laneId), {
      waitMs: 0,
      operation: 'auto-snapshot',
      actor: 'Forge auto-snapshot',
    });
  } catch (error) {
    if (busy(error)) return { status: 'skipped', reason: 'busy' };
    throw error;
  }
}
function capture(store: WorkStore, laneId: string): AutoSnapshotResult {
  const began = Date.now();
  const lane = store.select('lanes', laneId);
  if (!lane || ['completed', 'abandoned'].includes(lane.state))
    return { status: 'skipped', reason: 'inactive' };
  if (pending(lane)) return { status: 'skipped', reason: 'merge-pending' };
  const root = store.path(laneId),
    source = new NativeSource(store.root),
    head = source.state(lane.head),
    headBlobs = new Set(head.files.map(file => file.blob)),
    headModes = new Map(head.files.map(file => [file.path, file.mode])),
    cache = readCache(store, laneId),
    next = new Map<string, CacheEntry>(),
    written = new Set<string>();
  const storage = { cloned: 0, copied: 0, reasons: [] as string[] };
  let reread = 0;
  const files: NativeFile[] = nativePaths(
    root,
    head.files.map(file => file.path),
  ).map(path => {
    const before = statKey(root, path),
      hit = cache.get(path);
    if (hit?.key === before && existsSync(join(source.directory, hit.blob))) {
      next.set(path, hit);
      if (!headBlobs.has(hit.blob)) written.add(hit.blob);
      return { path, blob: hit.blob, mode: hit.mode };
    }
    reread++;
    const observed = nativeFile(root, path);
    const { bytes } = observed;
    const mode = headModes.get(path) === 'gitlink' && observed.mode === 'file' ? 'gitlink' : observed.mode;
    if (mode === 'gitlink') gitlinkCommit(bytes);
    let blob = digest(bytes);
    if (!headBlobs.has(blob)) {
      const retained = snapshotBlob(source, join(root, path), bytes, mode === 'symlink');
      blob = retained.blob;
      if (retained.storage?.method === 'clone') storage.cloned++;
      if (retained.storage?.method === 'copy') storage.copied++;
      if (retained.storage?.reason && !storage.reasons.includes(retained.storage.reason))
        storage.reasons.push(retained.storage.reason);
      written.add(blob);
    }
    // A file rewritten during the read is not cached; the next attempt reads it again.
    if (statKey(root, path) === before) next.set(path, { key: before, blob, mode });
    return { path, blob, mode };
  });
  const tree = source.tree(files),
    prior = readAutoSnapshot(store, laneId),
    elapsed = () => Date.now() - began;
  const saveCache = () => {
    if (reread || next.size !== cache.size) writeCache(store, laneId, next);
  };
  if (tree === source.tree(head.files)) {
    if (prior) withAutoSnapshotLock(store, () => unlinkSync(pointerPath(store, laneId)));
    saveCache();
    return { status: 'clean', reread, ms: elapsed() };
  }
  if (prior?.parent === lane.head && prior.tree === tree && existsSync(join(source.directory, prior.state))) {
    saveCache();
    return { status: 'unchanged', reread, ms: elapsed() };
  }
  const conversation = readEditContext(store.directory, laneId);
  const at = new Date().toISOString(),
    state = source.writeState(
      files,
      [lane.head],
      'Auto-snapshot of unsaved Lane edits',
      at,
      undefined,
      conversation,
    ),
    paths = changedPaths(head.files, files);
  const published = withAutoSnapshotLock(store, () => {
    const current = store.select('lanes', laneId);
    if (!current || ['completed', 'abandoned'].includes(current.state)) return false;
    // Collection may have removed an object written before this lock; retry later.
    for (const id of [state, ...written]) if (!existsSync(join(source.directory, id))) return false;
    writeRecoveryState(pointerPath(store, laneId), {
      schema: 1,
      kind: 'forge-auto-snapshot',
      laneId,
      state,
      parent: lane.head,
      tree,
      at,
      ...(conversation ? { conversation } : {}),
      changedPathCount: paths.length,
      paths: paths.slice(0, 20),
      storage,
    } satisfies AutoSnapshot);
    return true;
  });
  if (!published) {
    writeCache(store, laneId, new Map());
    return { status: 'skipped', reason: 'collected' };
  }
  saveCache();
  return { status: 'snapshot', state, changedPathCount: paths.length, reread, ms: elapsed() };
}

/** Debounced driver for one watched Lane. Edits only schedule; idle Lanes cost nothing. */
export function laneAutoSnapshots(store: WorkStore, laneId: string, unref: boolean) {
  let timer: NodeJS.Timeout | undefined,
    firstEdit: number | undefined,
    lastEdit = 0,
    lastSnapshot = 0,
    closed = false;
  const schedule = () => {
    if (closed || firstEdit === undefined) return;
    const { debounceMs, minIntervalMs, maxWaitMs } = settings(),
      due = Math.max(Math.min(lastEdit + debounceMs, firstEdit + maxWaitMs), lastSnapshot + minIntervalMs);
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, Math.max(0, due - Date.now()));
    if (unref) timer.unref();
  };
  const run = () => {
    timer = undefined;
    if (closed) return;
    const pendingSince = firstEdit;
    firstEdit = undefined;
    let result: AutoSnapshotResult;
    try {
      result = snapshotLane(store, laneId);
    } catch {
      result = { status: 'skipped', reason: 'error' };
    }
    lastSnapshot = Date.now();
    // A busy Lane or a raced collection keeps its edits pending for a later attempt.
    // Other skips wait for the next edit: idle Lanes never poll.
    if (result.status === 'skipped' && (result.reason === 'busy' || result.reason === 'collected')) {
      firstEdit = pendingSince;
      schedule();
    }
  };
  return {
    edited() {
      if (closed) return;
      lastEdit = Date.now();
      firstEdit ??= lastEdit;
      schedule();
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

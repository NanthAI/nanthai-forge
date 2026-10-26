// SPDX-License-Identifier: Apache-2.0
import {
  autoSnapshotRetentionPlan,
  autoSnapshotDiskUsage,
  removeAutoSnapshot,
  type SnapshotRetentionItem,
} from './lane-auto-snapshot-retention.js';
import { retentionPlan, removeRetention } from './clean-retention.js';
import { readPolicy } from './work-autonomy.js';
import { checkCleanupBlocker } from './clean-check-safety.js';
import { processBlocker, workingProcesses } from './clean-processes.js';
import { processGroupAlive } from './local-process.js';
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { NativeSource, nativeOwner, nativePaths } from './native-source.js';
import { nativeObjects } from './native-objects.js';
import { channelHeads, mergedChecker, allRecords } from './agent-lifecycle.js';
import { recoverRecordRuns } from './work-record-runs.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun, Lane } from './work-types.js';

export const CLEAN_KINDS = [
  'check-workspaces',
  'check-retention',
  'lane-deps',
  'lanes',
  'exchange-staging',
  'auto-snapshots',
  'objects',
] as const;
type Kind = (typeof CLEAN_KINDS)[number];
/** `objects` rewrites shared storage, so it only runs when named. */
const DEFAULT_KINDS: Kind[] = [
  'check-workspaces',
  'check-retention',
  'lane-deps',
  'lanes',
  'exchange-staging',
  'auto-snapshots',
];
export const cleanSchema = z.object({
  action: z.literal('clean'),
  /** Delete. Without it nothing changes and the candidates are only listed. */
  apply: z.boolean().default(false),
  kinds: z.array(z.enum(CLEAN_KINDS)).min(1).optional(),
  /** Candidate ids from a dry run; with `apply`, only these are considered (each is re-validated). */
  items: z.array(z.string().min(1)).max(10000).optional(),
});
export type CleanCommand = z.infer<typeof cleanSchema>;
type Item = {
  id: string;
  kind: Kind;
  path: string;
  bytes: number;
  reason: string;
  laneId?: string;
  runId?: string;
  tail?: true;
  snapshotBytes?: number;
};
type Skipped = { kind: Kind; id: string; reason: string; laneId?: string; runId?: string };
const BUILD_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.netlify',
  'web-dist',
  'hosted-web-dist',
]);

function stat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
/** A real directory, not a link, whose resolved path is exactly `path`. */
function plainDirectory(path: string) {
  const info = stat(path);
  if (!info?.isDirectory() || info.isSymbolicLink()) return false;
  try {
    return realpathSync(path) === path;
  } catch {
    return false;
  }
}
function bytesOf(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += bytesOf(child);
    else total += stat(child)?.size ?? 0;
  }
  return total;
}
const measured = (path: string) => {
  try {
    return bytesOf(path);
  } catch {
    return undefined;
  }
};

function checkWorkspaces(
  store: WorkStore,
  items: Item[],
  skipped: Skipped[],
  automatic?: Automatic,
  processes?: ReturnType<typeof workingProcesses>,
) {
  for (const run of allRecords<CheckRun>(store, 'runs')) {
    if (automatic?.runId && automatic.runId !== run.id) continue;
    const directory = join(store.directory, `check-${run.id}`);
    for (const leaf of ['workspace', 'runtime']) {
      const path = join(directory, leaf);
      if (!stat(path)) continue;
      const skip = (reason: string) =>
        skipped.push({ kind: 'check-workspaces', id: path, runId: run.id, reason });
      if (run.status === 'queued' || run.status === 'preparing' || run.status === 'running') {
        skip(`Run is recorded as ${run.status}.`);
        continue;
      }
      if (run.runner.host !== hostname()) {
        skip('Run was recorded on another host; its processes cannot be checked.');
        continue;
      }
      if (run.childPid && processGroupAlive(run.childPid, run.childStartTime)) {
        skip('The run process group is still alive.');
        continue;
      }
      if (automatic) {
        // A process in either copy may still need its workspace and private HOME/temp together.
        const blocker = processBlocker(directory, processes!) ?? checkCleanupBlocker(store, run, directory);
        if (blocker) {
          skip(blocker);
          continue;
        }
      }
      const bytes = plainDirectory(directory) && plainDirectory(path) ? measured(path) : undefined;
      if (bytes === undefined) {
        skip('Workspace is not a plain readable directory.');
        continue;
      }
      items.push({
        id: path,
        kind: 'check-workspaces',
        path,
        bytes,
        runId: run.id,
        reason: `Run ${run.status} and its process group is gone; the disposable materialized copy is removed, while result.json, logs and artifacts stay.`,
      });
    }
  }
}

function laneDirectories(
  store: WorkStore,
  kinds: Kind[],
  items: Item[],
  skipped: Skipped[],
  automatic?: Automatic,
  processes?: ReturnType<typeof workingProcesses>,
) {
  const wantDeps = kinds.includes('lane-deps'),
    wantLanes = kinds.includes('lanes');
  if (!wantDeps && !wantLanes) return;
  const lanes = allRecords<Lane>(store, 'lanes'),
    source = new NativeSource(store.root),
    merged = mergedChecker(store, channelHeads(store));
  for (const lane of lanes) {
    if (automatic?.laneIds && !automatic.laneIds.includes(lane.id)) continue;
    const path = store.path(lane.id);
    if (!stat(path)) continue;
    const into = merged(lane),
      skip = (kind: Kind, reason: string) => skipped.push({ kind, id: path, laneId: lane.id, reason });
    if (!['completed', 'abandoned'].includes(lane.state)) {
      if (automatic) skip(wantLanes ? 'lanes' : 'lane-deps', `Lane is still ${lane.state}.`);
      else if (into && lane.state !== 'creating')
        skip(
          wantLanes ? 'lanes' : 'lane-deps',
          `Merged into ${into} but still ${lane.state}; complete it first (complete-merged).`,
        );
      continue;
    }
    const why = `Lane ${lane.state}${into ? ` and merged into ${into}` : ''}`;
    if (!plainDirectory(path)) {
      skip('lanes', 'Lane directory is not a plain directory.');
      continue;
    }
    let owned = false;
    try {
      owned = nativeOwner(path) === store.root;
    } catch {
      /* Unreadable marker: treated as not owned. */
    }
    if (!owned) {
      skip('lanes', 'Directory is not marked as this owner’s Lane.');
      continue;
    }
    if (automatic) {
      const blocker = processBlocker(path, processes!);
      if (blocker) {
        skip(wantLanes ? 'lanes' : 'lane-deps', blocker);
        continue;
      }
      try {
        if (
          lane.pending ||
          lane.pendingSync ||
          lane.pendingMerge ||
          lane.pendingUndo ||
          source.tree(source.capture(path, false, lane.head)) !== source.tree(source.state(lane.head).files)
        ) {
          skip(
            wantLanes ? 'lanes' : 'lane-deps',
            'Uncaptured edits or pending source operation; automatic cleanup skipped.',
          );
          continue;
        }
        const excluded: { path: string; reason: string }[] = [];
        nativePaths(
          path,
          source.state(lane.head).files.map(file => file.path),
          excluded,
        );
        if (
          wantLanes &&
          excluded.some(
            entry =>
              entry.path !== '.forge' &&
              (!BUILD_DIRS.has(basename(entry.path)) || !plainDirectory(join(path, entry.path))),
          )
        ) {
          skip(
            'lanes',
            'Excluded local files outside regenerable build directories are not retained in State; automatic cleanup skipped.',
          );
          continue;
        }
        for (const file of source.state(lane.head).files) source.object(file.blob);
      } catch {
        skip(wantLanes ? 'lanes' : 'lane-deps', 'Source coverage unavailable; automatic cleanup skipped.');
        continue;
      }
    }
    let whole = false;
    if (wantLanes) {
      if (lane.pending || lane.pendingSync || lane.pendingMerge || lane.pendingUndo)
        skip('lanes', 'Unresolved source operation is pending in this Lane.');
      else
        try {
          if (
            source.tree(source.capture(path, false, lane.head)) === source.tree(source.state(lane.head).files)
          ) {
            const bytes = measured(path);
            if (bytes === undefined) skip('lanes', 'Lane directory could not be measured.');
            else {
              whole = true;
              items.push({
                id: path,
                kind: 'lanes',
                path,
                bytes,
                laneId: lane.id,
                reason: `${why}; a capture equals head State ${lane.head.slice(0, 12)}, so it is reconstructable (reopen re-materializes it). Gitignored files such as .env and node_modules are not in State and go with it.`,
              });
            }
          } else skip('lanes', 'Skipped: uncaptured edits (directory differs from the Lane head State).');
        } catch {
          skip('lanes', 'Skipped: directory could not be captured for comparison.');
        }
    }
    if (!wantDeps || whole) continue;
    try {
      const excluded: { path: string; reason: string }[] = [];
      nativePaths(
        path,
        source.state(lane.head).files.map(file => file.path),
        excluded,
      );
      for (const entry of excluded) {
        const full = join(path, entry.path);
        if (!BUILD_DIRS.has(basename(entry.path)) || !plainDirectory(full)) continue;
        const bytes = measured(full);
        if (bytes === undefined) continue;
        items.push({
          id: full,
          kind: 'lane-deps',
          path: full,
          bytes,
          laneId: lane.id,
          reason: `${why}; ${entry.path} is ${entry.reason === 'gitignored' ? 'gitignored' : 'excluded'} build output, not in State, and regenerates from the lockfile.`,
        });
      }
    } catch {
      skip('lane-deps', 'Lane directory could not be scanned.');
    }
  }
}

type Automatic = { id: string; actor: string; laneIds?: string[]; runId?: string };
function plan(store: WorkStore, kinds: Kind[], automatic?: Automatic, selected?: Set<string>) {
  const items: Item[] = [],
    skipped: Skipped[] = [];
  const processes = workingProcesses();
  if (kinds.includes('check-workspaces')) checkWorkspaces(store, items, skipped, automatic, processes);
  laneDirectories(store, kinds, items, skipped, automatic, processes);
  if (kinds.includes('auto-snapshots')) items.push(...autoSnapshotRetentionPlan(store));
  const retention = retentionPlan(store, kinds, processes, Date.now(), selected);
  items.push(...retention.items.filter(item => !items.some(existing => existing.path === item.path)));
  skipped.push(...retention.skipped);
  return { items, skipped };
}
const objectItems = (store: WorkStore) =>
  (
    nativeObjects(store, { action: 'inspect-native-objects' }).result.candidates as {
      id: string;
      bytes: number;
    }[]
  ).map((item): Item => ({
    id: `object:${item.id}`,
    kind: 'objects',
    path: join(new NativeSource(store.root).directory, item.id),
    bytes: item.bytes,
    reason: 'Digest object not reachable from retained State, Work records or history.',
  }));

function remove(store: WorkStore, item: Item): string | undefined {
  if (item.kind === 'auto-snapshots') {
    try {
      return removeAutoSnapshot(store, item as SnapshotRetentionItem);
    } catch {
      return 'Auto-snapshot removal failed; remaining files stay for retry.';
    }
  }
  // Re-check immediately before deleting: inside the owner's Work directory, and not a link.
  const inside = (path: string) => path.startsWith(store.directory + '/');
  if (!inside(item.path) || (!item.tail && !plainDirectory(item.path)))
    return 'Path changed or is no longer a plain directory.';
  if (!plainDirectory(dirname(item.path))) return 'Parent directory changed.';
  try {
    if (item.kind === 'check-retention' || item.kind === 'exchange-staging')
      removeRetention({ ...item, kind: item.kind });
    else rmSync(item.path, { recursive: true, force: true });
    return undefined;
  } catch {
    return 'Removal failed part-way; remaining files stay and a retry continues.';
  }
}

function cleanupResult(
  command: CleanCommand,
  kinds: Kind[],
  listed: Item[],
  skipped: Skipped[],
  skippedKinds: object[],
) {
  const group = (kind: Kind) => {
      const own = listed.filter(item => item.kind === kind);
      return {
        kind,
        count: own.length,
        bytes: own.reduce((sum, item) => sum + item.bytes, 0),
        ...(kind === 'auto-snapshots'
          ? { snapshotBytes: own.reduce((sum, item) => sum + (item.snapshotBytes ?? 0), 0) }
          : {}),
        items: own,
      };
    },
    groups = kinds.map(group).filter(item => item.count > 0 || skipped.some(s => s.kind === item.kind));
  return {
    mode: command.apply ? 'applied' : 'dry-run',
    kinds,
    [command.apply ? 'removed' : 'candidates']: groups,
    skipped,
    skippedKinds,
    totals: { count: listed.length, bytes: listed.reduce((sum, item) => sum + item.bytes, 0) },
    note: command.apply
      ? 'Removed items were re-validated under the owner lock. Work records, State objects, check results, log tails and artifacts remain; repeating is safe.'
      : 'No files were deleted. Send {"apply":true} (optionally with these item ids) to delete; every item is re-validated at that time.',
  };
}

export function agentClean(store: WorkStore, command: CleanCommand, automatic?: Automatic) {
  invariant(store.native, 'UNSUPPORTED_NATIVE_WORK', 'clean supports a native Work owner.');
  if (automatic) {
    invariant(
      command.apply &&
        command.kinds?.every(kind =>
          [
            'check-workspaces',
            'check-retention',
            'exchange-staging',
            'auto-snapshots',
            'lane-deps',
            'lanes',
          ].includes(kind),
        ),
      'BAD_ARGUMENT',
      'Automatic cleanup supports regenerable copies and seven-day retention only.',
    );
    const original = store.select('automaticActions', automatic.id);
    if (original?.result) return { revision: store.revision(), result: JSON.parse(original.result) };
  }
  const kinds = command.kinds ?? DEFAULT_KINDS,
    skippedKinds: { kind: Kind; reason: string; observed?: object }[] = [];
  let items: Item[], skipped: Skipped[];
  const removed: Item[] = [];
  if (command.apply) {
    ({ items, skipped } = store.locked(() => {
      const replay = automatic && store.select('automaticActions', automatic.id);
      if (replay?.result) return { items: [] as Item[], skipped: [] as Skipped[] };
      // Reconcile dead runners first so interrupted runs are recognized as finished.
      recoverRecordRuns(store, store.records());
      const current =
          automatic && !readPolicy(store).lifecycle.cleanRegenerableCopies
            ? {
                items: [] as Item[],
                skipped: [
                  {
                    kind: kinds[0]!,
                    id: automatic.id,
                    reason: 'Automatic cleanup is disabled by current lifecycle policy.',
                  },
                ] as Skipped[],
              }
            : plan(store, kinds, automatic, command.items ? new Set(command.items) : undefined),
        wanted = command.items ? new Set(command.items) : undefined,
        chosen = wanted ? current.items.filter(item => wanted.has(item.id)) : current.items;
      if (wanted)
        for (const id of wanted)
          if (!id.startsWith('object:') && !current.items.some(item => item.id === id))
            current.skipped.push({
              kind: kinds[0]!,
              id,
              reason: 'No longer eligible or not found; it changed since the dry run.',
            });
      // An empty automatic sweep has no action or replayable effect to journal.
      if (automatic && !chosen.length && !replay) return { items: chosen, skipped: current.skipped };
      // Children first: a Lane directory removal covers its deps entries.
      const tx = automatic ? store.records() : undefined;
      if (tx && automatic) {
        const prior = tx.find('automaticActions', automatic.id);
        if (!prior) {
          tx.setSchema(11);
          tx.append('automaticActions', {
            id: automatic.id,
            at: new Date().toISOString(),
            action: {
              actor: automatic.actor,
              summary: `Clean regenerable copies: ${chosen.map(i => i.path).join(', ')}`,
              undo: 'Run reopen with the Lane id to re-materialize its retained head. Checks reconstruct workspaces when run again. Restore Lane dependencies with npm ci --ignore-scripts and rerun the build; retained source, log tails and artifacts remain. Seven-day retention removes older copies and log prefixes; those prefixes cannot be reconstructed. Expired closed-Lane auto-snapshot pointers and caches cannot be restored; object collection can later reclaim their otherwise unreachable unsaved source.',
            },
          });
          store.commitRecords(tx);
        }
      }
      let exchangeFailed = false;
      // Retained exchange manifests pin exact log bytes. Remove staging first;
      // if that fails, no check retention from this plan may invalidate it.
      chosen.sort((a, b) => Number(b.kind === 'exchange-staging') - Number(a.kind === 'exchange-staging'));
      for (const item of chosen) {
        const failure =
          item.kind === 'check-retention' && exchangeFailed
            ? 'Exchange removal failed; its selected check bytes remain pinned.'
            : remove(store, item);
        if (failure && item.kind === 'exchange-staging') exchangeFailed = true;
        if (failure) current.skipped.push({ kind: item.kind, id: item.id, reason: failure });
        else removed.push(item);
      }
      if (automatic) {
        const tx = store.records(),
          original = tx.find('automaticActions', automatic.id)!;
        tx.replace('automaticActions', original.position, {
          ...original.record,
          result: JSON.stringify(cleanupResult(command, kinds, removed, current.skipped, skippedKinds)),
        });
        store.commitRecords(tx);
      }
      return { items: chosen, skipped: current.skipped };
    }));
    if (kinds.includes('objects')) {
      const wanted = command.items ? new Set(command.items) : undefined,
        candidates = objectItems(store);
      if (wanted && candidates.some(item => !wanted.has(item.id)))
        skipped.push({
          kind: 'objects',
          id: 'objects',
          reason: 'Unreferenced objects changed since the dry run.',
        });
      else {
        const result = nativeObjects(store, { action: 'collect-native-objects' }).result;
        const gone = new Set((result.removed as { id: string }[]).map(item => `object:${item.id}`));
        for (const item of candidates) if (gone.has(item.id)) removed.push(item);
        for (const item of result.preserved as { name: string; reason: string }[])
          skipped.push({ kind: 'objects', id: `object:${item.name}`, reason: item.reason });
      }
    }
  } else {
    ({ items, skipped } = store.locked(() => plan(store, kinds)));
    if (kinds.includes('objects')) items.push(...objectItems(store));
  }
  void items;
  const result = cleanupResult(command, kinds, command.apply ? removed : items, skipped, skippedKinds);
  return {
    revision: store.revision(),
    result: automatic
      ? (JSON.parse(
          store.select('automaticActions', automatic.id)?.result ?? JSON.stringify(result),
        ) as typeof result)
      : {
          ...result,
          ...(!command.apply && kinds.includes('auto-snapshots')
            ? { disk: { kinds: [autoSnapshotDiskUsage(store)] } }
            : {}),
        },
  };
}

// SPDX-License-Identifier: Apache-2.0
// Pure: also runs in the Convex non-Node runtime.
import { z } from 'zod';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './state/hash.js';
import { SNAPSHOT_INTERVAL_MINUTES } from './lane-snapshot-interval.js';

/**
 * Unsaved-work snapshots (Issue 7ac4e32f). A snapshot is a hidden save of a Lane checkout's
 * working files: it never moves the Lane head, never lands and never runs checks or notices.
 * Its delta pages (the save page format, src/hosted-save.ts) and changed file bytes live in R2
 * under the Lane's own snapshot prefix, apart from source objects, so expiry and purge delete
 * them for real. Convex keeps one small row per operation-log entry, never file bytes or paths.
 */
export const LANE_SNAPSHOT = {
  /** A Lane's snapshots expire this long after its latest one (owner-adjustable default). */
  retentionMs: 14 * 24 * 60 * 60 * 1000,
  /** jj's snapshot.max-new-file-size: a new file larger than this is left out and reported. */
  newFileBytes: 1024 * 1024,
  /** Bytes one snapshot may upload (its pages plus changed files). */
  snapshotBytes: 64 * 1024 * 1024,
  /** Snapshot bytes one Lane may hold in R2 until its snapshots expire or are purged. */
  laneBytes: 512 * 1024 * 1024,
  /** Objects one prepare may sign in the loose (pre-pack) shape; a larger change waits for an explicit save. */
  uploads: 200,
  /** Timed snapshots: one per Lane per interval during activity (project policy
   * autoSnapshotIntervalMinutes). The turn-end snapshot and the one before a command that rewrites
   * files are never held back by it and never count against it. */
  intervalMinutes: SNAPSHOT_INTERVAL_MINUTES,
  /** Entries `list` returns, newest first. */
  listLimit: 200,
} as const;

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const snapshotPinSchema = z.object({ sha256: hash, size: count }).strict();
export type SnapshotPin = z.infer<typeof snapshotPinSchema>;

/** R2 key of one snapshot object; inside the project prefix, so project deletion covers it. */
export const laneSnapshotPrefix = (projectId: string, laneId: string) => `v1/p/${projectId}/s/${laneId}/`;
export const laneSnapshotKey = (projectId: string, laneId: string, sha256: string) =>
  `${laneSnapshotPrefix(projectId, laneId)}${sha256}`;

/** The identity of a working tree: the saved head it was taken on and its delta pages. */
export const snapshotTree = (head: string, pages: SnapshotPin | null) =>
  digest(canonicalPayload({ kind: 'forge-lane-snapshot-tree', head, pages }));

export const snapshotPrepareSchema = z
  .object({
    laneId: z.uuid(),
    operationId: z.uuid(),
    /** The Lane's saved head the delta is relative to. */
    head: hash,
    tree: hash,
    /** Root delta page, or null when the working files equal the head (every edit undone). */
    pages: snapshotPinSchema.nullable(),
    pageCount: count,
    changeCount: count,
    /** Loose shape (before feature lane-snapshot-packs): its pages and changed files the Lane store
     * lacks, one object each, made live by `commit`. */
    uploads: z.array(snapshotPinSchema).max(LANE_SNAPSHOT.uploads).default([]),
    /** Pack shape: the pages and the changed files the Lane store lacks as ONE content-addressed
     * object (src/lane-snapshot-pack.ts), live as soon as `prepare` answers. Null when the working
     * files equal the head. */
    pack: snapshotPinSchema.nullable().optional(),
    /** Files the capture left out (credentials, ignore rules, size cap); counted, never named. */
    notSaved: count,
    /** The Lane snapshot store the client uploaded to before (from `prepare`), or null. When the
     * store was dropped since (expiry, purge), `prepare` answers `reset` and the client resends. */
    store: z.string().max(64).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.pages === null) !== (value.changeCount === 0) ||
      value.tree !== snapshotTree(value.head, value.pages)
    )
      ctx.addIssue({ code: 'custom', message: 'Snapshot tree, pages and change count disagree.' });
    if (
      value.pack !== undefined &&
      (value.uploads.length > 0 || (value.pack === null) !== (value.pages === null))
    )
      ctx.addIssue({ code: 'custom', message: 'A packed snapshot names its pack and no loose uploads.' });
  });
export type SnapshotPrepare = z.infer<typeof snapshotPrepareSchema>;

export const snapshotEntrySchema = z
  .object({
    seq: count,
    kind: z.enum(['snapshot', 'restore']),
    at: z.iso.datetime(),
    head: hash,
    tree: hash,
    pages: snapshotPinSchema.nullable(),
    /** The one object holding this snapshot's pages and new files (absent on loose snapshots). */
    pack: snapshotPinSchema.optional(),
    changeCount: count,
    /** The snapshot the working files matched just before this entry (none for the first). */
    parent: count.optional(),
    /** restore: the snapshot this entry moved the working files to, and why. */
    target: count.optional(),
    move: z.enum(['undo', 'redo', 'restore']).optional(),
    uploadBytes: count,
    notSaved: count,
  })
  .strict();
export type SnapshotEntry = z.infer<typeof snapshotEntrySchema>;

export const snapshotListSchema = z
  .object({
    laneId: z.uuid(),
    entries: z.array(snapshotEntrySchema),
    laneBytes: count,
    expiresAt: z.iso.datetime().nullable(),
    purging: z.boolean(),
  })
  .strict();

export const snapshotPrepareResultSchema = z
  .object({
    seq: count,
    state: z.enum(['live', 'pending', 'unchanged', 'reset']),
    /** The Lane snapshot store this entry lives in; null only on `reset` with no store left. */
    store: z.string().nullable(),
    targets: z.array(
      z.object({ sha256: hash, url: z.string(), headers: z.record(z.string(), z.string()) }).strict(),
    ),
  })
  .strict();

/** `x snapshots`: bare lists the Lane's operation log; one move or purge at a time. */
export const snapshotsCommandSchema = z
  .object({
    laneId: z.uuid().optional(),
    undo: z.number().int().min(1).max(100).optional(),
    redo: z.number().int().min(1).max(100).optional(),
    restore: z.union([z.number().int().min(1), z.literal('latest')]).optional(),
    purge: z.literal(true).optional(),
  })
  .strict()
  .refine(
    value =>
      [value.undo, value.redo, value.restore, value.purge].filter(item => item !== undefined).length <= 1,
    'Choose one of undo, redo, restore or purge.',
  );
export type SnapshotsCommand = z.infer<typeof snapshotsCommandSchema>;

/** The snapshot an entry leaves the working files at. */
const resolved = (entry: Pick<SnapshotEntry, 'kind' | 'seq' | 'target'>) =>
  entry.kind === 'restore' ? entry.target! : entry.seq;

/**
 * Undo/redo/restore target from the operation log, like jj's operation log: the working files
 * match the snapshot the newest entry resolves to. Undo moves to the snapshot they matched
 * before it (its parent); redo walks back the undos made since the last new snapshot. Steps
 * repeat the move. Returns the snapshot seq, or null when there is nothing to move to.
 */
export function snapshotTarget(
  entries: readonly Pick<SnapshotEntry, 'seq' | 'kind' | 'parent' | 'target' | 'move'>[],
  move: { undo?: number; redo?: number; restore?: number | 'latest' },
): number | null {
  const log = [...entries].sort((a, b) => a.seq - b.seq);
  const snapshots = new Map(log.filter(entry => entry.kind === 'snapshot').map(entry => [entry.seq, entry]));
  if (!snapshots.size) return null;
  if (move.restore === 'latest') return Math.max(...snapshots.keys());
  if (typeof move.restore === 'number') return snapshots.has(move.restore) ? move.restore : null;
  const kind = move.redo ? 'redo' : 'undo';
  let steps = move.redo ?? move.undo ?? 1,
    seq = log.at(-1)!.seq;
  for (; steps > 0; steps--) {
    const current = resolved(log.at(-1)!);
    let target: number | undefined;
    if (kind === 'undo') target = snapshots.get(current)?.parent;
    else
      for (let index = log.length - 1, depth = 0; index >= 0; index--) {
        const entry = log[index]!;
        if (entry.kind !== 'restore' || entry.move === 'restore') break;
        if (entry.move === 'redo') depth++;
        else if (depth) depth--;
        else {
          target = entry.parent;
          break;
        }
      }
    if (target === undefined || !snapshots.has(target)) return null;
    log.push({ seq: ++seq, kind: 'restore', target, parent: current, move: kind });
  }
  return resolved(log.at(-1)!);
}

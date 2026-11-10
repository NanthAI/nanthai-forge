// SPDX-License-Identifier: Apache-2.0
import { mergeNativeText, nativeConflictRegions } from './native-text-merge.js';
import { syntaxConflictReason } from './native-merge-syntax.js';

/** Exact conflicts at save (flip 4, Issue 853fcde3). A save trial-merges each file it shares with
 * main (when main changed it after the Lane's base) and with other open Lanes that saved the same
 * file, using composition's own rules: the per-file entry rule of native-merge, mergeNativeText and
 * the compose syntax gate. Pure: the caller supplies the bytes; nothing is written anywhere. */
export type TrialFile = { blob: string; mode: string } | null;
export type TrialPeer = { laneId: string; before: TrialFile; after: TrialFile };
export type TrialTask = {
  path: string;
  mine: { before: TrialFile; after: TrialFile };
  /** Main's file, only when main changed the path after this Lane's base; absent means unchanged. */
  main?: TrialFile;
  peers: TrialPeer[];
};
export type TrialRange = [number, number];
export type TrialConflict = {
  /** The other side: a Lane id, or 'main'. */
  peer: string;
  path: string;
  /** Line ranges in this Lane's file and in the other side's file (at most TRIAL_RANGES each). */
  mine: TrialRange[];
  theirs: TrialRange[];
  reason: string;
};
export const TRIAL_RANGES = 5;
type Held = { blob: string; mode: string; bytes?: Buffer } | null;
type Outcome =
  | { ok: true; file: Held }
  | { ok: false; reason: string; left: TrialRange[]; right: TrialRange[] };

const same = (a: Held | undefined, b: Held | undefined) =>
  !a || !b ? !a && !b : a.blob === b.blob && a.mode === b.mode && !a.bytes && !b.bytes;
const refuse = (reason: string, left: TrialRange[] = [], right: TrialRange[] = []): Outcome => ({
  ok: false,
  reason,
  left: left.slice(0, TRIAL_RANGES),
  right: right.slice(0, TRIAL_RANGES),
});

/** Bytes of a file this trial needs but could not read (recipe-only, too large, or missing). */
export class TrialUnavailable extends Error {}

/** One file, three versions: the same decision as native-merge's per-file entry (x = the current
 * side, y = the Lane composed onto it), then the compose syntax gate on a text merge. */
async function entry(
  path: string,
  original: Held,
  x: Held,
  y: Held,
  read: (file: NonNullable<Held>) => Buffer,
): Promise<Outcome> {
  if (same(x, y)) return { ok: true, file: x };
  if (same(x, original)) return { ok: true, file: y };
  if (same(y, original)) return { ok: true, file: x };
  if (!original || !x || !y)
    return refuse(!x || !y ? 'deleted on one side, changed on the other' : 'added on both sides');
  if (x.mode !== y.mode && x.mode !== original.mode && y.mode !== original.mode)
    return refuse('file mode changed on both sides');
  const mode = x.mode === original.mode ? y.mode : x.mode;
  if (!x.bytes && !y.bytes && x.blob === y.blob) return { ok: true, file: { blob: x.blob, mode } };
  if ([original, x, y].some(file => ['symlink', 'gitlink'].includes(file.mode)))
    return refuse('link changed on both sides');
  const [base, left, right] = [original, x, y].map(read) as [Buffer, Buffer, Buffer];
  const merged = mergeNativeText(base, left, right, path);
  if (!merged) {
    const regions = nativeConflictRegions(base, left, right);
    if (!regions) return refuse('binary or too different to align');
    if (!regions.length) return refuse('imports cannot be reconciled');
    return refuse(
      'both changed the same lines',
      regions.map(region => region.left),
      regions.map(region => region.right),
    );
  }
  const syntax = await syntaxConflictReason(path, merged, left, right);
  if (syntax) return refuse(syntax.slice(0, 240));
  return { ok: true, file: { blob: '', mode, bytes: merged } };
}

/** Every real conflict of the tasks. `read` returns verified bytes for a blob digest or throws
 * TrialUnavailable; a file that cannot be read is skipped and named in `unavailable`. */
export async function trialMerge(tasks: TrialTask[], read: (blob: string) => Buffer) {
  const conflicts: TrialConflict[] = [],
    unavailable: string[] = [];
  const bytes = (file: NonNullable<Held>) => file.bytes ?? read(file.blob);
  let merges = 0;
  for (const task of tasks) {
    try {
      const before = task.mine.before,
        after = task.mine.after;
      // This Lane composed onto current main (compose: main is x, the Lane is y).
      let current: Held = after,
        mainConflict = false;
      if (task.main !== undefined && !same(task.main, before)) {
        merges++;
        const onMain = await entry(task.path, before, task.main, after, bytes);
        if (onMain.ok) current = onMain.file;
        else {
          mainConflict = true;
          conflicts.push({
            peer: 'main',
            path: task.path,
            mine: onMain.right,
            theirs: onMain.left,
            reason: onMain.reason,
          });
        }
      }
      for (const peer of task.peers) {
        if (same(peer.after, current)) continue;
        // The peer composes after this Lane, from the peer's own base (as compose does). When this
        // Lane conflicts with main, only a peer on this Lane's base can still be compared exactly.
        if (mainConflict && !same(peer.before, before)) continue;
        merges++;
        const pair = await entry(task.path, peer.before, current, peer.after, bytes);
        if (!pair.ok)
          conflicts.push({
            peer: peer.laneId,
            path: task.path,
            mine: pair.left,
            theirs: pair.right,
            reason: pair.reason,
          });
      }
    } catch (error) {
      if (!(error instanceof TrialUnavailable)) throw error;
      unavailable.push(task.path);
    }
  }
  return { conflicts, unavailable, merges };
}

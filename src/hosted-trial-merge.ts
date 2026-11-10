// SPDX-License-Identifier: Apache-2.0
import { mergeNativeText, nativeConflictRegions } from './native-text-merge.js';
import { syntaxConflictReason } from './state/merge-syntax.js';
import { conflictRule, resolveListText } from './native-docs-resolve.js';
import type { DeclaredMergePaths } from './project-config.js';

/** Exact conflicts at save (flip 4, Issue 853fcde3). A save trial-merges each file it shares with
 * main (when main changed it after the Lane's base) and with other open Lanes that saved the same
 * file, using composition's own rules: the per-file entry rule of state/merge, mergeNativeText,
 * the compose syntax gate, and compose's conflict rules (Markdown docs and main's forge.json
 * `merge` lists), so a notice never names a conflict the landing would merge on its own. Pure: the caller supplies the bytes; nothing is written anywhere. */
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

const LINKS = ['symlink', 'gitlink'];
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

/** One file, three versions: the same decision as state/merge's per-file entry (x = the current
 * side, y = the Lane composed onto it), then the compose syntax gate on a text merge. A text conflict
 * compose would resolve (resolveDocsComposition: Markdown docs, main's declared lists; an add on both
 * sides with one mode against an empty base) is merged the same way, with no syntax gate. */
async function entry(
  path: string,
  original: Held,
  x: Held,
  y: Held,
  read: (file: NonNullable<Held>) => Buffer,
  declared: () => Promise<DeclaredMergePaths>,
): Promise<Outcome> {
  if (same(x, y)) return { ok: true, file: x };
  if (same(x, original)) return { ok: true, file: y };
  if (same(y, original)) return { ok: true, file: x };
  if (!x || !y) return refuse('deleted on one side, changed on the other');
  const ruled = async (): Promise<Outcome | null> => {
    const rule = conflictRule(path, await declared());
    if (!rule || [original, x, y].some(file => file && LINKS.includes(file.mode))) return null;
    const bytes = resolveListText(original ? read(original) : Buffer.alloc(0), read(x), read(y), rule);
    const mode = original && y.mode === original.mode ? x.mode : y.mode;
    return bytes ? { ok: true, file: { blob: '', mode, bytes } } : null;
  };
  if (!original) return (x.mode === y.mode && (await ruled())) || refuse('added on both sides');
  if (x.mode !== y.mode && x.mode !== original.mode && y.mode !== original.mode)
    return (await ruled()) ?? refuse('file mode changed on both sides');
  const mode = x.mode === original.mode ? y.mode : x.mode;
  if (!x.bytes && !y.bytes && x.blob === y.blob) return { ok: true, file: { blob: x.blob, mode } };
  if ([original, x, y].some(file => LINKS.includes(file.mode))) return refuse('link changed on both sides');
  const [base, left, right] = [original, x, y].map(read) as [Buffer, Buffer, Buffer];
  const merged = mergeNativeText(base, left, right, path);
  if (!merged) {
    const resolved = await ruled();
    if (resolved) return resolved;
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
 * TrialUnavailable; a file that cannot be read is skipped and named in `unavailable`. `declared`
 * returns main's forge.json merge paths; it is called (once) only when a text conflict needs a rule. */
export async function trialMerge(
  tasks: TrialTask[],
  read: (blob: string) => Buffer,
  declared: () => Promise<DeclaredMergePaths> = async () => ({ union: [], fragments: [] }),
) {
  let paths: Promise<DeclaredMergePaths> | undefined;
  const mergePaths = () => (paths ??= declared());
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
        const onMain = await entry(task.path, before, task.main, after, bytes, mergePaths);
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
      // Main's file as far as this plan knows: unchanged since this Lane's base unless named.
      const mainFile = task.main !== undefined ? task.main : before;
      for (const peer of task.peers) {
        if (same(peer.after, current)) continue;
        // The peer composes after this Lane, from the peer's own base (as compose does). When this
        // Lane conflicts with main, only a peer on this Lane's base can still be compared exactly.
        if (mainConflict && !same(peer.before, before)) continue;
        // A peer on another base must compose onto main alone first. When it cannot, the conflict is
        // the peer's with main (its own save names it), not this pair's: dogfood 2026-11-10 blamed
        // 139 such file conflicts on newer Lanes after main rewrote three hot files.
        if (!same(peer.before, before) && !same(peer.before, mainFile)) {
          merges++;
          if (!(await entry(task.path, peer.before, mainFile, peer.after, bytes, mergePaths)).ok) continue;
        }
        merges++;
        const pair = await entry(task.path, peer.before, current, peer.after, bytes, mergePaths);
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

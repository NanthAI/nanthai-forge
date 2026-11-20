// SPDX-License-Identifier: Apache-2.0
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { hostedLaneDirty, laneChanges } from './hosted-lane-dirty.js';
import { deltaApplyPending } from './hosted-checkout-delta-pending.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { ForgeError } from './errors.js';
import { shellQuote } from './shell-quote.js';
import type { NativeFile } from './state/format.js';

/** True when this checkout already settled the save with this operation id: its receipt replays
 * and the call captures nothing new. Local read only. */
export function saveSettledHere(root: string, operationId: string) {
  try {
    return checkoutPathExists(
      join(clientCacheRoot(realpathSync(root)), 'saves', operationId, 'terminal.json'),
    );
  } catch {
    return false;
  }
}

/** An earlier invocation of this save started here (its capture folder exists): this call is a replay. */
export function saveStartedHere(root: string, operationId: string) {
  try {
    return checkoutPathExists(join(clientCacheRoot(realpathSync(root)), 'saves', operationId));
  } catch {
    return false;
  }
}

/** The step split a save receipt keeps (Issue 15fd0037 F4). The first invocation that sees the outcome
 * retains its split; when an earlier call of the same save returned IN_PROGRESS, that split is a
 * replay's (no capture or upload) and says so with `replay: true`. A settled replay returns the kept one. */
export async function keptSaveTiming<T extends { stepsMs: Record<string, number> }>(
  journal: { get<V>(key: string): V | undefined; retain<V>(key: string, prepare: () => V): Promise<V> },
  input: { outcome: boolean; split: T; replay: boolean },
): Promise<(T & { replay?: true }) | undefined> {
  if (!input.outcome || !Object.keys(input.split.stepsMs).length) return journal.get('save-timing');
  return journal.retain('save-timing', () =>
    input.replay ? { ...input.split, replay: true as const } : input.split,
  );
}

/** The tree a save captured, as its receipt will install it: the baseline's files and materialized
 * paths with the captured changes applied (as applyHostedSaveReceipt does, so a scoped checkout's
 * paths outside its scope stay unmaterialized). Null once the save settled (capture.json is dropped
 * then) or when it cannot be read. Local read only. */
export function capturedTree(root: string, operationId: string): CapturedTree | null {
  try {
    const capture = JSON.parse(
      readFileSync(join(clientCacheRoot(realpathSync(root)), 'saves', operationId, 'capture.json'), 'utf8'),
    ) as {
      marker: { state: { files: NativeFile[] }; materialized: string[] };
      changes: { path: string; after: { blob: string; mode: NativeFile['mode'] } | null }[];
    };
    const files = new Map(capture.marker.state.files.map(file => [file.path, file])),
      materialized = new Set(capture.marker.materialized);
    for (const change of capture.changes)
      if (change.after) {
        files.set(change.path, { path: change.path, blob: change.after.blob, mode: change.after.mode });
        materialized.add(change.path);
      } else {
        files.delete(change.path);
        materialized.delete(change.path);
      }
    return { files: [...files.values()], materialized: [...materialized] };
  } catch {
    return null;
  }
}
type CapturedTree = { files: NativeFile[]; materialized: string[] };

/** Paths in this checkout that differ from the head its marker names (or from `expected`, a tree a
 * settling save captured): hostedLaneDirty's comparison, listing every path. One lstat pass that
 * reads only files the stat index cannot vouch for. Null when the folder is not a Lane checkout or an
 * in-place apply is pending; throws when a file cannot be read. No call. */
export function unsavedPaths(root: string, expected?: CapturedTree): string[] | null {
  const marker = readHostedLaneCheckout(root);
  if (!marker || deltaApplyPending(root)) return null;
  return [...new Set(laneChanges(root, marker, expected ? { expected } : {}))].sort();
}

const SHOWN = 20;
/** Local edits a command moved out of the checkout (kept-apply, a displaced prior copy): not in the head. */
export type KeptOut = { directories: string[]; count: number; paths: string[] };
/** The final check of every reply that claims a save: save (completed and settling), sync and
 * `save --sync`, `land --save` and recover-apply (Issues ca49dc6c, 48835eea). A reply that names a
 * save holds only while this checkout equals the head it saved (or, for a save still settling, the
 * tree it captured) and the command moved no local edit out of the checkout (`kept`). Otherwise it
 * is not a success: UNSAVED_LANE_EDITS (non-zero exit) names the files and the next step, and
 * `recovery.completed` keeps what the command did finish. One local lstat pass; no call. A scan that
 * cannot finish (a file changed while it was read) also refuses: nothing then proves the edits were
 * taken. */
export function assertSavedCheckout(
  root: string,
  said: {
    what: string;
    completed?: unknown;
    /** What a settling save captured; omitted: the head the marker names. */
    expected?: CapturedTree | null;
    /** False when the reply names no head this checkout should equal (nothing was installed). */
    scan?: false;
    kept?: KeptOut | null;
    /** The step that continues this one (a retained handoff): named instead of a bare save. */
    then?: { next: unknown; command: string };
  },
) {
  let paths: string[] = [],
    unread = false;
  if (said.scan !== false)
    try {
      const found = unsavedPaths(root, said.expected ?? undefined);
      // A pending in-place apply means the marker may not describe the bytes yet: nothing proves them.
      if (found === null) unread = !!readHostedLaneCheckout(root);
      else paths = found;
    } catch {
      unread = true;
    }
  const kept = said.kept && (said.kept.count || said.kept.directories.length) ? said.kept : null;
  if (!paths.length && !unread && !kept) return;
  const command = said.then?.command ?? `nforge agent ${shellQuote(root)} save '{}'`;
  const listed = paths.slice(0, SHOWN),
    more = paths.length - listed.length,
    one = paths.length === 1;
  const sentences = [
    unread
      ? 'this checkout could not be compared with the head it reports (a file changed while it was read, or an install is unfinished), so nothing proves its edits are saved.'
      : paths.length
        ? `${paths.length} file${one ? '' : 's'} in this checkout differ${one ? 's' : ''} from the head it reports, so ${one ? 'it is' : 'they are'} not saved: ${listed.join(', ')}${more ? ` (+${more} more)` : ''}.`
        : '',
    kept
      ? `${kept.count ? `${kept.count} local change${kept.count === 1 ? '' : 's'}` : 'Local bytes'} that clashed with it ${kept.count === 1 ? 'was' : 'were'} moved out of the checkout to ${kept.directories.join(', ')} and ${kept.count === 1 ? 'is' : 'are'} not in the Lane head${kept.paths.length ? `: ${kept.paths.slice(0, SHOWN).join(', ')}` : ''}. Copy back what you need.`
      : '',
  ].filter(Boolean);
  throw new ForgeError(
    'UNSAVED_LANE_EDITS',
    `${said.what}, but ${sentences.join(' ')} Then run: ${command}`,
    undefined,
    {
      status: 'needs-action',
      unsaved: { count: paths.length, paths: listed, ...(more ? { more } : {}) },
      ...(kept ? { kept: { ...kept, paths: kept.paths.slice(0, SHOWN) } } : {}),
      ...(said.completed !== undefined ? { completed: said.completed } : {}),
      next: said.then?.next ?? { action: 'save' },
      command,
    },
  );
}

/** A bare save whose settled receipt would replay while this checkout matches its saved head: there is
 * nothing to save. The answer names the head this checkout is on now (a sync since that save moved it)
 * and the earlier save, so no older receipt, head or failure is replayed as this call's result (ad80e037).
 * Null when edits differ from the head (a new save runs) or the checkout cannot be read. Local reads only. */
export function nothingToSave(root: string, operationId: string) {
  try {
    if (hostedLaneDirty(root)) return null;
    const marker = readHostedLaneCheckout(root);
    if (!marker) return null;
    const { laneId, head, version } = marker.selection;
    let lastHead: string | undefined;
    try {
      const settled = JSON.parse(
        readFileSync(
          join(clientCacheRoot(realpathSync(root)), 'saves', operationId, 'terminal.json'),
          'utf8',
        ),
      ) as { outcome?: { result?: { head?: unknown } } };
      const saved = settled.outcome?.result?.head;
      if (typeof saved === 'string') lastHead = saved;
    } catch {
      /* The note then names the earlier save without its head. */
    }
    const moved = lastHead !== undefined && lastHead !== head ? lastHead : undefined;
    return {
      status: 'nothing-to-save' as const,
      laneId,
      head,
      version,
      note: `Nothing to save: this checkout matches this checkout's saved head ${head.slice(0, 12)}, so no save ran.${
        moved
          ? ` The last save here (${operationId}) saved ${moved.slice(0, 12)}; this checkout moved on since (a sync).`
          : ''
      }`,
    };
  } catch {
    return null;
  }
}

// SPDX-License-Identifier: Apache-2.0
import { checkTerminal } from './check-run-state.js';
import { conflictMarkerScan, scanConflictMarkers, conflictMarkersFound } from './conflict-markers.js';
import {
  assertNoConflictMarkers,
  inPlaceResolution,
  pendingConflictPaths,
} from './hosted-conflict-precheck.js';
import { normalizeHostedFinishResult } from './hosted-agent-finish-result.js';
import { lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nativePaths } from './source-paths.js';
import { indexedBlob, readCheckoutStatIndex } from './checkout-stat-index.js';
import { forgeCachePath } from './forge-cache-paths.js';
import { SourceFileReader } from './source-file-reader.js';
import { digest } from './hash.js';
import { gitlinkDirectoryPointer } from './gitlink-workspace.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { readHostedLaneCheckout, type HostedLaneCheckoutMarker } from './hosted-lane-checkout-marker.js';
import { hostedAgentDirectory, readAgentJson, HostedAgentJournal } from './hosted-agent-journal.js';
import { durableReplace } from './native-durability.js';
import { workLocked } from './work-lock.js';
import { hostedActionError } from './hosted-action-error.js';
import type { HostedLaneSelection } from './hosted-lane.js';
import type { HostedAgentAddress, hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { diskMode } from './source-links.js';

type Command = z.infer<typeof hostedAgentCommandSchemas.finish>;
const selectionSchema = z.object({
  operationId: z.uuid(),
  fingerprint: z.string(),
  command: z.record(z.string(), z.unknown()),
});
export type FinishSelection = z.infer<typeof selectionSchema>;
/** Journal key: this finish was refused before it submitted anything (a known refusal code). */
export const finishRefusedKey = 'finish-refused';
/** Refusals thrown before compose or submission: the operation ended, nothing runs on the server. */
export const FINISH_REFUSALS = new Set([
  'NOTHING_TO_LAND',
  'UNSAVED_LANE_EDITS',
  'OVERLAP_UNANSWERED',
  'PREFLIGHT_REQUIRED',
]);
export type FinishContext = {
  command: Record<string, unknown>;
  clean: HostedLaneSelection | null;
  previous: FinishSelection | null;
};

/** Only one Lane's metadata and a 1 MiB scan buffer. Source is reread on every new
 * shorthand selection, except files whose lstat the checkout stat index ties to their baseline
 * blob; a cached fingerprint is never source authority. */
export function finishSourceFingerprint(root: string, command: Command, operationId?: string) {
  const marker = readHostedLaneCheckout(root);
  if (
    !marker ||
    command.inputs ||
    command.candidateId ||
    (command.laneId && command.laneId !== marker.selection.laneId)
  )
    return canonicalPayload({
      inputs: command.inputs ?? null,
      candidateId: command.candidateId ?? null,
      laneId: command.laneId ?? null,
    });
  const { files, marked } = scanCheckout(root, marker);
  assertNoConflictMarkers(
    root,
    marker.selection.laneId,
    marked,
    pendingConflictPaths(root, marker.selection.laneId).length > 0,
    { action: 'finish', parameters: { ...command, ...(operationId ? { operationId } : {}) } },
  );
  return digest(
    canonicalPayload({
      laneId: marker.selection.laneId,
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    }),
  );
}

/** The checkout's current files by path, and the paths whose bytes or mode differ from the saved
 * baseline (edited, added or deleted): the unsaved edits. One local scan; unchanged baseline files
 * are vouched for by the stat index and never reread. */
export function scanCheckout(root: string, marker: HostedLaneCheckoutMarker) {
  const baselineFiles = new Map(marker.state.files.map(file => [file.path, file]));
  const files = new Map(baselineFiles);
  const local = nativePaths(root, [...files.keys()]);
  const present = new Set(local);
  const changed: string[] = [];
  for (const path of marker.materialized)
    if (!forgeCachePath(path) && !present.has(path)) {
      files.delete(path);
      if (baselineFiles.has(path)) changed.push(path);
    }
  const scratch = Buffer.allocUnsafe(1024 * 1024),
    index = readCheckoutStatIndex(root);
  const marked: string[] = [];
  for (const path of local) {
    const stat = lstatSync(join(root, path));
    const before = baselineFiles.get(path);
    // A submodule is its pointer: a pointer file or a checkout (directory) whose HEAD names it.
    const mode = stat.isSymbolicLink()
      ? 'symlink'
      : stat.isDirectory() || before?.mode === 'gitlink'
        ? 'gitlink'
        : diskMode(stat, before?.mode);
    const baseline = files.get(path)?.blob;
    let blob: string;
    // The same blob the bytes would hash to: the stat index vouches only for unchanged baseline files.
    const indexed = baseline && !stat.isDirectory() ? indexedBlob(index, path, stat, baseline) : undefined;
    if (stat.isDirectory()) blob = digest(gitlinkDirectoryPointer(root, path));
    else if (indexed) blob = indexed;
    else if (mode === 'symlink') blob = digest(readlinkSync(join(root, path), { encoding: 'buffer' }));
    else {
      const reader = new SourceFileReader(root, path, 'SOURCE_CHANGED');
      try {
        const scan = conflictMarkerScan();
        blob = reader.scan(bytes => scanConflictMarkers(scan, bytes), undefined, scratch).sha256;
        if (blob !== baseline && conflictMarkersFound(scan)) marked.push(path);
      } finally {
        reader.close();
      }
    }
    if (!before || before.blob !== blob || before.mode !== mode) changed.push(path);
    files.set(path, { path, blob, mode });
  }
  return { files, marked, changed };
}

/** One durable index per normalized finish selection, independent of history size.
 * Explicit operation replay never changes the latest shorthand selection. */
export async function selectHostedFinish(
  root: string,
  address: HostedAgentAddress,
  actor: string,
  command: Command,
  operationId: string | undefined,
  observe: (
    operationId: string,
    runId?: string,
  ) => Promise<{ status?: string; submission?: { observation?: { state: string } } }>,
) {
  const directory = hostedAgentDirectory(root);
  const source = Object.fromEntries(
    Object.entries(command).filter(
      ([key]) => !['accept', 'message', 'retry', 'reason', 'priority'].includes(key),
    ),
  );
  const index = join(directory, `finish-${digest(canonicalPayload({ root, address, actor, source }))}.json`);
  const explicitReplay = operationId && checkoutPathExists(join(directory, `${operationId}.json`));
  if (explicitReplay) return new HostedAgentJournal(root, address, actor, 'finish', command, operationId);
  const fingerprint = finishSourceFingerprint(root, command, operationId);
  const marker = readHostedLaneCheckout(root);
  const clean =
    marker &&
    fingerprint ===
      digest(
        canonicalPayload({
          laneId: marker.selection.laneId,
          files: [...marker.state.files].sort((a, b) => a.path.localeCompare(b.path)),
        }),
      );
  const previous = checkoutPathExists(index) ? selectionSchema.parse(readAgentJson(index)) : undefined;
  // This folder became the named Lane's conflict resolution: that Lane's saved source is unchanged
  // by anything done here, so its shorthand keeps following the original operation's recovery.
  const resolvedHere =
    !!command.laneId &&
    !!marker &&
    marker.selection.laneId !== command.laneId &&
    !!inPlaceResolution(root, command.laneId);
  const sameSource = previous?.fingerprint === fingerprint || (resolvedHere && previous !== undefined);
  const terminal = async (prior: FinishSelection) => {
    const path = join(directory, `${prior.operationId}.json`);
    if (!checkoutPathExists(path)) return false;
    const saved = readAgentJson(path) as {
      values: Record<string, unknown>;
    };
    // A refusal before anything was submitted (nothing to land, an unanswered gate) ended that
    // operation: new source is new work. No server read (ac13de6b).
    if (saved.values['finish-source-failed'] || saved.values[finishRefusedKey]) return true;
    const run = saved.values['finish-check-run'] as { id: string } | undefined;
    // A check-only finish is never a landing, so the landing page has no row for it: without a run
    // it is still preparing (or its enqueue reply was lost) and is replayed, at zero reads.
    if (!run && prior.command.accept === false) return false;
    try {
      const observed = await observe(prior.operationId, run?.id);
      return observed.status
        ? checkTerminal(observed.status)
        : Boolean(observed.submission && observed.submission.observation?.state !== 'pending');
    } catch (error) {
      // A hosted read throws the server's code inside ConvexError data, not on the error itself.
      if (hostedActionError(error, 'observation').code === 'NOT_FOUND') return false;
      throw error;
    }
  };
  let selected = operationId;
  if (!selected && previous && !sameSource && !(await terminal(previous))) selected = previous.operationId;
  if (!selected && previous && sameSource && previous.command.accept === command.accept) {
    if (!command.retry) selected = previous.operationId;
    else if (canonicalPayload(previous.command) === canonicalPayload(command)) {
      if (!(await terminal(previous))) selected = previous.operationId;
    }
  }
  selected ??= randomUUID();
  const reservation = workLocked(join(directory, 'lock'), () => {
    const latest = checkoutPathExists(index) ? selectionSchema.parse(readAgentJson(index)) : undefined;
    // Another caller may have reserved the next generation while terminality
    // was observed outside the lock. Reconcile that unknown outcome first.
    if (
      !operationId &&
      latest &&
      latest.operationId !== previous?.operationId &&
      latest.fingerprint === fingerprint &&
      latest.command.accept === command.accept &&
      latest.command.priority === command.priority
    )
      return latest;
    const retainedCommand =
      !operationId && previous && selected === previous.operationId ? previous.command : command;
    const value = {
      operationId: selected!,
      fingerprint: previous && selected === previous.operationId ? previous.fingerprint : fingerprint,
      command: retainedCommand,
    };
    durableReplace(index, canonicalPayload(value));
    return value;
  });
  selected = reservation.operationId;
  const journal = new HostedAgentJournal(root, address, actor, 'finish', reservation.command, selected);
  await journal.retain<FinishContext>('finish-context', () => ({
    command: reservation.command,
    clean: clean ? marker.selection : null,
    previous: previous && sameSource && previous.operationId !== selected ? previous : null,
  }));
  return journal;
}

export function finishRetryHint(root: string, command: Command, result: Record<string, unknown>) {
  return normalizeHostedFinishResult(root, command, result);
}
